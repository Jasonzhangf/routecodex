use routecodex_v3_config::{
    collect_v3_route_group_catalog_model_refs,
    internal::{
        is_v3_hidden_codex_future_model, v3_builtin_catalog_model_ids, v3_builtin_model_defaults,
        V3BuiltinModelDefaults,
    },
    is_v3_route_group_single_provider_visible_model, V3Config05ManifestPublished,
};
use serde_json::{json, Map, Value};
use std::collections::BTreeSet;

pub fn build_v3_models_catalog(
    manifest: &V3Config05ManifestPublished,
    routing_group: &str,
    expose_models: &[String],
) -> serde_json::Value {
    let mut data = Vec::new();
    let mut seen = std::collections::BTreeSet::new();
    // expose_models 白名单（visible_id）；空 = 全量暴露（兼容现有）。
    let is_exposed = |visible_id: &str| -> bool {
        expose_models.is_empty() || expose_models.iter().any(|id| id == visible_id)
    };
    let scoped_models = collect_v3_route_group_catalog_model_refs(manifest, routing_group);
    // builtin 目录模型清单来自 config 内部配置层（internal.toml [builtin_catalog_models]），
    // 本面不内联具体模型名：路由组内存在对应模型引用时以 builtin 目录入口暴露。
    for builtin_model_id in v3_builtin_catalog_model_ids() {
        let builtin_refs = scoped_models
            .values()
            .filter(|model_ref| {
                model_ref.visible_id == *builtin_model_id || model_ref.model_id == *builtin_model_id
            })
            .collect::<Vec<_>>();
        if builtin_refs.is_empty() {
            continue;
        }
        let capabilities = builtin_refs
            .iter()
            .flat_map(|model_ref| model_ref.capabilities.iter().cloned())
            .collect::<BTreeSet<_>>();
        let capabilities = if capabilities.is_empty() {
            default_builtin_v3_model_capabilities(builtin_model_id)
        } else {
            capabilities
        };
        let mut item = build_v3_codex_model_metadata(
            builtin_model_id,
            builtin_model_id,
            None,
            Some(&capabilities),
            is_v3_route_group_single_provider_visible_model(
                manifest,
                routing_group,
                builtin_model_id,
            ),
        );
        item.insert("owned_by".to_string(), json!("openai"));
        seen.insert(builtin_model_id.to_string());
        if is_exposed(builtin_model_id) {
            data.push(Value::Object(item));
        }
    }
    for model_ref in scoped_models.values() {
        if is_v3_hidden_codex_future_model(&model_ref.visible_id)
            || is_v3_hidden_codex_future_model(&model_ref.model_id)
            || seen.contains(&model_ref.visible_id)
        {
            continue;
        }
        if !is_exposed(&model_ref.visible_id) {
            continue;
        }
        let Some(provider) = manifest.providers.get(&model_ref.provider_id) else {
            continue;
        };
        if !provider.enabled {
            continue;
        }
        let Some(model) = provider.models.get(&model_ref.model_id) else {
            continue;
        };
        let mut item = build_v3_codex_model_metadata(
            &model_ref.visible_id,
            &model.id,
            model.max_context_tokens,
            Some(&model_ref.capabilities),
            is_v3_route_group_single_provider_visible_model(
                manifest,
                routing_group,
                &model_ref.visible_id,
            ),
        );
        item.insert(
            "owned_by".to_string(),
            json!(format!("provider:{}", provider.id)),
        );
        item.insert("provider_id".to_string(), json!(provider.id));
        item.insert("canonical_model_id".to_string(), json!(model.id));
        item.insert("wire_model".to_string(), json!(model.wire_name));
        item.insert("aliases".to_string(), json!(model.aliases));
        item.insert(
            "capabilities".to_string(),
            json!(model_ref.capabilities.iter().cloned().collect::<Vec<_>>()),
        );
        item.insert(
            "supports_streaming".to_string(),
            json!(model.supports_streaming),
        );
        item.insert(
            "supports_thinking".to_string(),
            json!(model.supports_thinking),
        );
        item.insert("thinking".to_string(), json!(model.thinking));
        item.insert("max_tokens".to_string(), json!(model.max_tokens));
        item.insert(
            "max_context_tokens".to_string(),
            json!(model.max_context_tokens),
        );
        item.insert("features".to_string(), json!(model.features));
        seen.insert(model_ref.visible_id.clone());
        data.push(Value::Object(item));
    }
    // Direct-routing surface: every enabled provider model is addressable as
    // `provider.model` regardless of route-group declarations, so expose those
    // ids alongside the routed catalog.
    for provider in manifest.providers.values() {
        if !provider.enabled {
            continue;
        }
        for model in provider.models.values() {
            let direct_id = format!("{}.{}", provider.id, model.id);
            if seen.contains(&direct_id)
                || is_v3_hidden_codex_future_model(&model.id)
                || !is_exposed(&direct_id)
            {
                continue;
            }
            let capabilities = model.capabilities.iter().cloned().collect::<BTreeSet<_>>();
            let mut item = build_v3_codex_model_metadata(
                &direct_id,
                &model.id,
                model.max_context_tokens,
                Some(&capabilities),
                true,
            );
            item.insert(
                "owned_by".to_string(),
                json!(format!("provider:{}", provider.id)),
            );
            item.insert("provider_id".to_string(), json!(provider.id));
            item.insert("canonical_model_id".to_string(), json!(model.id));
            item.insert("wire_model".to_string(), json!(model.wire_name));
            item.insert("direct_route".to_string(), json!(true));
            item.insert(
                "capabilities".to_string(),
                json!(model.capabilities.clone()),
            );
            item.insert(
                "supports_streaming".to_string(),
                json!(model.supports_streaming),
            );
            item.insert(
                "supports_thinking".to_string(),
                json!(model.supports_thinking),
            );
            item.insert("max_tokens".to_string(), json!(model.max_tokens));
            item.insert(
                "max_context_tokens".to_string(),
                json!(model.max_context_tokens),
            );
            seen.insert(direct_id);
            data.push(Value::Object(item));
        }
    }
    let models = data.clone();
    json!({
        "object": "list",
        "data": data,
        "models": models,
    })
}

