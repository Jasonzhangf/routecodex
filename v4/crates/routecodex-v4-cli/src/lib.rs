//! Typed V4 CLI intent owner.
//!
//! This crate parses commands only. Config compilation, managed lifecycle,
//! server execution, provider transport, and servertool execution belong to
//! their respective owners.

use clap::{Args, CommandFactory, FromArgMatches, Parser, Subcommand};
use std::ffi::OsString;
use std::path::PathBuf;

#[derive(Debug, Clone, PartialEq, Eq, Parser)]
#[command(name = "rccv4", about = "RouteCodex V4", disable_version_flag = false)]
pub struct Cli {
    #[command(subcommand)]
    pub command: Option<V4CommandIntent>,
}

impl Cli {
    pub fn parse_with_version<I, T>(args: I, version: &'static str) -> Result<Self, clap::Error>
    where
        I: IntoIterator<Item = T>,
        T: Into<OsString> + Clone,
    {
        let matches = Self::command().version(version).try_get_matches_from(args)?;
        Self::from_arg_matches(&matches)
    }

    pub fn command_or_start(self) -> V4CommandIntent {
        self.command
            .unwrap_or(V4CommandIntent::Start(StartIntent::default()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
pub enum V4CommandIntent {
    Config {
        #[command(subcommand)]
        command: ConfigIntent,
    },
    Init(InitIntent),
    Start(StartIntent),
    Status(ConfigPathIntent),
    Restart(RestartIntent),
    Stop(StopIntent),
    Servertool {
        #[command(subcommand)]
        command: ServertoolIntent,
    },
    #[command(hide = true)]
    Server {
        #[command(subcommand)]
        command: ServerIntent,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
pub enum ConfigIntent {
    Check(ConfigPathIntent),
}

#[derive(Debug, Clone, PartialEq, Eq, Args, Default)]
pub struct ConfigPathIntent {
    #[arg(short = 'c', long = "config")]
    pub config: Option<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq, Args)]
pub struct InitIntent {
    #[arg(short = 'c', long = "config")]
    pub config: Option<PathBuf>,
    #[arg(long)]
    pub force: bool,
    #[arg(long)]
    pub provider: Option<String>,
    #[arg(long = "base-url")]
    pub base_url: Option<String>,
    #[arg(long)]
    pub model: Option<String>,
    #[arg(long = "api-key", conflicts_with_all = ["env", "token_file"])]
    pub api_key: Option<String>,
    #[arg(long, conflicts_with_all = ["api_key", "token_file"])]
    pub env: Option<String>,
    #[arg(long = "token-file", conflicts_with_all = ["api_key", "env"])]
    pub token_file: Option<PathBuf>,
    #[arg(long, value_parser = clap::value_parser!(u16).range(1..))]
    pub port: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Args, Default)]
pub struct SnapshotIntent {
    #[arg(long, conflicts_with = "snapall")]
    pub snap: bool,
    #[arg(long, conflicts_with = "snap")]
    pub snapall: bool,
    #[arg(long = "snap-stages", value_parser = non_blank)]
    pub snap_stages: Option<String>,
    #[arg(long)]
    pub debug: bool,
    #[arg(long = "sse-dump")]
    pub sse_dump: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Args, Default)]
pub struct StartIntent {
    #[arg(short = 'c', long = "config")]
    pub config: Option<PathBuf>,
    #[command(flatten)]
    pub snapshot: SnapshotIntent,
}

#[derive(Debug, Clone, PartialEq, Eq, Args)]
pub struct RestartIntent {
    #[arg(short = 'c', long = "config")]
    pub config: Option<PathBuf>,
    #[arg(long = "timeout-ms", default_value_t = 15_000, value_parser = clap::value_parser!(u64).range(1..))]
    pub timeout_ms: u64,
    #[command(flatten)]
    pub snapshot: SnapshotIntent,
}

#[derive(Debug, Clone, PartialEq, Eq, Args)]
pub struct StopIntent {
    #[arg(short = 'c', long = "config")]
    pub config: Option<PathBuf>,
    #[arg(long = "timeout-ms", default_value_t = 15_000, value_parser = clap::value_parser!(u64).range(1..))]
    pub timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
pub enum ServertoolIntent {
    Run(ServertoolRunIntent),
}

#[derive(Debug, Clone, PartialEq, Eq, Args)]
pub struct ServertoolRunIntent {
    pub tool_name: String,
    #[arg(long = "input-json")]
    pub input_json: String,
    #[arg(long)]
    pub flow: Option<String>,
    #[arg(long = "session-id")]
    pub session_id: Option<String>,
    #[arg(long = "request-id")]
    pub request_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Subcommand)]
pub enum ServerIntent {
    Start(ServerStartIntent),
    Status(ConfigPathIntent),
    Restart(RestartIntent),
    Stop(StopIntent),
    #[command(name = "run-managed-child", hide = true)]
    RunManagedChild(ManagedChildIntent),
}

#[derive(Debug, Clone, PartialEq, Eq, Args, Default)]
pub struct ServerStartIntent {
    #[arg(short = 'c', long = "config")]
    pub config: Option<PathBuf>,
    #[arg(long)]
    pub foreground: bool,
    #[command(flatten)]
    pub snapshot: SnapshotIntent,
}

#[derive(Debug, Clone, PartialEq, Eq, Args)]
pub struct ManagedChildIntent {
    #[arg(long)]
    pub manifest: PathBuf,
    #[arg(long = "config")]
    pub config: PathBuf,
    #[command(flatten)]
    pub snapshot: SnapshotIntent,
}

fn non_blank(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        Err("value must not be blank".to_string())
    } else {
        Ok(trimmed.to_string())
    }
}
