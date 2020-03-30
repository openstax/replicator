use roxmltree::{Attribute, Node};
use scandent::{
  AttributeRequirement, AttributeRequirementOperation, Axis, Namespace, ScandentResult, Selector,
  Step,
};
use std::borrow::Cow;
use std::collections::BTreeSet;
use std::iter;

pub(crate) struct ActionableSelector {
  pub original: Selector,
  steps: Vec<ActionableStep>,
}
impl ActionableSelector {
  fn from_selector(selector: Selector) -> ActionableSelector {
    ActionableSelector {
      original: selector.clone(),
      steps: selector
        .steps
        .into_iter()
        .map(ActionableStep::from_step)
        .collect(),
    }
  }
  pub(crate) fn from_string<'a, T: Into<Cow<'a, str>>>(
    source: T,
  ) -> ScandentResult<ActionableSelector> {
    let selector = Selector::from_string(source)?;
    Ok(ActionableSelector::from_selector(selector))
  }

  pub(crate) fn _inverse(&self) -> ActionableSelector {
    ActionableSelector::from_selector(self.original.inverse())
  }
}

struct ActionableStep {
  axis: Axis,
  condition: Box<dyn Fn(Node) -> bool + Sync + Send>,
}

impl ActionableStep {
  fn from_step(step: Step) -> ActionableStep {
    let mut conditions: Vec<Box<dyn Fn(Node) -> bool + Sync + Send>> = vec![];

    let name_requirement = step.name;
    if let Some(localname) = name_requirement.localname {
      conditions.push(Box::from(move |node: Node| {
        node.tag_name().name() == localname
      }));
    }
    if let Some(namespace) = name_requirement.namespace {
      match namespace {
        Namespace::Prefix(value) => {
          conditions.push(Box::from(move |node: Node| {
            node
              .tag_name()
              .namespace()
              .and_then(|uri| node.lookup_prefix(uri))
              .map(|prefix| prefix == value)
              .unwrap_or(false)
          }));
        }
        Namespace::Uri(value) => {
          conditions.push(Box::from(move |node: Node| {
            node
              .tag_name()
              .namespace()
              .map(|uri| uri == value)
              .unwrap_or(false)
          }));
        }
      };
    }

    let attr_requirements = step.attributes;
    for attr_req in attr_requirements {
      let AttributeRequirement {
        name: attr_name_req,
        op: attr_op,
      } = attr_req;
      let localname_filter: Box<dyn Fn(&str) -> bool + Sync + Send> = match attr_name_req.localname
      {
        Some(localname) => Box::from(move |name: &str| name == localname),
        None => Box::from(|_: &str| true),
      };
      let namespace_filter: Box<dyn Fn(Option<&'_ str>, Option<&'_ str>) -> bool + Sync + Send> =
        match attr_name_req.namespace {
          Some(namespace) => match namespace {
            Namespace::Prefix(value) => {
              Box::from(move |_: Option<&str>, prefix_opt: Option<&str>| {
                prefix_opt.map(|prefix| prefix == value).unwrap_or(false)
              })
            }
            Namespace::Uri(value) => Box::from(move |uri_opt: Option<&str>, _: Option<&str>| {
              uri_opt.map(|uri| uri == value).unwrap_or(false)
            }),
          },
          None => Box::from(move |_: Option<&str>, _: Option<&str>| true),
        };
      let op_condition_function: Box<dyn Fn(&Attribute) -> bool + Sync + Send> = match attr_op {
        AttributeRequirementOperation::Exists => Box::from(|_: &Attribute| true),
        AttributeRequirementOperation::Equals(value) => {
          Box::from(move |attr: &Attribute| attr.value() == value)
        }
        AttributeRequirementOperation::Contains(value) => Box::from(move |attr: &Attribute| {
          attr.value().split_whitespace().any(|entry| entry == value)
        }),
      };
      conditions.push(Box::from(move |node: Node| {
        node.attributes().iter().any(|attr| {
          if !localname_filter(attr.name()) {
            return false;
          }
          let uri_opt = attr.namespace();
          let prefix_opt = uri_opt.and_then(|uri| node.lookup_prefix(uri));
          if !namespace_filter(uri_opt, prefix_opt) {
            return false;
          }
          op_condition_function(attr)
        })
      }));
    }

    let path_requirements = step.paths;
    for path_req in path_requirements {
      let actionable = ActionableSelector::from_selector(path_req);
      conditions.push(Box::from(move |node: Node| {
        !resolve_selector(node, &actionable).is_empty()
      }));
    }

    let check_functions_requirements = step.checks;
    for _check_function_req in check_functions_requirements {
      conditions.push(Box::from(move |_node: Node| {
        true // Unimplemented
      }));
    }

    ActionableStep {
      axis: step.axis,
      condition: Box::from(move |node: Node| conditions.iter().all(|condition| condition(node))),
    }
  }
}

// TODO: needs to return iterator
pub(crate) fn resolve_selector<'a, 'b: 'a>(
  start: Node<'a, 'b>,
  selector: &ActionableSelector,
) -> BTreeSet<Node<'a, 'b>> {
  let mut set: BTreeSet<Node> = BTreeSet::new();
  set.insert(start);
  selector.steps.iter().fold(set, step_result)
}

// TODO: needs to return iterator
fn step_result<'a, 'b: 'a>(
  start: BTreeSet<Node<'a, 'b>>,
  step: &ActionableStep,
) -> BTreeSet<Node<'a, 'b>> {
  let mut next_set: BTreeSet<Node> = BTreeSet::new();
  start.into_iter().for_each(|node| {
    let axis_iter: Box<dyn Iterator<Item = Node>> = match step.axis {
      Axis::Ancestor => Box::from(node.ancestors()),
      Axis::Parent => Box::from(node.parent().into_iter()),
      Axis::Descendant => Box::from(node.descendants()),
      Axis::Child => Box::from(node.children()),
      Axis::Next => Box::from(node.next_sibling().into_iter()),
      Axis::Previous => Box::from(node.prev_sibling().into_iter()),
      Axis::FollowingSibling => Box::from(node.next_siblings()),
      Axis::PrecedingSibling => Box::from(node.prev_siblings()),
      Axis::Current => Box::from(iter::once(node)),
    };
    axis_iter
      .filter(|node| (step.condition)(*node))
      .for_each(|node| {
        next_set.insert(node);
      });
  });
  next_set
}
