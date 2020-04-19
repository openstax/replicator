mod error;
mod schema;
mod select;

// networking and io imports
use std::fs;
use std::io::{BufWriter, Read, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::Path;

// selection and tree parsing imports
#[macro_use]
extern crate rental;
use roxmltree::{Document, Node, NodeType};
use std::ops::Deref;

// general
use std::collections::{BTreeMap, HashMap, VecDeque};
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
use self::schema::{
  Attribute, Element, Namespace, QualifiedName, Request, Response, WriteInstruction,
};
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
      resolve_selector(document.get_node(id.into()).unwrap(), selector)
        .iter()
        .filter_map(|node| match node.node_type() {
          NodeType::Element | NodeType::Text | NodeType::Root => Some(node.id().get_usize()),
          _ => None,
        })
        .collect()
    })
  }

  fn qualified_name(&self, id: usize) -> QualifiedName {
    self.rent(|document| {
      let node = document.get_node(id.into()).unwrap();
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

  fn deep_text(node: Node) -> String {
    node.descendants()
      .filter_map(|descendant| {
          if descendant.is_text() { descendant.text() } else { None }
      })
      .collect()
  }

  fn text(&self, id: usize) -> String {
    self.rent(|document| {
      let node = document.get_node(id.into()).unwrap();
      Self::deep_text(node)
    })
  }

  fn attributes(&self, id: usize) -> Vec<Attribute> {
    self.rent(|document| {
      let node = document.get_node(id.into()).unwrap();
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

  fn to_write_instruction_queue(&self, results: &ReplacementMapping) -> Vec<WriteInstruction> {
    let mut queue = vec![];
    self.rent(|document| {
      queue_self_or_map(document, &mut queue, document.root(), "default", &results);
    });
    queue
  }
}

fn parse_file<T: AsRef<Path>>(path: T) -> OvenResult<DocumentWrapper> {
  let data = fs::read_to_string(path)?;
  DocumentWrapper::new(data)
}

#[derive(Copy, Clone)]
enum WriteInstructionKind<'a, 'b: 'a> {
  Document(Node<'a, 'b>),
  StartElement(Node<'a, 'b>),
  EndElement(Node<'a, 'b>),
  Attributes(Node<'a, 'b>),
  Namespaces(Node<'a, 'b>),
  PI(Node<'a, 'b>),
  Comment(Node<'a, 'b>),
  Text(Node<'a, 'b>),
}

impl From<WriteInstructionKind<'_, '_>> for WriteInstruction {
  fn from(wi_type: WriteInstructionKind) -> Self {
    match wi_type {
      WriteInstructionKind::Document(_) => WriteInstruction::Document,
      WriteInstructionKind::StartElement(node) => {
        let node_tag = node.tag_name();
        WriteInstruction::StartElement {
          qualified_name: QualifiedName {
            uri: node_tag.namespace().unwrap_or("").to_owned(),
            local_name: node_tag.name().to_owned(),
          },
        }
      }
      WriteInstructionKind::EndElement(node) => {
        let node_tag = node.tag_name();
        WriteInstruction::EndElement {
          qualified_name: QualifiedName {
            uri: node_tag.namespace().unwrap_or("").to_owned(),
            local_name: node_tag.name().to_owned(),
          },
        }
      }
      WriteInstructionKind::Namespaces(node) => {
        let difference = match node.parent_element().map(|p| p.namespaces()) {
          Some(parent_ns_map) => node
            .namespaces()
            .iter()
            .filter(|namespace| !parent_ns_map.iter().any(|n| n == *namespace))
            .map(|namespace| namespace.into())
            .collect::<Vec<Namespace>>(),
          None => node
            .namespaces()
            .iter()
            .map(|namespace| namespace.into())
            .collect::<Vec<Namespace>>(),
        };
        WriteInstruction::Namespaces {
          namespaces: difference,
        }
      }
      WriteInstructionKind::Attributes(node) => WriteInstruction::Attributes {
        attributes: node.attributes().iter().map(|a| a.into()).collect(),
      },
      WriteInstructionKind::PI(node) => WriteInstruction::PI {
        target: node.pi().expect("Already checked node.").target.to_owned(),
        value: node
          .pi()
          .expect("Already checked node.")
          .value
          .unwrap_or("")
          .to_owned(),
      },
      WriteInstructionKind::Comment(node) => WriteInstruction::Comment {
        text: node.text().unwrap().to_owned(),
      },
      WriteInstructionKind::Text(node) => WriteInstruction::Text {
        text: node.text().unwrap().to_owned(),
      },
    }
  }
}

impl From<&roxmltree::Attribute<'_>> for Attribute {
  fn from(source: &roxmltree::Attribute) -> Attribute {
    Attribute {
      qualified_name: QualifiedName {
        local_name: source.name().to_owned(),
        uri: source.namespace().unwrap_or("").to_owned(),
      },
      value: source.value().to_owned(),
    }
  }
}

impl From<&roxmltree::Namespace<'_>> for Namespace {
  fn from(source: &roxmltree::Namespace) -> Namespace {
    Namespace {
      prefix: source.name().unwrap_or("").to_owned(),
      uri: source.uri().to_owned(),
    }
  }
}

type ReplacementMapping = HashMap<(usize, String), Vec<WriteInstruction>>;
fn queue_self_or_map<'a, 'b: 'a>(
  doc: &Document,
  queue: &mut Vec<WriteInstruction>,
  node: Node<'a, 'b>,
  mode: &str,
  mapping: &ReplacementMapping,
) {
  let instructions_from_map = mapping.get(&(node.id().get_usize(), mode.to_owned()));
  if let Some(instructions) = instructions_from_map {
    instructions.iter().for_each(|instruction| {
      match instruction {
        WriteInstruction::Replace {
          node_id: replace_node_id,
          mode: replace_mode,
        } => queue_self_or_map(
          doc,
          queue,
          doc.get_node((*replace_node_id).into()).unwrap(),
          replace_mode,
          mapping,
        ),
        _ => queue.push(instruction.clone()),
      };
    });
    return;
  }
  match node.node_type() {
    NodeType::Root => {
      queue.push(WriteInstructionKind::Document(node).into());
      node.children().for_each(|child| {
        queue_self_or_map(doc, queue, child, mode, mapping);
      });
    }
    NodeType::Element => {
      queue.push(WriteInstructionKind::StartElement(node).into());
      queue.push(WriteInstructionKind::Namespaces(node).into());
      queue.push(WriteInstructionKind::Attributes(node).into());
      node.children().for_each(|child| {
        queue_self_or_map(doc, queue, child, mode, mapping);
      });
      queue.push(WriteInstructionKind::EndElement(node).into());
    }
    NodeType::PI => queue.push(WriteInstructionKind::PI(node).into()),
    NodeType::Comment => queue.push(WriteInstructionKind::Comment(node).into()),
    NodeType::Text => queue.push(WriteInstructionKind::Text(node).into()),
  }
}

#[derive(Debug)]
enum SerializationError {
  BadWrite,
  UnexpectedEOF,
  UnsetURI(String),
  UnexpectedInstruction,
}

trait WriteInstructionProcessor {
  fn write_queue<T: Write>(
    &self,
    write: T,
    queue: &mut VecDeque<WriteInstruction>,
  ) -> Result<(), SerializationError>;
}

struct XmlRsProcessor {
  pad_self_closing: bool,
  perform_indent: bool
}
use std::borrow::Cow;
use xml::attribute::Attribute as AttributeEvent;
use xml::name::Name;
use xml::namespace::Namespace as NamespaceEvent;
use xml::writer::{EmitterConfig, XmlEvent};
impl XmlRsProcessor {
  fn write_queue<T: Write>(
    &self,
    write: T,
    queue: &[WriteInstruction],
  ) -> Result<(), SerializationError> {
    let mut writer = EmitterConfig::new()
      .write_document_declaration(false)
      .pad_self_closing(self.pad_self_closing)
      .perform_indent(self.perform_indent)
      .create_writer(write);
    let mut cursor = 0;
    let mut ns_map: BTreeMap<String, String> = BTreeMap::new();
    while let Some(event) = self.get_next_event(&mut cursor, &queue, &mut ns_map)? {
      if writer.write(event).is_err() {
        return Err(SerializationError::BadWrite);
      }
    }
    Ok(())
  }

  fn get_next_event<'a>(
    &self,
    cursor: &mut usize,
    queue: &'a [WriteInstruction],
    ns_map: &'a mut BTreeMap<String, String>,
  ) -> Result<Option<XmlEvent<'a>>, SerializationError> {
    let next = queue.get(*cursor);
    *cursor += 1;
    match next {
      None => Ok(None),
      Some(instruction) => match instruction {
        WriteInstruction::StartElement { qualified_name } => {
          let mut attr_cache: Vec<&Attribute> = vec![];
          loop {
            let next = queue.get(*cursor);
            match next {
              None => return Err(SerializationError::UnexpectedEOF),
              Some(instruction) => match instruction {
                WriteInstruction::Attributes { attributes } => {
                  attr_cache.append(&mut attributes.iter().collect::<Vec<&Attribute>>());
                  *cursor += 1;
                }
                WriteInstruction::Namespaces { namespaces } => {
                  for namespace in namespaces {
                    ns_map.insert(namespace.prefix.clone(), namespace.uri.clone());
                  }
                  *cursor += 1;
                }
                _ => break,
              },
            }
          }
          let mut attribute_events: Vec<AttributeEvent> = vec![];
          for attr in attr_cache {
            let uri = &attr.qualified_name.uri;
            let prefix = match ns_map.iter().find(|(_, value)| *value == uri) {
              Some((prefix, _)) => prefix,
              None => match uri.len() {
                0 => "",
                _ => return Err(SerializationError::UnsetURI(uri.clone())),
              },
            };
            let event = AttributeEvent {
              name: Name {
                local_name: attr.qualified_name.local_name.as_ref(),
                namespace: if uri.is_empty() {
                  None
                } else {
                  Some(uri.as_ref())
                },
                prefix: if prefix.is_empty() {
                  None
                } else {
                  Some(prefix)
                },
              },
              value: attr.value.as_ref(),
            };
            attribute_events.push(event)
          }

          let uri = &qualified_name.uri;
          let prefix = match ns_map.iter().find(|(_, value)| *value == uri) {
            Some((prefix, _)) => prefix,
            None => {
              if uri.is_empty() {
                ""
              } else {
                return Err(SerializationError::UnsetURI(uri.clone()));
              }
            }
          };
          let name = Name {
            local_name: qualified_name.local_name.as_ref(),
            namespace: if uri.is_empty() {
              None
            } else {
              Some(uri.as_ref())
            },
            prefix: if prefix.is_empty() {
              None
            } else {
              Some(prefix)
            },
          };
          Ok(Some(XmlEvent::StartElement {
            name,
            attributes: Cow::Owned(attribute_events),
            namespace: Cow::Owned(NamespaceEvent(ns_map.clone())),
          }))
        }
        WriteInstruction::EndElement { .. } => Ok(Some(XmlEvent::EndElement { name: None })),
        WriteInstruction::Document => self.get_next_event(cursor, queue, ns_map),
        WriteInstruction::Text { text } => Ok(Some(XmlEvent::Characters(text.as_ref()))),
        WriteInstruction::Comment { text } => Ok(Some(XmlEvent::Comment(text.as_ref()))),
        WriteInstruction::PI { target, value } => Ok(Some(XmlEvent::ProcessingInstruction {
          name: target.as_ref(),
          data: if value.is_empty() {
            None
          } else {
            Some(value.as_ref())
          },
        })),
        _ => Err(SerializationError::UnexpectedInstruction),
      },
    }
  }
}

