use clap::{Parser, Subcommand};
use routecodex_v3_config::{default_v3_config_path, V3Config05ManifestPublished, V3ConfigStore};
use routecodex_v3_lifecycle::V3ManagedLifecycle;
use std::path::PathBuf;
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
    Server {
        #[command(subcommand)]
        command: ServerCommand,
    },
}

#[derive(Subcommand)]
enum ConfigCommand {
    Check {
        #[arg(long)]
        config: Option<String>,
    },
}

#[derive(Subcommand)]
enum ServerCommand {
    Start {
        #[arg(long)]
        config: Option<String>,
        #[arg(long, default_value_t = false)]
        foreground: bool,
    },
    Status {
        #[arg(long)]
        config: Option<String>,
    },
    Restart {
        #[arg(long)]
        config: Option<String>,
        #[arg(long, default_value_t = 15_000)]
        timeout_ms: u64,
    },
    Stop {
        #[arg(long)]
        config: Option<String>,
        #[arg(long, default_value_t = 15_000)]
        timeout_ms: u64,
    },
    #[command(hide = true)]
    RunManagedChild {
        #[arg(long)]
        config: Option<String>,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
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
        Command::Server {
            command: ServerCommand::Start { config, foreground },
        } => {
            let config = resolve_config_path(config)?;
            let manifest = load_manifest(&config)?;
            for server in manifest.servers.values().filter(|server| server.enabled) {
                println!("starting {} on {}:{}", server.id, server.bind, server.port);
            }
            if foreground {
                routecodex_v3_server::serve_v3_server_aggregate_until_shutdown(manifest).await?;
            } else {
                let executable = std::env::current_exe()?;
                let status = V3ManagedLifecycle::new(config)?
                    .start(&executable, Duration::from_secs(15))
                    .await?;
                println!("{}", serde_json::to_string(&status)?);
            }
        }
        Command::Server {
            command: ServerCommand::Status { config },
        } => {
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
            command: ServerCommand::Restart { config, timeout_ms },
        } => {
            let config = resolve_config_path(config)?;
            let executable = std::env::current_exe()?;
            let status = V3ManagedLifecycle::new(config)?
                .restart(&executable, Duration::from_millis(timeout_ms))
                .await?;
            println!("{}", serde_json::to_string(&status)?);
        }
        Command::Server {
            command: ServerCommand::Stop { config, timeout_ms },
        } => {
            let config = resolve_config_path(config)?;
            let executable = std::env::current_exe()?;
            let status = V3ManagedLifecycle::new(config)?
                .stop(&executable, Duration::from_millis(timeout_ms))
                .await?;
            println!("{}", serde_json::to_string(&status)?);
        }
        Command::Server {
            command: ServerCommand::RunManagedChild { config },
        } => {
            let config = resolve_config_path(config)?;
            let executable = std::env::current_exe()?;
            V3ManagedLifecycle::new(config)?
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
