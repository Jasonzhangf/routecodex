# 运行时与真源边界路由

本路由适用于 V3 的协议、路由、治理、provider 和错误处理。项目合同由根目录 `AGENTS.md` 维护；这里不复制另一套架构规则。

## 定位受影响流程

1. 先读 `docs/architecture/dagpipe/README.md` 中受影响业务图，检查入口、出口和成功/失败终点。
2. 用 `docs/architecture/v3-function-map.yml` 定位唯一 owner 和允许修改的路径。
3. 用 `docs/architecture/v3-mainline-call-map.yml` 核对实际 caller/callee；资源读写查 `docs/architecture/v3-resource-operation-map.yml`。
4. 从 `docs/architecture/v3-verification-map.yml` 选择受影响行为的必要验证。人工查看面为 `docs/architecture/wiki/v3-mainline-caller-flow.md`。
5. 读取对应源码和已有失败证据，再修改唯一 owner。只有影响本次定位或验收的图/map 缺口需要先补正。

有效定位结果直接复用。不把固定查询次数、全量 map 扫描或旧门禁清单作为每次修改的准入条件。

## 当前实现边界

运行时、协议投影、provider、路由和 CLI 位于 `v3/` Rust workspace。V2 已退役，不再指向旧 N-API、TypeScript pipeline 或 `sharedmodule/llmswitch-core`；V4 的独立重构不代表生产接线。

遵循 `AGENTS.md` 的 Runtime Ownership：Inbound 无损规范化；Relay 业务改写归 Chat Process；Direct 改写归注册 Direct hooks；Outbound 做标准协议投影；Compat 只做 provider 私有适配。控制状态保留在 typed control resources 或 Error chain。

Provider HTTP 错误留在内部 Error chain 并按既有策略恢复。可表达的业务响应忠实传给客户端。不得以本地额外语义校验拦截可转发内容，也不得伪造成功或向模型客户端投影错误响应。

## 验证与交付

开发流程使用 `.agents/skills/rcc-dev-skills/SKILL.md`。通过受影响公开入口或真实 consumer 验证成功、失败和副作用。静态图、源码 gate 和单测各自只证明其覆盖的内容。

完整且重大的 milestone 完成作者验收后，在正式提交/集成边界做一次整体 review，再按 `docs/agent-routing/05-foundation-contract.md` 完成提交、CI、合并、推送和资源收口。内部节点不重复触发整体 review。
