mod select;

// networking and io imports
use serde::{Deserialize, Serialize};
use std::fs;
use std::io;
use std::os::unix::net::{UnixListener, UnixStream};

// selection and tree parsing imports
use roxmltree::{Document, Node, NodeType};
use scandent::ScandentResult;
use std::ops::Deref;

// other
use std::borrow::Cow;
use std::error;
use std::fmt;
use std::result;
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use std::time::Instant;

// parallelism
use rayon::prelude::*;
use rayon::scope;

// rental
#[macro_use]
extern crate rental;

// self
use self::select::{resolve_selector, ActionableSelector};

#[derive(Serialize, Deserialize, Debug)]
struct QualifiedName {
  uri: String,
  local_name: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct Element {
  qualified_name: QualifiedName,
  node_id: usize,
}

#[derive(Serialize, Deserialize, Debug)]
struct Attribute {
  qualified_name: QualifiedName,
  value: String,
}

#[derive(Serialize, Deserialize, Debug)]
struct TransformResult {
  node_id: usize,
  mode: String,
  instructions: Vec<WriteInstruction>,
}

#[derive(Serialize, Deserialize, Debug)]
enum WriteInstruction {
  StartElement { qualified_name: QualifiedName },
  EndElement { qualified_name: QualifiedName },
  Text { text: String },
  Attributes { attributes: Vec<Attribute> },
  Replace { node_id: usize, mode: String },
}

#[derive(Serialize, Deserialize, Debug)]
enum Request {
  Selection { node_id: usize, selector: String },
  Text { node_id: usize },
  Attributes { node_id: usize },
  PutResults { results: Vec<TransformResult> },
  PutCount { count: usize },
  PutComplete,
  PutError { message: String },
}

#[derive(Serialize, Deserialize, Debug)]
enum Response {
  None,
  Selection { elements: Vec<Element> },
  Text { text: String },
  Attributes { attributes: Vec<Attribute> },
}

type OvenResult<T> = result::Result<T, OvenError>;

#[derive(Debug)]
enum OvenError {
  DocumentReadError(io::Error),
  DocumentParseError(roxmltree::Error),
}

impl error::Error for OvenError {
  fn source(&self) -> Option<&(dyn error::Error + 'static)> {
    match &self {
      OvenError::DocumentReadError(err) => Some(err),
      OvenError::DocumentParseError(err) => Some(err),
    }
  }
}

impl fmt::Display for OvenError {
  fn fmt(&self, f: &mut fmt::Formatter) -> fmt::Result {
    write!(
      f,
      "{}: {}",
      match &self {
        OvenError::DocumentReadError(_) => "DocumentReadError",
        OvenError::DocumentParseError(_) => "DocumentParseError",
      },
      match &self {
        OvenError::DocumentReadError(err) => err.to_string(),
        OvenError::DocumentParseError(err) => err.to_string(),
      }
    )
  }
}

rental! {
  pub mod rent_document {
    use roxmltree::Document;

    #[rental]
    pub struct ContainedDocument {
      source: Box<String>,
      document: Document<'source>,
    }
  }
}

use rent_document::ContainedDocument;

pub struct DocumentWrapper {
  document: ContainedDocument,
}

impl Deref for DocumentWrapper {
  type Target = ContainedDocument;

  fn deref(&self) -> &Self::Target {
    &self.document
  }
}

impl DocumentWrapper {
  fn new(source: String) -> OvenResult<DocumentWrapper> {
    let contained =
      ContainedDocument::try_new(Box::from(source), |src| match Document::parse(src) {
        Err(err) => Err(OvenError::DocumentParseError(err)),
        Ok(document) => Ok(document),
      });

    match contained {
      Ok(contained) => Ok(DocumentWrapper {
        document: contained,
      }),
      Err(err) => Err(err.0),
    }
  }

  fn root_id(&self) -> usize {
    self.rent(|document| document.root().get_id())
  }

  fn select(&self, id: usize, selector: &ActionableSelector) -> Vec<usize> {
    self.rent(|document| {
      resolve_selector(document.get_node_by_id(id), selector)
        .iter()
        .filter_map(|node| match node.node_type() {
          NodeType::Element | NodeType::Text | NodeType::Root => Some(node.get_id()),
          _ => None
        })
        .collect()
    })
  }

  fn qualified_name(&self, id: usize) -> QualifiedName {
    self.rent(|document| {
      let node = document.get_node_by_id(id);
      let tag = node.tag_name();
      QualifiedName {
        uri: tag.namespace().unwrap_or("").to_owned(),
        local_name: if let NodeType::Text = node.node_type() { "#text" } else { tag.name() }.to_owned()
      }
    })
  }

  fn text(&self, id: usize) -> String {
    self.rent(|document| {
      let node = document.get_node_by_id(id);
      node.deep_text().unwrap_or("".to_owned())
    })
  }

