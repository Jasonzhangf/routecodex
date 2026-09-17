use std::path::Path;
use std::thread;
use std::time::Duration;

use routecodex_v3_hooks::{
    hooks_unavailable, AppServerSocketConfig, ControlServer, HookHandlersConfig,
    HooksUnavailableReason, NativeAppServerTransport, PROTOCOL,
};

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    let once = args.iter().any(|arg| arg == "--once");
    let socket = next_arg(&args, "--socket");
    let appserver_socket = next_arg(&args, "--appserver-socket");
    let tui_appserver_socket = next_arg(&args, "--tui-appserver-socket");
    let desktop_appserver_socket = next_arg(&args, "--desktop-appserver-socket");
    let handlers_config = next_arg(&args, "--handlers-config");
    let state_file = next_arg(&args, "--state-file");
    let probe_appserver = next_arg(&args, "--probe-appserver");

    if once {
        if let Some(appserver_socket) = probe_appserver.as_deref() {
            print_probe_appserver(appserver_socket);
            return;
        }
        print_ready(socket.as_deref(), state_file.as_deref());
        return;
    }

    if let Some(appserver_socket) = probe_appserver.as_deref() {
        print_probe_appserver(appserver_socket);
        return;
    }

    if let Some(socket) = socket.as_deref() {
        let appserver_sockets = AppServerSocketConfig {
            default: appserver_socket,
            codex_tui: tui_appserver_socket,
            codex_app: desktop_appserver_socket,
        };
        let handlers_config = match handlers_config.as_deref() {
            Some(path) => match std::fs::File::open(path)
                .map_err(|error| error.to_string())
                .and_then(|file| {
                    serde_json::from_reader::<_, HookHandlersConfig>(file)
                        .map_err(|error| error.to_string())
                }) {
                Ok(config) => Some(config),
                Err(error) => {
                    eprintln!("rccv3-hooksd handler config failed: {error}");
                    std::process::exit(1);
                }
            },
            None => None,
        };
        // The transport is selected from the actual socket configuration, but
        // handlers and persisted state load whenever either is supplied. A
        // handler-only configuration therefore mounts its registry and fails
        // closed on send instead of advertising an unreachable native route.
        let server = if appserver_sockets.has_any_socket() || handlers_config.is_some() {
            ControlServer::with_appserver_sockets_handlers_and_state(
                Path::new(socket),
                appserver_sockets,
                handlers_config,
                state_file.as_deref().map(Path::new),
            )
        } else if state_file.is_some() {
            ControlServer::with_state(Path::new(socket), state_file.as_deref().map(Path::new))
        } else {
            ControlServer::new(Path::new(socket))
        };
        let server = match server {
            Ok(server) => server,
            Err(error) => {
                eprintln!("rccv3-hooksd control socket failed: {error}");
                std::process::exit(1);
            }
        };
        print_ready(Some(socket), state_file.as_deref());
        if let Err(error) = server.serve_forever() {
            eprintln!("rccv3-hooksd control server failed: {error}");
            std::process::exit(1);
        }
        return;
    }

    print_ready(socket.as_deref(), state_file.as_deref());
    loop {
        thread::sleep(Duration::from_secs(3600));
    }
}

fn print_ready(socket: Option<&str>, state_file: Option<&str>) {
    let readiness = serde_json::json!({
        "protocol": PROTOCOL,
        "ready": true,
        "control_socket": socket,
        "state_file": state_file,
        "hooks": {
            "unavailable": hooks_unavailable(HooksUnavailableReason::Disabled),
            "message": "rccv3-hooksd readiness"
        }
    });
    println!("{}", readiness);
}

fn print_probe_appserver(appserver_socket: &str) {
    let mut transport = NativeAppServerTransport::new(appserver_socket);
    match transport.loaded_threads() {
        Ok(loaded_threads) => {
            let probe = serde_json::json!({
                "protocol": PROTOCOL,
                "probe": "appserver",
                "ok": true,
                "appserver_socket": appserver_socket,
                "loaded_threads": loaded_threads
            });
            println!("{}", probe);
        }
        Err(error) => {
            let probe = serde_json::json!({
                "protocol": PROTOCOL,
                "probe": "appserver",
                "ok": false,
                "appserver_socket": appserver_socket,
                "error": error.to_string()
            });
            println!("{}", probe);
        }
    }
}

fn next_arg(args: &[String], name: &str) -> Option<String> {
    args.iter().position(|arg| arg == name).and_then(|index| {
        args.get(index + 1)
            .filter(|value| !value.starts_with("--"))
            .cloned()
    })
}
