mod error;
mod schema;
mod select;

// networking and io imports
use std::fs;
use std::io::{Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;

// selection and tree parsing imports
#[macro_use]
extern crate rental;
use roxmltree::{Document, NodeType};
use std::ops::Deref;

// general
use std::collections::HashMap;
use std::process::{Command, Stdio};

// parallelism/concurrency
use rayon::scope;
use std::sync::{Arc, Mutex};
use std::time::Instant;

// cli
use clap::{crate_version, App, Arg};
use console::{style, Style};
use indicatif::{ProgressBar, ProgressDrawTarget, ProgressStyle};

// self
use self::error::{OvenResult, RequestError, RequestResult};
use self::schema::{Attribute, Element, QualifiedName, Request, Response, WriteInstruction};
use self::select::{resolve_selector, ActionableSelector};

rental! {
  pub mod rent_document {
    use roxmltree::Document;

    #[rental]
    pub struct ContainedDocument {
      source: String,
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
    let contained = ContainedDocument::try_new(source, |src| Document::parse(src));
    match contained {
      Ok(contained) => Ok(DocumentWrapper {
        document: contained,
      }),
      Err(err) => Err(err.0.into()),
    }
  }

  fn select(&self, id: usize, selector: &ActionableSelector) -> Vec<usize> {
    self.rent(|document| {
      resolve_selector(document.get_node_by_id(id), selector)
        .iter()
        .filter_map(|node| match node.node_type() {
          NodeType::Element | NodeType::Text | NodeType::Root => Some(node.get_id()),
          _ => None,
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
        local_name: if let NodeType::Text = node.node_type() {
          "#text"
        } else {
          tag.name()
        }
        .to_owned(),
      }
    })
  }

  fn text(&self, id: usize) -> String {
    self.rent(|document| {
      let node = document.get_node_by_id(id);
      node.deep_text().unwrap_or_else(|| "".to_owned())
    })
  }

  fn attributes(&self, id: usize) -> Vec<Attribute> {
    self.rent(|document| {
      let node = document.get_node_by_id(id);
      node
        .attributes()
        .iter()
        .map(|attribute| Attribute {
          qualified_name: QualifiedName {
            uri: attribute.namespace().unwrap_or("").to_owned(),
            local_name: attribute.name().to_owned(),
          },
          value: attribute.value().to_owned(),
        })
        .collect()
    })
  }
}

fn parse_file<T: AsRef<Path>>(path: T) -> OvenResult<DocumentWrapper> {
  let data = fs::read_to_string(path)?;
  DocumentWrapper::new(data)
}

// async fn handle_request(
fn handle_request(
  document: &DocumentWrapper,
  mut stream: UnixStream,
  state_manager: Arc<Mutex<StateManager>>,
) -> RequestResult<()> {
  let mut request_string = String::new();
  stream.read_to_string(&mut request_string)?;
  let request = serde_json::from_str(&request_string)?;

  let response: Response = match request {
    Request::Selection { node_id, selector } => {
      let selector = ActionableSelector::from_string(selector)?;
      let selected = document.select(node_id, &selector);
      Response::Selection {
        elements: selected
          .iter()
          .map(|&node_id| Element {
            node_id,
            qualified_name: document.qualified_name(node_id),
          })
          .collect(),
      }
    }
    Request::Text { node_id } => Response::Text {
      text: document.text(node_id),
    },
    Request::Attributes { node_id } => Response::Attributes {
      attributes: document.attributes(node_id),
    },
    Request::PutResults { results } => {
      let mut locked_manager = state_manager.lock().unwrap();
      let state_results = &mut locked_manager.results;
      let mut races = 0;
      for result in results {
        if state_results
          .insert((result.node_id, result.mode), result.instructions)
          .is_some()
        {
          races += 1;
        }
      }
      locked_manager.race_count += races;
      locked_manager.progress += 1;
      return Ok(());
    }
    Request::PutCount { count } => {
      let mut locked_manager = state_manager.lock().unwrap();
      locked_manager.count += count;
      return Ok(());
    }
    Request::PutComplete => {
      let mut locked_manager = state_manager.lock().unwrap();
      locked_manager.completed = true;
      return Ok(());
    }
    Request::PutError { message } => {
      return Err(RequestError::ChildTerminated(message));
    }
    Request::HeartBeat => return Ok(()),
  };

  let response_string = serde_json::to_string(&response)?;
  let bytes = response_string.as_bytes();
  stream.write_all(bytes)?;

  Ok(())
}

struct StateManager {
  count: usize,
  results: HashMap<(usize, String), Vec<WriteInstruction>>,
  progress: usize,
  completed: bool,
  error: Option<RequestError>,
  race_count: usize,
}

fn main() {
  let matches = App::new("Replicator")
    .version(crate_version!())
    .about("High performance replacement-baking processor")
    .arg(
      Arg::with_name("TARGET")
        .help("The file to bake")
        .required(true)
        .index(1),
    )
    .arg(
      Arg::with_name("MANIFEST")
        .help("The baking recipe manifest file")
        .required(true)
        .index(2),
    )
    .get_matches();

  const SOCKET_PATH: &str = "/tmp/baking.sock";
  fs::remove_file(SOCKET_PATH).ok();
  let listener = UnixListener::bind(SOCKET_PATH).unwrap();
  listener.set_nonblocking(true).unwrap();

  const NUM_STEPS: u8 = 4;

  let baked_file_path =
    fs::canonicalize(matches.value_of("TARGET").expect("Argument is required")).unwrap();
  let manifest_file_path =
    fs::canonicalize(matches.value_of("MANIFEST").expect("Argument is required")).unwrap();

  println!(
    "{} Starting acceptor for manifest: {}",
    style(format!("[1/{}]", NUM_STEPS)).bold().dim(),
    style(manifest_file_path.to_string_lossy()).dim()
  );
  let mut child_process = Command::new("node")
    .args(&[
      "-r",
      "./../recipe-acceptor/.pnp.js",
      "./../recipe-acceptor/build/src/bake.js",
      SOCKET_PATH,
      manifest_file_path.to_str().unwrap(),
    ])
    .stderr(Stdio::inherit())
    .stdout(Stdio::inherit())
    .spawn()
    .unwrap();

  println!(
    "{} Parsing file: {}",
    style(format!("[2/{}]", NUM_STEPS)).bold().dim(),
    style(baked_file_path.to_string_lossy()).dim()
  );
  let document = parse_file(baked_file_path).unwrap();

  let state_manager = Arc::new(Mutex::new(StateManager {
    count: 0,
    results: HashMap::new(),
    progress: 0,
    completed: false,
    error: None,
    race_count: 0,
  }));

  let progress_bar = ProgressBar::hidden();
  progress_bar.set_prefix(&format!(
    "{} Collecting transforms: ",
    style(format!("[3/{}]", NUM_STEPS)).bold().dim()
  ));
  let template = "{prefix} {bar:.blue.dim.on_white} {pos:>4} / {len}";
  progress_bar.set_style(ProgressStyle::default_bar().template(template));

  const CHECK_INTERVAL_MILLIS: u128 = 100;
  let mut last_check = Instant::now();

  scope(|s| {
    'listener: for stream in listener.incoming() {
      if let Ok(stream) = stream {
        s.spawn(|_| {
          if let Err(err) = handle_request(&document, stream, state_manager.clone()) {
            let state_manager_clone = state_manager.clone();
            let mut locked_manager = state_manager_clone.lock().unwrap();
            locked_manager.error = Some(err);
          }
        });
      }
      let now = Instant::now();
      if now.duration_since(last_check).as_millis() > CHECK_INTERVAL_MILLIS {
        let state_manager_clone = state_manager.clone();
        let locked_manager = state_manager_clone.lock().unwrap();
        let count = locked_manager.count;
        let progress = locked_manager.progress;
        if locked_manager.error.is_some() {
          break 'listener;
        }
        if locked_manager.completed && progress == count {
          progress_bar.finish();
          break 'listener;
        }
        if count > 0 && progress_bar.is_hidden() {
          progress_bar.set_draw_target(ProgressDrawTarget::stderr());
        }
        progress_bar.set_length(count as u64);
        progress_bar.set_position(progress as u64);
        last_check = now;
      }
    }
  });
  println!("{}", style("### Report ###").bold());
  let not_good_style = Style::new().red().bold();
  let good_style = Style::new().green().bold();
  let locked_manager = state_manager.lock().unwrap();
  println!("Results: {:?}", locked_manager.results.iter().count());
  println!(
    "Races: {:?}",
    if locked_manager.race_count > 0 {
      &not_good_style
    } else {
      &good_style
    }
    .apply_to(locked_manager.race_count)
  );
  println!(
    "Error: {:?}",
    if locked_manager.error.is_some() {
      &not_good_style
    } else {
      &good_style
    }
    .apply_to(&locked_manager.error)
  );

  println!(
    "{} Shutting down acceptor...",
    style(format!("[4/{}]", NUM_STEPS)).bold().dim(),
  );
  child_process.kill().ok();

  println!(
    "{} Serializing...",
    style(format!("[5/{}]", NUM_STEPS)).bold().dim(),
  );

  
  // TODO: serialize output
  // TODO: Intersection types to handle race conditions
  // TODO: Clean up error handling in main on OvenError with From impls
  // TODO: Pipe child process output to logfile or report afterwards?
}

#[test]
fn passing_test() {}
