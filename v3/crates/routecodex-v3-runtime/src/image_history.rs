use std::{
    borrow::Cow,
    collections::{BTreeSet, HashMap},
    sync::{Arc, Mutex},
};

use routecodex_v3_error::V3ProviderFailureSessionScope;
use routecodex_v3_route_classifier::is_v3_inline_image_reference;
use serde_json::Value;

use crate::execution_control::V3AttemptSuccessReceipt;
use crate::hub_v1::V3HubProviderWireProtocol;

#[derive(Clone, Default)]
struct ImageReferences {
    urls: BTreeSet<Arc<str>>,
    file_ids: BTreeSet<Arc<str>>,
}

enum ImageReference<'a> {
    Url(Cow<'a, str>),
    FileId(&'a str),
}

impl ImageReferences {
    fn contains(&self, reference: &ImageReference<'_>) -> bool {
        match reference {
            ImageReference::Url(url) => self.urls.contains(url.as_ref()),
            ImageReference::FileId(id) => self.file_ids.contains(*id),
        }
    }

    fn insert(&mut self, reference: ImageReference<'_>) {
        match reference {
            ImageReference::Url(url) => self.urls.insert(Arc::from(url.as_ref())),
            ImageReference::FileId(id) => self.file_ids.insert(Arc::from(id)),
        };
    }

    fn is_empty(&self) -> bool {
        self.urls.is_empty() && self.file_ids.is_empty()
    }

    fn extend(&mut self, other: Self) {
        self.urls.extend(other.urls);
        self.file_ids.extend(other.file_ids);
    }
}

/// One store per listener runtime. The server supplies the client session scope.
#[derive(Clone, Default)]
pub struct V3SuccessfulImageHistory {
    sessions: Arc<Mutex<HashMap<String, Arc<ImageReferences>>>>,
}

#[derive(Clone)]
pub struct V3ImageHistoryView {
    history: V3SuccessfulImageHistory,
    session: String,
    sent: Arc<ImageReferences>,
}

impl V3SuccessfulImageHistory {
    pub fn for_request(&self, scope: &V3ProviderFailureSessionScope) -> Option<V3ImageHistoryView> {
        if !scope.is_client_session() {
            return None;
        }
        let session = scope.session_id().to_owned();
        let sent = self
            .sessions
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get(&session)
            .cloned()
            .unwrap_or_default();
        Some(V3ImageHistoryView {
            history: self.clone(),
            session,
            sent,
        })
    }
}

impl V3ImageHistoryView {
    pub(crate) fn project_responses(&self, payload: &mut Value) {
        self.project_history(payload, "input", true);
    }

    pub(crate) fn project_canonical_chat(&self, payload: &mut Value) {
        self.project_history(payload, "messages", false);
    }

    fn project_history(&self, payload: &mut Value, field: &str, responses: bool) {
        if self.sent.is_empty() {
            return;
        }
        let Some(items) = payload.get_mut(field).and_then(Value::as_array_mut) else {
            return;
        };
        let Some(current) = history_end(items) else {
            return;
        };
        for item in &mut items[..current] {
            let text_type = if responses && item["role"] == "assistant" {
                "output_text"
            } else if responses {
                "input_text"
            } else {
                "text"
            };
            if is_responses_tool_output(item) {
                if let Some(output) = item.get_mut("output") {
                    self.project_carrier(output, text_type);
                }
            }
            if let Some(content) = item.get_mut("content") {
                self.project_carrier(content, text_type);
            }
        }
    }

    fn project_carrier(&self, carrier: &mut Value, text_type: &str) {
        for part in carrier.as_array_mut().into_iter().flatten() {
            if image_reference(part).is_some_and(|image| self.sent.contains(&image)) {
                crate::hub_v1::project_image_part(part, text_type);
            }
        }
    }

    pub(crate) fn capture_attempt(
        &self,
        payload: &Value,
        protocol: V3HubProviderWireProtocol,
    ) -> V3AttemptImageReferences {
        let (field, parts) = match protocol {
            V3HubProviderWireProtocol::Responses => ("input", "content"),
            V3HubProviderWireProtocol::OpenAiChat | V3HubProviderWireProtocol::Anthropic => {
                ("messages", "content")
            }
            V3HubProviderWireProtocol::Gemini => ("contents", "parts"),
        };
        let mut sent = ImageReferences::default();
        for item in payload[field].as_array().into_iter().flatten() {
            if is_responses_tool_output(item) {
                collect_carrier(&item["output"], &mut sent);
            }
            if item["role"] == "tool" {
                collect_carrier(&item[parts], &mut sent);
                continue;
            }
            for part in item[parts].as_array().into_iter().flatten() {
                if part["type"] == "tool_result" {
                    collect_carrier(&part["content"], &mut sent);
                } else if protocol == V3HubProviderWireProtocol::Gemini
                    && part["functionResponse"].is_object()
                {
                    let tool = &part["functionResponse"];
                    collect_carrier(&tool["parts"], &mut sent);
                    collect_carrier(&tool["response"]["output"], &mut sent);
                } else if let Some(image) = image_reference(part) {
                    sent.insert(image);
                }
            }
        }
        V3AttemptImageReferences(sent)
    }

    pub(crate) fn record_success(
        &self,
        _: &V3AttemptSuccessReceipt,
        V3AttemptImageReferences(images): V3AttemptImageReferences,
    ) {
        if images.is_empty() {
            return;
        }
        let mut sessions = self
            .history
            .sessions
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        Arc::make_mut(sessions.entry(self.session.clone()).or_default()).extend(images);
    }
}

/// Keep raw historical images in the default pool until an actual delivery
/// receipt makes them eligible for projection. This also covers a cold process.
pub(crate) fn has_unprojected_history_images(
    payload: &Value,
    history: Option<&V3ImageHistoryView>,
) -> bool {
    let (items, responses) = if let Some(items) = payload["input"].as_array() {
        (items, true)
    } else if let Some(items) = payload["messages"].as_array() {
        (items, false)
    } else {
        return false;
    };
    let Some(end) = history_end(items) else {
        return false;
    };
    items[..end].iter().any(|item| {
        let missing = |carrier: &Value| {
            carrier_contains_image(carrier, |image| {
                history.is_none_or(|history| !history.sent.contains(&image))
            })
        };
        (is_responses_tool_output(item) && missing(&item["output"]))
            || ((item["content"].is_array() || (!responses && item["role"] == "tool"))
                && missing(&item["content"]))
    })
}

fn history_end(items: &[Value]) -> Option<usize> {
    let mut current = items.iter().rposition(|item| item["role"] == "user")?;
    while current > 0 && items[current - 1]["role"] == "user" {
        current -= 1;
    }
    Some(current)
}

pub(crate) struct V3AttemptImageReferences(ImageReferences);

fn is_responses_tool_output(item: &Value) -> bool {
    matches!(
        item["type"].as_str(),
        Some("function_call_output" | "custom_tool_call_output")
    )
}

fn collect_carrier(carrier: &Value, images: &mut ImageReferences) {
    // Only a structured media carrier proves transmission. A string can be
    // inspected conservatively for route planning, but remains tool text here.
    for image in carrier
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(image_reference)
    {
        images.insert(image);
    }
}

fn carrier_contains_image(
    carrier: &Value,
    mut predicate: impl FnMut(ImageReference<'_>) -> bool,
) -> bool {
    let parsed;
    let parts = if let Some(text) = carrier.as_str() {
        if is_v3_inline_image_reference(text) {
            return predicate(ImageReference::Url(Cow::Borrowed(text.trim())));
        }
        parsed = serde_json::from_str::<Vec<Value>>(text).ok();
        parsed.as_ref()
    } else {
        carrier.as_array()
    };
    parts
        .into_iter()
        .flatten()
        .filter_map(image_reference)
        .any(predicate)
}

fn image_reference(part: &Value) -> Option<ImageReference<'_>> {
    for source in [
        &part["source"],
        &part["inlineData"],
        &part["inline_data"],
        &part["fileData"],
        &part["file_data"],
        part,
    ] {
        let media = source["media_type"]
            .as_str()
            .or_else(|| source["mimeType"].as_str())
            .or_else(|| source["mime_type"].as_str());
        if let Some(media) = media.filter(|media| media.starts_with("image/")) {
            if let Some(data) = source["data"].as_str() {
                return Some(ImageReference::Url(if data.starts_with("data:image/") {
                    Cow::Borrowed(data)
                } else {
                    Cow::Owned(format!("data:{media};base64,{data}"))
                }));
            }
            if let Some(url) = source["fileUri"]
                .as_str()
                .or_else(|| source["file_uri"].as_str())
            {
                return Some(ImageReference::Url(Cow::Borrowed(url)));
            }
        }
    }
    if !matches!(
        part["type"].as_str(),
        None | Some("input_image" | "output_image" | "image_url" | "image")
    ) {
        return None;
    }
    part["image_url"]
        .as_str()
        .or_else(|| part["image_url"]["url"].as_str())
        .or_else(|| part["source"]["url"].as_str())
        .or_else(|| part["file_url"].as_str())
        .or_else(|| part["url"].as_str().filter(|_| part["type"].is_string()))
        .or_else(|| {
            part["data"]
                .as_str()
                .filter(|data| data.starts_with("data:image/"))
        })
        .filter(|value| !value.is_empty())
        .map(|url| ImageReference::Url(Cow::Borrowed(url)))
        .or_else(|| {
            matches!(
                part["type"].as_str(),
                Some("input_image" | "output_image" | "image_url")
            )
            .then(|| {
                part["file_id"]
                    .as_str()
                    .or_else(|| part["image_url"]["file_id"].as_str())
            })
            .flatten()
            .filter(|id| !id.is_empty())
            .map(ImageReference::FileId)
        })
}
