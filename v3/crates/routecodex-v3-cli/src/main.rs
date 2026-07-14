use clap::{Parser, Subcommand};
use routecodex_v3_config::{V3Config05ManifestPublished, V3ConfigStore};

#[derive(Parser)]
#[command(name = "routecodex-v3")]
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
        config: String,
    },
}

#[derive(Subcommand)]
enum ServerCommand {
    Start {
        #[arg(long)]
        config: String,
    },
    Status {
        #[arg(long)]
        config: String,
    },
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    match Args::parse().command {
        Command::Config {
            command: ConfigCommand::Check { config },
        } => {
            let manifest = load_manifest(&config)?;
            println!(
                "config ok: version={} servers={}",
                manifest.version,
                manifest.servers.len()
            );
        }
        Command::Server {
            command: ServerCommand::Start { config },
        } => {
            let manifest = load_manifest(&config)?;
            for server in manifest.servers.values().filter(|server| server.enabled) {
                println!("starting {} on {}:{}", server.id, server.bind, server.port);
            }
            routecodex_v3_server::serve_v3_server_aggregate_until_shutdown(manifest).await?;
        }
        Command::Server {
            command: ServerCommand::Status { config },
        } => {
            let manifest = load_manifest(&config)?;
            for server in manifest.servers.values() {
                println!(
                    "{} enabled={} address={}:{}",
                    server.id, server.enabled, server.bind, server.port
                );
            }
        }
    }
    Ok(())
}

fn load_manifest(config: &str) -> Result<V3Config05ManifestPublished, Box<dyn std::error::Error>> {
    Ok(V3ConfigStore::new(config).load_snapshot()?)
}
