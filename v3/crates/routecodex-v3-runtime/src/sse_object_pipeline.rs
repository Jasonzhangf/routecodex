//! Runtime-owned SSE object boundary.
//!
//! `routecodex-v3-sse` owns bytes, fields, frame boundaries, limits, and
//! transport errors only. This module is the adjacent runtime boundary where
//! provider `data` text becomes an object and where typed protocol consumers
//! may notify or rewrite business content.

use routecodex_v3_sse::{
    build_sse_transport_in_02_from_fields, build_sse_transport_in_03_from_sse_transport_in_02,
    build_sse_transport_out_04_from_sse_transport_in_03, SseField,
    SseTransportIn03ValidatedFrameStream, SseTransportOut04EncodedChunk,
};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct SseObjectFrame {
    event_name: Option<String>,
    data_value: Option<Value>,
    data_present: bool,
    done: bool,
    json_valid: bool,
    raw_utf8_valid: bool,
}

impl SseObjectFrame {
    pub(crate) fn from_json(data_json: impl Into<String>) -> Result<Self, SseObjectError> {
        let data_json = data_json.into();
        let data_value = serde_json::from_str::<Value>(&data_json).map_err(|error| {
            SseObjectError::InvalidJson {
                message: error.to_string(),
            }
        })?;
        Ok(Self {
            event_name: None,
            data_value: Some(data_value),
            data_present: true,
            done: false,
            json_valid: true,
            raw_utf8_valid: true,
        })
    }

    pub(crate) fn from_event_json(
        event_name: Option<String>,
        data_json: impl Into<String>,
    ) -> Result<Self, SseObjectError> {
        let mut object = Self::from_json(data_json)?;
        object.event_name = event_name;
        Ok(object)
    }

    pub(crate) fn from_frame(frame: &SseTransportIn03ValidatedFrameStream) -> Self {
        let mut event_name = None;
        let mut data_lines = Vec::new();
        for field in frame.frame().fields() {
            if let SseField::Named { name, value } = field {
                match name.as_str() {
                    "event" => event_name = Some(value.clone()),
                    "data" => data_lines.push(value.clone()),
                    _ => {}
                }
            }
        }
        let data_text = (!data_lines.is_empty()).then(|| data_lines.join("\n"));
        let done = data_text
            .as_deref()
            .is_some_and(|data| data.trim() == "[DONE]");
        let data_value = data_text
            .as_deref()
            .and_then(|data| serde_json::from_str::<Value>(data).ok());
        let json_valid = done || data_value.is_some() || data_text.is_none();
        Self {
            event_name,
            data_value,
            data_present: data_text.is_some(),
            done,
            json_valid,
            raw_utf8_valid: frame.frame().raw_utf8_valid(),
        }
    }

    pub(crate) fn event_name(&self) -> Option<&str> {
        self.event_name.as_deref()
    }

    pub(crate) fn normalized_data_json(&self) -> Option<String> {
        self.data_value
            .as_ref()
            .and_then(|value| serde_json::to_string(value).ok())
    }

    pub(crate) fn data_value(&self) -> Option<&Value> {
        self.data_value.as_ref()
    }

    pub(crate) fn has_data(&self) -> bool {
        self.data_present
    }

    pub(crate) fn is_done(&self) -> bool {
        self.done
    }

    pub(crate) fn is_json_valid(&self) -> bool {
        self.json_valid
    }

    pub(crate) fn raw_utf8_valid(&self) -> bool {
        self.raw_utf8_valid
    }

    pub(crate) fn replace_data_value(&mut self, data_value: Value) {
        self.data_value = Some(data_value);
        self.data_present = true;
        self.done = false;
        self.json_valid = true;
    }

