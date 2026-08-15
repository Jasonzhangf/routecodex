// feature_id: v3.cli_init
// `rccv3 init`：首次初始化向导。
// 流程：检查已有配置 -> 官方 provider 预设/自定义 -> 输入必要配置 ->
// 生成 provider 文件（config.v2.toml）-> 创建最简 default route pool。
// 所有配置操作经 Config Core（routecodex-v3-config-mgmt）落盘。
use routecodex_v3_config::{
    V2ProviderAuthConfig, V2ProviderConfig, V2ProviderConfigFile, V2ProviderModelConfig,
    V3Config02AuthoringParsed, V3RoutePoolTargetAuthoringConfig, V3RouteTargetKind,
    V3SelectionPolicy, V3SelectionStrategy, V3ServerAuthoringConfig,
};
use routecodex_v3_config_mgmt::{write_provider_file, ConfigMgmtStore};
use std::collections::BTreeMap;
use std::io::{self, Write};
use std::path::Path;

pub struct OfficialProviderPreset {
    pub id: &'static str,
    pub label: &'static str,
    pub provider_type: &'static str,
    pub base_url: &'static str,
    pub default_model: &'static str,
    pub hint: &'static str,
}

pub const OFFICIAL_PROVIDER_PRESETS: &[OfficialProviderPreset] = &[
    OfficialProviderPreset {
        id: "openai",
        label: "OpenAI",
        provider_type: "responses",
        base_url: "https://api.openai.com/v1",
        default_model: "gpt-5.5",
        hint: "api.openai.com Responses API",
    },
    OfficialProviderPreset {
        id: "anthropic",
        label: "Anthropic",
        provider_type: "anthropic",
        base_url: "https://api.anthropic.com",
        default_model: "claude-sonnet-4-5",
        hint: "Anthropic Messages API",
    },
    OfficialProviderPreset {
        id: "deepseek",
        label: "DeepSeek",
        provider_type: "openai_chat",
        base_url: "https://api.deepseek.com/v1",
        default_model: "deepseek-chat",
        hint: "DeepSeek Chat Completions API",
    },
    OfficialProviderPreset {
        id: "gemini",
        label: "Google Gemini",
        provider_type: "gemini",
        base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
        default_model: "gemini-2.5-pro",
        hint: "Gemini OpenAI-compatible endpoint",
    },
    OfficialProviderPreset {
        id: "openrouter",
        label: "OpenRouter",
        provider_type: "openai_chat",
        base_url: "https://openrouter.ai/api/v1",
        default_model: "openai/gpt-4o",
        hint: "OpenRouter unified gateway",
    },
    OfficialProviderPreset {
        id: "lmstudio",
        label: "LM Studio (local)",
        provider_type: "openai_chat",
        base_url: "http://127.0.0.1:1234/v1",
        default_model: "local-model",
        hint: "Local LM Studio OpenAI-compatible server",
    },
];

pub struct InitOptions {
    pub config_path: std::path::PathBuf,
    pub force: bool,
    pub provider: Option<String>,
    pub base_url: Option<String>,
    pub model: Option<String>,
    pub api_key: Option<String>,
    pub env: Option<String>,
    pub token_file: Option<String>,
    pub port: Option<u16>,
}

