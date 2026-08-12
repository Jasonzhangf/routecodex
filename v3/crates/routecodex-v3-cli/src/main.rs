use clap::{Parser, Subcommand};
use routecodex_v3_config::{
    default_v3_config_path, resolve_routecodex_package_version_from_executable,
    V3Config05ManifestPublished, V3ConfigStore,
};
use routecodex_v3_lifecycle::{
    V3ManagedLifecycle, V3ManagedLifecycleObservation, V3ManagedListenerDeclaration,
    V3ManagedStatusRecord,
};
use servertool_core::cli_contract::{
    build_servertool_cli_binary_run_command_from_client_exec_result, ServertoolCliRunInput,
};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

#[derive(Parser)]
#[command(name = "rccv3")]
struct Args {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    Config {
        #[command(subcommand)]
        command: ConfigCommand,
    },
    Start {
        #[arg(short, long)]
        config: Option<String>,
        #[arg(long, default_value_t = false, conflicts_with = "snapall")]
        snap: bool,
        #[arg(long, default_value_t = false, conflicts_with = "snap")]
        snapall: bool,
        #[arg(long, value_parser = parse_non_empty_snapshot_stages)]
        snap_stages: Option<String>,
        #[arg(long, default_value_t = false)]
        debug: bool,
    },
    Status {
        #[arg(short, long)]
        config: Option<String>,
    },
    Restart {
        #[arg(short, long)]
        config: Option<String>,
        #[arg(long, default_value_t = 15_000)]
        timeout_ms: u64,
        #[arg(long, default_value_t = false, conflicts_with = "snapall")]
        snap: bool,
        #[arg(long, default_value_t = false, conflicts_with = "snap")]
        snapall: bool,
        #[arg(long, value_parser = parse_non_empty_snapshot_stages)]
        snap_stages: Option<String>,
        #[arg(long, default_value_t = false)]
        debug: bool,
    },
    Stop {
        #[arg(short, long)]
        config: Option<String>,
        #[arg(long, default_value_t = 15_000)]
        timeout_ms: u64,
    },
    Servertool {
        #[command(subcommand)]
        command: ServertoolCommand,
    },
    #[command(hide = true)]
    Server {
        #[command(subcommand)]
        command: ServerCommand,
    },
}

#[derive(Subcommand)]
enum ServertoolCommand {
    Run {
        tool_name: String,
        #[arg(long = "input-json")]
        input_json: String,
        #[arg(long = "flow")]
        flow: Option<String>,
        #[arg(long = "session-id")]
        session_id: Option<String>,
        #[arg(long = "request-id")]
        request_id: Option<String>,
    },
}

#[derive(Subcommand)]
enum ConfigCommand {
    Check {
        #[arg(short, long)]
        config: Option<String>,
    },
}

#[derive(Subcommand)]
enum ServerCommand {
    Start {
        #[arg(short, long)]
        config: Option<String>,
        #[arg(long, default_value_t = false)]
        foreground: bool,
        #[arg(long, default_value_t = false, conflicts_with = "snapall")]
        snap: bool,
        #[arg(long, default_value_t = false, conflicts_with = "snap")]
        snapall: bool,
        #[arg(long, value_parser = parse_non_empty_snapshot_stages)]
        snap_stages: Option<String>,
        #[arg(long, default_value_t = false)]
        debug: bool,
    },
    Status {
        #[arg(short, long)]
        config: Option<String>,
    },
    Restart {
        #[arg(short, long)]
        config: Option<String>,
        #[arg(long, default_value_t = 15_000)]
        timeout_ms: u64,
        #[arg(long, default_value_t = false, conflicts_with = "snapall")]
        snap: bool,
        #[arg(long, default_value_t = false, conflicts_with = "snap")]
        snapall: bool,
        #[arg(long, value_parser = parse_non_empty_snapshot_stages)]
        snap_stages: Option<String>,
        #[arg(long, default_value_t = false)]
        debug: bool,
    },
    Stop {
        #[arg(short, long)]
        config: Option<String>,
        #[arg(long, default_value_t = 15_000)]
        timeout_ms: u64,
    },
    #[command(hide = true)]
    RunManagedChild {
        #[arg(short, long)]
        config: Option<String>,
        #[arg(long, default_value_t = false, conflicts_with = "snapall")]
        snap: bool,
        #[arg(long, default_value_t = false, conflicts_with = "snap")]
        snapall: bool,
        #[arg(long, value_parser = parse_non_empty_snapshot_stages)]
        snap_stages: Option<String>,
        #[arg(long, default_value_t = false)]
        console: bool,
    },
}

