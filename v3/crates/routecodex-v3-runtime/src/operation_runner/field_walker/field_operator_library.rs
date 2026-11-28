use super::profile::ProfileError;
use serde_json::Value;
use std::collections::BTreeMap;

/// A complete field value is the unit of consumption, including tool payloads.
/// None means no representable mapping: the walker preserves an opaque record.
pub(crate) trait FieldOperator: Send + Sync {
    fn identity(&self) -> &'static str;
    fn apply(&self, value: &Value) -> Option<Value>;
}

struct StaticOperator {
    identity: &'static str,
    preserve: bool,
}

impl FieldOperator for StaticOperator {
    fn identity(&self) -> &'static str {
        self.identity
    }
    fn apply(&self, value: &Value) -> Option<Value> {
        self.preserve.then(|| value.clone())
    }
}

pub(crate) struct FieldOperatorRegistry {
    operators: BTreeMap<&'static str, Box<dyn FieldOperator>>,
}

impl FieldOperatorRegistry {
    pub(crate) fn empty() -> Self {
        Self {
            operators: BTreeMap::new(),
        }
    }

    pub(crate) fn register(
        &mut self,
        operator: impl FieldOperator + 'static,
    ) -> Result<(), ProfileError> {
        let key = operator.identity();
        if self.operators.contains_key(key) {
            return Err(ProfileError(format!(
                "duplicate operator registration: {key}"
            )));
        }
        self.operators.insert(key, Box::new(operator));
        Ok(())
    }

    pub(crate) fn get(&self, key: &str) -> Option<&dyn FieldOperator> {
        self.operators.get(key).map(Box::as_ref)
    }
}

impl Default for FieldOperatorRegistry {
    fn default() -> Self {
        let mut registry = Self::empty();
        // Transform/table-dependent entries are registered, but cannot claim a
        // conversion without their typed resources. Their complete values take
        // the explicit opaque path until those resources are supplied at cutover.
        for (identity, preserve) in [
            ("routecodex.v3.field.lossless_preserve@1", true),
            ("routecodex.v3.field.standard_projection@1", true),
            ("routecodex.v3.field.provider_normalization@1", true),
            ("routecodex.v3.field.inverse_client_projection@1", true),
            ("routecodex.v3.field.identity_preserve@1", true),
            ("routecodex.v3.field.opaque_tool_payload@1", true),
            ("routecodex.v3.field.responses_include_transform@1", false),
            (
                "routecodex.v3.field.instructions_to_system_message@1",
                false,
            ),
            ("routecodex.v3.field.token_limit_rename@1", false),
            ("routecodex.v3.field.fold_role_developer_to_system@1", false),
            ("routecodex.v3.field.fold_role_system_to_developer@1", false),
            ("routecodex.v3.field.fold_finalize@1", false),
            ("routecodex.v3.field.role_value_map@1", false),
            ("routecodex.v3.field.part_type_value_map@1", false),
            ("routecodex.v3.field.tool_choice_value_map@1", false),
            ("routecodex.v3.field.parallel_tool_calls_value_map@1", false),
            ("routecodex.v3.field.tool_choice_shape_branch@1", false),
            ("routecodex.v3.field.finish_reason_value_map@1", false),
            ("routecodex.v3.field.usage_value_map@1", false),
            ("routecodex.v3.field.provider_event_value_map@1", false),
            ("routecodex.v3.field.field_bidi_value_map@1", false),
            ("routecodex.v3.field.request_field_whitelist@1", false),
            ("routecodex.v3.field.tool_identity_context@1", true),
            ("routecodex.v3.field.tool_declaration_transform@1", false),
            ("routecodex.v3.field.media_shape_branch@1", false),
            ("routecodex.v3.field.request_input_shape_branch@1", true),
            ("routecodex.v3.field.content_shape_branch@1", true),
            ("routecodex.v3.field.value_domain_transform@1", false),
            ("routecodex.v3.field.array_container_shape@1", true),
        ] {
            registry
                .register(StaticOperator { identity, preserve })
                .expect("unique static operator identities");
        }
        registry
    }
}
