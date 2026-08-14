use super::*;

pub(super) fn test_manifest() -> V3Config05ManifestPublished {
    let authoring = parse_v3_config_02_authoring(
        r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }

[providers.openai]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "ROUTECODEX_V3_TEST_KEY" }] }

[providers.openai.models.gpt-test]
supports_streaming = true
capabilities = ["text", "vision"]

[forwarders.responses]
model = "client-model"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "openai", model = "gpt-test", priority = 1 }]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "responses", priority = 1 }]
"#,
    )
    .unwrap();
    compile_v3_config_05_manifest(authoring).unwrap()
}

pub(super) fn reselection_manifest() -> V3Config05ManifestPublished {
    let authoring = parse_v3_config_02_authoring(
        r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }

[providers.first]
type = "responses"
base_url = "http://first.invalid/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "FIRST_KEY" }] }
[providers.first.models.test]
wire_name = "wire-first"

[providers.second]
type = "responses"
base_url = "http://second.invalid/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "SECOND_KEY" }] }
[providers.second.models.test]
wire_name = "wire-second"

[forwarders.responses]
model = "client-model"
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "first", model = "test", key = "key", priority = 1 },
  { kind = "provider_model", provider = "second", model = "test", key = "key", priority = 2 }
]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "responses", priority = 1 }]
"#,
    )
    .unwrap();
    compile_v3_config_05_manifest(authoring).unwrap()
}

pub(super) fn mixed_protocol_reselection_manifest() -> V3Config05ManifestPublished {
    let authoring = parse_v3_config_02_authoring(
        r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }

[providers.first]
type = "responses"
base_url = "http://first.invalid/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "FIRST_KEY" }] }
[providers.first.models.test]
wire_name = "wire-first"

[providers.chat]
type = "openai_chat"
base_url = "http://chat.invalid/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "CHAT_KEY" }] }
[providers.chat.models.test]
wire_name = "wire-chat"

[forwarders.mixed]
model = "client-model"
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "first", model = "test", key = "key", priority = 1 },
  { kind = "provider_model", provider = "chat", model = "test", key = "key", priority = 2 }
]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "mixed", priority = 1 }]
"#,
    )
    .unwrap();
    compile_v3_config_05_manifest(authoring).unwrap()
}

pub(super) fn responses_process_chat_manifest() -> V3Config05ManifestPublished {
    let authoring = parse_v3_config_02_authoring(
        r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }

[providers.grok]
type = "responses"
base_url = "http://grok.invalid/v1"
default_model = "grok-test"
auth = { type = "api_key", entries = [{ alias = "key", env = "GROK_KEY" }] }
responses = { process = "chat", streaming = "always" }
[providers.grok.models.grok-test]
wire_name = "grok-wire"

[forwarders.grok]
model = "client-model"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "grok", model = "grok-test", key = "key", priority = 1 }]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "grok", priority = 1 }]
"#,
    )
    .unwrap();
    compile_v3_config_05_manifest(authoring).unwrap()
}

pub(super) fn optional_default_manifest() -> V3Config05ManifestPublished {
    let authoring = parse_v3_config_02_authoring(
        r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }

[providers.optional]
type = "responses"
base_url = "http://optional.invalid/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "OPTIONAL_KEY" }] }
	[providers.optional.models.test]
	wire_name = "wire-optional"
	capabilities = ["text", "tools"]

[providers.default]
type = "responses"
base_url = "http://default.invalid/v1"
default_model = "test"
auth = { type = "api_key", entries = [{ alias = "key", env = "DEFAULT_KEY" }] }
	[providers.default.models.test]
	wire_name = "wire-default"
	capabilities = ["text", "tools"]

[route_groups.default.pools.client_model]
selection = { strategy = "priority" }
match = { precedence = 10, entry_protocol = "responses", models = ["client-model"], min_input_tokens = 1, max_input_tokens = 100 }
targets = [{ kind = "provider_model", provider = "optional", model = "test", key = "key", priority = 1 }]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "default", model = "test", key = "key", priority = 1 }]
"#,
    )
    .unwrap();
    compile_v3_config_05_manifest(authoring).unwrap()
}

/// 两个 gpt 候选的 default 池：`is_v3_retain_response_cipher(candidates=2, "gpt-...")`
/// 为 false——多 provider 场景响应密文必须剥离（direct JSON 响应剥离测试用）。
pub(super) fn multi_candidate_test_manifest() -> V3Config05ManifestPublished {
    let authoring = parse_v3_config_02_authoring(
        r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }

[providers.openai]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "gpt-test"
auth = { type = "api_key", entries = [{ alias = "key1", env = "ROUTECODEX_V3_TEST_KEY" }] }
[providers.openai.models.gpt-test]
supports_streaming = true
capabilities = ["text", "vision"]

[providers.openai2]
type = "responses"
base_url = "http://127.0.0.1:10/v1"
default_model = "gpt-test2"
auth = { type = "api_key", entries = [{ alias = "key1", env = "ROUTECODEX_V3_TEST_KEY" }] }
[providers.openai2.models.gpt-test2]
supports_streaming = true
capabilities = ["text", "vision"]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [
  { kind = "provider_model", provider = "openai", model = "gpt-test", key = "key1", priority = 1 },
  { kind = "provider_model", provider = "openai2", model = "gpt-test2", key = "key1", priority = 2 },
]
"#,
    )
    .unwrap();
    compile_v3_config_05_manifest(authoring).unwrap()
}

pub(super) fn deepseek_console_go_profile_manifest() -> V3Config05ManifestPublished {
    let authoring = parse_v3_config_02_authoring(
        r#"
version = 3

[servers.test]
bind = "127.0.0.1"
port = 4444
routing_group = "default"
[servers.test.execution]
allowed_modes = ["direct", "relay"]
allowed_invocation_sources = ["client", "servertool_followup", "dry_run"]
allowed_transports = ["json", "sse"]
continuation = { allowed_owners = ["none", "remote_provider", "routecodex_local"], scope_keys = ["entry_protocol", "server", "routing_group", "session"] }

[providers.ds]
type = "responses"
base_url = "http://127.0.0.1:9/v1"
default_model = "deepseek-v4-flash"
compatibility_profile = "responses:deepseek-console-go"
auth = { type = "api_key", entries = [{ alias = "key1", env = "ROUTECODEX_V3_TEST_KEY" }] }
[providers.ds.models.deepseek-v4-flash]
supports_streaming = true
capabilities = ["text", "vision"]

[forwarders.responses]
model = "client-model"
selection = { strategy = "priority" }
targets = [{ kind = "provider_model", provider = "ds", model = "deepseek-v4-flash", priority = 1 }]

[route_groups.default.pools.default]
selection = { strategy = "priority" }
targets = [{ kind = "forwarder", id = "responses", priority = 1 }]
"#,
    )
    .unwrap();
    compile_v3_config_05_manifest(authoring).unwrap()
}