pub fn run_init(options: &InitOptions) -> Result<(), String> {
    if options.config_path.exists() && !options.force {
        match routecodex_v3_config_mgmt::ConfigMgmtStore::new(&options.config_path).read_authoring() {
            Ok(authoring) => {
                println!(
                    "[init] existing config found at {} (version={}, servers={})",
                    options.config_path.display(),
                    authoring.version,
                    authoring.servers.len()
                );
                println!("[init] re-run with --force to overwrite or extend the config.");
                return Err("already initialized".to_string());
            }
            Err(error) => {
                println!(
                    "[init] existing config at {} failed to load: {error}. --force will overwrite.",
                    options.config_path.display()
                );
                if !options.force {
                    return Err("existing config unreadable; pass --force to reinitialize".to_string());
                }
            }
        }
    }

    let preset = resolve_preset(options.provider.as_deref())?;
    let provider_id = preset
        .map(|preset| preset.id.to_string())
        .unwrap_or_else(|| prompt("provider id (used as directory name)").expect("read stdin"));
    let provider_type = preset
        .map(|preset| preset.provider_type.to_string())
        .unwrap_or_else(|| {
            prompt("provider type [responses|anthropic|openai_chat|gemini]").expect("read stdin")
        });
    let base_url = if let Some(base_url) = &options.base_url {
        base_url.clone()
    } else if let Some(preset) = preset {
        preset.base_url.to_string()
    } else {
        prompt_optional(
            "base URL (default https://api.openai.com/v1)",
            "https://api.openai.com/v1",
        )?
    };
    let default_model = if let Some(model) = &options.model {
        model.clone()
    } else if let Some(preset) = preset {
        preset.default_model.to_string()
    } else {
        prompt("default model")?
    };

    if !matches!(
        provider_type.as_str(),
        "responses" | "anthropic" | "gemini" | "openai_chat"
    ) {
        return Err(format!("invalid provider type {provider_type:?}"));
    }
    if default_model.trim().is_empty() {
        return Err("default model must not be empty".to_string());
    }

    let auth = resolve_auth(options)?;

    let port = options.port.unwrap_or_else(|| {
        prompt_optional("listen port (default 4444)", "4444")
            .expect("port")
            .parse::<u16>()
            .unwrap_or(4444)
    });
    if port == 0 {
        return Err("listen port must be non-zero".to_string());
    }

    let config_dir = options
        .config_path
        .parent()
        .ok_or_else(|| "config path has no parent".to_string())?
        .to_path_buf();

    let mut models = BTreeMap::new();
    models.insert(
        default_model.clone(),
        V2ProviderModelConfig {
            wire_name: None,
            aliases: Vec::new(),
            capabilities: vec!["text".to_string(), "reasoning".to_string(), "tools".to_string()],
            supports_streaming: Some(true),
            supports_thinking: Some(true),
            thinking: None,
            max_tokens: None,
            max_context: None,
            max_context_tokens: None,
            context_window: None,
            web_search_execution_mode: None,
            web_search_backend: None,
            features: BTreeMap::new(),
        },
    );

    let provider_file = V2ProviderConfigFile {
        version: Some("2.0.0".to_string()),
        provider_id: Some(provider_id.clone()),
        provider: V2ProviderConfig {
            id: provider_id.clone(),
            enabled: Some(true),
            provider_type: provider_type.clone(),
            base_url: base_url.clone(),
            default_model: default_model.clone(),
            auth,
            responses: None,
            concurrency: None,
            compatibility_profile: None,
            models,
            v3: None,
            timeout: Some(300_000),
            sse_first_frame_timeout_ms: None,
        },
    };
    let provider_path =
        write_provider_file(&config_dir, &provider_id, &provider_file)?;
    println!("[init] wrote provider file {}", provider_path.display());

    let authoring = build_minimal_authoring(&provider_id, &default_model, port)?;
    let store = ConfigMgmtStore::new(&options.config_path);
    store
        .commit_with_backup(&authoring, "init", "rcc init")
        .map_err(|error| error.to_string())?;
    println!(
        "[init] wrote config {} with a minimal default pool (provider={provider_id}, model={default_model}, port={port})",
        options.config_path.display()
    );
    println!("[init] next: `rccv3 config check` then `rccv3 start`");
    Ok(())
}

fn resolve_preset(provider: Option<&str>) -> Result<Option<&'static OfficialProviderPreset>, String> {
    match provider {
        None => {
            println!("[init] official providers:");
            for (index, preset) in OFFICIAL_PROVIDER_PRESETS.iter().enumerate() {
                println!("  {}. {} ({}) - {}", index + 1, preset.label, preset.id, preset.hint);
            }
            println!("  {}. custom provider", OFFICIAL_PROVIDER_PRESETS.len() + 1);
            let choice = prompt("select provider number (default 1)")?;
            let choice = choice.trim();
            if choice.is_empty() {
                return Ok(Some(&OFFICIAL_PROVIDER_PRESETS[0]));
            }
            let index = choice
                .parse::<usize>()
                .map_err(|_| format!("invalid choice {choice:?}"))?;
            if index == 0 || index > OFFICIAL_PROVIDER_PRESETS.len() + 1 {
                return Err(format!("choice out of range: {index}"));
            }
            if index <= OFFICIAL_PROVIDER_PRESETS.len() {
                Ok(Some(&OFFICIAL_PROVIDER_PRESETS[index - 1]))
            } else {
                Ok(None)
            }
        }
        Some("custom") => Ok(None),
        Some(id) => OFFICIAL_PROVIDER_PRESETS
            .iter()
            .find(|preset| preset.id == id)
            .map(Some)
            .ok_or_else(|| format!("unknown provider preset {id:?}; use --provider custom")),
    }
}