struct V3ModelCapabilityProjection {
    input_modalities: Vec<&'static str>,
    supports_image_detail_original: bool,
    supports_search_tool: bool,
    web_search_tool_type: &'static str,
}

/// 内置目录模型默认能力（内部配置真源：internal.toml [builtin_catalog_models.defaults]），
/// 未命中时回退最小能力集 ["text"]。
fn default_builtin_v3_model_capabilities(model_id: &str) -> BTreeSet<String> {
    let capabilities = match v3_builtin_model_defaults(model_id) {
        Some(defaults) => defaults
            .capabilities
            .iter()
            .map(|capability| capability.as_str())
            .collect::<Vec<_>>(),
        None => vec!["text"],
    };
    capabilities
        .into_iter()
        .map(str::to_string)
        .collect::<BTreeSet<_>>()
}

/// reasoning 级别列表构建（effort 顺序来自内部配置 internal.toml
/// [builtin_catalog_models.defaults].reasoning_efforts，描述文案是静态 UI 模板）。
/// 非内置预设模型固定暴露 4 级（low/medium/high/xhigh）。
fn build_v3_supported_reasoning_levels(efforts: &[String], has_preset: bool) -> Value {
    let effort_order: Vec<&str> = if has_preset {
        efforts.iter().map(String::as_str).collect()
    } else {
        vec!["low", "medium", "high", "xhigh"]
    };
    let descriptions = [
        ("low", "Fast responses with lighter reasoning"),
        (
            "medium",
            "Balances speed and reasoning depth for everyday tasks",
        ),
        ("high", "Greater reasoning depth for complex problems"),
        ("xhigh", "Extra high reasoning depth for complex problems"),
        ("max", "Maximum reasoning depth for the hardest tasks"),
        ("ultra", "Ultra reasoning depth for frontier-grade tasks"),
    ];
    Value::Array(
        effort_order
            .iter()
            .map(|effort| {
                let description = descriptions
                    .iter()
                    .find(|(key, _)| key == effort)
                    .map(|(_, desc)| *desc)
                    .unwrap_or("Reasoning depth for complex tasks");
                json!({"effort": effort, "description": description})
            })
            .collect(),
    )
}

fn build_v3_model_capability_projection(
    capabilities: Option<&BTreeSet<String>>,
    preset: Option<&V3BuiltinModelDefaults>,
) -> V3ModelCapabilityProjection {
    let owned_default;
    let capabilities = match capabilities {
        Some(capabilities) => capabilities,
        None => {
            owned_default = match preset {
                Some(defaults) => defaults.capabilities.iter().cloned().collect(),
                None => ["text"].into_iter().map(str::to_string).collect(),
            };
            &owned_default
        }
    };
    let image_capable = capabilities.contains("multimodal") || capabilities.contains("vision");
    let supports_search_tool = capabilities.contains("web_search");
    let mut input_modalities = vec!["text"];
    if image_capable {
        input_modalities.push("image");
    }
    V3ModelCapabilityProjection {
        input_modalities,
        supports_image_detail_original: image_capable,
        supports_search_tool,
        web_search_tool_type: if image_capable {
            "text_and_image"
        } else {
            "text"
        },
    }
}

