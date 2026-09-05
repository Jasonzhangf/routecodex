use super::*;

#[test]
fn snake_case_web_search_mode_parses_via_alias() {
    let parsed: V2ProviderModelConfig = toml::from_str(
        r#"
wireName = "MiniMax-M3"
capabilities = ["web_search"]
web_search_execution_mode = "metadata_center_local_search"
web_search_backend = "MiniMax-M3"
"#,
    )
    .expect("parse");
    assert_eq!(
        parsed.web_search_execution_mode().as_str(),
        "metadata_center_local_search",
        "snake_case web_search_execution_mode must parse (found {:?})",
        parsed.web_search_execution_mode()
    );
    assert_eq!(parsed.web_search_backend.as_deref(), Some("MiniMax-M3"));
}

#[test]
fn camel_case_web_search_mode_still_parses() {
    let parsed: V2ProviderModelConfig = toml::from_str(
        r#"
wireName = "MiniMax-M3"
webSearchExecutionMode = "metadata_center_local_search"
webSearchBackend = "MiniMax-M3"
"#,
    )
    .expect("parse");
    assert_eq!(
        parsed.web_search_execution_mode().as_str(),
        "metadata_center_local_search"
    );
    assert_eq!(parsed.web_search_backend.as_deref(), Some("MiniMax-M3"));
}

#[test]
fn context_token_estimate_scale_parses_explicit_and_defaults() {
    let explicit: V2ProviderModelConfig = toml::from_str(
        r#"
contextTokenEstimateScaleBps = 17000
"#,
    )
    .expect("explicit scale must parse");
    assert_eq!(explicit.context_token_estimate_scale_bps, 17_000);

    let defaulted: V2ProviderModelConfig =
        toml::from_str("").expect("omitted scale must use the V2 compatibility default");
    assert_eq!(defaulted.context_token_estimate_scale_bps, 10_000);
}

