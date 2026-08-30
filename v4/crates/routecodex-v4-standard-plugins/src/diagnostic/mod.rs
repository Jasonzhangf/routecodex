//! Diagnostic category marker and shell projection formatter.
//!
//! The formatter is deliberately observation-only: it receives already typed
//! lifecycle/request facts and returns terminal text. It never reads or
//! reconstructs business payload/control state.

const ANSI_RESET: &str = "\x1b[0m";
const ANSI_CYAN: &str = "\x1b[36m";
const ANSI_GREEN: &str = "\x1b[32m";
const ANSI_DIM: &str = "\x1b[2;90m";

fn colorize(color: &str, text: String) -> String {
    if std::env::var_os("NO_COLOR").is_some() {
        text
    } else {
        format!("{color}{text}{ANSI_RESET}")
    }
}

pub fn format_startup(
    identity: &str,
    version: &str,
    binary: &str,
    listeners: &[String],
) -> (String, String) {
    let addresses = listeners.join(", ");
    let headline = colorize(
        ANSI_GREEN,
        format!("[RouteCodexV4] Server started on {addresses}"),
    );
    let debug = colorize(
        ANSI_DIM,
        format!("event=started identity={identity} version={version} binary={binary} addresses={addresses}"),
    );
    (headline, debug)
}

pub fn format_request(endpoint: &str, request_id: &str, model: &str, target: &str) -> String {
    colorize(
        ANSI_CYAN,
        format!("▶ [{endpoint}] req={request_id} model={model} target={target}"),
    )
}

pub fn format_response(endpoint: &str, request_id: &str, status: u16, model: &str) -> String {
    colorize(
        ANSI_GREEN,
        format!("✅ [{endpoint}] req={request_id} status={status} model={model}"),
    )
}