fn resolve_auth(options: &InitOptions) -> Result<V2ProviderAuthConfig, String> {
    if let Some(api_key) = &options.api_key {
        return Ok(V2ProviderAuthConfig {
            api_key: Some(api_key.clone()),
            env: None,
            token_file: None,
            entries: None,
        });
    }
    if let Some(env) = &options.env {
        return Ok(V2ProviderAuthConfig {
            api_key: None,
            env: Some(env.clone()),
            token_file: None,
            entries: None,
        });
    }
    if let Some(token_file) = &options.token_file {
        return Ok(V2ProviderAuthConfig {
            api_key: None,
            env: None,
            token_file: Some(token_file.clone()),
            entries: None,
        });
    }
    let raw = prompt_optional(
        "api key source: 1) paste key  2) env variable name  3) token file path (default 1)",
        "1",
    )?;
    match raw.trim() {
        "2" => {
            let env = prompt("env variable name (e.g. MY_PROVIDER_KEY)")?;
            Ok(V2ProviderAuthConfig {
                api_key: None,
                env: Some(env),
                token_file: None,
                entries: None,
            })
        }
        "3" => {
            let token_file = prompt("token file path (e.g. ~/.rcc/secrets/provider.token)")?;
            Ok(V2ProviderAuthConfig {
                api_key: None,
                env: None,
                token_file: Some(token_file),
                entries: None,
            })
        }
        _ => {
            let api_key = prompt("api key")?;
            Ok(V2ProviderAuthConfig {
                api_key: Some(api_key),
                env: None,
                token_file: None,
                entries: None,
            })
        }
    }
}

fn build_minimal_authoring(
    provider_id: &str,
    default_model: &str,
    port: u16,
) -> Result<V3Config02AuthoringParsed, String> {
    let server_id = format!("routecodex_v3_{port}");
    let mut servers = BTreeMap::new();
    servers.insert(
        server_id.clone(),
        V3ServerAuthoringConfig {
            enabled: true,
            bind: "127.0.0.1".to_string(),
            port,
            routing_group: server_id.clone(),
            endpoints: vec![
                "responses".to_string(),
                "openai_chat".to_string(),
                "anthropic".to_string(),
            ],
            features: BTreeMap::new(),
            execution: None,
            expose_models: vec![],
        },
    );
    let mut route_groups = BTreeMap::new();
    let mut pools = BTreeMap::new();
    let mut targets = Vec::new();
    targets.push(V3RoutePoolTargetAuthoringConfig {
        kind: V3RouteTargetKind::ProviderModel,
        id: None,
        provider: Some(provider_id.to_string()),
        model: Some(default_model.to_string()),
        key: Some("key1".to_string()),
        priority: Some(1),
        weight: None,
    });
    pools.insert(
        "default".to_string(),
        routecodex_v3_config::V3RoutePoolAuthoringConfig {
            selection: V3SelectionPolicy {
                strategy: V3SelectionStrategy::Priority,
            },
            match_rule: None,
            targets,
            features: BTreeMap::new(),
        },
    );
    route_groups.insert(
        server_id.clone(),
        routecodex_v3_config::V3RouteGroupAuthoringConfig {
            pools,
            features: BTreeMap::new(),
        },
    );
    Ok(V3Config02AuthoringParsed {
        version: 3,
        pipelines: Default::default(),
        servers,
        providers: BTreeMap::new(),
        forwarders: BTreeMap::new(),
        route_groups,
        features: BTreeMap::new(),
        debug: Default::default(),
        error: Default::default(),
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

fn prompt_optional(message: &str, default: &str) -> Result<String, String> {
    let value = prompt(&format!("{message} [default: {default}]"))?;
    if value.is_empty() {
        Ok(default.to_string())
    } else {
        Ok(value)
    }
}
