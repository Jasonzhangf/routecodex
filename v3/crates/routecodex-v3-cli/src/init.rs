// feature_id: v3.cli_init
// `rccv3 init` only selects an existing provider/model and writes minimal config.toml.

use routecodex_v3_config::{
    V3UserConfig02RoutingSelectionParsed, V3UserRouteMember, V3UserRoutePool,
    V3UserServerAuthoringConfig,
};
use routecodex_v3_config_mgmt::{list_provider_ids, read_provider_file, ConfigMgmtStore};
use std::collections::BTreeMap;
use std::io::{self, Write};

pub struct InitOptions {
    pub config_path: std::path::PathBuf,
    pub force: bool,
    pub provider: Option<String>,
    pub model: Option<String>,
    pub bind: Option<String>,
    pub port: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ProviderChoice {
    provider: String,
    model: String,
    models: Vec<String>,
}

pub fn run_init(options: &InitOptions) -> Result<(), String> {
    if options
        .config_path
        .file_name()
        .and_then(|name| name.to_str())
        != Some("config.toml")
    {
        return Err(format!(
            "init requires config.toml, got {}",
            options.config_path.display()
        ));
    }
    if options.config_path.exists() && !options.force {
        ConfigMgmtStore::new(&options.config_path)
            .read_user_routing()
            .map_err(|error| format!("existing config.toml is invalid: {error}"))?;
        return Err(format!(
            "config already exists at {}; pass --force to replace it",
            options.config_path.display()
        ));
    }

    let config_dir = options
        .config_path
        .parent()
        .ok_or_else(|| "config path has no parent".to_string())?;
    let catalogue = provider_catalogue(config_dir)?;
    let choice = select_provider_model(
        &catalogue,
        options.provider.as_deref(),
        options.model.as_deref(),
    )?;
    let selection = minimal_user_config(
        &choice.provider,
        &choice.model,
        options.bind.as_deref(),
        options.port,
    )?;
    ConfigMgmtStore::new(&options.config_path)
        .commit_user_routing_with_backup(&selection, "init", "rcc init")
        .map_err(|error| error.to_string())?;
    println!(
        "[init] wrote {} using existing provider/model {}/{}",
        options.config_path.display(),
        choice.provider,
        choice.model
    );
    println!(
        "[init] next: `rccv3 config check -c {}`",
        options.config_path.display()
    );
    Ok(())
}

fn provider_catalogue(config_dir: &std::path::Path) -> Result<Vec<ProviderChoice>, String> {
    let mut catalogue = Vec::new();
    for provider_id in list_provider_ids(config_dir)? {
        let entry = read_provider_file(config_dir, &provider_id)?;
        if entry.config.provider.enabled == Some(false) {
            continue;
        }
        let models = entry
            .config
            .provider
            .models
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        if models.contains(&entry.config.provider.default_model) {
            catalogue.push(ProviderChoice {
                provider: provider_id,
                model: entry.config.provider.default_model,
                models,
            });
        }
    }
    if catalogue.is_empty() {
        return Err(
            "no enabled provider with a declared default model exists under provider/".into(),
        );
    }
    Ok(catalogue)
}

fn select_provider_model(
    catalogue: &[ProviderChoice],
    provider: Option<&str>,
    model: Option<&str>,
) -> Result<ProviderChoice, String> {
    let selected = if let Some(provider) = provider {
        catalogue
            .iter()
            .find(|entry| entry.provider == provider)
            .ok_or_else(|| format!("unknown or disabled provider {provider:?}"))?
    } else {
        println!("[init] available providers:");
        for (index, entry) in catalogue.iter().enumerate() {
            println!("  {}. {}/{}", index + 1, entry.provider, entry.model);
        }
        let raw = prompt("select provider number (default 1)")?;
        let index = if raw.is_empty() {
            0
        } else {
            raw.parse::<usize>()
                .map_err(|_| format!("invalid provider selection {raw:?}"))?
                .checked_sub(1)
                .ok_or_else(|| "provider selection must start at 1".to_string())?
        };
        catalogue
            .get(index)
            .ok_or_else(|| format!("provider selection {} is out of range", index + 1))?
    };
    let selected_model = model.unwrap_or(&selected.model);
    if !selected
        .models
        .iter()
        .any(|candidate| candidate == selected_model)
    {
        return Err(format!(
            "provider {:?} does not declare model {:?}",
            selected.provider, selected_model
        ));
    }
    Ok(ProviderChoice {
        provider: selected.provider.clone(),
        model: selected_model.to_string(),
        models: selected.models.clone(),
    })
}

fn minimal_user_config(
    provider: &str,
    model: &str,
    bind: Option<&str>,
    port: Option<u16>,
) -> Result<V3UserConfig02RoutingSelectionParsed, String> {
    let port = port.ok_or_else(|| {
        "init requires --port because listener ports belong to user config.toml".to_string()
    })?;
    if port == 0 {
        return Err("init --port must be non-zero".to_string());
    }
    let bind = bind.unwrap_or("127.0.0.1").trim();
    if bind.is_empty() {
        return Err("init --bind must not be empty".to_string());
    }
    Ok(V3UserConfig02RoutingSelectionParsed {
        version: 3,
        servers: BTreeMap::from([(
            "default".to_string(),
            V3UserServerAuthoringConfig {
                enabled: true,
                bind: bind.to_string(),
                port,
                endpoints: vec![
                    "responses".to_string(),
                    "anthropic".to_string(),
                    "gemini".to_string(),
                    "openai_chat".to_string(),
                ],
                features: BTreeMap::new(),
                execution: None,
                expose_models: Vec::new(),
                routes: BTreeMap::from([(
                    "default".to_string(),
                    V3UserRoutePool {
                        tiers: vec![vec![V3UserRouteMember::new(provider, model, None)]],
                    },
                )]),
            },
        )]),
    })
}

fn prompt(message: &str) -> Result<String, String> {
    print!("[init] {message}: ");
    io::stdout().flush().map_err(|error| error.to_string())?;
    let mut line = String::new();
    io::stdin()
        .read_line(&mut line)
        .map_err(|error| format!("read stdin failed: {error}"))?;
    Ok(line.trim().to_string())
}