#[tokio::main]
async fn main() {
    if let Err(error) = run_cli().await {
        eprintln!("[RouteCodexV3] command failed: {error}");
        std::process::exit(1);
    }
}

async fn run_cli() -> Result<(), Box<dyn std::error::Error>> {
    if should_print_version() {
        let executable = std::env::current_exe()?;
        println!(
            "rccv3 {} (crate {})",
            resolve_routecodex_package_version_from_executable(&executable)
                .unwrap_or_else(|| "unknown".to_string()),
            env!("CARGO_PKG_VERSION")
        );
        return Ok(());
    }
    match Args::parse().command {
        Command::Config {
            command: ConfigCommand::Check { config },
        } => {
            let config = resolve_config_path(config)?;
            let manifest = load_manifest(&config)?;
            println!(
                "config ok: version={} servers={}",
                manifest.version,
                manifest.servers.len()
            );
        }
        Command::Servertool {
            command:
                ServertoolCommand::Run {
                    tool_name,
                    input_json,
                    flow,
                    session_id,
                    request_id,
                },
        } => {
            let input = serde_json::from_str(&input_json)
                .map_err(|error| format!("SERVERTOOL_CLI_INVALID_JSON: {error}"))?;
            let output = build_servertool_cli_binary_run_command_from_client_exec_result(
                ServertoolCliRunInput {
                    tool_name,
                    input,
                    flow_id: flow,
                    repeat_count: None,
                    max_repeats: None,
                    session_id,
                    request_id,
                },
            )?;
            println!("{}", serde_json::to_string(&output)?);
        }
        Command::Start {
            config,
            snap,
            snapall,
            snap_stages,
            debug,
        } => {
            let config = resolve_config_path(config)?;
            let executable = std::env::current_exe()?;
            let manifest = load_manifest(&config)?;
            let snap_flags = resolve_v3_cli_snapshot_flags(snap, snapall, snap_stages);
            let debug = resolve_v3_cli_debug_flag(debug);
            emit_v3_cli_start_console_line(
                "start",
                &config,
                &executable,
                snap_flags.snap,
                snap_flags.snapall,
                snap_flags.snap_stages.as_deref(),
                debug,
            );
            emit_v3_cli_server_started_console_line(&manifest, &executable);
            configure_v3_snapshot_flags(
                V3ManagedLifecycle::new(config)?,
                snap_flags.snap,
                snap_flags.snapall,
                snap_flags.snap_stages,
            )
            .with_console_enabled(true)
            .start_foreground(&executable)
            .await?;
        }
        Command::Server {
            command:
                ServerCommand::Start {
                    config,
                    foreground,
                    snap,
                    snapall,
                    snap_stages,
                    debug,
                },
        } => {
            let config = resolve_config_path(config)?;
            let snap_flags = resolve_v3_cli_snapshot_flags(snap, snapall, snap_stages);
            let debug = resolve_v3_cli_debug_flag(debug);
            if foreground {
                let executable = std::env::current_exe()?;
                emit_v3_cli_start_console_line(
                    "server start --foreground",
                    &config,
                    &executable,
                    snap_flags.snap,
                    snap_flags.snapall,
                    snap_flags.snap_stages.as_deref(),
                    debug,
                );
                configure_v3_snapshot_flags(
                    V3ManagedLifecycle::new(config)?,
                    snap_flags.snap,
                    snap_flags.snapall,
                    snap_flags.snap_stages,
                )
                .with_console_enabled(debug)
                .start_foreground(&executable)
                .await?;
            } else {
                let executable = std::env::current_exe()?;
                let manifest = load_manifest(&config)?;
                emit_v3_cli_start_console_line(
                    "server start",
                    &config,
                    &executable,
                    snap_flags.snap,
                    snap_flags.snapall,
                    snap_flags.snap_stages.as_deref(),
                    debug,
                );
                let status = configure_v3_snapshot_flags(
                    V3ManagedLifecycle::new(config)?,
                    snap_flags.snap,
                    snap_flags.snapall,
                    snap_flags.snap_stages,
                )
                .with_console_enabled(debug)
                .start(&executable, Duration::from_secs(15))
                .await?;
                emit_v3_cli_start_completed_console_line(&status);
                emit_v3_cli_server_started_console_line(&manifest, &executable);
                println!("{}", serde_json::to_string(&status)?);
            }
        }
        Command::Server {
            command: ServerCommand::Status { config },
        }
        | Command::Status { config } => {
            let config = resolve_config_path(config)?;
            let manifest = load_manifest(&config)?;
            for server in manifest.servers.values() {
                println!(
                    "{} enabled={} address={}:{}",
                    server.id, server.enabled, server.bind, server.port
                );
            }
            let executable = std::env::current_exe()?;
            let status = V3ManagedLifecycle::new(config)?.status(&executable).await?;
            println!("{}", serde_json::to_string(&status)?);
        }
        Command::Server {
            command:
                ServerCommand::Restart {
                    config,
                    timeout_ms,
                    snap,
                    snapall,
                    snap_stages,
                    debug,
                },
        } => {
            let config = resolve_config_path(config)?;
            let executable = std::env::current_exe()?;
            let snap_flags = resolve_v3_cli_snapshot_flags(snap, snapall, snap_stages);
            let debug = resolve_v3_cli_debug_flag(debug);
            let status = configure_v3_snapshot_flags(
                V3ManagedLifecycle::new(config)?,
                snap_flags.snap,
                snap_flags.snapall,
                snap_flags.snap_stages,
            )
            .with_console_enabled(debug)
            .restart(&executable, Duration::from_millis(timeout_ms))
            .await?;
            println!("{}", serde_json::to_string(&status)?);
        }
        Command::Restart {
            config,
            timeout_ms,
            snap,
            snapall,
            snap_stages,
            debug,
        } => {
            let config = resolve_config_path(config)?;
            let executable = std::env::current_exe()?;
            let snap_flags = resolve_v3_cli_snapshot_flags(snap, snapall, snap_stages);
            let debug = resolve_v3_cli_debug_flag(debug);
            emit_v3_cli_start_console_line(
                "restart",
                &config,
                &executable,
                snap_flags.snap,
                snap_flags.snapall,
                snap_flags.snap_stages.as_deref(),
                debug,
            );
            let manifest = load_manifest(&config)?;
            let status = configure_v3_snapshot_flags(
                V3ManagedLifecycle::new(config)?,
                snap_flags.snap,
                snap_flags.snapall,
                snap_flags.snap_stages,
            )
            .with_console_enabled(debug)
            .restart_with_observer(
                &executable,
                Duration::from_millis(timeout_ms),
                emit_v3_cli_lifecycle_observation,
            )
            .await?;
            emit_v3_cli_restart_completed_console_line(&status);
            emit_v3_cli_server_started_console_line(&manifest, &executable);
            println!("{}", serde_json::to_string(&status)?);
        }
        Command::Server {
            command: ServerCommand::Stop { config, timeout_ms },
        }
        | Command::Stop { config, timeout_ms } => {
            let config = resolve_config_path(config)?;
            let executable = std::env::current_exe()?;
            emit_v3_cli_stop_console_line(&config, &executable, timeout_ms);
            let status = V3ManagedLifecycle::new(config)?
                .stop(&executable, Duration::from_millis(timeout_ms))
                .await?;
            emit_v3_cli_stop_completed_console_line(&status);
            println!("{}", serde_json::to_string(&status)?);
        }
        Command::Server {
            command:
                ServerCommand::RunManagedChild {
                    config,
                    snap,
                    snapall,
                    snap_stages,
                    console,
                },
        } => {
            let config = resolve_config_path(config)?;
            let executable = std::env::current_exe()?;
            configure_v3_snapshot_flags(
                V3ManagedLifecycle::new(config)?,
                snap,
                snapall,
                snap_stages,
            )
            .with_console_enabled(console)
            .run_managed_child(&executable)
            .await?;
        }
    }
    Ok(())
}