#[test]
fn provider_timeout_parses_into_manifest_request_timeout_ms() {
    // 端到端：v2 provider 文件 `[provider].timeout` 经 V2→V3 兼容层必须写入
    // `V3ProviderAuthoringConfig.request_timeout_ms`（曾因 serde 静默丢弃
    // snake_case 字段导致 9 分钟超时永远不生效）。
    // 三层验证：(1) V2 schema 解析 (2) compile_v2_provider_directory 端到点
    // 写入 (3) 缺省字段 → DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS fallback。
    use std::io::Write;

    // (1) V2 schema 解析层：snake_case timeout 必须被接受
    let parsed: V2ProviderConfigFile = toml::from_str(
        r#"
providerId = "test-provider"

[provider]
id = "test-provider"
enabled = true
type = "openai"
baseURL = "http://127.0.0.1:9999/v1"
timeout = 900000
defaultModel = "model"

[provider.auth]
type = "apikey"
apiKey = "test-key"

[provider.models.model]
contextTokenEstimateScaleBps = 17000
"#,
    )
    .expect("parse");
    assert_eq!(
        parsed.provider.timeout,
        Some(900_000),
        "snake_case timeout must parse"
    );

    // (2) 端到点：临时 provider 目录 → compile_v2_provider_directory →
    //      manifest request_timeout_ms == 900_000
    let tmp = std::env::temp_dir().join(format!(
        "rccv3-timeout-test-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let provider_dir = tmp.join("provider").join("test-provider");
    std::fs::create_dir_all(&provider_dir).expect("create provider dir");
    let mut file = std::fs::File::create(provider_dir.join("config.v2.toml")).expect("file");
    file.write_all(
        br#"
providerId = "test-provider"

[provider]
id = "test-provider"
enabled = true
type = "openai"
baseURL = "http://127.0.0.1:9999/v1"
timeout = 900000
defaultModel = "model"

[provider.auth]
type = "apikey"
apiKey = "test-key"

[provider.models.model]
contextTokenEstimateScaleBps = 17000
"#,
    )
    .expect("write");

    let mut referenced_models: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    referenced_models.insert(
        "test-provider".to_string(),
        BTreeSet::from(["model".to_string()]),
    );
    let (providers, _sources) =
        compile_v2_provider_directory(&tmp, &referenced_models).expect("compile v2 provider dir");
    let authoring = providers.get("test-provider").expect("provider compiled");
    assert_eq!(
        authoring.request_timeout_ms, 900_000,
        "V2→V3 end-to-end: timeout=900_000 must land in request_timeout_ms (was silently dropped)"
    );
    assert_eq!(
        authoring.models["model"].context_token_estimate_scale_bps, 17_000,
        "V2→V3 end-to-end: provider model context scale must not be dropped"
    );
    std::fs::remove_dir_all(&tmp).ok();

    // (2c) sse_first_frame_timeout_ms 端到点：provider 配置的 SSE 首帧
    //      超时必须写入 authoring（本地慢部署按 provider 放宽）。
    let tmp_sse = std::env::temp_dir().join(format!(
        "rccv3-sse-timeout-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let provider_dir_sse = tmp_sse.join("provider").join("test-provider");
    std::fs::create_dir_all(&provider_dir_sse).expect("create provider dir");
    let mut file_sse =
        std::fs::File::create(provider_dir_sse.join("config.v2.toml")).expect("file");
    file_sse
        .write_all(
            br#"
providerId = "test-provider"

[provider]
id = "test-provider"
enabled = true
type = "openai"
baseURL = "http://127.0.0.1:9999/v1"
defaultModel = "model"
sse_first_frame_timeout_ms = 600000

[provider.auth]
type = "apikey"
apiKey = "test-key"
"#,
        )
        .expect("write");
    let (providers_sse, _) =
        compile_v2_provider_directory(&tmp_sse, &referenced_models).expect("compile");
    assert_eq!(
        providers_sse
            .get("test-provider")
            .expect("provider compiled")
            .sse_first_frame_timeout_ms,
        Some(600_000),
        "V2→V3 end-to-end: sse_first_frame_timeout_ms=600000 must land in authoring"
    );
    std::fs::remove_dir_all(&tmp_sse).ok();

    // (2b) 缺省字段端到点：无 timeout 时，V2→V3 fallback 必须等于
    //      DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS（300_000），不能为 0/默认
    //      隐藏 bug。
    let tmp_default = std::env::temp_dir().join(format!(
        "rccv3-timeout-default-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let provider_dir_default = tmp_default.join("provider").join("test-provider");
    std::fs::create_dir_all(&provider_dir_default).expect("create provider dir");
    let mut file_default =
        std::fs::File::create(provider_dir_default.join("config.v2.toml")).expect("file");
    file_default
        .write_all(
            br#"
providerId = "test-provider"

[provider]
id = "test-provider"
enabled = true
type = "openai"
baseURL = "http://127.0.0.1:9999/v1"
defaultModel = "model"

[provider.auth]
type = "apikey"
apiKey = "test-key"
"#,
        )
        .expect("write");
    let (providers_default, _sources_default) =
        compile_v2_provider_directory(&tmp_default, &referenced_models)
            .expect("compile v2 provider dir (absent timeout)");
    let authoring_default = providers_default
        .get("test-provider")
        .expect("provider compiled");
    assert_eq!(
        authoring_default.request_timeout_ms, DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
        "absent timeout must fall back to DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS (300_000)"
    );
    std::fs::remove_dir_all(&tmp_default).ok();

    // (3) V2 schema 解析层：snake_case timeout 必须被接受；缺省字段 → None
    let parsed: V2ProviderConfigFile = toml::from_str(
        r#"
providerId = "test-provider"

[provider]
id = "test-provider"
enabled = true
type = "openai"
baseURL = "http://127.0.0.1:9999/v1"
timeout = 900000
defaultModel = "model"

[provider.auth]
type = "apikey"
apiKey = "test-key"
"#,
    )
    .expect("parse");
    assert_eq!(
        parsed.provider.timeout,
        Some(900_000),
        "snake_case timeout must parse"
    );

    let absent: V2ProviderConfigFile = toml::from_str(
        r#"
providerId = "test-provider"

[provider]
id = "test-provider"
enabled = true
type = "openai"
baseURL = "http://127.0.0.1:9999/v1"
defaultModel = "model"

[provider.auth]
type = "apikey"
apiKey = "test-key"
"#,
    )
    .expect("parse");
    assert_eq!(
        absent.provider.timeout, None,
        "absent timeout must be None (default applies later)"
    );
}

#[test]
fn provider_auth_root_secret_file_roundtrip_preserves_authoring() {
    let parsed = parse_v2_provider_config_file(
        r#"
version = "2.0.0"
providerId = "secret-provider"

[provider]
id = "secret-provider"
type = "responses"
baseURL = "https://example.com/v1"
defaultModel = "model-a"

[provider.auth]
secretFile = "/tmp/secret-provider.conf"
"#,
    )
    .expect("parse");
    assert_eq!(
        parsed.provider.auth.secret_file.as_deref(),
        Some("/tmp/secret-provider.conf")
    );

    let generated = generate_v2_provider_config_file(&parsed).expect("generate");
    let reparsed = parse_v2_provider_config_file(&generated).expect("reparse");
    assert_eq!(
        reparsed.provider.auth.secret_file.as_deref(),
        Some("/tmp/secret-provider.conf")
    );
}

#[test]
fn provider_config_file_roundtrip_via_parse_and_generate() {
    let raw = r#"
version = "2.0.0"
providerId = "roundtrip-provider"

[provider]
id = "roundtrip-provider"
enabled = true
type = "openai"
baseURL = "http://127.0.0.1:9999/v1"
defaultModel = "model-a"
timeout = 120000
sse_first_frame_timeout_ms = 600000

[provider.auth]
env = "ROUNDTRIP_KEY"

[provider.concurrency]
maxInFlight = 4

[provider.models."model-a"]
supportsStreaming = true
supportsThinking = true
maxTokens = 8192
maxContext = 262144
capabilities = ["text", "reasoning", "tools"]
"#;
    let parsed = parse_v2_provider_config_file(raw).expect("parse");
    assert_eq!(parsed.version.as_deref(), Some("2.0.0"));
    assert_eq!(parsed.provider_id.as_deref(), Some("roundtrip-provider"));
    assert_eq!(parsed.provider.provider_type, "openai");
    assert_eq!(parsed.provider.base_url, "http://127.0.0.1:9999/v1");
    assert_eq!(parsed.provider.default_model, "model-a");
    assert_eq!(parsed.provider.timeout, Some(120000));
    assert_eq!(parsed.provider.sse_first_frame_timeout_ms, Some(600000));
    assert_eq!(parsed.provider.auth.env.as_deref(), Some("ROUNDTRIP_KEY"));

    let generated = generate_v2_provider_config_file(&parsed).expect("generate");
    let reparsed = parse_v2_provider_config_file(&generated).expect("reparse");
    assert_eq!(reparsed.provider_id, parsed.provider_id);
    assert_eq!(reparsed.provider.id, parsed.provider.id);
    assert_eq!(reparsed.provider.provider_type, "openai");
    assert_eq!(reparsed.provider.base_url, parsed.provider.base_url);
    assert_eq!(reparsed.provider.default_model, "model-a");
    assert_eq!(reparsed.provider.timeout, Some(120000));
    assert_eq!(reparsed.provider.sse_first_frame_timeout_ms, Some(600000));
    assert_eq!(reparsed.provider.auth.env.as_deref(), Some("ROUNDTRIP_KEY"));
    let model = reparsed
        .provider
        .models
        .get("model-a")
        .expect("model-a present");
    assert_eq!(model.supports_streaming, Some(true));
    assert_eq!(model.max_tokens, Some(8192));
    assert!(generated.contains("sseFirstFrameTimeoutMs = 600000"), "generated toml must serialize the sse timeout key in a runtime-parseable form: {generated}");
}

#[test]
fn generate_v2_provider_config_file_writes_camel_case_keys() {
    let config = V2ProviderConfigFile {
        version: Some("2.0.0".into()),
        provider_id: Some("gen-provider".into()),
        provider: V2ProviderConfig {
            id: "gen-provider".into(),
            enabled: Some(true),
            provider_type: "anthropic".into(),
            base_url: "https://api.example.com/v1".into(),
            default_model: "model-x".into(),
            auth: V2ProviderAuthConfig {
                api_key: None,
                env: Some("GEN_PROVIDER_KEY".into()),
                token_file: None,
                secret_file: None,
                entries: None,
                selection: None,
            },
            responses: None,
            concurrency: Some(V2ProviderConcurrencyConfig {
                max_in_flight: Some(2),
                acquire_timeout_ms: None,
                stale_lease_ms: None,
            }),
            compatibility_profile: None,
            models: BTreeMap::new(),
            v3: None,
            timeout: None,
            sse_first_frame_timeout_ms: None,
        },
    };
    let generated = generate_v2_provider_config_file(&config).expect("generate");
    assert!(
        generated.contains("providerId = \"gen-provider\""),
        "{generated}"
    );
    assert!(
        generated.contains("baseURL = \"https://api.example.com/v1\""),
        "{generated}"
    );
    assert!(generated.contains("type = \"anthropic\""), "{generated}");
    assert!(generated.contains("maxInFlight = 2"), "{generated}");
    assert!(
        generated.contains("env = \"GEN_PROVIDER_KEY\""),
        "{generated}"
    );
}

#[test]
fn provider_auth_secret_file_auto_discovers_single_or_multiple_handles() {
    let tmp = std::env::temp_dir().join(format!(
        "rccv3-auth-key-file-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    std::fs::create_dir_all(&tmp).expect("create temp dir");
    let key_file = tmp.join("opencode-go.conf");
    std::fs::write(
        &key_file,
        "opencode-go.key1 = first-secret\nopencode-go.key2 = second-secret\n",
    )
    .expect("write key file");
    let key_file = key_file.to_string_lossy().into_owned();
    let compiled = compile_v2_auth(
        &tmp,
        "opencode-go",
        "source".to_string(),
        V2ProviderAuthConfig {
            api_key: None,
            env: None,
            token_file: None,
            secret_file: Some(key_file.clone()),
            entries: None,
            selection: None,
        },
    )
    .expect("auto discover key file");
    assert_eq!(compiled.entries.len(), 2);
    assert_eq!(compiled.entries[0].alias, "key1");
    assert_eq!(
        compiled.entries[0].secret_file.as_deref(),
        Some(key_file.as_str())
    );
    assert_eq!(
        compiled.entries[0].secret_key.as_deref(),
        Some("opencode-go.key1")
    );
    assert_eq!(compiled.entries[1].alias, "key2");
    assert_eq!(
        compiled.entries[1].secret_key.as_deref(),
        Some("opencode-go.key2")
    );
    assert!(compiled.entries.iter().all(|entry| entry.api_key.is_none()));

    std::fs::write(&key_file, "opencode-go = single-secret\n").expect("write single key");
    let single = compile_v2_auth(
        &tmp,
        "opencode-go",
        "source".to_string(),
        V2ProviderAuthConfig {
            api_key: None,
            env: None,
            token_file: None,
            secret_file: Some(key_file.clone()),
            entries: None,
            selection: None,
        },
    )
    .expect("auto discover single key");
    assert_eq!(single.entries.len(), 1);
    assert_eq!(single.entries[0].alias, "key1");
    assert_eq!(single.entries[0].secret_key.as_deref(), Some("opencode-go"));
    std::fs::remove_dir_all(&tmp).ok();
}

#[test]
fn provider_auth_secret_file_auto_discovery_rejects_mixed_authoring() {
    let error = compile_v2_auth(
        Path::new("."),
        "opencode-go",
        "source".to_string(),
        V2ProviderAuthConfig {
            api_key: None,
            env: None,
            token_file: None,
            secret_file: Some("keys.conf".to_string()),
            entries: Some(Vec::new()),
            selection: None,
        },
    )
    .expect_err("entries plus secretFile must fail");
    assert!(error
        .to_string()
        .contains("cannot combine entries with secretFile"));
}
