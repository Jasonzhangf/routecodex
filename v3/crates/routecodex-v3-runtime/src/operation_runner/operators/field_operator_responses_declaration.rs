//! REQ02 Responses `input[]` hosted-tool declaration governance.
//!
//! A Responses `input[]` item whose `type` is a hosted search declaration
//! (`web_search`) declares a hosted tool for the current turn; it is not chat
//! history and it is not a message. Canonical Chat carries hosted declarations
//! in `tools[]`, and that single canonical shape is what the Virtual Router
//! web_search capability, the Req04 Mode B local-search surface, and the
//! provider wire projection consume.
//!
//! Declared search options are preserved on the declaration. Every other member
//! of the item stays lossless in the inverse record.

use serde_json::{Map, Value};

use super::field_operator_library::RequestNormalizer;

/// Search options a Responses `input[]` hosted web_search declaration carries
/// into its canonical `tools[]` declaration.
const HOSTED_WEB_SEARCH_OPTION_KEYS: [&str; 4] = [
    "search_context_size",
    "user_location",
    "external_web_access",
    "search_content_types",
];

/// One canonical hosted declaration pending its final `chat.tools[]` index.
pub(super) struct HostedToolDeclaration {
    declaration: Value,
    object: Map<String, Value>,
    item_path: String,
    consumed: Vec<&'static str>,
}

impl<'a> RequestNormalizer<'a> {
    /// Capture a Responses `input[]` hosted web_search declaration.
    ///
    /// Canonical `tools[]` is assembled from the top-level `tools` field, so the
    /// captured declaration is flushed after every top-level field is processed.
    pub(super) fn absorb_responses_web_search_declaration(
        &mut self,
        object: &Map<String, Value>,
        item_path: &str,
    ) {
        let mut declaration = Map::new();
        declaration.insert("type".to_string(), Value::String("web_search".to_string()));
        let mut consumed = vec!["type"];
        for key in HOSTED_WEB_SEARCH_OPTION_KEYS {
            if let Some(value) = object.get(key) {
                consumed.push(key);
                declaration.insert(key.to_string(), value.clone());
            }
        }
        self.hosted_tool_declarations.push(HostedToolDeclaration {
            declaration: Value::Object(declaration),
            object: object.clone(),
            item_path: item_path.to_string(),
            consumed,
        });
    }

    /// Join the captured `input[]` hosted declarations to canonical `tools[]`
    /// once their index is final, using the registered declaration emitter.
    pub(super) fn flush_hosted_tool_declarations(&mut self) {
        if self.hosted_tool_declarations.is_empty() {
            return;
        }
        let mut declarations = std::mem::take(&mut self.hosted_tool_declarations);
        let mut tools = match self.canonical.remove("tools") {
            Some(Value::Array(tools)) => tools,
            // A malformed non-array `tools` field keeps its lossless raw value;
            // the source item stays in the inverse opaque record.
            Some(other) => {
                self.canonical.insert("tools".to_string(), other);
                return;
            }
            None => Vec::new(),
        };
        for declaration in declarations.drain(..) {
            self.record_part_siblings(
                &declaration.object,
                &declaration.item_path,
                &declaration.consumed,
            );
            self.process_openai_like_tool(
                &declaration.declaration,
                &declaration.item_path,
                &mut tools,
            );
        }
        self.canonical.insert("tools".to_string(), Value::Array(tools));
    }
}