  fn attributes(&self, id: usize) -> Vec<Attribute> {
    self.rent(|document| {
      let node = document.get_node_by_id(id);
      node.attributes()
        .iter()
        .map(|attribute| {
          Attribute {
            qualified_name: QualifiedName {
              uri: attribute.namespace().unwrap_or("").to_owned(),
              local_name: attribute.name().to_owned()
            },
            value: attribute.value().to_owned()
          }
        })
        .collect()
    })
  }
}

fn parse_file<'a, T: Into<Cow<'a, str>>>(path: T) -> OvenResult<DocumentWrapper> {
  let path_string: String = path.into().into();
  let data_result = fs::read_to_string(&path_string);
  match data_result {
    Err(err) => Err(OvenError::DocumentReadError(err)),
    Ok(data) => DocumentWrapper::new(data),
  }
}

type RequestResult<T> = result::Result<T, RequestError>;

#[derive(Debug)]
pub enum RequestError {
  ScandentError,
  ChildTerminated(String),
  Misc,
}

impl From<scandent::ScandentError> for RequestError {
  fn from(err: scandent::ScandentError) -> RequestError {
    RequestError::ScandentError
  }
}

impl From<serde_json::error::Error> for RequestError {
  fn from(err: serde_json::error::Error) -> RequestError {
    RequestError::Misc
  }
}

impl From<std::io::Error> for RequestError {
  fn from(err: std::io::Error) -> RequestError {
    RequestError::Misc
  }
}

fn handle_request(
  wrapper: &DocumentWrapper,
  stream: UnixStream,
  state_manager: &Arc<Mutex<StateManager>>
) -> RequestResult<()> {
  println!("Handling request");
  let mut deserializer = serde_json::Deserializer::from_reader(&stream);
  let request = Request::deserialize(&mut deserializer).expect("Format should be consistent");

  let response: Response = match request {
    Request::Selection { node_id, selector } => {
      let selector = ActionableSelector::from_string(selector)?;
      let selected = wrapper.select(node_id, &selector);
      Response::Selection {
        elements: selected
          .iter()
          .map(|&node_id| Element { node_id, qualified_name: wrapper.qualified_name(node_id) })
          .collect()
      }
    },
    Request::Text { node_id } => {
      Response::Text { text: wrapper.text(node_id) }
    },
    Request::Attributes { node_id } => {
      Response::Attributes { attributes: wrapper.attributes(node_id)}
    },
    Request::PutResults { results } => {
      let mut state_manager = state_manager.lock().unwrap();
      let state_results = &mut state_manager.results;
      for result in results {
        state_results.insert((result.node_id, result.mode), result.instructions);
      }
      state_manager.progress += 1;
      return Ok(())
    },
    Request::PutCount { count } => {
      let mut state_manager = state_manager.lock().unwrap();
      state_manager.count = count;
      return Ok(())
    },
    Request::PutComplete => {
      let mut state_manager = state_manager.lock().unwrap();
      state_manager.completed = true;
      return Ok(())
    },
    Request::PutError { message } => {
      return Err(RequestError::ChildTerminated(message))
    },
  };
  serde_json::to_writer(&stream, &response)?;

  Ok(())
}

struct StateManager {
  count: usize,
  results: HashMap<(usize, String), Vec<WriteInstruction>>,
  progress: usize,
  completed: bool
}

fn main() {
  let wrapper = parse_file("./chemistry.xhtml").unwrap();

  let socket_path = "/tmp/baking.sock";

  fs::remove_file(&socket_path).ok();
  let listener = UnixListener::bind(&socket_path).expect("Could not start server");

  let state_manager = Arc::new(Mutex::new(StateManager {
    count: 0,
    results: HashMap::new(),
    progress: 0,
    completed: false
  }));

  let check_interval = 500;
  let mut last_check = Instant::now();

  scope(|s| {
    println!("Listening");
    'listener: for stream in listener.incoming() {
      match stream {
        Ok(stream) => {
          s.spawn(|_| {
            println!("Thread spawned");
            let state_manager_clone = state_manager.clone();
            match handle_request(&wrapper, stream, &state_manager_clone) {
              Ok(_) => println!("Processed request successfully."),
              Err(err) => panic!("Error occured processing a request: {:?}", err)
            };
          });
        }
        Err(err) => {
          println!("Error: {}", err);
          break 'listener;
        }
      }
      // A stream must be incoming for this check to fire.
      // Child process must send heartbeat of some form.
      // e.g. when complete, continuously send PutComplete.
      let now = Instant::now();
      if now.duration_since(last_check).as_millis() > check_interval {
        last_check = now;
        let state_manager_clone = state_manager.clone();
        let locked_manager = state_manager_clone.lock().unwrap();
        println!("Progress: {} / {}", locked_manager.progress, locked_manager.count);
        if locked_manager.completed {
          println!("Completed");
          break 'listener;
        }
      }
    }
  });

  let locked_manager = state_manager.lock().unwrap();
  println!("{:?}", locked_manager.results);

  // TODO: serialize output
}

#[test]
fn passing_test() {}
