use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::BTreeMap;

pub(super) const CLIENT_REQUEST_DIRECTION: &str = "client_request_to_chat";
const FOLD_HISTORY_MERGE_OPERATOR: &str = "routecodex.v3.field.fold_history_merge";
const FOLD_HISTORY_MERGE_VERSION: &str = "1";
const FOLD_FINALIZE_OPERATOR: &str = "routecodex.v3.field.fold_finalize@1";
const FOLD_FINALIZE_POSITION: &str = "after_all_fold_input_paths";
const FOLD_EQUIVALENCE_POLICY: &str =
    "canonical_exact_or_declared_text_or_empty_assistant_tool_content";
const FOLD_CONFLICT_POLICY: &str = "preserve_distinct_in_source_order";

pub(super) fn normalize_protocol(protocol: &str) -> String {
    match protocol
        .trim()
        .to_ascii_lowercase()
        .replace('-', "_")
        .as_str()
    {
        "openai" | "openai_chat" | "openai_chat_completions" | "chat" => "openai_chat".to_string(),
        "openai_responses" => "responses".to_string(),
        "google" | "gemini" => "gemini".to_string(),
        value => value.to_string(),
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum FieldOperatorKind {
    LosslessPreserve,
    InstructionsToSystemMessage,
    TokenLimitRename,
    ResponsesIncludeTransform,
    ToolDeclarationTransform,
    ToolChoiceShapeBranch,
    ToolChoiceValueMap,
    RequestInputShapeBranch,
    ArrayContainerShape,
    RoleValueMap,
    ParallelToolCallsValueMap,
    PartTypeValueMap,
    MediaShapeBranch,
    ContentShapeBranch,
    OpaqueToolPayload,
}

pub(super) fn resolve_field_operator_kind(operator: &str) -> Option<FieldOperatorKind> {
    match operator {
        "routecodex.v3.field.lossless_preserve@1"
        | "routecodex.v3.field.identity_preserve@1"
        | "routecodex.v3.field.tool_identity_context@1"
        | "routecodex.v3.field.usage_value_map@1"
        | "routecodex.v3.field.value_domain_transform@1" => {
            Some(FieldOperatorKind::LosslessPreserve)
        }
        "routecodex.v3.field.instructions_to_system_message@1" => {
            Some(FieldOperatorKind::InstructionsToSystemMessage)
        }
        "routecodex.v3.field.token_limit_rename@1" => Some(FieldOperatorKind::TokenLimitRename),
        "routecodex.v3.field.responses_include_transform@1" => {
            Some(FieldOperatorKind::ResponsesIncludeTransform)
        }
        "routecodex.v3.field.tool_declaration_transform@1" => {
            Some(FieldOperatorKind::ToolDeclarationTransform)
        }
        "routecodex.v3.field.tool_choice_shape_branch@1" => {
            Some(FieldOperatorKind::ToolChoiceShapeBranch)
        }
        "routecodex.v3.field.tool_choice_value_map@1" => {
            Some(FieldOperatorKind::ToolChoiceValueMap)
        }
        "routecodex.v3.field.request_input_shape_branch@1" => {
            Some(FieldOperatorKind::RequestInputShapeBranch)
        }
        "routecodex.v3.field.array_container_shape@1" => {
            Some(FieldOperatorKind::ArrayContainerShape)
        }
        "routecodex.v3.field.role_value_map@1" => Some(FieldOperatorKind::RoleValueMap),
        "routecodex.v3.field.parallel_tool_calls_value_map@1" => {
            Some(FieldOperatorKind::ParallelToolCallsValueMap)
        }
        "routecodex.v3.field.part_type_value_map@1" => Some(FieldOperatorKind::PartTypeValueMap),
        "routecodex.v3.field.media_shape_branch@1" => Some(FieldOperatorKind::MediaShapeBranch),
        "routecodex.v3.field.content_shape_branch@1" => Some(FieldOperatorKind::ContentShapeBranch),
        "routecodex.v3.field.opaque_tool_payload@1" => Some(FieldOperatorKind::OpaqueToolPayload),
        _ => None,
    }
}

fn profile_path_to_lookup_path(path: &str) -> Option<String> {
    path.strip_prefix("request.")
        .filter(|path| !path.is_empty())
        .map(ToString::to_string)
}

pub(super) fn lookup_path(path: &str) -> String {
    path.strip_prefix("request.").unwrap_or(path).to_string()
}

pub(super) fn child_lookup_path(parent: &str, child: &str) -> String {
    if parent.is_empty() {
        child.to_string()
    } else {
        format!("{parent}.{child}")
    }
}

pub(super) fn array_item_lookup_path(parent: &str) -> String {
    format!("{parent}[]")
}

pub(super) fn string_value(value: &Value) -> Option<&str> {
    value.as_str()
}

pub(super) fn object_value(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

pub(super) fn canonical_key_for_row(row: &ProfileRow, default_key: &str) -> String {
    let Some(binding) = row.binding() else {
        return default_key.to_string();
    };
    let Some(destination) = binding.destination.as_deref() else {
        return default_key.to_string();
    };
    if let Some(destination) = destination.strip_prefix("request.") {
        return destination.to_string();
    }
    if let Some(destination) = destination.strip_prefix("chat.") {
        if destination == "system.instructions" || destination.starts_with("extension.") {
            return default_key.to_string();
        }
        return destination.to_string();
    }
    default_key.to_string()
}

pub(super) fn canonical_child_key_for_row(
    row: &ProfileRow,
    default_key: &str,
    parent: &str,
) -> String {
    row.binding()
        .and_then(|binding| binding.destination.as_deref())
        .and_then(|destination| destination.strip_prefix(&format!("{parent}.")))
        .map(str::to_string)
        .unwrap_or_else(|| canonical_key_for_row(row, default_key))
}

#[derive(Clone, Debug, Default, Deserialize)]
pub(super) struct Params {
    #[serde(default)]
    pub(super) shape: Option<String>,
    #[serde(default)]
    pub(super) semantics: Option<String>,
    #[serde(default)]
    pub(super) direction_bindings: Option<BTreeMap<String, DirectionBinding>>,
    #[serde(default)]
    pub(super) inverse_boolean: Option<String>,
    /// Configured hosted-history cases for a `request_input_shape_branch@1`
    /// row. Each case is an explicit typed recipe; models, providers and raw
    /// type guesses never select it.
    #[serde(default)]
    pub(super) hosted_history_cases: Option<Vec<HostedHistoryCase>>,
}

/// One admitted hosted-history recipe. Authoring enums are validated once when
/// the profile is compiled; the values below are the compiled typed recipe.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
pub(crate) struct HostedHistoryCase {
    pub(crate) discriminator_value: String,
    pub(crate) function_name: String,
    #[serde(default)]
    pub(crate) identity_paths: Vec<String>,
    pub(crate) generated_identity_prefix: String,
    #[serde(default)]
    pub(crate) argument_paths: Vec<String>,
    pub(crate) non_object_argument_encoding: String,
    pub(crate) absent_argument_encoding: String,
    pub(crate) canonical_encoding: String,
    pub(crate) canonical_extension_key: String,
    pub(crate) provider_chat_encoding: String,
    pub(crate) provider_anthropic_encoding: String,
    pub(crate) provider_gemini_encoding: String,
    pub(crate) native_call_block_type: String,
    pub(crate) native_result_block_type: String,
    pub(crate) native_result_encoding: String,
    #[serde(default)]
    pub(crate) native_result_excluded_fields: Vec<String>,
    pub(crate) inverse_encoding: String,
}

impl HostedHistoryCase {
    pub(crate) fn discriminator_value(&self) -> &str {
        &self.discriminator_value
    }

    pub(crate) fn function_name(&self) -> &str {
        &self.function_name
    }

    pub(crate) fn identity_paths(&self) -> &[String] {
        &self.identity_paths
    }

    pub(crate) fn generated_identity_prefix(&self) -> &str {
        &self.generated_identity_prefix
    }

    pub(crate) fn argument_paths(&self) -> &[String] {
        &self.argument_paths
    }

    pub(crate) fn canonical_extension_key(&self) -> &str {
        &self.canonical_extension_key
    }

    pub(crate) fn native_call_block_type(&self) -> &str {
        &self.native_call_block_type
    }

    pub(crate) fn native_result_block_type(&self) -> &str {
        &self.native_result_block_type
    }

    pub(crate) fn native_result_excluded_fields(&self) -> &[String] {
        &self.native_result_excluded_fields
    }

    /// Non-object call arguments are preserved under `value`.
    pub(crate) fn non_object_argument_encoding(&self) -> &str {
        &self.non_object_argument_encoding
    }

    /// Missing call arguments are preserved as an empty object.
    pub(crate) fn absent_argument_encoding(&self) -> &str {
        &self.absent_argument_encoding
    }

    pub(crate) fn canonical_encoding(&self) -> &str {
        &self.canonical_encoding
    }

    pub(crate) fn provider_chat_encoding(&self) -> &str {
        &self.provider_chat_encoding
    }

    pub(crate) fn provider_anthropic_encoding(&self) -> &str {
        &self.provider_anthropic_encoding
    }

    pub(crate) fn provider_gemini_encoding(&self) -> &str {
        &self.provider_gemini_encoding
    }

    pub(crate) fn native_result_encoding(&self) -> &str {
        &self.native_result_encoding
    }

    pub(crate) fn inverse_encoding(&self) -> &str {
        &self.inverse_encoding
    }
}

const NON_OBJECT_ARGUMENT_ENCODINGS: [&str; 1] = ["value_member"];
const ABSENT_ARGUMENT_ENCODINGS: [&str; 1] = ["empty_object"];
const CANONICAL_ENCODINGS: [&str; 1] = ["single_hosted_event_extension"];
const PROVIDER_CHAT_ENCODINGS: [&str; 1] = ["adjacent_call_and_complete_event_result"];
const PROVIDER_ANTHROPIC_ENCODINGS: [&str; 1] = ["assistant_native_hosted_blocks"];
const PROVIDER_GEMINI_ENCODINGS: [&str; 1] = ["adjacent_call_and_complete_event_result"];
const NATIVE_RESULT_ENCODINGS: [&str; 1] = ["current_event_outcome_members"];
const INVERSE_ENCODINGS: [&str; 1] = ["current_source_event_value"];

#[derive(Clone, Debug, Default, Deserialize)]
pub(super) struct DirectionBinding {
    #[serde(default)]
    pub(super) source: Option<String>,
    #[serde(default)]
    pub(super) destination: Option<String>,
    #[serde(default)]
    pub(super) operator: Option<String>,
    #[serde(default)]
    pub(super) shape: Option<String>,
    #[serde(default)]
    pub(super) transform_id: Option<String>,
    #[serde(default)]
    pub(super) collision_policy: Option<String>,
    #[serde(default)]
    pub(super) default_projection: Option<String>,
    #[serde(default)]
    pub(super) failure_class: Option<String>,
}

#[derive(Debug, Deserialize)]
struct FieldProfileManifest {
    business_unmatched_value: BusinessUnmatchedValue,
    #[serde(default)]
    path_consumers: Vec<RawPathConsumer>,
    #[serde(default)]
    extension_path_consumers: Vec<ExtensionPathConsumer>,
    #[serde(default)]
    fold_contract: FoldContract,
}

#[derive(Debug, Deserialize)]
struct BusinessUnmatchedValue {
    value_owner: String,
    provider_projection: OpaqueProviderProjection,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
enum OpaqueProviderProjection {
    RetainInRequestCanonicalOnly,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub(super) struct FoldContract {
    #[serde(default)]
    pub(super) registered_folds: Vec<FoldRegistration>,
}

#[derive(Clone, Debug, Deserialize)]
pub(super) struct FoldRegistration {
    pub(super) operator: String,
    pub(super) operator_version: String,
    #[serde(default)]
    pub(super) protocol: Option<String>,
    pub(super) direction: String,
    #[serde(default)]
    pub(super) input_paths: Vec<String>,
    #[serde(default)]
    pub(super) params: FoldParams,
    pub(super) finalize_operator: String,
    pub(super) finalize_position: String,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub(super) struct FoldParams {
    #[serde(default)]
    pub(super) destination: Option<String>,
    #[serde(default)]
    pub(super) source_order: Option<Vec<String>>,
    #[serde(default)]
    pub(super) equivalence_policy: Option<String>,
    #[serde(default)]
    pub(super) conflict_policy: Option<String>,
    #[serde(flatten)]
    pub(super) extra: BTreeMap<String, serde_yaml::Value>,
}

#[derive(Debug, Deserialize)]
struct RawPathConsumer {
    protocol: String,
    #[serde(default)]
    section: String,
    path: String,
    #[serde(default)]
    consumers: BTreeMap<String, String>,
    #[serde(default)]
    params: Params,
    #[serde(default)]
    parent_owned: bool,
    #[serde(default)]
    structure_only: bool,
    #[serde(default)]
    union_shape: bool,
    #[serde(default)]
    scalar_consumer: BTreeMap<String, String>,
    #[serde(default)]
    shape_children: Vec<String>,
}

#[derive(Debug, Deserialize)]
struct ExtensionPathConsumer {
    protocol: String,
    path: String,
    #[serde(default)]
    params: Params,
}

#[derive(Clone, Debug)]
pub(super) struct ProfileRow {
    pub(super) protocol: String,
    pub(super) section: String,
    pub(super) profile_path: String,
    pub(super) lookup_path: String,
    operator: Option<String>,
    scalar_operator: Option<String>,
    pub(super) params: Params,
    pub(super) parent_owned: bool,
    pub(super) structure_only: bool,
    pub(super) union_shape: bool,
    pub(super) shape_children: Vec<String>,
    pub(super) dispatch_kind: Option<FieldOperatorKind>,
}

impl ProfileRow {
    pub(super) fn inverse_boolean(&self) -> bool {
        matches!(
            self.params.inverse_boolean.as_deref(),
            Some("true" | "enum(true)")
        )
    }

    pub(super) fn binding(&self) -> Option<&DirectionBinding> {
        self.params
            .direction_bindings
            .as_ref()
            .and_then(|bindings| bindings.get(CLIENT_REQUEST_DIRECTION))
    }

    pub(super) fn consumed_operator(&self) -> Option<&str> {
        self.operator.as_deref().or(self.scalar_operator.as_deref())
    }

    /// The registered direction binding is authoritative for dispatch. Rows
    /// without a binding retain the manifest consumer/scalar consumer.
    pub(super) fn dispatch_operator(&self) -> Option<&str> {
        self.binding()
            .and_then(|binding| binding.operator.as_deref())
            .or_else(|| self.consumed_operator())
    }

    pub(super) fn transform_id(&self) -> Option<&str> {
        self.binding()
            .and_then(|binding| binding.transform_id.as_deref())
    }

    pub(super) fn collision_policy(&self) -> Option<&str> {
        self.binding()
            .and_then(|binding| binding.collision_policy.as_deref())
    }
}

#[derive(Debug)]
pub(super) struct ProfileIndex {
    rows: BTreeMap<(String, String), ProfileRow>,
    request_history_folds: BTreeMap<String, FoldRegistration>,
    request_only_carrier: String,
}

impl ProfileIndex {
    pub(super) fn parse(source: &str) -> Result<Self, String> {
        let manifest: FieldProfileManifest = serde_yaml::from_str(source)
            .map_err(|error| format!("invalid field-profile manifest: {error}"))?;
        let FieldProfileManifest {
            business_unmatched_value,
            path_consumers,
            extension_path_consumers,
            fold_contract,
        } = manifest;
        let mut rows = BTreeMap::new();

        for raw in path_consumers {
            let protocol = normalize_protocol(&raw.protocol);
            let Some(lookup_path) = profile_path_to_lookup_path(&raw.path) else {
                continue;
            };
            let operator = raw.consumers.get(CLIENT_REQUEST_DIRECTION).cloned();
            let scalar_operator = raw.scalar_consumer.get(CLIENT_REQUEST_DIRECTION).cloned();
            if operator.is_none() && scalar_operator.is_none() && !raw.structure_only {
                continue;
            }
            let row = ProfileRow {
                protocol: protocol.clone(),
                section: raw.section,
                profile_path: raw.path,
                lookup_path: lookup_path.clone(),
                operator,
                scalar_operator,
                params: raw.params,
                parent_owned: raw.parent_owned,
                structure_only: raw.structure_only,
                union_shape: raw.union_shape,
                shape_children: raw.shape_children,
                dispatch_kind: None,
            };
            let mut row = row;
            if let Some(operator) = row.dispatch_operator() {
                let kind = resolve_field_operator_kind(operator).ok_or_else(|| {
                    format!(
                        "profile row `{}` binds client_request operator `{operator}` which is not executable",
                        row.profile_path
                    )
                })?;
                row.dispatch_kind = Some(kind);
            }
            let key = (protocol, lookup_path);
            if rows.contains_key(&key) {
                return Err(format!(
                    "duplicate `{CLIENT_REQUEST_DIRECTION}` profile row for `{}`",
                    raw_path_for_error(&key.0, &key.1)
                ));
            }
            rows.insert(key, row);
        }

        for raw in extension_path_consumers {
            let protocol = normalize_protocol(&raw.protocol);
            if protocol != "openai_chat" {
                continue;
            }
            let Some(lookup_path) = profile_path_to_lookup_path(&raw.path) else {
                continue;
            };
            let key = (protocol.clone(), lookup_path.clone());
            if rows.contains_key(&key) {
                continue;
            }
            rows.insert(
                key,
                ProfileRow {
                    protocol,
                    section: "extended_superset".to_string(),
                    profile_path: raw.path,
                    lookup_path,
                    operator: Some("routecodex.v3.field.lossless_preserve@1".to_string()),
                    scalar_operator: None,
                    params: raw.params,
                    parent_owned: false,
                    structure_only: false,
                    union_shape: false,
                    shape_children: Vec::new(),
                    dispatch_kind: Some(FieldOperatorKind::LosslessPreserve),
                },
            );
        }

        validate_hosted_history_cases(&rows)?;

        let request_history_folds = validate_request_history_folds(&fold_contract, &rows)?;

        Ok(Self {
            rows,
            request_history_folds,
            request_only_carrier: match business_unmatched_value.provider_projection {
                OpaqueProviderProjection::RetainInRequestCanonicalOnly => {
                    business_unmatched_value.value_owner
                }
            },
        })
    }

    pub(super) fn request_only_carrier(&self) -> &str {
        &self.request_only_carrier
    }

    pub(super) fn has_protocol(&self, protocol: &str) -> bool {
        self.rows
            .keys()
            .any(|(row_protocol, _)| row_protocol == protocol)
    }

    pub(super) fn row(&self, protocol: &str, lookup_path: &str) -> Option<&ProfileRow> {
        self.rows
            .get(&(protocol.to_string(), lookup_path.to_string()))
    }

    pub(super) fn has_descendant(&self, protocol: &str, lookup_path: &str) -> bool {
        let prefix = format!("{lookup_path}.");
        let array_prefix = format!("{lookup_path}[]");
        self.rows.keys().any(|(row_protocol, row_path)| {
            row_protocol == protocol
                && (row_path.starts_with(&prefix) || row_path.starts_with(&array_prefix))
        })
    }

    pub(super) fn request_history_fold(&self, protocol: &str) -> Option<&FoldRegistration> {
        self.request_history_folds.get(protocol)
    }

    /// Every compiled hosted-history case with its owning protocol and the
    /// lookup path of the source container row that registered it.
    pub(super) fn hosted_history_cases(
        &self,
    ) -> impl Iterator<Item = (&str, &str, &HostedHistoryCase)> + '_ {
        self.rows.values().flat_map(|row| {
            row.params
                .hosted_history_cases
                .iter()
                .flatten()
                .map(move |case| (row.protocol.as_str(), row.lookup_path.as_str(), case))
        })
    }
}

fn raw_path_for_error(protocol: &str, lookup_path: &str) -> String {
    format!("{protocol}:request.{lookup_path}")
}

fn ensure_hosted_encoding(value: &str, allowed: &[&str], label: &str) -> Result<(), String> {
    if allowed.contains(&value) {
        Ok(())
    } else {
        Err(format!(
            "hosted_history_cases {label} `{value}` is not an admitted encoding"
        ))
    }
}

/// Compile-time admission for the configured hosted-history recipes. Authoring
/// enums, duplicate cases and source-member registration are rejected here;
/// business payloads are never validated by this gate.
fn validate_hosted_history_cases(
    rows: &BTreeMap<(String, String), ProfileRow>,
) -> Result<(), String> {
    let mut seen_discriminators: BTreeMap<(String, String), String> = BTreeMap::new();
    let mut seen_extension_keys: BTreeMap<String, String> = BTreeMap::new();

    for row in rows.values() {
        let Some(cases) = row.params.hosted_history_cases.as_ref() else {
            continue;
        };
        for case in cases {
            let label = format!(
                "`{}` case `{}`",
                raw_path_for_error(&row.protocol, &row.lookup_path),
                case.discriminator_value
            );
            if case.discriminator_value.trim().is_empty()
                || case.function_name.trim().is_empty()
                || case.generated_identity_prefix.trim().is_empty()
                || case.canonical_extension_key.trim().is_empty()
            {
                return Err(format!(
                    "hosted_history_cases {label} must declare non-empty discriminator_value, function_name, generated_identity_prefix and canonical_extension_key"
                ));
            }
            if case.identity_paths.is_empty() {
                return Err(format!(
                    "hosted_history_cases {label} must declare non-empty identity_paths"
                ));
            }
            if case.argument_paths.is_empty() {
                return Err(format!(
                    "hosted_history_cases {label} must declare non-empty argument_paths"
                ));
            }
            ensure_hosted_encoding(
                &case.non_object_argument_encoding,
                &NON_OBJECT_ARGUMENT_ENCODINGS,
                &format!("{label} non_object_argument_encoding"),
            )?;
            ensure_hosted_encoding(
                &case.absent_argument_encoding,
                &ABSENT_ARGUMENT_ENCODINGS,
                &format!("{label} absent_argument_encoding"),
            )?;
            ensure_hosted_encoding(
                &case.canonical_encoding,
                &CANONICAL_ENCODINGS,
                &format!("{label} canonical_encoding"),
            )?;
            ensure_hosted_encoding(
                &case.provider_chat_encoding,
                &PROVIDER_CHAT_ENCODINGS,
                &format!("{label} provider_chat_encoding"),
            )?;
            ensure_hosted_encoding(
                &case.provider_anthropic_encoding,
                &PROVIDER_ANTHROPIC_ENCODINGS,
                &format!("{label} provider_anthropic_encoding"),
            )?;
            ensure_hosted_encoding(
                &case.provider_gemini_encoding,
                &PROVIDER_GEMINI_ENCODINGS,
                &format!("{label} provider_gemini_encoding"),
            )?;
            ensure_hosted_encoding(
                &case.native_result_encoding,
                &NATIVE_RESULT_ENCODINGS,
                &format!("{label} native_result_encoding"),
            )?;
            ensure_hosted_encoding(
                &case.inverse_encoding,
                &INVERSE_ENCODINGS,
                &format!("{label} inverse_encoding"),
            )?;
            if case.native_call_block_type.trim().is_empty()
                || case.native_result_block_type.trim().is_empty()
            {
                return Err(format!(
                    "hosted_history_cases {label} must declare native_call_block_type and native_result_block_type"
                ));
            }

            let discriminator_key = (row.protocol.clone(), case.discriminator_value.clone());
            if seen_discriminators
                .insert(discriminator_key, label.clone())
                .is_some()
            {
                return Err(format!(
                    "hosted_history_cases duplicate discriminator case `{}` for protocol `{}`",
                    case.discriminator_value, row.protocol
                ));
            }
            if seen_extension_keys
                .insert(case.canonical_extension_key.clone(), label.clone())
                .is_some()
            {
                return Err(format!(
                    "hosted_history_cases duplicate canonical_extension_key `{}`",
                    case.canonical_extension_key
                ));
            }

            let item_lookup = array_item_lookup_path(&row.lookup_path);
            for member in case.identity_paths.iter().chain(case.argument_paths.iter()) {
                let child_lookup = child_lookup_path(&item_lookup, member);
                if !rows.contains_key(&(row.protocol.clone(), child_lookup.clone())) {
                    return Err(format!(
                        "hosted_history_cases {label} source member `{member}` is not a registered `{}` path",
                        raw_path_for_error(&row.protocol, &child_lookup)
                    ));
                }
            }
        }
    }

    Ok(())
}

fn validate_request_history_folds(
    contract: &FoldContract,
    rows: &BTreeMap<(String, String), ProfileRow>,
) -> Result<BTreeMap<String, FoldRegistration>, String> {
    let mut by_protocol = BTreeMap::new();
    let mut destinations = BTreeMap::new();

    for fold in &contract.registered_folds {
        match fold.direction.as_str() {
            CLIENT_REQUEST_DIRECTION => {}
            "chat_to_provider" | "provider_response_to_chat" | "chat_to_client_response" => {
                if fold.operator == FOLD_HISTORY_MERGE_OPERATOR {
                    return Err(format!(
                        "fold `{}@{}` direction must be `{CLIENT_REQUEST_DIRECTION}`",
                        fold.operator, fold.operator_version
                    ));
                }
                continue;
            }
            direction => {
                return Err(format!("unknown fold direction `{direction}`"));
            }
        }

        let label = format!("{}@{}", fold.operator, fold.operator_version);
        if fold.operator != FOLD_HISTORY_MERGE_OPERATOR
            || fold.operator_version != FOLD_HISTORY_MERGE_VERSION
        {
            return Err(format!(
                "client_request fold `{label}` must use `{FOLD_HISTORY_MERGE_OPERATOR}@{FOLD_HISTORY_MERGE_VERSION}`"
            ));
        }
        let protocol = fold
            .protocol
            .as_deref()
            .ok_or_else(|| format!("fold `{label}` must declare protocol"))?;
        let protocol = normalize_protocol(protocol);
        if !rows
            .keys()
            .any(|(row_protocol, _)| row_protocol == &protocol)
        {
            return Err(format!(
                "fold `{label}` declares unknown protocol `{protocol}`"
            ));
        }
        if fold.finalize_operator != FOLD_FINALIZE_OPERATOR {
            return Err(format!(
                "fold `{label}` finalize_operator must be `{FOLD_FINALIZE_OPERATOR}`"
            ));
        }
        if fold.finalize_position != FOLD_FINALIZE_POSITION {
            return Err(format!(
                "fold `{label}` finalize_position must be `{FOLD_FINALIZE_POSITION}`"
            ));
        }
        if let Some((param, _)) = fold.params.extra.iter().next() {
            return Err(format!("fold `{label}` has unexpected param `{param}`"));
        }
        let destination = fold
            .params
            .destination
            .as_deref()
            .ok_or_else(|| format!("fold `{label}` missing destination"))?;
        if destination != "chat.messages" {
            return Err(format!(
                "fold `{label}` destination must be `chat.messages`"
            ));
        }
        let equivalence_policy = fold
            .params
            .equivalence_policy
            .as_deref()
            .ok_or_else(|| format!("fold `{label}` missing equivalence_policy"))?;
        if equivalence_policy != FOLD_EQUIVALENCE_POLICY {
            return Err(format!(
                "fold `{label}` unknown equivalence_policy `{equivalence_policy}`"
            ));
        }
        let conflict_policy = fold
            .params
            .conflict_policy
            .as_deref()
            .ok_or_else(|| format!("fold `{label}` missing conflict_policy"))?;
        if conflict_policy != FOLD_CONFLICT_POLICY {
            return Err(format!(
                "fold `{label}` unknown conflict_policy `{conflict_policy}`"
            ));
        }

        if fold.input_paths.is_empty() {
            return Err(format!("fold `{label}` input_paths must not be empty"));
        }
        let mut input_paths = std::collections::BTreeSet::new();
        for path in &fold.input_paths {
            if !input_paths.insert(path.clone()) {
                return Err(format!(
                    "fold `{label}` input_paths contains duplicate entry `{path}`"
                ));
            }
        }
        let source_order = fold
            .params
            .source_order
            .as_ref()
            .ok_or_else(|| format!("fold `{label}` missing source_order"))?;
        if source_order.is_empty() {
            return Err(format!("fold `{label}` source_order must not be empty"));
        }
        let mut ordered_sources = std::collections::BTreeSet::new();
        for path in source_order {
            if !ordered_sources.insert(path.clone()) {
                return Err(format!(
                    "fold `{label}` source_order contains duplicate entry `{path}`"
                ));
            }
        }
        if ordered_sources != input_paths {
            return Err(format!(
                "fold `{label}` source_order must contain exactly the declared input_paths"
            ));
        }
        for path in source_order {
            let lookup_path = lookup_path(path);
            if !rows.contains_key(&(protocol.clone(), lookup_path.clone())) {
                return Err(format!(
                    "fold `{label}` input source `{path}` is not in protocol `{protocol}` inventory"
                ));
            }
        }

        let destination_key = format!("{protocol}:{destination}");
        if destinations
            .insert(destination_key.clone(), label.clone())
            .is_some()
        {
            return Err(format!(
                "fold `{label}` duplicate fold ownership or more than one finalizer for destination `{destination}`"
            ));
        }
        if by_protocol.insert(protocol.clone(), fold.clone()).is_some() {
            return Err(format!(
                "fold `{label}` duplicate request fold ownership for protocol `{protocol}`"
            ));
        }
    }

    Ok(by_protocol)
}
