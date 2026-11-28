use crate::{V3Config05ManifestPublished, V3ConfigError};
use serde_yaml::Value;
use std::collections::BTreeSet;
use std::sync::OnceLock;

const FIELD_PROFILES: &str = include_str!(
    "../../../../docs/architecture/manifests/v3.operation_runner.field_profiles.v1.yml"
);
static COMPILED: OnceLock<V3OperationRunnerManifestBundle> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3OperationRunnerManifestBundle {
    pub schema_version: u64,
    pub contract_id: String,
    pub path_consumers: Vec<V3OperationRunnerPathConsumer>,
    pub extension_path_consumers: Vec<V3OperationRunnerPathConsumer>,
    pub opaque_tool_payload_paths: Vec<V3OperationRunnerPath>,
    pub registered_operators: BTreeSet<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub struct V3OperationRunnerPath {
    pub protocol: String,
    pub direction: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct V3OperationRunnerPathConsumer {
    pub protocol: String,
    pub direction: String,
    pub path: String,
    pub operator: String,
}

fn validation(message: impl Into<String>) -> V3ConfigError {
    V3ConfigError::Validation(format!("operation-runner manifest: {}", message.into()))
}

fn mapping(value: &Value, key: &str) -> Result<Value, V3ConfigError> {
    value
        .as_mapping()
        .and_then(|map| map.get(Value::String(key.to_owned())))
        .cloned()
        .ok_or_else(|| validation(format!("missing mapping `{key}`")))
}

fn string(value: &Value, field: &str) -> Result<String, V3ConfigError> {
    value
        .as_str()
        .map(str::to_owned)
        .ok_or_else(|| validation(format!("`{field}` must be a string")))
}

fn entries(value: &Value, field: &str) -> Result<Vec<Value>, V3ConfigError> {
    value
        .as_sequence()
        .cloned()
        .ok_or_else(|| validation(format!("`{field}` must be a sequence")))
}

fn consumers(
    root: &Value,
    field: &str,
    registered: &BTreeSet<String>,
) -> Result<Vec<V3OperationRunnerPathConsumer>, V3ConfigError> {
    let rows = entries(&mapping(root, field)?, field)?;
    let mut seen = BTreeSet::new();
    let mut result = Vec::new();
    for row in rows {
        let protocol = string(&mapping(&row, "protocol")?, "protocol")?;
        let path = string(&mapping(&row, "path")?, "path")?;
        let parent_owned = row
            .as_mapping()
            .and_then(|map| map.get(Value::String("parent_owned".into())))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let row_consumers = row
            .as_mapping()
            .and_then(|map| map.get(Value::String("consumers".into())))
            .and_then(Value::as_mapping);
        if parent_owned && row_consumers.is_some_and(|c| !c.is_empty()) {
            return Err(validation(format!(
                "parent_owned row `{protocol}:{path}` declares consumers"
            )));
        }
        // Shape branches and discriminator cases are part of their parent row,
        // rather than additional ownership of the same raw leaf path.
        if let Some(scalar) = row.get("scalar_consumer") {
            let scalar = scalar
                .as_mapping()
                .ok_or_else(|| validation("scalar_consumer must be a mapping"))?;
            for operator in scalar.values() {
                require_registered(operator, registered)?;
            }
        }
        if let Some(discriminator) = row.get("typed_discriminator_cases") {
            for case in entries(&mapping(discriminator, "cases")?, "cases")? {
                require_registered(&mapping(&case, "operator")?, registered)?;
            }
        }
        let Some(row_consumers) = row_consumers else {
            continue;
        };
        for (direction, operator) in row_consumers {
            let direction = direction
                .as_str()
                .ok_or_else(|| validation("consumer direction must be a string"))?;
            let operator = require_registered(operator, registered)?;
            if !seen.insert((protocol.clone(), direction.to_owned(), path.clone())) {
                return Err(validation(format!(
                    "duplicate consumer for `{protocol}:{direction}:{path}`"
                )));
            }
            result.push(V3OperationRunnerPathConsumer {
                protocol: protocol.clone(),
                direction: direction.to_owned(),
                path: path.clone(),
                operator,
            });
        }
    }
    Ok(result)
}

fn require_registered(
    value: &Value,
    registered: &BTreeSet<String>,
) -> Result<String, V3ConfigError> {
    let operator = string(value, "consumer operator")?;
    if !registered.contains(&operator) {
        return Err(validation(format!(
            "unregistered operator@version `{operator}`"
        )));
    }
    Ok(operator)
}

pub fn compile_operation_runner_manifest_from_yaml(
    yaml: &str,
) -> Result<V3OperationRunnerManifestBundle, V3ConfigError> {
    let root: Value = serde_yaml::from_str(yaml)
        .map_err(|error| validation(format!("YAML parse failed: {error}")))?;
    let schema_version = mapping(&root, "schema_version")?
        .as_u64()
        .ok_or_else(|| validation("`schema_version` must be an integer"))?;
    if schema_version != 1 {
        return Err(validation(format!(
            "unsupported schema_version {schema_version}"
        )));
    }
    let contract_id = string(&mapping(&root, "contract_id")?, "contract_id")?;
    if contract_id != "v3.operation_runner.field_profiles" {
        return Err(validation(format!(
            "unexpected contract_id `{contract_id}`"
        )));
    }

    let library = mapping(&root, "field_operator_library")?;
    let registry = mapping(&root, "operator_registry")?;
    let registry_nodes = entries(
        &mapping(&registry, "field_operators")?,
        "operator_registry.field_operators",
    )?;
    if string(&mapping(&library, "registered_at")?, "registered_at")?
        != "operator_registry.field_operators"
    {
        return Err(validation(
            "field_operator_library must reference operator_registry.field_operators",
        ));
    }
    let mut registered_operators = BTreeSet::new();
    for node in registry_nodes {
        let name = string(&mapping(&node, "operator")?, "operator")?;
        let version = string(&mapping(&node, "operator_version")?, "operator_version")?;
        let id = format!("{name}@{version}");
        registered_operators.insert(id);
    }
    // Field operators are listed in the registry's dedicated field_operators table;
    // operator identities there are authoritative even when library roles use bare names.
    let path_consumers = consumers(&root, "path_consumers", &registered_operators)?;
    let extension_path_consumers =
        consumers(&root, "extension_path_consumers", &registered_operators)?;

    let all_paths: BTreeSet<_> = path_consumers
        .iter()
        .chain(&extension_path_consumers)
        .map(|consumer| {
            (
                consumer.protocol.clone(),
                consumer.direction.clone(),
                consumer.path.clone(),
            )
        })
        .collect();
    let consumer_count = path_consumers.len() + extension_path_consumers.len();
    if all_paths.len() != consumer_count {
        return Err(validation("duplicate consumer across path inventories"));
    }
    let opaque = entries(
        &mapping(
            &mapping(&root, "field_walker")?,
            "opaque_tool_payload_paths",
        )?,
        "opaque_tool_payload_paths",
    )?;
    let mut opaque_tool_payload_paths = Vec::new();
    let mut opaque_seen = BTreeSet::new();
    for row in opaque {
        let path = V3OperationRunnerPath {
            protocol: string(&mapping(&row, "protocol")?, "protocol")?,
            direction: string(&mapping(&row, "section")?, "section")?,
            path: string(&mapping(&row, "path")?, "path")?,
        };
        if !opaque_seen.insert(path.clone()) {
            return Err(validation(format!(
                "duplicate opaque tool payload path `{}`",
                path.path
            )));
        }
        opaque_tool_payload_paths.push(path);
    }
    Ok(V3OperationRunnerManifestBundle {
        schema_version,
        contract_id,
        path_consumers,
        extension_path_consumers,
        opaque_tool_payload_paths,
        registered_operators,
    })
}

pub(crate) fn validate_and_compile_embedded_operation_runner_manifest() -> Result<(), V3ConfigError>
{
    if COMPILED.get().is_some() {
        return Ok(());
    }
    let bundle = compile_operation_runner_manifest_from_yaml(FIELD_PROFILES)?;
    let _ = COMPILED.set(bundle);
    Ok(())
}

impl V3Config05ManifestPublished {
    pub fn operation_runner_manifest(
        &self,
    ) -> Result<&'static V3OperationRunnerManifestBundle, V3ConfigError> {
        validate_and_compile_embedded_operation_runner_manifest()?;
        COMPILED
            .get()
            .ok_or_else(|| validation("compiled bundle was not published"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{compile_v3_config_05_manifest, parse_v3_config_02_authoring};

    #[test]
    fn embedded_manifest_compiles_and_is_available_from_published_config() {
        let bundle = compile_operation_runner_manifest_from_yaml(FIELD_PROFILES).unwrap();
        assert_eq!(bundle.schema_version, 1);
        assert_eq!(bundle.contract_id, "v3.operation_runner.field_profiles");
        assert!(!bundle.path_consumers.is_empty());
        let raw = r#"version = 3
[servers.test]
bind = "127.0.0.1"
port = 19999
routing_group = "test"
[providers.test]
type = "openai_chat"
base_url = "https://example.invalid"
default_model = "model"
auth = { type = "api_key", entries = [{ alias = "key", env = "TEST_API_KEY" }] }
[providers.test.models.model]
capabilities = ["text", "tools"]
[route_groups.test.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "test", model = "model", key = "key", priority = 1 }]
"#;
        let config =
            compile_v3_config_05_manifest(parse_v3_config_02_authoring(raw).unwrap()).unwrap();
        assert_eq!(config.operation_runner_manifest().unwrap(), &bundle);
    }

    #[test]
    fn duplicate_consumer_is_rejected() {
        let mut root: Value = serde_yaml::from_str(FIELD_PROFILES).unwrap();
        let rows = root
            .get_mut("path_consumers")
            .unwrap()
            .as_sequence_mut()
            .unwrap();
        rows.push(rows[0].clone());
        assert!(
            matches!(compile_operation_runner_manifest_from_yaml(&serde_yaml::to_string(&root).unwrap()), Err(V3ConfigError::Validation(message)) if message.contains("duplicate consumer"))
        );
    }

    #[test]
    fn unregistered_consumer_is_rejected() {
        let yaml = FIELD_PROFILES.replacen(
            "client_request_to_chat: routecodex.v3.field.identity_preserve@1",
            "client_request_to_chat: missing.operator@9",
            1,
        );
        assert!(
            matches!(compile_operation_runner_manifest_from_yaml(&yaml), Err(V3ConfigError::Validation(message)) if message.contains("unregistered operator@version"))
        );
    }

    #[test]
    fn parent_owned_consumer_is_rejected() {
        let mut root: Value = serde_yaml::from_str(FIELD_PROFILES).unwrap();
        let rows = root
            .get_mut("path_consumers")
            .unwrap()
            .as_sequence_mut()
            .unwrap();
        let parent = rows
            .iter_mut()
            .find(|row| row.get("parent_owned").and_then(Value::as_bool) == Some(true))
            .unwrap();
        parent.as_mapping_mut().unwrap().insert(
            Value::String("consumers".into()),
            serde_yaml::from_str(
                "{client_request_to_chat: routecodex.v3.field.identity_preserve@1}",
            )
            .unwrap(),
        );
        assert!(
            matches!(compile_operation_runner_manifest_from_yaml(&serde_yaml::to_string(&root).unwrap()), Err(V3ConfigError::Validation(message)) if message.contains("parent_owned"))
        );
    }

    #[test]
    fn invalid_contract_identity_is_rejected() {
        for (from, to, expected) in [
            (
                "schema_version: 1",
                "schema_version: 2",
                "unsupported schema_version",
            ),
            (
                "contract_id: v3.operation_runner.field_profiles",
                "contract_id: other",
                "unexpected contract_id",
            ),
        ] {
            let yaml = FIELD_PROFILES.replacen(from, to, 1);
            assert!(matches!(compile_operation_runner_manifest_from_yaml(&yaml),
                Err(V3ConfigError::Validation(message)) if message.contains(expected)));
        }
    }

    #[test]
    fn duplicate_opaque_payload_path_is_rejected() {
        let mut root: Value = serde_yaml::from_str(FIELD_PROFILES).unwrap();
        let paths = root["field_walker"]["opaque_tool_payload_paths"]
            .as_sequence_mut()
            .unwrap();
        paths.push(paths[0].clone());
        assert!(
            matches!(compile_operation_runner_manifest_from_yaml(&serde_yaml::to_string(&root).unwrap()),
            Err(V3ConfigError::Validation(message)) if message.contains("duplicate opaque"))
        );
    }

    #[test]
    fn unregistered_discriminator_operator_is_rejected() {
        let mut root: Value = serde_yaml::from_str(FIELD_PROFILES).unwrap();
        let row = root["path_consumers"]
            .as_sequence_mut()
            .unwrap()
            .iter_mut()
            .find(|row| row.get("typed_discriminator_cases").is_some())
            .unwrap();
        row["typed_discriminator_cases"]["cases"][0]["operator"] =
            Value::String("missing.operator@9".into());
        assert!(
            matches!(compile_operation_runner_manifest_from_yaml(&serde_yaml::to_string(&root).unwrap()),
            Err(V3ConfigError::Validation(message)) if message.contains("unregistered operator@version"))
        );
    }
}
