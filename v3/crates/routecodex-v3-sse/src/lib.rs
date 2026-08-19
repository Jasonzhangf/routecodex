//! Protocol-neutral incremental SSE framing for RouteCodex V3.
//!
//! This crate is copied into the V3 workspace so V3 can run without depending on the V2 llmswitch-core crate tree.
//! It deliberately does not interpret event names or `data` payloads.
// feature_id: v3.sse_transport_core_independent

use std::time::Duration;
use thiserror::Error;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SseTransportLimits {
    pub max_frame_bytes: usize,
    pub max_buffer_bytes: usize,
}

impl Default for SseTransportLimits {
    fn default() -> Self {
        Self {
            max_frame_bytes: 1024 * 1024,
            max_buffer_bytes: 2 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SseTransportError {
    #[error("SSE input is not valid UTF-8")]
    InvalidUtf8,
    #[error("SSE stream ended before the final frame delimiter")]
    UnterminatedFrame,
    #[error("SSE frame exceeds {limit} bytes")]
    FrameLimitExceeded { limit: usize },
    #[error("SSE decoder buffer exceeds {limit} bytes")]
    BufferLimitExceeded { limit: usize },
    #[error("SSE transport aborted")]
    Aborted,
    #[error("SSE transport timed out after {timeout:?}")]
    Timeout { timeout: Duration },
    #[error("SSE upstream read failed: {message}")]
    UpstreamRead { message: String },
    #[error("SSE downstream write failed: {message}")]
    DownstreamWrite { message: String },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SseTransportLifecycleState {
    Flowing,
    Paused,
    Closed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseTransportLifecycleEvent {
    DownstreamWriteAccepted,
    DownstreamWriteBlocked,
    DownstreamDrain,
    UpstreamEof,
    Abort,
    Timeout(Duration),
    UpstreamReadFailed(String),
    DownstreamWriteFailed(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseTransportLifecycleEffect {
    StillRunning,
    PauseUpstream,
    ResumeUpstream,
    CloseAndRelease(Result<(), SseTransportError>),
    AlreadyTerminal(Result<(), SseTransportError>),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseTransportLifecycle {
    state: SseTransportLifecycleState,
    terminal_result: Option<Result<(), SseTransportError>>,
}

impl Default for SseTransportLifecycle {
    fn default() -> Self {
        Self::new()
    }
}

impl SseTransportLifecycle {
    pub fn new() -> Self {
        Self {
            state: SseTransportLifecycleState::Flowing,
            terminal_result: None,
        }
    }

    pub fn state(&self) -> SseTransportLifecycleState {
        self.state
    }

    pub fn is_released(&self) -> bool {
        self.state == SseTransportLifecycleState::Closed
    }

    pub fn apply(&mut self, event: SseTransportLifecycleEvent) -> SseTransportLifecycleEffect {
        if let Some(result) = &self.terminal_result {
            return SseTransportLifecycleEffect::AlreadyTerminal(result.clone());
        }

        match event {
            SseTransportLifecycleEvent::DownstreamWriteBlocked
                if self.state == SseTransportLifecycleState::Flowing =>
            {
                self.state = SseTransportLifecycleState::Paused;
                SseTransportLifecycleEffect::PauseUpstream
            }
            SseTransportLifecycleEvent::DownstreamDrain
                if self.state == SseTransportLifecycleState::Paused =>
            {
                self.state = SseTransportLifecycleState::Flowing;
                SseTransportLifecycleEffect::ResumeUpstream
            }
            SseTransportLifecycleEvent::DownstreamWriteAccepted
            | SseTransportLifecycleEvent::DownstreamWriteBlocked
            | SseTransportLifecycleEvent::DownstreamDrain => {
                SseTransportLifecycleEffect::StillRunning
            }
            SseTransportLifecycleEvent::UpstreamEof => self.close(Ok(())),
            SseTransportLifecycleEvent::Abort => self.close(Err(SseTransportError::Aborted)),
            SseTransportLifecycleEvent::Timeout(timeout) => {
                self.close(Err(SseTransportError::Timeout { timeout }))
            }
            SseTransportLifecycleEvent::UpstreamReadFailed(message) => {
                self.close(Err(SseTransportError::UpstreamRead { message }))
            }
            SseTransportLifecycleEvent::DownstreamWriteFailed(message) => {
                self.close(Err(SseTransportError::DownstreamWrite { message }))
            }
        }
    }

    fn close(&mut self, result: Result<(), SseTransportError>) -> SseTransportLifecycleEffect {
        self.state = SseTransportLifecycleState::Closed;
        self.terminal_result = Some(result.clone());
        SseTransportLifecycleEffect::CloseAndRelease(result)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseField {
    Comment(String),
    Named { name: String, value: String },
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseTransportIn01RawChunk<'a> {
    bytes: &'a [u8],
}

pub type V3SseTransportIn01RawChunk<'a> = SseTransportIn01RawChunk<'a>;

pub fn build_sse_transport_in_01_raw_chunk(bytes: &[u8]) -> SseTransportIn01RawChunk<'_> {
    SseTransportIn01RawChunk { bytes }
}

pub fn build_v3_sse_transport_in_01_raw_chunk(bytes: &[u8]) -> SseTransportIn01RawChunk<'_> {
    build_sse_transport_in_01_raw_chunk(bytes)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseTransportIn02DecodedFrame {
    fields: Vec<SseField>,
    /// 原始帧字节是否全部为合法 UTF-8。framing 层仍按 U+FFFD 修复保留帧结构
    /// （既有 transport 契约），但语义消费层必须能区分“合法 UTF-8 的 JSON
    /// 载荷错误”（codec 归属）与“帧字节本身非法 UTF-8”（transport 归属）。
    raw_utf8_valid: bool,
}

pub type V3SseTransportIn02DecodedFrame = SseTransportIn02DecodedFrame;

impl SseTransportIn02DecodedFrame {
    pub fn fields(&self) -> &[SseField] {
        &self.fields
    }

    pub fn raw_utf8_valid(&self) -> bool {
        self.raw_utf8_valid
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseTransportIn03ValidatedFrameStream {
    frame: SseTransportIn02DecodedFrame,
}

pub type V3SseTransportIn03ValidatedFrameStream = SseTransportIn03ValidatedFrameStream;

impl SseTransportIn03ValidatedFrameStream {
    pub fn frame(&self) -> &SseTransportIn02DecodedFrame {
        &self.frame
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SseTransportOut04EncodedChunk(Vec<u8>);

pub type V3SseTransportOut04EncodedChunk = SseTransportOut04EncodedChunk;

impl SseTransportOut04EncodedChunk {
    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn into_bytes(self) -> Vec<u8> {
        self.0
    }
}

/// 帧内容（data 行为主）的 JSON 闭合检查：引号/括号平衡（转义感知）。
/// 用于决定空行是否真的是 SSE 帧分隔——JSON 未闭合时空行是字符串值
/// 内容的一部分（upstream 未转义的原始换行），继续缓冲直到闭合。
/// 非 JSON data（如 [DONE]）括号平衡即视为闭合。
fn sse_frame_json_is_closed(bytes: &[u8]) -> bool {
    let mut in_string = false;
    let mut escaped = false;
    let mut depth: i32 = 0;
    for &byte in bytes {
        if escaped {
            escaped = false;
            continue;
        }
        match byte {
            b'\\' if in_string => escaped = true,
            b'"' => in_string = !in_string,
            b'{' | b'[' if !in_string => depth += 1,
            b'}' | b']' if !in_string => {
                depth -= 1;
                if depth < 0 {
                    return true;
                }
            }
            _ => {}
        }
    }
    !in_string && depth <= 0
}

#[derive(Debug)]
pub struct SseIncrementalDecoder {
    limits: SseTransportLimits,
    buffer: Vec<u8>,
    scan_index: usize,
    line_start: usize,
    frame_start: usize,
}

impl SseIncrementalDecoder {
    pub fn new(limits: SseTransportLimits) -> Self {
        Self {
            limits,
            buffer: Vec::new(),
            scan_index: 0,
            line_start: 0,
            frame_start: 0,
        }
    }

    pub fn push(
        &mut self,
        raw_chunk: SseTransportIn01RawChunk<'_>,
    ) -> Result<Vec<SseTransportIn03ValidatedFrameStream>, SseTransportError> {
        let mut frames = Vec::new();
        for byte in raw_chunk.bytes {
            self.buffer.push(*byte);
            if self.buffer.len() > self.limits.max_buffer_bytes {
                return Err(SseTransportError::BufferLimitExceeded {
                    limit: self.limits.max_buffer_bytes,
                });
            }
            loop {
                let mut frame_end = None;
                while self.scan_index < self.buffer.len() {
                    let ending_len = match self.buffer[self.scan_index] {
                        b'\n' => 1,
                        b'\r' if self.buffer.get(self.scan_index + 1) == Some(&b'\n') => 2,
                        b'\r' if self.buffer.get(self.scan_index + 1).is_none() => break,
                        b'\r' => 1,
                        _ => {
                            self.scan_index += 1;
                            continue;
                        }
                    };
                    if self.scan_index == self.line_start {
                        // 空行：SSE 帧结束候选。但部分 upstream 把超长 JSON
                        // 单行发出且字符串值内含原始换行/空行（未按 SSE 规范
                        // 折成多 data 行）——若当前帧的 JSON 未闭合（引号/括号
                        // 不平衡，转义感知），该空行是字符串值的一部分，不能
                        // 当作帧分隔，否则 JSON 被截断（serde 报 expected ':'/
                        // expected ',' or '}'）。JSON 闭合后才允许帧结束。
                        if !sse_frame_json_is_closed(
                            &self.buffer[self.frame_start..self.scan_index],
                        ) {
                            self.scan_index += ending_len;
                            self.line_start = self.scan_index;
                            continue;
                        }
                        frame_end = Some(self.scan_index + ending_len);
                        break;
                    }
                    self.scan_index += ending_len;
                    self.line_start = self.scan_index;
                }
                let Some(end) = frame_end else { break };
                if end > self.limits.max_frame_bytes {
                    return Err(SseTransportError::FrameLimitExceeded {
                        limit: self.limits.max_frame_bytes,
                    });
                }
                let raw = self.buffer.drain(..end).collect::<Vec<_>>();
                self.scan_index = 0;
                self.line_start = 0;
                self.frame_start = 0;
                frames.push(build_sse_transport_in_03_from_sse_transport_in_02(
                    build_sse_transport_in_02_from_sse_transport_in_01(&raw, self.limits)?,
                )?);
            }
            if self.buffer.len() > self.limits.max_frame_bytes {
                return Err(SseTransportError::FrameLimitExceeded {
                    limit: self.limits.max_frame_bytes,
                });
            }
        }
        Ok(frames)
    }

    pub fn remaining_bytes(&self) -> &[u8] {
        &self.buffer
    }

    pub fn finish(self) -> Result<(), SseTransportError> {
        if self.buffer.is_empty() {
            Ok(())
        } else {
            Err(SseTransportError::UnterminatedFrame)
        }
    }

    pub fn finish_with_trailing_frame(
        self,
    ) -> Result<Option<SseTransportIn03ValidatedFrameStream>, SseTransportError> {
        if self.buffer.is_empty() {
            return Ok(None);
        }
        if self.buffer.len() > self.limits.max_frame_bytes {
            return Err(SseTransportError::FrameLimitExceeded {
                limit: self.limits.max_frame_bytes,
            });
        }
        Ok(Some(build_sse_transport_in_03_from_sse_transport_in_02(
            build_sse_transport_in_02_from_sse_transport_in_01(&self.buffer, self.limits)?,
        )?))
    }
}

pub fn build_sse_transport_out_04_from_sse_transport_in_03(
    frame: &SseTransportIn03ValidatedFrameStream,
) -> SseTransportOut04EncodedChunk {
    let mut output = Vec::new();
    for field in frame.frame.fields() {
        match field {
            SseField::Comment(value) => {
                output.push(b':');
                output.extend_from_slice(value.as_bytes());
            }
            SseField::Named { name, value } => {
                output.extend_from_slice(name.as_bytes());
                output.push(b':');
                if !value.is_empty() {
                    output.push(b' ');
                    output.extend_from_slice(value.as_bytes());
                }
            }
        }
        output.push(b'\n');
    }
    output.push(b'\n');
    SseTransportOut04EncodedChunk(output)
}

pub fn build_v3_sse_transport_out_04_from_v3_sse_transport_in_03(
    frame: &SseTransportIn03ValidatedFrameStream,
) -> SseTransportOut04EncodedChunk {
    build_sse_transport_out_04_from_sse_transport_in_03(frame)
}

pub fn build_sse_transport_in_02_from_fields(
    fields: Vec<SseField>,
) -> Result<SseTransportIn02DecodedFrame, SseTransportError> {
    Ok(SseTransportIn02DecodedFrame {
        fields,
        raw_utf8_valid: true,
    })
}

pub fn build_v3_sse_transport_in_02_from_fields(
    fields: Vec<SseField>,
) -> Result<SseTransportIn02DecodedFrame, SseTransportError> {
    build_sse_transport_in_02_from_fields(fields)
}

pub fn build_sse_transport_in_03_from_sse_transport_in_02(
    frame: SseTransportIn02DecodedFrame,
) -> Result<SseTransportIn03ValidatedFrameStream, SseTransportError> {
    Ok(SseTransportIn03ValidatedFrameStream { frame })
}

pub fn build_v3_sse_transport_in_03_from_v3_sse_transport_in_02(
    frame: SseTransportIn02DecodedFrame,
) -> Result<SseTransportIn03ValidatedFrameStream, SseTransportError> {
    build_sse_transport_in_03_from_sse_transport_in_02(frame)
}

pub fn build_sse_transport_out_04_keepalive_comment(
    comment: &str,
) -> SseTransportOut04EncodedChunk {
    SseTransportOut04EncodedChunk(format!(":{}\n\n", comment).into_bytes())
}

pub fn build_v3_sse_transport_out_04_keepalive_comment(
    comment: &str,
) -> SseTransportOut04EncodedChunk {
    build_sse_transport_out_04_keepalive_comment(comment)
}

fn build_sse_transport_in_02_from_sse_transport_in_01(
    raw: &[u8],
    _limits: SseTransportLimits,
) -> Result<SseTransportIn02DecodedFrame, SseTransportError> {
    // 容忍流内非法 UTF-8 字节（upstream 可能在 reasoning 文本等字段携带
    // 编码噪声）：按 U+FFFD 替换后继续解析帧结构（\n 分隔保留），不整体
    // 拒绝请求；JSON 语义错误仍在后续 classify 层 fail-fast。
    let text = String::from_utf8_lossy(raw);
    let body = text.trim_end_matches(['\r', '\n']);
    let mut fields = Vec::new();
    let mut pending_blank = false;
    for line in body.split(['\n', '\r']) {
        if line.is_empty() {
            pending_blank = true;
            continue;
        }
        if let Some(comment) = line.strip_prefix(':') {
            fields.push(SseField::Comment(comment.to_string()));
            pending_blank = false;
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            let value = value.strip_prefix(' ').unwrap_or(value);
            fields.push(SseField::Named {
                name: name.to_string(),
                value: value.to_string(),
            });
            pending_blank = false;
            continue;
        }
        // 无冒号行：SSE 规范里非法，但部分 upstream 把超长 JSON 折行发出
        // （续行不带 `data:` 前缀）。作为前一个 Named 字段 value 的续行
        // 追加（原始换行保留，含续行前的空行），避免上层 codec 因只收集
        // `data` 字段而静默丢失 JSON 内容；续行若拼出非法 JSON 仍在 parse
        // 层显式失败。
        if let Some(SseField::Named { value, .. }) = fields.last_mut() {
            if pending_blank {
                value.push('\n');
            }
            value.push('\n');
            value.push_str(line);
        }
        pending_blank = false;
    }
    Ok(SseTransportIn02DecodedFrame {
        fields,
        raw_utf8_valid: std::str::from_utf8(raw).is_ok(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arbitrary_utf8_chunks_preserve_multiline_comment_id_retry_and_unknown_fields() {
        let input = "event: custom\r\nid: 7\r\nretry: 50\r\n:note\r\ndata: 你\r\ndata: 好\r\nx-extra: value\r\n\r\n".as_bytes();
        for split in 0..=input.len() {
            let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
            let mut frames = decoder
                .push(build_sse_transport_in_01_raw_chunk(&input[..split]))
                .unwrap();
            frames.extend(
                decoder
                    .push(build_sse_transport_in_01_raw_chunk(&input[split..]))
                    .unwrap(),
            );
            decoder.finish().unwrap();
            assert_eq!(frames.len(), 1, "split={split}");
            let encoded = build_sse_transport_out_04_from_sse_transport_in_03(&frames[0]);
            let text = std::str::from_utf8(encoded.as_bytes()).unwrap();
            assert!(text.contains("data: 你\ndata: 好\n"));
            assert!(text.contains("x-extra: value\n"));
        }
    }

    #[test]
    fn colonless_line_continues_previous_data_field_value() {
        // upstream 把超长 JSON 折行发出（续行无 `data:` 前缀）：续行必须
        // 追加到前一个 data 字段的 value（原始换行保留），不得变成独立
        // field name 而被上层 codec 静默丢弃。
        let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
        let frames = decoder
            .push(build_sse_transport_in_01_raw_chunk(
                b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"first\nsecond line\"}\n\n",
            ))
            .unwrap();
        assert_eq!(frames.len(), 1);
        let frame = frames[0].frame();
        let data = frame
            .fields()
            .iter()
            .find_map(|field| match field {
                SseField::Named { name, value } if name == "data" => Some(value.clone()),
                _ => None,
            })
            .expect("data field must be present");
        assert_eq!(
            data, "{\"type\":\"response.output_text.delta\",\"delta\":\"first\nsecond line\"}",
            "colonless continuation must be appended to the previous data value"
        );
    }

    #[test]
    fn colonless_leading_line_without_previous_field_is_dropped_not_crashed() {
        // 首行即无冒号（无前 field 可续）：非法行被忽略，不 panic、不产生
        // 幽灵字段；帧其余部分正常解析。
        let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
        let frames = decoder
            .push(build_sse_transport_in_01_raw_chunk(
                b"orphan line\ndata: {\"ok\":true}\n\n",
            ))
            .unwrap();
        assert_eq!(frames.len(), 1);
        let frame = frames[0].frame();
        let data = frame
            .fields()
            .iter()
            .find_map(|field| match field {
                SseField::Named { name, value } if name == "data" => Some(value.clone()),
                _ => None,
            })
            .expect("data field must be present");
        assert_eq!(data, "{\"ok\":true}");
    }

    #[test]
    fn blank_line_inside_open_json_string_does_not_end_the_frame() {
        // upstream 单行 data 内字符串值含原始空行（\n\n 未转义）：该空行
        // 是字符串值内容，不得当作 SSE 帧分隔（否则 JSON 被截断报
        // expected ':'）。JSON 闭合后才允许帧结束。
        let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
        let frames = decoder
            .push(build_sse_transport_in_01_raw_chunk(
                b"data: {\"type\":\"response.output_text.delta\",\"delta\":\"first\n\nsecond\"}\n\n",
            ))
            .unwrap();
        assert_eq!(
            frames.len(),
            1,
            "blank line inside open JSON must not split the frame"
        );
        let frame = frames[0].frame();
        let data = frame
            .fields()
            .iter()
            .find_map(|field| match field {
                SseField::Named { name, value } if name == "data" => Some(value.clone()),
                _ => None,
            })
            .expect("data field must be present");
        assert_eq!(
            data, "{\"type\":\"response.output_text.delta\",\"delta\":\"first\n\nsecond\"}",
            "JSON value with raw blank line must be preserved as one frame"
        );
    }

    #[test]
    fn closed_json_still_splits_frames_at_blank_lines() {
        // JSON 闭合后空行仍是帧分隔：一帧结束、下一帧正常开始，不吞帧。
        let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
        let frames = decoder
            .push(build_sse_transport_in_01_raw_chunk(
                b"data: {\"a\":1}\n\ndata: {\"b\":2}\n\n",
            ))
            .unwrap();
        assert_eq!(frames.len(), 2);
        let first = frames[0].frame();
        let first_data = first
            .fields()
            .iter()
            .find_map(|field| match field {
                SseField::Named { name, value } if name == "data" => Some(value.as_str()),
                _ => None,
            })
            .expect("first data field");
        assert_eq!(first_data, "{\"a\":1}");
        let second = frames[1].frame();
        let second_data = second
            .fields()
            .iter()
            .find_map(|field| match field {
                SseField::Named { name, value } if name == "data" => Some(value.as_str()),
                _ => None,
            })
            .expect("second data field");
        assert_eq!(second_data, "{\"b\":2}");
    }

    #[test]
    fn done_is_opaque_data_and_no_terminal_is_synthesized() {
        let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
        let frames = decoder
            .push(build_sse_transport_in_01_raw_chunk(b"data: [DONE]\n\n"))
            .unwrap();
        decoder.finish().unwrap();
        assert_eq!(
            build_sse_transport_out_04_from_sse_transport_in_03(&frames[0]).as_bytes(),
            b"data: [DONE]\n\n"
        );
    }

    #[test]
    fn long_chunk_is_drained_frame_by_frame_under_buffer_budget() {
        let limits = SseTransportLimits {
            max_frame_bytes: 16,
            max_buffer_bytes: 16,
        };
        let mut decoder = SseIncrementalDecoder::new(limits);
        let frames = decoder
            .push(build_sse_transport_in_01_raw_chunk(
                b"data: 1\n\ndata: 2\n\ndata: 3\n\n",
            ))
            .unwrap();
        decoder.finish().unwrap();
        assert_eq!(frames.len(), 3);
    }

    #[test]
    fn accepts_long_sse_data_lines_and_keeps_frame_buffer_limits() {
        let long_payload = "x".repeat(80 * 1024);
        let raw = format!("data: {long_payload}\n\n");
        let mut decoder = SseIncrementalDecoder::new(SseTransportLimits::default());
        let frames = decoder
            .push(build_sse_transport_in_01_raw_chunk(raw.as_bytes()))
            .unwrap();
        decoder.finish().unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(
            frames[0]
                .frame
                .fields
                .iter()
                .find_map(|field| match field {
                    SseField::Named { name, value } if name == "data" => Some(value),
                    _ => None,
                })
                .map(String::as_str),
            Some(long_payload.as_str())
        );

        let limits = SseTransportLimits {
            max_frame_bytes: 32,
            max_buffer_bytes: 64,
        };
        let mut oversized_frame = SseIncrementalDecoder::new(limits);
        assert_eq!(
            oversized_frame.push(build_sse_transport_in_01_raw_chunk(
                b"data: 1234567890123456789012345678901234567890\n\n"
            )),
            Err(SseTransportError::FrameLimitExceeded { limit: 32 })
        );
    }

    #[test]
    fn rejects_unterminated_invalid_utf8_and_buffer_limit() {
        let mut unfinished = SseIncrementalDecoder::new(SseTransportLimits::default());
        unfinished
            .push(build_sse_transport_in_01_raw_chunk(b"data: half"))
            .unwrap();
        assert_eq!(
            unfinished.finish(),
            Err(SseTransportError::UnterminatedFrame)
        );

        let mut trailing = SseIncrementalDecoder::new(SseTransportLimits::default());
        trailing
            .push(build_sse_transport_in_01_raw_chunk(b"data: terminal"))
            .unwrap();
        let frame = trailing
            .finish_with_trailing_frame()
            .unwrap()
            .expect("trailing frame");
        assert_eq!(
            build_sse_transport_out_04_from_sse_transport_in_03(&frame).as_bytes(),
            b"data: terminal\n\n"
        );

        let mut invalid = SseIncrementalDecoder::new(SseTransportLimits::default());
        let repaired = invalid
            .push(build_sse_transport_in_01_raw_chunk(b"data: \xff\n\n"))
            .expect("invalid UTF-8 bytes must be repaired, not rejected");
        assert_eq!(
            build_sse_transport_out_04_from_sse_transport_in_03(&repaired[0]).as_bytes(),
            "data: \u{FFFD}\n\n".as_bytes(),
            "invalid UTF-8 bytes must be replaced with U+FFFD and the frame kept"
        );

        let limits = SseTransportLimits {
            max_frame_bytes: 1024,
            max_buffer_bytes: 4,
        };
        let mut oversized_buffer = SseIncrementalDecoder::new(limits);
        assert_eq!(
            oversized_buffer.push(build_sse_transport_in_01_raw_chunk(b"datax")),
            Err(SseTransportError::BufferLimitExceeded { limit: 4 })
        );
    }

    #[test]
    fn lifecycle_pauses_on_backpressure_and_resumes_only_after_drain() {
        let mut lifecycle = SseTransportLifecycle::new();
        assert_eq!(
            lifecycle.apply(SseTransportLifecycleEvent::DownstreamWriteBlocked),
            SseTransportLifecycleEffect::PauseUpstream
        );
        assert_eq!(lifecycle.state(), SseTransportLifecycleState::Paused);
        assert_eq!(
            lifecycle.apply(SseTransportLifecycleEvent::DownstreamDrain),
            SseTransportLifecycleEffect::ResumeUpstream
        );
        assert_eq!(lifecycle.state(), SseTransportLifecycleState::Flowing);
    }

    #[test]
    fn lifecycle_success_and_failures_close_and_release_exactly_once() {
        let cases = [
            (SseTransportLifecycleEvent::UpstreamEof, Ok(())),
            (
                SseTransportLifecycleEvent::Abort,
                Err(SseTransportError::Aborted),
            ),
            (
                SseTransportLifecycleEvent::Timeout(Duration::from_secs(3)),
                Err(SseTransportError::Timeout {
                    timeout: Duration::from_secs(3),
                }),
            ),
            (
                SseTransportLifecycleEvent::UpstreamReadFailed("read".to_string()),
                Err(SseTransportError::UpstreamRead {
                    message: "read".to_string(),
                }),
            ),
            (
                SseTransportLifecycleEvent::DownstreamWriteFailed("write".to_string()),
                Err(SseTransportError::DownstreamWrite {
                    message: "write".to_string(),
                }),
            ),
        ];
        for (event, expected) in cases {
            let mut lifecycle = SseTransportLifecycle::new();
            assert_eq!(
                lifecycle.apply(event),
                SseTransportLifecycleEffect::CloseAndRelease(expected.clone())
            );
            assert_eq!(
                lifecycle.apply(SseTransportLifecycleEvent::Abort),
                SseTransportLifecycleEffect::AlreadyTerminal(expected)
            );
        }
    }

    #[test]
    fn lifecycle_non_terminal_events_never_close_or_release() {
        let mut lifecycle = SseTransportLifecycle::new();
        assert_eq!(
            lifecycle.apply(SseTransportLifecycleEvent::DownstreamWriteAccepted),
            SseTransportLifecycleEffect::StillRunning
        );
        assert_eq!(lifecycle.state(), SseTransportLifecycleState::Flowing);
        assert!(!lifecycle.is_released());
    }
}
