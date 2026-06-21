use clap::{Parser, Subcommand};
use servertool_core::cli_contract::{
    build_servertool_cli_binary_run_command_from_client_exec_result, ServertoolCliRunInput,
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
            println!("{}", serde_json::to_string(&output)?);
        }
    }
    Ok(())
}