fn resolve_config_path(config: Option<String>) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if let Some(config) = config {
        return Ok(PathBuf::from(config));
    }
    let home = std::env::var_os("HOME").ok_or_else(|| {
        std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "HOME is required to resolve config.v3.toml",
        )
    })?;
    Ok(default_v3_config_path(home))
}

fn load_manifest(
    config: impl Into<PathBuf>,
) -> Result<V3Config05ManifestPublished, Box<dyn std::error::Error>> {
    Ok(V3ConfigStore::new(config).load_snapshot()?)
}

struct V3CliSnapshotFlags {
    snap: bool,
    snapall: bool,
    snap_stages: Option<String>,
}

fn resolve_v3_cli_snapshot_flags(
    snap: bool,
    snapall: bool,
    snap_stages: Option<String>,
) -> V3CliSnapshotFlags {
    V3CliSnapshotFlags {
        snap: snap || v3_cli_env_flag("ROUTECODEX_V3_DEV_DEFAULT_SNAP"),
        snapall,
        snap_stages,
    }
}

fn resolve_v3_cli_debug_flag(debug: bool) -> bool {
    debug || v3_cli_env_flag("ROUTECODEX_V3_DEV_DEFAULT_DEBUG")
}

fn v3_cli_env_flag(name: &str) -> bool {
    let Ok(value) = std::env::var(name) else {
        return false;
    };
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn configure_v3_snapshot_flags(
    lifecycle: V3ManagedLifecycle,
    snap: bool,
    snapall: bool,
    snapshot_stages: Option<String>,
) -> V3ManagedLifecycle {
    let snapshot_stages = snapshot_stages
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());
    let enabled = snap || snapall || snapshot_stages.is_some();
    lifecycle
        .with_snapshots_enabled(enabled)
        .with_direct_snapshots_enabled(snapall)
        .with_snapshot_stages(snapshot_stages)
}

