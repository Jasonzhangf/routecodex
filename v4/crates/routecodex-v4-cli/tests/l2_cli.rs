use routecodex_v4_cli::{Cli, ConfigIntent, ServerIntent, V4CommandIntent};

const VERSION: &str = "0.1.0-test";

fn parse(args: &[&str]) -> Result<Cli, clap::Error> {
    Cli::parse_with_version(args.iter().copied(), VERSION)
}

#[test]
fn no_args_maps_to_start_intent() {
    match parse(&["rccv4"]).expect("parse").command_or_start() {
        V4CommandIntent::Start(intent) => assert!(!intent.foreground),
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn config_check_is_typed_and_does_not_touch_runtime() {
    let cli = parse(&["rccv4", "config", "check", "-c", "/tmp/config.v4.toml"]).expect("parse");
    match cli.command.expect("command") {
        V4CommandIntent::Config {
            command: ConfigIntent::Check(intent),
        } => assert_eq!(intent.config.unwrap().to_str(), Some("/tmp/config.v4.toml")),
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn start_snapshot_flags_are_typed() {
    let cli = parse(&[
        "rccv4",
        "start",
        "--snap",
        "--snap-stages",
        "req_inbound,resp_outbound",
        "--debug",
    ])
    .expect("parse");
    match cli.command.expect("command") {
        V4CommandIntent::Start(intent) => {
            assert!(intent.snapshot.snap);
            assert!(intent.snapshot.debug);
            assert_eq!(
                intent.snapshot.snap_stages.as_deref(),
                Some("req_inbound,resp_outbound")
            );
        }
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn start_foreground_is_explicit_and_typed() {
    let cli = parse(&["rccv4", "start", "--foreground"]).expect("parse");
    match cli.command.expect("command") {
        V4CommandIntent::Start(intent) => assert!(intent.foreground),
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn start_defaults_to_managed_console_observation() {
    let cli = parse(&["rccv4", "start"]).expect("parse");
    match cli.command.expect("command") {
        V4CommandIntent::Start(intent) => assert!(!intent.foreground),
        other => panic!("unexpected command: {other:?}"),
    }
}

#[test]
fn hidden_managed_child_requires_absolute_inputs_from_dispatcher() {
    let cli = parse(&[
        "rccv4",
        "server",
        "run-managed-child",
        "--manifest",
        "/tmp/manifest.json",
        "--config",
        "/tmp/config.v4.toml",
    ])
    .expect("parse");
    assert!(matches!(
        cli.command.expect("command"),
        V4CommandIntent::Server {
            command: ServerIntent::RunManagedChild(_)
        }
    ));
}

#[test]
fn rejects_conflicting_or_invalid_options() {
    assert!(parse(&["rccv4", "start", "--snap", "--snapall"]).is_err());
    assert!(parse(&["rccv4", "start", "--snap-stages", " "]).is_err());
    assert!(parse(&["rccv4", "unknown"]).is_err());
    assert!(parse(&[
        "rccv4",
        "init",
        "--api-key",
        "secret",
        "--token-file",
        "/tmp/token"
    ])
    .is_err());
}

#[test]
fn help_and_version_are_parser_only_early_exits() {
    let help = parse(&["rccv4", "--help"]).expect_err("help exits through clap");
    assert_eq!(help.kind(), clap::error::ErrorKind::DisplayHelp);
    let version = parse(&["rccv4", "--version"]).expect_err("version exits through clap");
    assert_eq!(version.kind(), clap::error::ErrorKind::DisplayVersion);
    assert!(version.to_string().contains(VERSION));
}
