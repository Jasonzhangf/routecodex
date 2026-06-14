/**
 * TOML commented template for user config.
 * Provides the default annotated config.toml content.
 * This is the human-editable SSOT template, not a machine-generated skeleton.
 */

export const DEFAULT_CONFIG_TOML_TEMPLATE = `# RouteCodex 主用户配置 (V2)
# 路径: ~/.rcc/config.toml
# 格式: TOML — 支持完整注释，注意不要删除注释，CLI/admin 写回会尽量保留

#------------------------------------------------------------------------------
# 配置版本 (必填，当前只支持 2.0.0)
#------------------------------------------------------------------------------
version = "2.0.0"

#------------------------------------------------------------------------------
# HTTP 服务器配置
# 如果不需要对外暴露 HTTP API，可将 host 改为 127.0.0.1
#------------------------------------------------------------------------------
[httpserver]
# 监听端口 (范围 1024-65535)
port = 5521
# 监听地址 (建议 127.0.0.1 仅本地访问)
host = "127.0.0.1"

#------------------------------------------------------------------------------
# Virtual Router 模式 (仅支持 v2)
#------------------------------------------------------------------------------
virtualrouterMode = "v2"

#------------------------------------------------------------------------------
# Virtual Router 路由策略
# routingPolicyGroups 定义命名路由策略组；每个 router 端口通过 httpserver.ports[].routingPolicyGroup 选择
#------------------------------------------------------------------------------
[virtualrouter]

#------------------------------------------------------------------------------
# 策略组: default (示例)
# 每个 routing 键对应一种请求类型：default、coding、thinking、search、tools、multimodal、vision 等
# 每个 provider 用 provider_key 格式: "provider_group.provider_id"
#------------------------------------------------------------------------------
[virtualrouter.routingPolicyGroups."default"]

# 默认路由: 未分类请求
# priority 越高越优先，mode 支持 priority / weighted
# targets 为 provider 列表，loadBalancing 控制权重
[[virtualrouter.routingPolicyGroups."default".routing.default]]
id = "default-primary"
priority = 200
mode = "priority"
targets = ["default_provider.provider_default"]
[virtualrouter.routingPolicyGroups."default".routing.default.loadBalancing]
strategy = "weighted"
[virtualrouter.routingPolicyGroups."default".routing.default.loadBalancing.weights]
"default_provider.provider_default" = 1

# 编码路由: coding 类请求
[[virtualrouter.routingPolicyGroups."default".routing.coding]]
id = "coding-primary"
priority = 200
mode = "weighted"
targets = ["coding_provider.provider_coding"]
[virtualrouter.routingPolicyGroups."default".routing.coding.loadBalancing]
strategy = "weighted"
[virtualrouter.routingPolicyGroups."default".routing.coding.loadBalancing.weights]
"coding_provider.provider_coding" = 1

# 网页搜索路由: web_search 类请求
[[virtualrouter.routingPolicyGroups."default".routing.web_search]]
id = "web_search-primary"
priority = 180
targets = ["search_provider.provider_search"]
[virtualrouter.routingPolicyGroups."default".routing.web_search.loadBalancing]
strategy = "weighted"
[virtualrouter.routingPolicyGroups."default".routing.web_search.loadBalancing.weights]
"search_provider.provider_search" = 10

# 多模态路由: multimodal 类请求
[[virtualrouter.routingPolicyGroups."default".routing.multimodal]]
id = "multimodal-auto"
priority = 180
mode = "priority"
targets = ["vision_provider.provider_vision"]
[virtualrouter.routingPolicyGroups."default".routing.multimodal.loadBalancing]
strategy = "weighted"
[virtualrouter.routingPolicyGroups."default".routing.multimodal.loadBalancing.weights]
"vision_provider.provider_vision" = 1

#------------------------------------------------------------------------------
# 组级负载均衡 (fallback 策略，当 routing 条目未单独配置时生效)
#------------------------------------------------------------------------------
[virtualrouter.routingPolicyGroups."default".loadBalancing]
strategy = "round-robin"

#------------------------------------------------------------------------------
# 会话保持 (避免频繁切换 provider)
# enabled: 是否启用
# tickMs: 会话心跳间隔 (ms)
# retentionMs: 会话保留时长 (ms)
#------------------------------------------------------------------------------
[virtualrouter.routingPolicyGroups."default".session]
enabled = true
tickMs = 1500
dueWindowMs = 0
retentionMs = 1200000
holdNonStreaming = true
holdMaxMs = 60000

#------------------------------------------------------------------------------
# 网页搜索引擎配置
# injectPolicy: selective 按需注入, always 总是注入
# 引擎配置决定哪个 provider 处理 web_search 请求
#------------------------------------------------------------------------------
[virtualrouter.routingPolicyGroups."default".webSearch]
injectPolicy = "selective"
force = false

[[virtualrouter.routingPolicyGroups."default".webSearch.engines]]
id = "example:web_search_engine"
providerKey = "search_provider.provider_search"
description = "示例搜索引擎 (请替换为实际 provider)"
default = true
executionMode = "direct"
directActivation = "route"
modelId = "default-model"
serverToolsDisabled = true
`;