fn parse_non_empty_snapshot_stages(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("--snap-stages must not be blank".to_string());
    }
    Ok(value.to_string())
}

fn should_print_version() -> bool {
    let mut args = std::env::args().skip(1);
    let Some(first) = args.next() else {
        return false;
    };
    args.next().is_none() && matches!(first.as_str(), "--version" | "-V" | "version")
}

fn emit_v3_cli_start_console_line(
    command: &str,
    config: &Path,
    executable: &Path,
    snap: bool,
    snapall: bool,
    snap_stages: Option<&str>,
    debug: bool,
) {
    println!(
        "[RouteCodexV3] rccv3 {command} version={} crate={} binary={} config={} snap={} snapall={} snap_stages={} debug={}",
        resolve_routecodex_package_version_from_executable(executable)
            .unwrap_or_else(|| "unknown".to_string()),
        env!("CARGO_PKG_VERSION"),
        executable.display(),
        config.display(),
        snap,
        snapall,
        snap_stages.unwrap_or(""),
        debug
    );
    flush_stdout_best_effort();
}

fn emit_v3_cli_start_completed_console_line(status: &V3ManagedStatusRecord) {
    println!(
        "[RouteCodexV3] Start completed state={} instance={}",
        format!("{:?}", status.state).to_ascii_lowercase(),
        status.instance_id
    );
    flush_stdout_best_effort();
}

