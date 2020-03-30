use std::error;
use std::fmt;
use std::io;
use std::result::Result;

pub type OvenResult<T> = Result<T, OvenError>;

#[derive(Debug)]
pub enum OvenError {
  DocumentReadError(io::Error),
  DocumentParseError(roxmltree::Error),
}

impl From<io::Error> for OvenError {
  fn from(err: io::Error) -> OvenError {
    OvenError::DocumentReadError(err)
  }
}

impl From<roxmltree::Error> for OvenError {
  fn from(err: roxmltree::Error) -> OvenError {
    OvenError::DocumentParseError(err)
  }
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

pub type RequestResult<T> = Result<T, RequestError>;

#[derive(Debug)]
pub enum RequestError {
  ScandentParseError(scandent::ScandentError),
  ChildTerminated(String),
  JsonParseError(serde_json::Error),
  Misc(io::Error),
}

impl From<scandent::ScandentError> for RequestError {
  fn from(err: scandent::ScandentError) -> RequestError {
    RequestError::ScandentParseError(err)
  }
}

impl From<serde_json::Error> for RequestError {
  fn from(err: serde_json::Error) -> RequestError {
    RequestError::JsonParseError(err)
  }
}

impl From<io::Error> for RequestError {
  fn from(err: io::Error) -> RequestError {
    RequestError::Misc(err)
  }
}
