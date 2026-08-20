//! V4 CLI plugin — thin binary shim that forwards `pub fn run()` into a
//! process exit code. All CLI logic lives in `src/lib.rs` so build-link can
//! compile this crate as `--crate-type lib` for the consumer regression suite.

use std::process::ExitCode;

fn fail(message: impl AsRef<str>) -> ExitCode {
    eprintln!("[rccv4-plugin] {}", message.as_ref());
    ExitCode::from(2)
}

fn main() -> ExitCode {
    match routecodex_v4_cli_plugin::run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => fail(error),
    }
}
