use super::{FieldDirection, FieldOperatorRegistry};
use serde::Deserialize;
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProfileError(pub(crate) String);
impl fmt::Display for ProfileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for ProfileError {}

pub(crate) struct FieldProfile {
    pub(crate) protocol: String,
    pub(crate) direction: FieldDirection,
    pub(super) rules: Vec<Rule>,
    inventory: BTreeSet<String>,
    opaque_paths: BTreeSet<String>,
}

#[derive(Clone, Deserialize)]
pub(super) struct Rule {
    pub(super) path: String,
    #[serde(default)]
    pub(super) consumer: Option<String>,
    #[serde(default)]
    pub(super) scalar_consumer: Option<String>,
    #[serde(default)]
    pub(super) structure_only: bool,
    pub(super) shape: String,
    #[serde(default)]
    pub(super) typed_discriminator_cases: Option<Discriminator>,
}

#[derive(Clone, Deserialize)]
pub(super) struct Discriminator {
    discriminator_path: String,
    cases: Vec<Case>,
}
#[derive(Clone, Deserialize)]
pub(super) struct Case {
    type_value: Option<Value>,
    pub(super) semantic_id: String,
    pub(super) operator: String,
    #[serde(default)]
    predicates: Vec<Predicate>,
}
#[derive(Clone, Deserialize)]
struct Predicate {
    path: String,
    value: Option<Value>,
    state: Option<String>,
}

impl Rule {
    pub(super) fn matches_shape(&self, value: &Value) -> bool {
        let shape = self
            .shape
            .strip_prefix("enum(")
            .and_then(|s| s.strip_suffix(')'))
            .unwrap_or(&self.shape);
        shape.split(',').any(|shape| match shape.trim() {
            "object" => value.is_object(),
            "array" => value.is_array(),
            // Manifest array_item describes field location, not its value type.
            "array_item" if !self.structure_only => true,
            "array_item" => value.is_array(),
            "leaf" => !value.is_object() && !value.is_array(),
            "opaque_complete_value" | "inverse_projection" | "fold_merge" | "unrepresentable" => {
                true
            }
            _ => false,
        })
    }

    pub(super) fn branch<'a>(&'a self, root: &Value, pointer: &str) -> Option<&'a Case> {
        let discriminator = self.typed_discriminator_cases.as_ref()?;
        discriminator.cases.iter().find(|case| {
            if case.predicates.is_empty() {
                lookup(root, &discriminator.discriminator_path, &self.path, pointer)
                    == case.type_value.as_ref()
            } else {
                case.predicates.iter().all(|predicate| {
                    let actual = lookup(root, &predicate.path, &self.path, pointer);
                    match predicate.state.as_deref() {
                        Some("missing") => actual.is_none(),
                        Some("present") => actual.is_some(),
                        _ => actual.is_some() && actual == predicate.value.as_ref(),
                    }
                })
            }
        })
    }
}

fn lookup<'a>(root: &'a Value, path: &str, rule_path: &str, pointer: &str) -> Option<&'a Value> {
    let concrete: Vec<&str> = pointer.trim_start_matches('/').split('/').collect();
    let rule_parts = rule_path
        .split('.')
        .skip(1)
        .flat_map(|s| {
            s.strip_suffix("[]")
                .map_or_else(|| vec![s], |s| vec![s, "[]"])
        })
        .collect::<Vec<_>>();
    let indices: Vec<&str> = rule_parts
        .iter()
        .zip(&concrete)
        .filter_map(|(part, actual)| (*part == "[]").then_some(*actual))
        .collect();
    let mut index = 0;
    let mut value = root;
    for part in path.split('.').skip(1) {
        if let Some(member) = part.strip_suffix("[]") {
            value = value
                .get(member)?
                .get(indices.get(index)?.parse::<usize>().ok()?)?;
            index += 1;
        } else {
            value = value.get(part)?;
        }
    }
    Some(value)
}

