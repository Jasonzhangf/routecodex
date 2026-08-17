// feature_id: v3.admin_bin
// rccv3-admin：RCC V3 Config Management WebUI Backend 入口。
use routecodex_v3_admin::{AppState, router};
use std::path::PathBuf;

const DEFAULT_BIND: &str = "127.0.0.1:8777";

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mut bind = DEFAULT_BIND.to_string();
    let mut config: Option<PathBuf> = None;
    let mut index = 1;
    while index < args.len() {
        match args[index].as_str() {
            "--bind" => {
                index += 1;
                bind = args.get(index).cloned().unwrap_or_else(|| DEFAULT_BIND.to_string());
            }
            "--config" => {
                index += 1;
                config = args.get(index).map(PathBuf::from);
            }
            "--help" | "-h" => {
                println!("rccv3-admin [--bind 127.0.0.1:8777] [--config ~/.rcc/config.v3.toml]");
                return;
            }
            _ => {}
        }
        index += 1;
    }
    let config_path = config.unwrap_or_else(default_config_path);

    let rt = tokio::runtime::Runtime::new().expect("tokio runtime");
    rt.block_on(async move {
        let listener = tokio::net::TcpListener::bind(&bind)
            .await
            .unwrap_or_else(|error| panic!("bind {bind} failed: {error}"));
        println!(
            "[admin] RCC V3 Config Management WebUI listening on http://{bind} (config: {})",
            config_path.display()
        );
        axum::serve(listener, router(AppState::new(config_path)))
            .await
            .expect("axum serve");
    });
}

fn default_config_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".rcc").join("config.v3.toml")
}