fn handle_request(
  document: &DocumentWrapper,
  mut stream: UnixStream,
  state_manager: Arc<Mutex<StateManager>>,
) -> RequestResult<()> {
  let mut request_string = String::new();
  stream.read_to_string(&mut request_string)?;
  let request = match serde_json::from_str(&request_string) {
    Ok(request) => request,
    Err(err) => {
      eprintln!("{}", request_string);
      return Err(err.into())
    }
  };

  let response: Response = match request {
    Request::Selection { node_id, selector } => match ActionableSelector::from_string(selector) {
      Ok(sel) => {
        let selected = document.select(node_id, &sel);
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
      Err(err) => Response::BadRequest {
        reason: format!("{}", err),
      },
    },
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

#[derive(Debug)]
struct StateManager {
  count: usize,
  results: ReplacementMapping,
  progress: usize,
  completed: bool,
  error: Option<RequestError>,
  race_count: usize,
}

fn unwrap_results(state_manager: Arc<Mutex<StateManager>>) -> ReplacementMapping {
  Arc::try_unwrap(state_manager)
    .unwrap()
    .into_inner()
    .unwrap()
    .results
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
    .arg(
      Arg::with_name("OUTFILE")
        .help("The output file")
        .required(false)
        .index(3),
    )
    .arg(
      Arg::with_name("node-coverage")
        .long("node-coverage")
        .short('c')
        .takes_value(false)
        .help("Run node worker with coverage reporting"),
    )
    .arg(
      Arg::with_name("pretty-print")
        .long("pretty-print")
        .short('p')
        .takes_value(false)
        .help("Pretty-print XML output"),
    )
    .arg(
      Arg::with_name("node-workers")
        .long("node-workers")
        .short('w')
        .takes_value(true)
        .default_value("2")
        .help("The number of node workers to use"),
    )
    .get_matches();

  let mut socket_path = std::env::temp_dir();
  socket_path.push(format!("tmp-baking-{}.sock", rand::random::<u32>()));
  let listener = UnixListener::bind(&socket_path).unwrap();
  listener.set_nonblocking(true).unwrap();

  const NUM_STEPS: u8 = 5;

  let baked_file_path =
    fs::canonicalize(matches.value_of("TARGET").expect("Argument is required")).unwrap();
  let manifest_file_path =
    fs::canonicalize(matches.value_of("MANIFEST").expect("Argument is required")).unwrap();

  let info_style = Style::new().bold().dim();

  eprintln!(
    "{} Starting acceptor for manifest: {}",
    info_style.apply_to(format!("[1/{}]", NUM_STEPS)),
    style(manifest_file_path.to_string_lossy()).dim()
  );
  let mut path_to_js = std::env::current_exe().unwrap();
  path_to_js.pop();
  path_to_js.push("bake.js");
  let mut child_process = if matches.is_present("node-coverage") {
    Command::new("nyc")
      .args(&[
        "--silent",
        "--no-clean",
        "node",
        path_to_js.to_str().unwrap(),
        socket_path.to_str().unwrap(),
        manifest_file_path.to_str().unwrap(),
        matches.value_of("node-workers").unwrap(),
      ])
      .stderr(Stdio::inherit())
      .stdout(Stdio::inherit())
      .spawn()
      .unwrap()
  } else {
    Command::new("node")
      .args(&[
        path_to_js.to_str().unwrap(),
        socket_path.to_str().unwrap(),
        manifest_file_path.to_str().unwrap(),
        matches.value_of("node-workers").unwrap(),
      ])
      .stderr(Stdio::inherit())
      .stdout(Stdio::inherit())
      .spawn()
      .unwrap()
  };

  eprintln!(
    "{} Parsing file: {}",
    info_style
      .apply_to(format!("[2/{}]", NUM_STEPS))
      .bold()
      .dim(),
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
    info_style.apply_to(format!("[3/{}]", NUM_STEPS))
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
  eprintln!("{}", style("### Report ###").bold());
  let not_good_style = Style::new().red().bold();
  let good_style = Style::new().green().bold();
  {
    let locked_manager = state_manager.lock().unwrap();
    eprintln!("Results: {:?}", locked_manager.results.iter().count());
    eprintln!(
      "Races: {:?}",
      if locked_manager.race_count > 0 {
        &not_good_style
      } else {
        &good_style
      }
      .apply_to(locked_manager.race_count)
    );
    match locked_manager.error {
      Some(ref err) => eprintln!("Error: {}", not_good_style.apply_to(err)),
      None => eprintln!("Error: {}", good_style.apply_to("None")),
    };
  }

  eprintln!(
    "{} Shutting down acceptor...",
    info_style
      .apply_to(format!("[4/{}]", NUM_STEPS))
      .bold()
      .dim(),
  );
  if matches.is_present("node-coverage") {
    child_process.wait().unwrap();
  } else {
    child_process.kill().unwrap();
  }
  fs::remove_file(socket_path).ok();

  eprintln!(
    "{} Serializing...",
    info_style
      .apply_to(format!("[5/{}]", NUM_STEPS))
      .bold()
      .dim(),
  );
  let results = unwrap_results(state_manager);
  let write_instruction_queue = document.to_write_instruction_queue(&results);
  let processor = XmlRsProcessor {
    pad_self_closing: false,
    perform_indent: matches.is_present("pretty-print")
  };
  let writer: Box<dyn Write> = match matches.value_of("OUTFILE") {
    Some(file) => Box::new(fs::File::create(file).unwrap()),
    None => Box::new(std::io::stdout()),
  };
  let buffered = BufWriter::new(writer);
  processor
    .write_queue(buffered, &write_instruction_queue)
    .unwrap();

  eprintln!("{}", style("Done!").green().bold());
}

#[test]
fn passing_test() {}