impl FieldProfile {
    /// Source inventory is supplied separately; profile rows never authorize paths.
    pub(crate) fn from_yaml(
        source: &str,
        inventory: BTreeSet<String>,
        protocol: &str,
        direction: FieldDirection,
    ) -> Result<Self, ProfileError> {
        let manifest: Value =
            serde_yaml::from_str(source).map_err(|e| ProfileError(e.to_string()))?;
        let direction_key = serde_json::to_value(direction)
            .unwrap()
            .as_str()
            .unwrap()
            .to_owned();
        let mut rules = Vec::new();
        for row in ["path_consumers", "extension_path_consumers"]
            .into_iter()
            .flat_map(|key| manifest[key].as_array().into_iter().flatten())
        {
            if row["protocol"].as_str() != Some(protocol) {
                continue;
            }
            if row.get("alias_of").is_some() {
                if row.get("consumers").is_some() {
                    return Err(ProfileError("inventory alias declares consumers".into()));
                }
                continue;
            }
            let consumer = row["consumers"][&direction_key].as_str().map(str::to_owned);
            let scalar_consumer = row["scalar_consumer"][&direction_key]
                .as_str()
                .map(str::to_owned);
            let path = row["path"]
                .as_str()
                .ok_or_else(|| ProfileError("missing path".into()))?;
            if !path.starts_with(&format!("{}.", direction.root())) {
                continue;
            }
            if consumer.is_none()
                && scalar_consumer.is_none()
                && !row["structure_only"].as_bool().unwrap_or(false)
            {
                continue;
            }
            rules.push(Rule {
                path: path.into(),
                consumer,
                scalar_consumer,
                structure_only: row["structure_only"].as_bool().unwrap_or(false),
                shape: row["params"]["shape"]
                    .as_str()
                    .ok_or_else(|| ProfileError(format!("missing shape: {path}")))?
                    .into(),
                typed_discriminator_cases: row
                    .get("typed_discriminator_cases")
                    .map(|v| serde_json::from_value(v.clone()))
                    .transpose()
                    .map_err(|e| ProfileError(e.to_string()))?,
            });
        }
        let opaque_paths = manifest["field_walker"]["opaque_tool_payload_paths"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|row| row["protocol"].as_str() == Some(protocol))
            .filter_map(|row| row["path"].as_str().map(str::to_owned))
            .collect();
        Ok(Self {
            protocol: protocol.into(),
            direction,
            rules,
            inventory,
            opaque_paths,
        })
    }

    pub(super) fn validate(&self, registry: &FieldOperatorRegistry) -> Result<(), ProfileError> {
        let mut ownership = BTreeMap::new();
        for rule in &self.rules {
            let shapes = rule
                .shape
                .strip_prefix("enum(")
                .and_then(|shape| shape.strip_suffix(')'))
                .unwrap_or(&rule.shape);
            if shapes.split(',').any(|shape| {
                !matches!(
                    shape.trim(),
                    "object"
                        | "array"
                        | "array_item"
                        | "leaf"
                        | "opaque_complete_value"
                        | "inverse_projection"
                        | "fold_merge"
                        | "unrepresentable"
                )
            }) {
                return Err(ProfileError(format!("invalid shape: {}", rule.shape)));
            }
            if !self.inventory.contains(&rule.path) {
                return Err(ProfileError(format!(
                    "unauthorized inventory path: {}",
                    rule.path
                )));
            }
            if ownership.insert(&rule.path, ()).is_some() {
                return Err(ProfileError(format!(
                    "duplicate consumer ownership: {}",
                    rule.path
                )));
            }
            if rule.structure_only && rule.consumer.is_some() {
                return Err(ProfileError(format!(
                    "structural row has consumer: {}",
                    rule.path
                )));
            }
            for operator in rule.consumer.iter().chain(rule.scalar_consumer.iter()) {
                if registry.get(operator).is_none() {
                    return Err(ProfileError(format!(
                        "missing operator registration: {operator}"
                    )));
                }
                if operator == "routecodex.v3.field.opaque_tool_payload@1"
                    && !self.opaque_paths.contains(&rule.path)
                {
                    return Err(ProfileError(format!(
                        "opaque operator outside classified path: {}",
                        rule.path
                    )));
                }
                if self.opaque_paths.contains(&rule.path)
                    && operator != "routecodex.v3.field.opaque_tool_payload@1"
                {
                    return Err(ProfileError(format!(
                        "opaque payload has non-opaque consumer: {}",
                        rule.path
                    )));
                }
            }
            if let Some(discriminator) = &rule.typed_discriminator_cases {
                if !self.inventory.contains(&discriminator.discriminator_path) {
                    return Err(ProfileError("unauthorized discriminator path".into()));
                }
                for case in &discriminator.cases {
                    if registry.get(&case.operator).is_none() {
                        return Err(ProfileError(format!(
                            "missing operator registration: {}",
                            case.operator
                        )));
                    }
                    if self.opaque_paths.contains(&rule.path)
                        && case.operator != "routecodex.v3.field.opaque_tool_payload@1"
                    {
                        return Err(ProfileError("opaque branch has non-opaque consumer".into()));
                    }
                    if case.operator == "routecodex.v3.field.opaque_tool_payload@1"
                        && !self.opaque_paths.contains(&rule.path)
                    {
                        return Err(ProfileError("opaque branch outside classified path".into()));
                    }
                    for predicate in &case.predicates {
                        if !self.inventory.contains(&predicate.path) {
                            return Err(ProfileError("unauthorized predicate path".into()));
                        }
                        if !matches!(
                            predicate.state.as_deref(),
                            None | Some("present" | "missing")
                        ) {
                            return Err(ProfileError("invalid predicate state".into()));
                        }
                    }
                }
            }
        }
        for parent in &self.rules {
            if parent.structure_only {
                continue;
            }
            if self.rules.iter().any(|child| {
                child.path.starts_with(&format!("{}.", parent.path))
                    || child.path.starts_with(&format!("{}[]", parent.path))
            }) {
                return Err(ProfileError(format!(
                    "container and descendant both consume: {}",
                    parent.path
                )));
            }
        }
        Ok(())
    }
}