fn emit_v3_cli_stop_console_line(config: &Path, executable: &Path, timeout_ms: u64) {
    println!(
        "[RouteCodexV3] rccv3 stop version={} crate={} binary={} config={} timeout_ms={}",
        resolve_routecodex_package_version_from_executable(executable)
            .unwrap_or_else(|| "unknown".to_string()),
        env!("CARGO_PKG_VERSION"),
        executable.display(),
        config.display(),
        timeout_ms
    );
    flush_stdout_best_effort();
}

fn emit_v3_cli_restart_completed_console_line(status: &V3ManagedStatusRecord) {
    println!(
        "[RouteCodexV3] Restart completed state={} instance={}",
        format!("{:?}", status.state).to_ascii_lowercase(),
        status.instance_id
    );
    flush_stdout_best_effort();
}

fn emit_v3_cli_stop_completed_console_line(status: &V3ManagedStatusRecord) {
    println!(
        "[RouteCodexV3] Stop completed state={} instance={}",
        format!("{:?}", status.state).to_ascii_lowercase(),
        status.instance_id
    );
    flush_stdout_best_effort();
}

fn emit_v3_cli_lifecycle_observation(observation: V3ManagedLifecycleObservation) {
    match observation {
        V3ManagedLifecycleObservation::RestartTargetResolved {
            instance_id,
            control_instance_id,
            listeners,
        } => {
            println!(
                "[RouteCodexV3] Restart target resolved instance={} control_instance={} listeners={}",
                instance_id,
                control_instance_id,
                format_v3_managed_listener_declarations(&listeners)
            );
            flush_stdout_best_effort();
        }
        V3ManagedLifecycleObservation::RestartControlAccepted {
            instance_id,
            state,
            message,
        } => {
            println!(
                "[RouteCodexV3] Restart control accepted state={} instance={} message={}",
                format!("{:?}", state).to_ascii_lowercase(),
                instance_id,
                message
            );
            flush_stdout_best_effort();
        }
        V3ManagedLifecycleObservation::RestartStatusObserved { status } => {
            let detail = status
                .detail
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .map(|value| format!(" detail={value}"))
                .unwrap_or_default();
            println!(
                "[RouteCodexV3] Restart status state={} instance={}{}",
                format!("{:?}", status.state).to_ascii_lowercase(),
                status.instance_id,
                detail
            );
            flush_stdout_best_effort();
        }
    }
}

fn format_v3_managed_listener_declarations(listeners: &[V3ManagedListenerDeclaration]) -> String {
    listeners
        .iter()
        .map(|listener| {
            format!(
                "{}:{}({})",
                listener.bind, listener.port, listener.server_id
            )
        })
        .collect::<Vec<_>>()
        .join(",")
}

fn emit_v3_cli_server_started_console_line(
    manifest: &V3Config05ManifestPublished,
    executable: &Path,
) {
    let addresses = manifest
        .servers
        .values()
        .filter(|server| server.enabled)
        .map(|server| format!("{}:{}", server.bind, server.port))
        .collect::<Vec<_>>()
        .join(", ");
    println!(
        "[RouteCodexV3] Server started version={} crate={} binary={} on {addresses}",
        resolve_routecodex_package_version_from_executable(executable)
            .unwrap_or_else(|| "unknown".to_string()),
        env!("CARGO_PKG_VERSION"),
        executable.display()
    );
    flush_stdout_best_effort();
}

fn flush_stdout_best_effort() {
    let _ = io::stdout().flush();
}
