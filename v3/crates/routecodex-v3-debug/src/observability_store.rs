// Shared JSONL envelope owner for the per-listener WebUI request-records store.
// Server writes lifecycle rows and Admin reads them through this module; the
// row is a typed serde_json::Value so each crate can decode its own typed row
// without owning a second file format. Reads fold lifecycle rows by
// request_key so each request is projected once at its latest lifecycle state.

use serde_json::Value;
use std::collections::{BTreeMap, VecDeque};
use std::fs;
use std::io::{BufRead, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
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
    let line_bytes = encode_observability_line(row)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    append_encoded_line(path, &line_bytes)
}

pub fn v3_webui_observability_append_row_with_retention(
    path: &Path,
    row: &Value,
    max_history_bytes: u64,
) -> Result<(), V3WebuiObservabilityStoreError> {
    let line_bytes = encode_observability_line(row)?;
    if line_bytes.len() as u64 > max_history_bytes {
        return Err(V3WebuiObservabilityStoreError::RecordTooLarge {
            limit: max_history_bytes,
        });
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let current_bytes = fs::metadata(path)
        .map(|metadata| metadata.len())
        .or_else(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                Ok(0)
            } else {
                Err(error)
            }
        })?;
    if current_bytes.saturating_add(line_bytes.len() as u64) <= max_history_bytes {
        return append_encoded_line(path, &line_bytes);
    }

    let existing_rows = v3_webui_observability_read_raw_rows(path)?;
    let retention_target = max_history_bytes
        .saturating_div(2)
        .max(line_bytes.len() as u64);
    let mut retained = Vec::new();
    let mut retained_bytes = line_bytes.len() as u64;
    for existing_row in existing_rows.into_iter().rev() {
        let existing_line = encode_observability_line(&existing_row)?;
        let next_bytes = retained_bytes.saturating_add(existing_line.len() as u64);
        if next_bytes > retention_target {
            break;
        }
        retained.push(existing_line);
        retained_bytes = next_bytes;
    }
    retained.reverse();
    retained.push(line_bytes);

    let temp_path = path.with_extension(format!(
        "jsonl.tmp-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|error| V3WebuiObservabilityStoreError::Io(std::io::Error::other(error)))?
            .as_nanos()
    ));
    let result = (|| {
        let file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        let mut writer = BufWriter::new(file);
        for line in &retained {
            writer.write_all(line)?;
            writer.write_all(b"\n")?;
        }
        writer.flush()?;
        writer.get_ref().sync_all()?;
        fs::rename(&temp_path, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn encode_observability_line(row: &Value) -> Result<Vec<u8>, V3WebuiObservabilityStoreError> {
    let row_bytes = serde_json::to_vec(row)
        .map_err(|error| V3WebuiObservabilityStoreError::Encode(error.to_string()))?;
    let limit = routecodex_v3_config::internal::v3_observability_max_record_bytes();
    if row_bytes.len() as u64 > limit {
        return Err(V3WebuiObservabilityStoreError::RecordTooLarge { limit });
    }
    let envelope = serde_json::json!({
        "schema_version": V3_WEBUI_OBSERVABILITY_SCHEMA_VERSION,
        "row": row,
    });
    serde_json::to_vec(&envelope)
        .map_err(|error| V3WebuiObservabilityStoreError::Encode(error.to_string()))
}

fn append_encoded_line(
    path: &Path,
    line_bytes: &[u8],
) -> Result<(), V3WebuiObservabilityStoreError> {
    let file = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)?;
    let mut writer = BufWriter::new(file);
    writer
        .write_all(line_bytes)
        .map_err(V3WebuiObservabilityStoreError::Io)?;
    writer
        .write_all(b"\n")
        .map_err(V3WebuiObservabilityStoreError::Io)?;
    writer.flush()?;
    Ok(())
}

#[cfg(test)]
mod retention_tests {
    use super::*;
    use serde_json::json;

    fn temp_dir(label: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("v3-obs-retention-{label}-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn bounded_append_reclaims_old_raw_rows_and_keeps_new_row() {
        let dir = std::env::temp_dir().join(format!(
            "v3-obs-retention-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join("records.jsonl");
        let limit = 300;
        for key in ["old", "middle", "recent"] {
            v3_webui_observability_append_row(
                &path,
                &json!({
                    "request_key": key,
                    "event_type": "request.completed",
                    "padding": "x".repeat(70)
                }),
            )
            .unwrap();
        }
        let new_row = json!({"request_key": "new", "event_type": "request.completed"});
        v3_webui_observability_append_row_with_retention(&path, &new_row, limit).unwrap();

        let rows = v3_webui_observability_read_raw_rows(&path).unwrap();
        assert!(rows.len() < 4);
        assert_eq!(
            rows.last()
                .and_then(|row| row.get("request_key"))
                .and_then(Value::as_str),
            Some("new")
        );
        assert!(fs::metadata(&path).unwrap().len() <= limit);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bounded_append_rejects_a_single_row_larger_than_history_limit() {
        let dir = temp_dir("retention-too-large");
        let path = dir.join("records.jsonl");
        let error = v3_webui_observability_append_row_with_retention(
            &path,
            &json!({"request_key": "large", "padding": "x".repeat(400)}),
            100,
        )
        .unwrap_err();
        assert!(matches!(
            error,
            V3WebuiObservabilityStoreError::RecordTooLarge { limit: 100 }
        ));
        assert!(!path.exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn bounded_append_rejects_corrupt_history_instead_of_overwriting_it() {
        let dir = temp_dir("retention-corrupt");
        let path = dir.join("records.jsonl");
        let corrupt = format!("{}\n", "not-json".repeat(101));
        fs::write(&path, &corrupt).unwrap();
        let error = v3_webui_observability_append_row_with_retention(
            &path,
            &json!({"request_key": "new"}),
            100,
        )
        .unwrap_err();
        assert!(matches!(error, V3WebuiObservabilityStoreError::Decode(_)));
        assert_eq!(fs::read_to_string(&path).unwrap(), corrupt);
        let _ = fs::remove_dir_all(&dir);
    }
}

pub fn v3_webui_observability_read_rows(
    path: &Path,
) -> Result<Vec<Value>, V3WebuiObservabilityStoreError> {
    v3_webui_observability_read_rows_bounded(path, usize::MAX)
}

pub fn v3_webui_observability_read_rows_bounded(
    path: &Path,
    max_rows: usize,
) -> Result<Vec<Value>, V3WebuiObservabilityStoreError> {
    if max_rows == 0 {
        return Ok(Vec::new());
    }
    if !path.exists() {
        return Ok(Vec::new());
    }
    let file = fs::File::open(path)?;
    let mut latest_by_key = BTreeMap::<String, Value>::new();
    let mut order = VecDeque::<String>::new();
    for (line_number, line) in BufReader::new(file).lines().enumerate() {
        let row = decode_observability_row(path, line_number, &line?)?;
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
        if latest_by_key.contains_key(key) {
            order.retain(|existing| existing != key);
        } else if latest_by_key.len() >= max_rows {
            if let Some(oldest) = order.pop_front() {
                latest_by_key.remove(&oldest);
            }
        }
        order.push_back(key.to_string());
        latest_by_key.insert(key.to_string(), row);
    }
    Ok(order
        .into_iter()
        .filter_map(|key| latest_by_key.remove(&key))
        .collect())
}

/// Rows plus per-line records that a strict read would have rejected. The
/// store is Debug surface, never business truth, so a torn append or a legacy
/// row must degrade into `skipped` evidence instead of failing the reader.
#[derive(Debug, Default, Clone)]
pub struct V3WebuiObservabilityLenientRead {
    pub rows: Vec<Value>,
    pub skipped: Vec<String>,
}

/// Lenient sibling of `v3_webui_observability_read_rows_bounded`: identical
/// request_key folding and bounding, but undecodable lines and rows without a
/// request_key are skipped and reported instead of aborting the whole read.
/// This read never fails; even an unreadable file yields an empty report with
/// a skipped note so observability loading cannot block listener startup.
pub fn v3_webui_observability_read_rows_bounded_lenient(
    path: &Path,
    max_rows: usize,
) -> V3WebuiObservabilityLenientRead {
    let mut report = V3WebuiObservabilityLenientRead::default();
    if max_rows == 0 {
        return report;
    }
    if !path.exists() {
        return report;
    }
    let file = match fs::File::open(path) {
        Ok(file) => file,
        Err(error) => {
            report.skipped.push(format!(
                "open observability store {}: {error}",
                path.display()
            ));
            return report;
        }
    };
    let mut latest_by_key = BTreeMap::<String, Value>::new();
    let mut order = VecDeque::<String>::new();
    for (line_number, line) in BufReader::new(file).lines().enumerate() {
        let skipped_note = |reason: String| {
            format!(
                "observability record {}:{} skipped: {reason}",
                path.display(),
                line_number + 1
            )
        };
        let line = match line {
            Ok(line) => line,
            Err(error) => {
                report.skipped.push(skipped_note(error.to_string()));
                continue;
            }
        };
        let row = match decode_observability_row(path, line_number, &line) {
            Ok(row) => row,
            Err(error) => {
                report.skipped.push(skipped_note(error.to_string()));
                continue;
            }
        };
        let Some(key) = row.get("request_key").and_then(Value::as_str) else {
            report
                .skipped
                .push(skipped_note("has no request_key".to_string()));
            continue;
        };
        if latest_by_key.contains_key(key) {
            order.retain(|existing| existing != key);
        } else if latest_by_key.len() >= max_rows {
            if let Some(oldest) = order.pop_front() {
                latest_by_key.remove(&oldest);
            }
        }
        order.push_back(key.to_string());
        latest_by_key.insert(key.to_string(), row);
    }
    report.rows = order
        .into_iter()
        .filter_map(|key| latest_by_key.remove(&key))
        .collect();
    report
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
        rows.push(decode_observability_row(path, line_number, &line)?);
    }
    Ok(rows)
}

/// Records decoded by an incremental tail read plus the reader position that
/// follows them.
#[derive(Debug, Default)]
pub struct V3WebuiObservabilityRawTail {
    pub rows: Vec<Value>,
    /// Byte offset of the first byte after the last complete record consumed.
    pub next_offset: u64,
    /// Number of store lines consumed, including skipped blank lines.
    pub next_line: usize,
}

/// Reads complete records starting at `start_offset`.
///
/// The store is append-only between retention rewrites, so a reader that
/// remembers `next_offset`/`next_line` decodes only newly appended records
/// instead of the whole history. A trailing partial line (a writer caught
/// mid-append) is left unconsumed: `next_offset` stops at the last newline so
/// the next call re-reads it once the record is complete.
pub fn v3_webui_observability_read_raw_rows_from(
    path: &Path,
    start_offset: u64,
    start_line: usize,
) -> Result<V3WebuiObservabilityRawTail, V3WebuiObservabilityStoreError> {
    let mut tail = V3WebuiObservabilityRawTail {
        rows: Vec::new(),
        next_offset: start_offset,
        next_line: start_line,
    };
    if !path.exists() {
        return Ok(tail);
    }
    let mut file = fs::File::open(path)?;
    if start_offset > 0 {
        file.seek(SeekFrom::Start(start_offset))?;
    }
    let mut buffer = Vec::new();
    file.read_to_end(&mut buffer)?;
    let mut consumed = 0usize;
    for line in buffer.split_inclusive(|byte| *byte == b'\n') {
        if !line.ends_with(b"\n") {
            break;
        }
        consumed += line.len();
        let mut text = &line[..line.len() - 1];
        if text.ends_with(b"\r") {
            text = &text[..text.len() - 1];
        }
        let text = std::str::from_utf8(text).map_err(|error| {
            V3WebuiObservabilityStoreError::Io(std::io::Error::new(
                std::io::ErrorKind::InvalidData,
                error,
            ))
        })?;
        let line_number = tail.next_line;
        tail.next_line += 1;
        if text.trim().is_empty() {
            continue;
        }
        tail.rows
            .push(decode_observability_row(path, line_number, text)?);
    }
    tail.next_offset = start_offset + consumed as u64;
    Ok(tail)
}

fn decode_observability_row(
    path: &Path,
    line_number: usize,
    line: &str,
) -> Result<Value, V3WebuiObservabilityStoreError> {
    if line.trim().is_empty() {
        return Err(V3WebuiObservabilityStoreError::Decode(format!(
            "observability record {}:{} is empty",
            path.display(),
            line_number + 1
        )));
    }
    let envelope: Value = serde_json::from_str(line).map_err(|error| {
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
    use routecodex_v3_config::internal::v3_observability_max_record_bytes;
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
        assert!(v3_webui_observability_read_raw_rows(path)
            .unwrap()
            .is_empty());
    }

    /// The incremental reader must agree with the full reader at every step of
    /// an append-only history, must leave a torn trailing record for the next
    /// call, and must be re-readable from a reset offset.
    #[test]
    fn incremental_tail_matches_full_read_and_leaves_partial_lines() {
        let dir = temp_dir("tail");
        let path = dir.join("records.jsonl");
        let row = |id: &str| json!({"request_key": format!("4444:{id}"), "event_type": "request.started"});

        v3_webui_observability_append_row(&path, &row("r1")).unwrap();
        let first = v3_webui_observability_read_raw_rows_from(&path, 0, 0).unwrap();
        assert_eq!(first.rows.len(), 1);
        assert_eq!(first.next_line, 1);
        assert_eq!(
            first.next_offset,
            std::fs::metadata(&path).unwrap().len(),
            "a complete record must advance the offset to the file end"
        );

        // A writer caught mid-append leaves the torn record unconsumed.
        let mut file = std::fs::OpenOptions::new()
            .append(true)
            .open(&path)
            .unwrap();
        file.write_all(br#"{"schema_version":1,"row":{"request_key":"#)
            .unwrap();
        file.flush().unwrap();
        let torn =
            v3_webui_observability_read_raw_rows_from(&path, first.next_offset, first.next_line)
                .unwrap();
        assert!(torn.rows.is_empty());
        assert_eq!(torn.next_offset, first.next_offset);
        assert_eq!(torn.next_line, first.next_line);

        // Completing that record makes it readable from the same offset.
        file.write_all(br#""4444:r2","event_type":"request.completed"}}"#)
            .unwrap();
        file.write_all(b"\n").unwrap();
        file.flush().unwrap();
        let resumed =
            v3_webui_observability_read_raw_rows_from(&path, torn.next_offset, torn.next_line)
                .unwrap();
        assert_eq!(resumed.rows.len(), 1);
        assert_eq!(resumed.next_line, 2);

        // Incremental results concatenate to exactly the full read.
        let mut incremental = first.rows.clone();
        incremental.extend(resumed.rows.clone());
        assert_eq!(
            incremental,
            v3_webui_observability_read_raw_rows(&path).unwrap()
        );

        // Blank lines are consumed without becoming rows and still count.
        v3_webui_observability_append_row(&path, &row("r3")).unwrap();
        let with_blank = std::fs::read_to_string(&path).unwrap();
        std::fs::write(&path, format!("{with_blank}\n\n")).unwrap();
        let past = v3_webui_observability_read_raw_rows_from(
            &path,
            resumed.next_offset,
            resumed.next_line,
        )
        .unwrap();
        assert_eq!(past.rows.len(), 1);
        assert_eq!(past.next_line, 5);
        assert_eq!(past.next_offset, std::fs::metadata(&path).unwrap().len());

        // A reset offset re-reads the whole history from the start.
        let full = v3_webui_observability_read_raw_rows_from(&path, 0, 0).unwrap();
        assert_eq!(full.rows.len(), 3);
        assert_eq!(full.next_offset, std::fs::metadata(&path).unwrap().len());
        let _ = std::fs::remove_dir_all(&dir);
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

    #[test]
    fn bounded_startup_read_keeps_only_the_most_recent_request_rows() {
        let dir = temp_dir("bounded-startup");
        let path = dir.join("records-bounded.jsonl");
        for request_key in ["r1", "r2", "r3"] {
            v3_webui_observability_append_row(
                &path,
                &json!({
                    "request_key": request_key,
                    "event_type": "request.completed",
                    "result": "success"
                }),
            )
            .unwrap();
        }

        let rows = v3_webui_observability_read_rows_bounded(&path, 2).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0].get("request_key").and_then(Value::as_str),
            Some("r2")
        );
        assert_eq!(
            rows[1].get("request_key").and_then(Value::as_str),
            Some("r3")
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
