use routecodex_v3_hooks::{
    hooks_unavailable, shared_hooks_root, HooksUnavailableReason, NativeAppServerTransport,
    SharedHooksDaemon, PROTOCOL, SHARED_HOOKS_PROTOCOL,
};

fn main() {
    let args = std::env::args().collect::<Vec<_>>();
    if args.len() == 2 && args[1] == "--help" {
        println!("Usage: rccv3-hooksd --shared-daemon | --once | --probe-appserver <socket>");
        return;
    }
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--once" | "--shared-daemon" => index += 1,
            "--probe-appserver" => {
                if args
                    .get(index + 1)
                    .is_none_or(|value| value.starts_with("--"))
                {
                    eprintln!("missing value for {}", args[index]);
                    std::process::exit(2);
                }
                index += 2;
            }
            _ => {
                eprintln!("unknown argument: {}", args[index]);
                std::process::exit(2);
            }
        }
    }
    if args.iter().any(|arg| arg == "--shared-daemon") {
        let result = shared_hooks_root()
            .and_then(|root| SharedHooksDaemon::bind(&root))
            .and_then(SharedHooksDaemon::serve);
        if let Err(error) = result {
            eprintln!("shared hooks daemon failed: {error}");
            std::process::exit(1);
        }
        return;
    }
    let once = args.iter().any(|arg| arg == "--once");
    let probe_appserver = next_arg(&args, "--probe-appserver");

    if once {
        if let Some(appserver_socket) = probe_appserver.as_deref() {
            print_probe_appserver(appserver_socket);
            return;
        }
        print_ready();
        return;
    }

    if let Some(appserver_socket) = probe_appserver.as_deref() {
        print_probe_appserver(appserver_socket);
        return;
    }

    eprintln!("rccv3-hooksd requires --shared-daemon, --once or --probe-appserver");
    std::process::exit(2);
}

fn print_ready() {
    let readiness = serde_json::json!({
        "protocol": PROTOCOL,
        "shared_registry_protocol": SHARED_HOOKS_PROTOCOL,
        "ready": true,
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