    pub(crate) fn encode_sse(&self) -> Result<Vec<u8>, SseObjectError> {
        let mut fields = Vec::new();
        if let Some(event_name) = &self.event_name {
            fields.push(SseField::Named {
                name: "event".to_owned(),
                value: event_name.clone(),
            });
        }
        if let Some(data_json) = self.normalized_data_json() {
            fields.push(SseField::Named {
                name: "data".to_owned(),
                value: data_json,
            });
        }
        let decoded = build_sse_transport_in_02_from_fields(fields)
            .and_then(build_sse_transport_in_03_from_sse_transport_in_02)
            .map_err(|error| SseObjectError::Consumer {
                message: error.to_string(),
            })?;
        Ok(build_sse_transport_out_04_from_sse_transport_in_03(&decoded).into_bytes())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub(crate) enum SseObjectError {
    #[error("SSE object data is not valid JSON: {message}")]
    InvalidJson { message: String },
    #[error("SSE object consumer failed: {message}")]
    Consumer { message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SseObjectConsumerAction {
    Pass,
    RewriteData,
}

pub(crate) trait SseObjectConsumer {
    fn consume(
        &mut self,
        object: &mut SseObjectFrame,
    ) -> Result<SseObjectConsumerAction, SseObjectError>;
}

pub(crate) fn process_sse_object_frame<C: SseObjectConsumer>(
    frame: &SseTransportIn03ValidatedFrameStream,
    consumer: &mut C,
) -> Result<SseTransportOut04EncodedChunk, SseObjectError> {
    let original_event_name = frame.frame().fields().iter().find_map(|field| match field {
        SseField::Named { name, value } if name == "event" => Some(value.as_str()),
        _ => None,
    });
    let mut object = SseObjectFrame::from_frame(frame);
    let action = consumer.consume(&mut object)?;
    if object.event_name() != original_event_name {
        return Err(SseObjectError::Consumer {
            message: "consumer changed the event name".to_owned(),
        });
    }
    if matches!(action, SseObjectConsumerAction::Pass) {
        return Ok(build_sse_transport_out_04_from_sse_transport_in_03(frame));
    }
    let mut fields = Vec::new();
    for field in frame.frame().fields() {
        match field {
            SseField::Named { name, .. } if name == "data" => {
                if let Some(data_json) = object.normalized_data_json() {
                    fields.push(SseField::Named {
                        name: "data".to_owned(),
                        value: data_json,
                    });
                }
            }
            other => fields.push(other.clone()),
        }
    }
    let rewritten = build_sse_transport_in_02_from_fields(fields)
        .and_then(build_sse_transport_in_03_from_sse_transport_in_02)
        .map_err(|error| SseObjectError::Consumer {
            message: error.to_string(),
        })?;
    Ok(build_sse_transport_out_04_from_sse_transport_in_03(&rewritten))
}

pub(crate) fn process_sse_object_json<C: SseObjectConsumer>(
    data_json: impl Into<String>,
    consumer: &mut C,
) -> Result<String, SseObjectError> {
    let mut object = SseObjectFrame::from_json(data_json)?;
    consumer.consume(&mut object)?;
    object
        .normalized_data_json()
        .ok_or_else(|| SseObjectError::Consumer {
            message: "JSON object has no data".to_owned(),
        })
}

pub(crate) fn project_sse_frame_json(
    frame: &SseTransportIn03ValidatedFrameStream,
) -> Result<Vec<u8>, SseObjectError> {
    let object = SseObjectFrame::from_frame(frame);
    object
        .normalized_data_json()
        .map(|data| data.into_bytes())
        .ok_or_else(|| SseObjectError::Consumer {
            message: "object has no JSON data".to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use routecodex_v3_sse::{
        build_v3_sse_transport_in_01_raw_chunk, SseIncrementalDecoder, SseTransportLimits,
    };

    struct RewriteGenericObject;

    impl SseObjectConsumer for RewriteGenericObject {
        fn consume(
            &mut self,
            object: &mut SseObjectFrame,
        ) -> Result<SseObjectConsumerAction, SseObjectError> {
            let mut value = object.data_value().cloned().unwrap_or(Value::Null);
            value["rewritten"] = Value::Bool(true);
            object.replace_data_value(value);
            Ok(SseObjectConsumerAction::RewriteData)
        }
    }

    fn generic_frame() -> SseTransportIn03ValidatedFrameStream {
        let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
        decoder
            .push(build_v3_sse_transport_in_01_raw_chunk(
                b"event: generic\ndata: {\"kind\":\"value\"}\n\n",
            ))
            .unwrap()
            .pop()
            .unwrap()
    }

    #[test]
    fn runtime_object_consumer_rewrites_data_without_changing_transport_event() {
        let output = process_sse_object_frame(&generic_frame(), &mut RewriteGenericObject).unwrap();
        let text = String::from_utf8(output.into_bytes()).unwrap();
        assert!(text.contains("event: generic"));
        assert!(text.contains("\"rewritten\":true"));
    }

    #[test]
    fn runtime_object_consumer_rejects_event_name_rewrite() {
        struct RewriteEvent;
        impl SseObjectConsumer for RewriteEvent {
            fn consume(
                &mut self,
                object: &mut SseObjectFrame,
            ) -> Result<SseObjectConsumerAction, SseObjectError> {
                object.event_name = Some("forbidden".to_owned());
                Ok(SseObjectConsumerAction::Pass)
            }
        }
        let error = process_sse_object_frame(&generic_frame(), &mut RewriteEvent).unwrap_err();
        assert!(error.to_string().contains("changed the event name"));
    }
}
