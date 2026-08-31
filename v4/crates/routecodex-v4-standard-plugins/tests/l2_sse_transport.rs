use std::sync::Arc;
use std::time::{Duration, Instant};

use routecodex_v4_standard_plugins::sse_transport::{
    SseEgressPlugin, SseIngressPlugin, SseTransportError, SseTransportFrame, SseTransportPolicy,
};

#[test]
fn transport_frames_bytes_without_reading_payload_semantics() {
    let policy = SseTransportPolicy::new(128, 128, Duration::from_secs(30)).unwrap();
    let mut plugin = SseIngressPlugin::new(policy, Instant::now());
    let now = Instant::now();

    let first = plugin
        .push_chunk(b"data: {\"model\":\"untouched\"}\n", now)
        .unwrap();
    assert!(first.is_empty());
    let second = plugin.push_chunk(b"\ndata: [DONE]\n\n", now).unwrap();

    assert_eq!(second.len(), 2);
    assert_eq!(second[0].as_bytes(), b"data: {\"model\":\"untouched\"}\n\n");
    assert_eq!(second[1].as_bytes(), b"data: [DONE]\n\n");
}

#[test]
fn transport_frames_crlf_without_protocol_interpretation() {
    let policy = SseTransportPolicy::new(128, 128, Duration::from_secs(30)).unwrap();
    let mut plugin = SseIngressPlugin::new(policy, Instant::now());
    let frames = plugin
        .push_chunk(b"event: opaque\r\ndata: bytes\r\n\r\n", Instant::now())
        .unwrap();
    assert_eq!(frames.len(), 1);
    assert_eq!(
        frames[0].as_bytes(),
        b"event: opaque\r\ndata: bytes\r\n\r\n"
    );
}

#[test]
fn transport_bounds_buffer_and_timeout_without_terminal_inference() {
    let start = Instant::now();
    let policy = SseTransportPolicy::new(8, 32, Duration::from_millis(5)).unwrap();
    let mut overflow = SseIngressPlugin::new(policy, start);
    assert_eq!(
        overflow.push_chunk(b"123456789", start),
        Err(SseTransportError::BufferLimitExceeded)
    );

    let policy = SseTransportPolicy::new(32, 32, Duration::from_millis(5)).unwrap();
    let mut timed_out = SseIngressPlugin::new(policy, start);
    assert_eq!(
        timed_out.push_chunk(b": keepalive\n\n", start + Duration::from_millis(6)),
        Err(SseTransportError::InactivityTimeout)
    );
}

#[test]
fn egress_preserves_order_applies_backpressure_and_drains_closeout() {
    let start = Instant::now();
    let policy = SseTransportPolicy::new(64, 20, Duration::from_secs(30)).unwrap();
    let mut plugin = SseEgressPlugin::new(policy, start);
    let first = SseTransportFrame::from_complete_bytes(b"data: one\n\n".to_vec()).unwrap();
    let second = SseTransportFrame::from_complete_bytes(b"data: two\n\n".to_vec()).unwrap();

    plugin.enqueue(first.clone(), start).unwrap();
    assert_eq!(
        plugin.enqueue(second.clone(), start),
        Err(SseTransportError::Backpressure)
    );
    assert_eq!(plugin.pop(), Some(first));
    plugin.enqueue(second.clone(), start).unwrap();
    assert_eq!(plugin.drain_closeout(), vec![second]);
    assert_eq!(
        SseEgressPlugin::keepalive_frame().as_bytes(),
        b": keepalive\n\n"
    );
}

#[test]
fn frame_clones_share_the_same_payload_allocation() {
    let source: Arc<[u8]> = Arc::from(&b"data: shared\n\n"[..]);
    let frame = SseTransportFrame::from_shared_bytes(Arc::clone(&source)).unwrap();
    let cloned = frame.clone();
    let frame_bytes = frame.shared_bytes();
    let cloned_bytes = cloned.shared_bytes();

    assert!(Arc::ptr_eq(&source, &frame_bytes));
    assert!(Arc::ptr_eq(&frame_bytes, &cloned_bytes));
}
