use routecodex_v3_config::V3ConfigStore;
use routecodex_v3_runtime::V3AnthropicRelayRuntimeInput;
use routecodex_v3_server::execute_v3_anthropic_messages_request;
use serde_json::{json, Value};
use std::io::Read;
use std::path::PathBuf;

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut config = None;
    let mut args = std::env::args().skip(1);
    while let Some(argument) = args.next() {
        match argument.as_str() {
            "--config" => config = args.next().map(PathBuf::from),
            _ => return Err(format!("unknown driver argument: {argument}").into()),
        }
    }
    let config = config.ok_or("--config is required")?;
    let mut stdin = String::new();
    std::io::stdin().read_to_string(&mut stdin)?;
    let fixture: Value = serde_json::from_str(&stdin)?;
    let client_request = fixture
        .get("client_request")
        .cloned()
        .ok_or("fixture client_request is required")?;
    let manifest = V3ConfigStore::new(config).load_snapshot()?;
    let output = execute_v3_anthropic_messages_request(
        &manifest,
        V3AnthropicRelayRuntimeInput {
            server_id: "controlled".to_string(),
            request_id: format!(
                "controlled-{}",
                fixture
                    .get("case_id")
                    .and_then(Value::as_str)
                    .unwrap_or("fixture")
            ),
            payload: client_request,
        },
    )
    .await?;
    println!(
        "{}",
        serde_json::to_string(&json!({
            "status": output.status,
            "client_response": output.client_response,
            "node_trace": output.node_trace,
            "error_chain": output.error_chain,
        }))?
    );
    Ok(())
}
