// Shared JSONL envelope owner for the per-listener WebUI request-records store.
// Server writes lifecycle rows and Admin reads them through this module; the
// row is a typed serde_json::Value so each crate can decode its own typed row
// without owning a second file format. Reads fold lifecycle rows by
// request_key so each request is projected once at its latest lifecycle state.

use serde_json::Value;
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader, BufWriter, Write};
use std::path::Path;

pub const V3_WEBUI_OBSERVABILITY_SCHEMA_VERSION: u64 = 1;

#[derive(Debug, thiserror::Error)]
pub enum V3WebuiObservabilityStoreError {
    #[error("observability store record exceeds configured {limit} byte limit")]
    RecordTooLarge { limit: u64 },
    #[error("observability store io failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("observability store encode failed: {0}")]
    Encode(String),
    #[error("observability store decode failed: {0}")]
    Decode(String),
    #[error("observability store record {path}:{line} has unsupported schema {schema}")]
    UnsupportedSchema {
        path: String,
        line: u64,
        schema: u64,
    },
}

pub fn v3_webui_observability_append_row(
    path: &Path,
    row: &Value,
) -> Result<(), V3WebuiObservabilityStoreError> {
    let row_bytes = serde_json::to_vec(row)
        .map_err(|error| V3WebuiObservabilityStoreError::Encode(error.to_string()))?;
    let limit = crate::internal::v3_observability_max_record_bytes();
    if row_bytes.len() as u64 > limit {
        return Err(V3WebuiObservabilityStoreError::RecordTooLarge { limit });
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let envelope = serde_json::json!({
        "schema_version": V3_WEBUI_OBSERVABILITY_SCHEMA_VERSION,
        "row": row,
    });
    let line_bytes = serde_json::to_vec(&envelope)
        .map_err(|error| V3WebuiObservabilityStoreError::Encode(error.to_string()))?;
    let file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    let mut writer = BufWriter::new(file);
    writer
        .write_all(&line_bytes)
        .map_err(V3WebuiObservabilityStoreError::Io)?;
    writer
        .write_all(b"\n")
        .map_err(V3WebuiObservabilityStoreError::Io)?;
    writer.flush()?;
    Ok(())
}

pub fn v3_webui_observability_read_rows(
    path: &Path,
) -> Result<Vec<Value>, V3WebuiObservabilityStoreError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = fs::File::open(path)?;
    let mut latest_by_key = BTreeMap::<String, Value>::new();
    let mut order = Vec::<String>::new();
    for (line_number, line) in BufReader::new(file).lines().enumerate() {
        let row = decode_observability_row(path, line_number, line?)?;
        let key = row
            .get("request_key")
            .and_then(Value::as_str)
            .ok_or_else(|| {
                V3WebuiObservabilityStoreError::Decode(format!(
                    "observability record {}:{} has no request_key",
                    path.display(),
                    line_number + 1
                ))
            })?;
        if !latest_by_key.contains_key(key) {
            order.push(key.to_string());
        }
        latest_by_key.insert(key.to_string(), row);
    }
    Ok(order
        .into_iter()
        .filter_map(|key| latest_by_key.remove(&key))
        .collect())
}

/// Reads the store in file order without folding lifecycle rows by request_key.
/// Admin uses this raw view so every failed provider attempt remains visible
/// even when a later retry or completion succeeds.
pub fn v3_webui_observability_read_raw_rows(
    path: &Path,
) -> Result<Vec<Value>, V3WebuiObservabilityStoreError> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = fs::File::open(path)?;
    let mut rows = Vec::new();
    for (line_number, line) in BufReader::new(file).lines().enumerate() {
        let line = line?;
        if line.trim().is_empty() {
            continue;
        }
        rows.push(decode_observability_row(path, line_number, line)?);
    }
    Ok(rows)
}

