use clap::{Parser, Subcommand};
use servertool_core::cli_contract::{
    build_servertool_cli_binary_run_command_from_client_exec_result, ServertoolCliRunInput,
    ServertoolCliRunOutput,
};

#[derive(Debug, Parser)]
#[command(name = "routecodex-servertool")]
#[command(about = "RouteCodex servertool Rust binary")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    Run {
        tool_name: String,
        #[arg(long = "input-json")]
        input_json: String,
        #[arg(long = "flow")]
        flow: Option<String>,
        #[arg(long = "repeat-count")]
        repeat_count: Option<u32>,
        #[arg(long = "max-repeats")]
        max_repeats: Option<u32>,
        #[arg(long = "session-id")]
        session_id: Option<String>,
        #[arg(long = "request-id")]
        request_id: Option<String>,
    },
}

fn main() {
    if let Err(error) = run() {
        eprintln!("{error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let cli = Cli::parse();
    match cli.command {
        Command::Run {
            tool_name,
            input_json,
            flow,
            repeat_count,
            max_repeats,
            session_id,
            request_id,
        } => {
            let input = serde_json::from_str(&input_json)
                .map_err(|e| format!("SERVERTOOL_CLI_INVALID_JSON: {e}"))?;
            let output = build_servertool_cli_binary_run_command_from_client_exec_result(
                ServertoolCliRunInput {
                    tool_name,
                    input,
                    flow_id: flow,
                    repeat_count,
                    max_repeats,
                    session_id,
                    request_id,
                },
            )?;
            persist_stopless_continuation_state(&output);
            println!("{}", serde_json::to_string(&output)?);
        }
    }
    Ok(())
}

/// Write the stopless continuation `used + 1` back to the same
/// `session:<sessionId>` key that the next CLI invocation will read from.
/// Failures are non-fatal: stdout remains the request-local truth, while the
/// persisted session snapshot is best-effort state for the next stopless turn.
fn persist_stopless_continuation_state(output: &ServertoolCliRunOutput) {
    if output.kind != "stop_message_auto" {
        return;
    }
    let Some(session_id) = output.session_id.as_deref().map(str::trim).filter(|v| !v.is_empty()) else {
        return;
    };
    let request_id = output.request_id.clone().unwrap_or_default();
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let used_u64 = u64::from(output.repeat_count);
    let max_repeats_u64 = u64::from(output.max_repeats);
    let next_used = used_u64.min(max_repeats_u64);
    let _exhausted = output
        .schema_guidance
        .as_ref()
        .map(|guidance| guidance.trigger_hint.as_str())
        == Some("budget_exhausted");
    // budget_exhausted 不能清空 persisted text。
    // `record_stopless_continuation_state()` 对空 text 会直接 clear session state，
    // caller 下一次又会从 repeatCount=1 重新 armed，导致 exhausted 后还能重开 stopless。
    // 这里保留 terminal prompt，并把 used=max 持久化，下一次同 session 命中时只能继续
    // 回到 terminal exhausted，而不是重新开始。
    let persisted_text = &output.continuation_prompt;
    let record = match servertool_core::persisted_lookup::record_stopless_continuation_state(
        session_id,
        &request_id,
        persisted_text,
        next_used,
        max_repeats_u64,
        now_ms,
    ) {
        Ok(record) => record,
        Err(error) => {
            eprintln!("[servertool-cli] record_stopless_continuation_state: {error}");
            return;
        }
    };
    if let Err(error) =
        servertool_core::persisted_state_fs_write::save_persisted_runtime_stop_message_state(
            session_id, &record,
        )
    {
        eprintln!("[servertool-cli] save_persisted_runtime_stop_message_state: {error}");
    }
}
