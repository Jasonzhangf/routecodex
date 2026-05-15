# config.toml 多端口路由与 provider 直连闭环设计

## 目标拆解
- 单一 `config.toml` 是用户配置唯一入口，一个文件支持多个输入端口。
- 每个输入端口可配置 `router` 或 `provider` 模式，但 route-level 参数（如 thinking/reasoning/tools 参数）与端口模式解耦。
- 路由表简化为按 `priority` 顺序排列的数组；每一项声明目标与权重，运行时合并为一个 weighted target pool，保留数组顺序作为优先展示/稳定顺序。
- `responses` / `openai-chat` / `anthropic-messages` 的 provider 直连能力与 router 模式共用同一 route 参数语义。
- 路由表后续可动态修改配置：admin/API/热更新路径必须更新同一 config 真源并重载 runtime，不引入第二份运行时状态真源。

## 唯一真源定位
- 配置真源：`config.toml` -> `src/config/routecodex-config-loader.ts` -> `src/config/user-config-loader.ts` / `src/config/virtual-router-builder.ts`。
- 端口真源：`httpserver.ports[]`，每个 port 显式声明 `mode` 与专属字段。
- 路由真源：`virtualrouter.routingPolicyGroups.<group>.routing.<route>[]`。
- Router runtime 真源：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/`。
- Provider direct 真源：`src/server/runtime/http-server/provider-direct-pipeline.ts` 与 `RouteCodexHttpServer.executeProviderDirectPipelineForPort`。

## 简化路由配置语义
推荐形态：

```toml
[[virtualrouter.routingPolicyGroups."default".routing.thinking]]
target = "qwen.qwen3-coder"
weight = 10
priority = 200
[virtualrouter.routingPolicyGroups."default".routing.thinking.routeParams]
reasoning_effort = "high"

[[virtualrouter.routingPolicyGroups."default".routing.thinking]]
target = "openai.gpt-5.2"
weight = 3
priority = 100
[virtualrouter.routingPolicyGroups."default".routing.thinking.routeParams]
reasoning_effort = "high"

[[virtualrouter.routingPolicyGroups."default".routing.tools]]
target = "qwen.qwen3-coder"
weight = 10
priority = 200
[virtualrouter.routingPolicyGroups."default".routing.tools.routeParams]
reasoning_effort = "low"
```

解析规则：
- 同一路由数组按 `priority desc` / 原始数组顺序排序。
- 每项的 `target + weight` 合并为该 route 的一个 weighted pool。
- `routeParams` 是 route 语义，不属于 provider mode 或 router mode。
- 旧结构 `targets + loadBalancing.weights` 可作为迁移输入，但不再作为推荐配置模板。

## 技术方案
1. 配置解析
   - TS 与 Rust bootstrap 同步支持简化路由项 `{ target, weight, priority, routeParams }`。
   - 合并后的 pool 保持 `loadBalancing.strategy = weighted`，禁止变成多个单目标 pool。
   - per-port `routingPolicyGroup` 提取必须能识别简化项、旧 `targets`、旧 `loadBalancing.weights`。
2. Route 参数透传
   - Router 模式：选中 route pool 后把 `routeParams` 写入 selected target，并在 req_process route selection 中写入 normalized metadata 与 provider payload。
   - Provider 模式：输入端口绑定 provider 后仍按请求 routeHint/endpoint/metadata 解析同一 routeParams；不能因为是 provider direct 就丢失 thinking/tools 参数。
   - 删除/替换硬编码 `routeName -> reasoning_effort` 规则；`thinking high`、`tools low` 必须来自配置。
3. Provider direct 矩阵
   - direct：协议一致时原样直连。
   - relay：只有有明确语义转换实现的协议对才允许；未实现组合 fail-fast。
   - auto：协议一致走 direct，不一致走 relay，但必须遵守上条 fail-fast。
4. 动态配置修改
   - admin/API 修改路由表时写回同一个 config 真源。
   - 热更新只调用统一 reload/runtime rebuild；禁止维护第二份内存路由真源。

## 风险点
- 多个单目标 pool 会导致第一个 pool 永远先被选择，破坏权重语义。
- `routeName` 硬编码 reasoning 会让 provider mode/router mode 产生假差异。
- provider direct relay 若只声明支持但不转换 payload，会造成语义透传错误。
- 动态配置若只改内存不写回 config，会和单一 config.toml 目标冲突。

## 验证矩阵
- Config loader：TOML 简化 route 数组、旧结构兼容、非法字段 fail-fast。
- Routing bootstrap：targets+weights 合并为单 weighted pool，顺序按 priority，targetKeys 完整。
- Per-port routing：不同 router port 绑定不同 group，provider 白名单隔离有效。
- Route params：thinking route 注入 high，tools route 注入 low；router/provider direct 都覆盖。
- Provider direct：openai-chat / openai-responses / anthropic-messages direct 与 relay 矩阵，未实现 relay fail-fast。
- Dynamic config：admin/API 写回 config 后 reload，新增/修改/删除 route 立即生效。
- Build：TS typecheck + Rust crate tests + targeted Jest。

## 修复顺序
1. 先修 route config 解析与合并，确保单 weighted pool。
2. 再修 routeParams 在 Rust route selection 与 provider payload 的唯一透传点。
3. 再修 provider direct 协议矩阵与 fail-fast。
4. 再补动态配置写回与 reload 验证。
5. 最后更新 TOML template 和迁移/文档。