fn decode_observability_row(
    path: &Path,
    line_number: usize,
    line: String,
) -> Result<Value, V3WebuiObservabilityStoreError> {
    if line.trim().is_empty() {
        return Err(V3WebuiObservabilityStoreError::Decode(format!(
            "observability record {}:{} is empty",
            path.display(),
            line_number + 1
        )));
    }
    let envelope: Value = serde_json::from_str(&line).map_err(|error| {
        V3WebuiObservabilityStoreError::Decode(format!(
            "invalid observability record {}:{}: {error}",
            path.display(),
            line_number + 1
        ))
    })?;
    let schema = envelope
        .get("schema_version")
        .and_then(Value::as_u64)
        .ok_or_else(|| {
            V3WebuiObservabilityStoreError::Decode(format!(
                "observability record {}:{} has no schema_version",
                path.display(),
                line_number + 1
            ))
        })?;
    if schema != V3_WEBUI_OBSERVABILITY_SCHEMA_VERSION {
        return Err(V3WebuiObservabilityStoreError::UnsupportedSchema {
            path: path.display().to_string(),
            line: line_number as u64 + 1,
            schema,
        });
    }
    envelope.get("row").cloned().ok_or_else(|| {
        V3WebuiObservabilityStoreError::Decode(format!(
            "observability record {}:{} has no row",
            path.display(),
            line_number + 1
        ))
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::internal::v3_observability_max_record_bytes;
    use serde_json::json;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("v3-obs-io-test-{label}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn append_then_read_roundtrip() {
        let dir = temp_dir("roundtrip");
        let path = dir.join("records.jsonl");
        let row1 = json!({"request_key": "4444:r1", "event_type": "request.started"});
        let row2 = json!({"request_key": "4444:r2", "event_type": "request.completed"});
        v3_webui_observability_append_row(&path, &row1).unwrap();
        v3_webui_observability_append_row(&path, &row2).unwrap();
        let rows = v3_webui_observability_read_rows(&path).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0].get("request_key").and_then(Value::as_str),
            Some("4444:r1")
        );
        assert_eq!(
            rows[1].get("request_key").and_then(Value::as_str),
            Some("4444:r2")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_missing_file_ok() {
        let path = std::path::Path::new("/nonexistent/this/file/does/not/exist.jsonl");
        assert!(v3_webui_observability_read_rows(path).unwrap().is_empty());
        assert!(
            v3_webui_observability_read_raw_rows(path)
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn unsupported_schema_rejected() {
        let dir = temp_dir("unsupported");
        let path = dir.join("records-bad.jsonl");
        std::fs::write(&path, "{\"schema_version\":99,\"row\":{}}\n").unwrap();
        let error = v3_webui_observability_read_rows(&path).unwrap_err();
        assert!(format!("{error}").contains("unsupported schema"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn missing_row_field_rejected() {
        let dir = temp_dir("missing-row");
        let path = dir.join("records-norow.jsonl");
        std::fs::write(&path, "{\"schema_version\":1}\n").unwrap();
        let error = v3_webui_observability_read_rows(&path).unwrap_err();
        assert!(format!("{error}").contains("no row"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_folds_lifecycle_rows_by_request_key() {
        let dir = temp_dir("fold");
        let path = dir.join("records-fold.jsonl");
        v3_webui_observability_append_row(
            &path,
            &json!({"request_key": "r1", "event_type": "request.started", "attempts": 0}),
        )
        .unwrap();
        v3_webui_observability_append_row(
            &path,
            &json!({"request_key": "r1", "event_type": "request.provider_attempt_failed", "attempts": 1}),
        )
        .unwrap();
        v3_webui_observability_append_row(
            &path,
            &json!({"request_key": "r1", "event_type": "request.completed", "attempts": 1, "result": "success"}),
        )
        .unwrap();
        v3_webui_observability_append_row(
            &path,
            &json!({"request_key": "r2", "event_type": "request.started", "attempts": 0}),
        )
        .unwrap();
        let rows = v3_webui_observability_read_rows(&path).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0].get("request_key").and_then(Value::as_str),
            Some("r1")
        );
        assert_eq!(
            rows[0].get("event_type").and_then(Value::as_str),
            Some("request.completed")
        );
        assert_eq!(
            rows[0].get("result").and_then(Value::as_str),
            Some("success")
        );
        assert_eq!(
            rows[1].get("request_key").and_then(Value::as_str),
            Some("r2")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn raw_reader_preserves_provider_attempt_failure_rows() {
        let dir = temp_dir("raw-attempt");
        let path = dir.join("records-attempt.jsonl");
        v3_webui_observability_append_row(
            &path,
            &json!({
                "request_key": "r1",
                "event_type": "request.started",
                "started_epoch_ms": 1,
                "updated_epoch_ms": 1
            }),
        )
        .unwrap();
        v3_webui_observability_append_row(
            &path,
            &json!({
                "request_key": "r1",
                "event_type": "request.provider_attempt_failed",
                "started_epoch_ms": 1,
                "updated_epoch_ms": 2,
                "meta": {"provider_status": 502}
            }),
        )
        .unwrap();
        v3_webui_observability_append_row(
            &path,
            &json!({
                "request_key": "r1",
                "event_type": "request.completed",
                "started_epoch_ms": 1,
                "updated_epoch_ms": 3,
                "result": "success"
            }),
        )
        .unwrap();

        let folded = v3_webui_observability_read_rows(&path).unwrap();
        assert_eq!(folded.len(), 1);
        assert_eq!(
            folded[0].get("event_type").and_then(Value::as_str),
            Some("request.completed")
        );

        let raw = v3_webui_observability_read_raw_rows(&path).unwrap();
        assert_eq!(raw.len(), 3);
        assert_eq!(
            raw[1].get("event_type").and_then(Value::as_str),
            Some("request.provider_attempt_failed")
        );
        assert_eq!(
            raw[1]
                .get("meta")
                .and_then(|meta| meta.get("provider_status"))
                .and_then(Value::as_u64),
            Some(502)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn append_rejects_record_over_internal_limit() {
        let dir = temp_dir("too-large");
        let path = dir.join("records-too-large.jsonl");
        let row = json!({
            "request_key": "r1",
            "payload": "x".repeat((v3_observability_max_record_bytes() as usize) + 1),
        });
        let error = v3_webui_observability_append_row(&path, &row).unwrap_err();
        assert!(format!("{error}").contains("limit"));
        assert!(!path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
