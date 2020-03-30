use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Debug)]
pub(crate) struct QualifiedName {
  #[serde(rename = "u")]
  pub(crate) uri: String,
  #[serde(rename = "l")]
  pub(crate) local_name: String,
}

#[derive(Serialize, Debug)]
pub(crate) struct Element {
  #[serde(rename = "q")]
  pub(crate) qualified_name: QualifiedName,
  #[serde(rename = "n")]
  pub(crate) node_id: usize,
}

#[derive(Serialize, Deserialize, Debug)]
pub(crate) struct Attribute {
  #[serde(rename = "q")]
  pub(crate) qualified_name: QualifiedName,
  #[serde(rename = "v")]
  pub(crate) value: String,
}

#[derive(Deserialize, Debug)]
pub(crate) struct TransformResult {
  #[serde(rename = "n")]
  pub(crate) node_id: usize,
  #[serde(rename = "m")]
  pub(crate) mode: String,
  #[serde(rename = "i")]
  pub(crate) instructions: Vec<WriteInstruction>,
}

#[derive(Deserialize, Debug)]
pub(crate) enum WriteInstruction {
  #[serde(rename = "S")]
  StartElement {
    #[serde(rename = "q")]
    qualified_name: QualifiedName
  },
  #[serde(rename = "E")]
  EndElement {
    #[serde(rename = "q")]
    qualified_name: QualifiedName
  },
  #[serde(rename = "T")]
  Text {
    #[serde(rename = "t")]
    text: String
  },
  #[serde(rename = "A")]
  Attributes {
    #[serde(rename = "a")]
    attributes: Vec<Attribute>
  },
  #[serde(rename = "R")]
  Replace {
    #[serde(rename = "n")]
    node_id: usize,
    #[serde(rename = "m")]
    mode: String
  },
}

#[derive(Deserialize, Debug)]
pub(crate) enum Request {
  #[serde(rename = "S")]
  Selection {
    #[serde(rename = "n")]
    node_id: usize,
    #[serde(rename = "s")]
    selector: String
  },
  #[serde(rename = "T")]
  Text {
    #[serde(rename = "n")]
    node_id: usize
  },
  #[serde(rename = "A")]
  Attributes {
    #[serde(rename = "n")]
    node_id: usize
  },
  #[serde(rename = "R")]
  PutResults {
    #[serde(rename = "r")]
    results: Vec<TransformResult>
  },
  #[serde(rename = "C")]
  PutCount {
    #[serde(rename = "c")]
    count: usize
  },
  #[serde(rename = "CC")]
  PutComplete,
  #[serde(rename = "E")]
  PutError {
    #[serde(rename = "m")]
    message: String
  },
  #[serde(rename = "H")]
  HeartBeat,
}

#[derive(Serialize, Debug)]
pub(crate) enum Response {
  #[serde(rename = "S")]
  Selection {
    #[serde(rename = "e")]
    elements: Vec<Element>
  },
  #[serde(rename = "T")]
  Text {
    #[serde(rename = "t")]
    text: String
  },
  #[serde(rename = "A")]
  Attributes {
    #[serde(rename = "a")]
    attributes: Vec<Attribute>
  },
}
