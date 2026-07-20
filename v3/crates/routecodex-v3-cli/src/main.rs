use clap::{Parser, Subcommand};
use routecodex_v3_config::{
    default_v3_config_path, resolve_routecodex_package_version_from_executable,
    V3Config05ManifestPublished, V3ConfigStore,
};
use routecodex_v3_lifecycle::V3ManagedLifecycle;
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
        #[arg(long, default_value_t = false)]
        snap: bool,
        #[arg(long)]
        snap_stages: Option<String>,
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
        #[arg(long, default_value_t = false)]
        snap: bool,
        #[arg(long)]
        snap_stages: Option<String>,
    },
    Stop {
        #[arg(short, long)]
        config: Option<String>,
        #[arg(long, default_value_t = 15_000)]
        timeout_ms: u64,
    },
    #[command(hide = true)]
    Server {
        #[command(subcommand)]
        command: ServerCommand,
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
        #[arg(long, default_value_t = false)]
        snap: bool,
        #[arg(long)]
        snap_stages: Option<String>,
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
        #[arg(long, default_value_t = false)]
        snap: bool,
        #[arg(long)]
        snap_stages: Option<String>,
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
        #[arg(long, default_value_t = false)]
        snap: bool,
        #[arg(long)]
        snap_stages: Option<String>,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
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
        Command::Start {
            config,
            snap,
            snap_stages,
        } => {
            let config = resolve_config_path(config)?;
            let executable = std::env::current_exe()?;
            emit_v3_cli_start_console_line(
                "start",
                &config,
                &executable,
                snap,
                snap_stages.as_deref(),
            );
            V3ManagedLifecycle::new(config)?
                .with_snapshots_enabled(snap)
                .with_snapshot_stages(snap_stages)
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
                    snap_stages,
                },
        } => {
            let config = resolve_config_path(config)?;
            if foreground {
                let executable = std::env::current_exe()?;
                emit_v3_cli_start_console_line(
                    "server start --foreground",
                    &config,
                    &executable,
                    snap,
                    snap_stages.as_deref(),
                );
                V3ManagedLifecycle::new(config)?
                    .with_snapshots_enabled(snap)
                    .with_snapshot_stages(snap_stages)
                    .with_console_enabled(true)
                    .start_foreground(&executable)
                    .await?;
            } else {
                let executable = std::env::current_exe()?;
                V3ManagedLifecycle::new(config)?
                    .with_snapshots_enabled(snap)
                    .with_snapshot_stages(snap_stages)
                    .start(&executable, Duration::from_secs(15))
                    .await?;
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
                    snap_stages,
                },
        }
        | Command::Restart {
            config,
            timeout_ms,
            snap,
            snap_stages,
        } => {
            let config = resolve_config_path(config)?;
            let executable = std::env::current_exe()?;
            let status = V3ManagedLifecycle::new(config)?
                .with_snapshots_enabled(snap)
                .with_snapshot_stages(snap_stages)
                .restart(&executable, Duration::from_millis(timeout_ms))
                .await?;
            println!("{}", serde_json::to_string(&status)?);
        }
        Command::Server {
            command: ServerCommand::Stop { config, timeout_ms },
        }
        | Command::Stop { config, timeout_ms } => {
            let config = resolve_config_path(config)?;
            let executable = std::env::current_exe()?;
            let status = V3ManagedLifecycle::new(config)?
                .stop(&executable, Duration::from_millis(timeout_ms))
                .await?;
            println!("{}", serde_json::to_string(&status)?);
        }
        Command::Server {
            command:
                ServerCommand::RunManagedChild {
                    config,
                    snap,
                    snap_stages,
                },
        } => {
            let config = resolve_config_path(config)?;
            let executable = std::env::current_exe()?;
            V3ManagedLifecycle::new(config)?
                .with_snapshots_enabled(snap)
                .with_snapshot_stages(snap_stages)
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
    snap_stages: Option<&str>,
) {
    println!(
        "[RouteCodexV3] rccv3 {command} version={} crate={} binary={} config={} snap={} snap_stages={}",
        resolve_routecodex_package_version_from_executable(executable)
            .unwrap_or_else(|| "unknown".to_string()),
        env!("CARGO_PKG_VERSION"),
        executable.display(),
        config.display(),
        snap,
        snap_stages.unwrap_or("")
    );
}