fn build_v3_codex_model_metadata(
    visible_id: &str,
    canonical_model_id: &str,
    max_context_tokens: Option<u64>,
    capabilities: Option<&BTreeSet<String>>,
    single_provider: bool,
) -> Map<String, Value> {
    let preset = v3_builtin_model_defaults(canonical_model_id);
    let is_builtin_bare = visible_id == canonical_model_id && preset.is_some();
    let preset_context_window = preset.and_then(|defaults| defaults.context_window);
    let context_window = if is_builtin_bare {
        preset_context_window.or(max_context_tokens)
    } else {
        max_context_tokens.or(preset_context_window)
    }
    .unwrap_or(128_000);
    // preset 模型的描述 / reasoning / 最小客户端版本全部来自内部配置层
    // （internal.toml 必填字段，缺失即解析 fail-fast）；非 preset 模型用
    // 不包含具体模型名的通用默认文案。
    let description = preset
        .map(|defaults| defaults.description.clone())
        .unwrap_or_else(|| "RouteCodex advanced agentic coding model.".to_string());
    let default_reasoning_level = preset
        .map(|defaults| defaults.default_reasoning_level.clone())
        .unwrap_or_else(|| "medium".to_string());
    let minimal_client_version = preset
        .map(|defaults| defaults.minimal_client_version.clone())
        .unwrap_or_else(|| "0.98.0".to_string());
    let supported_reasoning_efforts = preset
        .map(|defaults| defaults.reasoning_efforts.clone())
        .unwrap_or_default();
    let supported_reasoning_levels =
        build_v3_supported_reasoning_levels(&supported_reasoning_efforts, preset.is_some());
    let capability_projection = build_v3_model_capability_projection(capabilities, preset);
    let mut item = Map::from_iter([
        ("id".to_string(), json!(visible_id)),
        ("object".to_string(), json!("model")),
        ("owned_by".to_string(), json!("provider")),
        ("slug".to_string(), json!(visible_id)),
        ("display_name".to_string(), json!(visible_id)),
        ("base_instructions".to_string(), json!("")),
        ("description".to_string(), json!(description)),
        ("prefer_websockets".to_string(), json!(false)),
        ("support_verbosity".to_string(), json!(single_provider)),
        (
            "default_verbosity".to_string(),
            json!(if single_provider { "low" } else { "none" }),
        ),
        ("apply_patch_tool_type".to_string(), json!("freeform")),
        (
            "web_search_tool_type".to_string(),
            json!(capability_projection.web_search_tool_type),
        ),
        (
            "supports_search_tool".to_string(),
            json!(capability_projection.supports_search_tool),
        ),
        (
            "input_modalities".to_string(),
            json!(capability_projection.input_modalities),
        ),
        (
            "supports_image_detail_original".to_string(),
            json!(capability_projection.supports_image_detail_original),
        ),
        (
            "truncation_policy".to_string(),
            json!({"mode":"tokens","limit":10000}),
        ),
        ("supports_parallel_tool_calls".to_string(), json!(true)),
        (
            "reasoning_summary_format".to_string(),
            json!(if single_provider {
                "experimental"
            } else {
                "none"
            }),
        ),
        (
            "supports_reasoning_summaries".to_string(),
            json!(single_provider),
        ),
        (
            "default_reasoning_summary".to_string(),
            json!(if single_provider { "none" } else { "off" }),
        ),
        (
            "default_reasoning_level".to_string(),
            json!(default_reasoning_level),
        ),
        (
            "supported_reasoning_levels".to_string(),
            supported_reasoning_levels,
        ),
        ("shell_type".to_string(), json!("shell_command")),
        ("visibility".to_string(), json!("list")),
        (
            "minimal_client_version".to_string(),
            json!(minimal_client_version),
        ),
        ("supported_in_api".to_string(), json!(true)),
        ("priority".to_string(), json!(0)),
        (
            "experimental_supported_tools".to_string(),
            // Codex currently consumes this field for recognized experimental tool names such as
            // `test_sync_tool`; `apply_patch` and search are controlled by `apply_patch_tool_type`
            // and `supports_search_tool`, not by this vector.
            json!(Vec::<&str>::new()),
        ),
        ("effective_context_window_percent".to_string(), json!(95)),
        ("context_window".to_string(), json!(context_window)),
        ("max_context_window".to_string(), json!(context_window)),
    ]);
    // gpt-5.6 系列不对外暴露（is_v3_hidden_codex_future_model 在 models catalog 层隐藏），
    // 且 RouteCodex 不支持 responses_lite 请求面（input/instructions 拆分、禁 parallel
    // tool calls、responses_lite header 均未实现）——绝不向 Codex 广告 use_responses_lite
    // 或 tool_mode=code_mode_only，避免客户端切换到未实现的嵌套 exec/wait 入口。
    item
}
