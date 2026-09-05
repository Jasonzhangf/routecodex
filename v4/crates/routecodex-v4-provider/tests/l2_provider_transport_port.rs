use routecodex_v4_provider::{ProviderTransportPort, ProviderTransportRequest};
use std::fs;
use serde_json::json;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::thread;

#[test]
fn typed_transport_port_rejects_unsupported_protocol_before_io() {
    let request = ProviderTransportRequest::new(
        "unsupported",
        "/missing/profile.toml",
        None,
        "model",
        json!({"input": []}),
        false,
    )
    .expect("request shape is valid");
    let error = ProviderTransportPort::execute(request)
        .expect_err("unsupported protocol must fail at provider port before profile I/O");
    assert_eq!(error.code, "provider_protocol_unsupported");
}

#[test]
fn typed_transport_request_rejects_control_payload() {
    let error = ProviderTransportRequest::new(
        "responses",
        "/profile.toml",
        None,
        "model",
        json!({"metadata": {"route": "internal"}}),
        false,
    )
    .expect_err("control payload must not cross the typed provider boundary");
    assert_eq!(error.code, "provider_control_payload_leak");
}

#[test]
fn provider_transport_has_no_legacy_semantic_dispatchers() {
    let source = fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/lib.rs"))
        .expect("provider source must be readable");
    for symbol in [
        "pub fn resolve_model(",
        "pub fn send_responses(",
        "pub fn send_responses_streaming(",
        "pub fn build_retry_wire(",
        "pub fn build_openai_chat_wire(",
        "pub fn build_anthropic_messages_wire(",
        "pub fn build_protocol_wire(",
        "pub fn send_openai_chat(",
        "pub fn send_anthropic_messages(",
    ] {
        assert!(
            !source.contains(symbol),
            "legacy semantic dispatcher remains in provider transport owner: {symbol}"
        );
    }
}

#[test]
fn provider_transport_preserves_plugin_built_wire_without_semantic_injection() {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind provider fixture");
    let address = listener.local_addr().expect("provider fixture address");
    let profile_path = std::env::temp_dir().join(format!(
        "routecodex-v4-provider-port-{}-{}.toml",
        std::process::id(),
        address.port()
    ));
    std::fs::write(
        &profile_path,
        format!(
            "providerId = \"fixture\"\n\n[provider]\nbaseURL = \"http://{address}\"\ndefaultModel = \"selected-model\"\ntype = \"responses\"\n\n[provider.models.selected-model]\nwireName = \"selected-model\"\n\n[provider.auth]\napiKey = \"fixture-key\"\n"
        ),
    )
    .expect("write provider fixture");
    let server = thread::spawn(move || {
        let (mut stream, _) = listener.accept().expect("accept provider request");
        let mut request = Vec::new();
        let mut buffer = [0u8; 4096];
        let body_start = loop {
            let count = stream.read(&mut buffer).expect("read provider request");
            assert!(count > 0, "provider request ended before headers");
            request.extend_from_slice(&buffer[..count]);
            if let Some(index) = request.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
        };
        let headers = std::str::from_utf8(&request[..body_start]).expect("request headers");
        let content_length = headers
            .lines()
            .find_map(|line| line.strip_prefix("content-length: "))
            .and_then(|value| value.parse::<usize>().ok())
            .expect("content length");
        while request.len() - body_start < content_length {
            let count = stream.read(&mut buffer).expect("read provider body");
            assert!(count > 0, "provider request ended before body");
            request.extend_from_slice(&buffer[..count]);
        }
        stream
            .write_all(b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 2\r\nconnection: close\r\n\r\n{}")
            .expect("write provider response");
        serde_json::from_slice::<serde_json::Value>(
            &request[body_start..body_start + content_length],
        )
        .expect("provider body JSON")
    });
    let request = ProviderTransportRequest::new(
        "responses",
        profile_path.to_str().expect("profile path utf8"),
        None,
        "selected-model",
        json!({"model":"semantic-model","input":[],"stream":true}),
        false,
    )
    .expect("typed provider request");
    let response = ProviderTransportPort::execute(request).expect("provider response");
    let body = server.join().expect("provider fixture thread");
    let _ = std::fs::remove_file(profile_path);
    match response {
        routecodex_v4_provider::ProviderTransportResult::Response(response) => {
            assert_eq!(response.status, 200);
        }
        routecodex_v4_provider::ProviderTransportResult::Stream(_) => {
            panic!("non-stream request returned stream")
        }
    }
    assert_eq!(body["model"], "semantic-model");
    assert_eq!(body["stream"], true);
}
