# Architecture Templates

本目录承载“规则下沉”的项目级真源骨架，目标是把全局原则落成可查询、可维护、可逐步 gate 化的项目模板。

- `wiki/README.md`
  - 架构 wiki 路径索引：先看哪里、owner 和 mainline 分别去哪查、closeout/gate 去哪查
- `wiki/coverage-matrix.md`
  - 架构 wiki 覆盖矩阵：哪些逻辑已有 review 面，哪些逻辑还缺
- `wiki/request-mainline-call-graph.md`
- `wiki/response-mainline-call-graph.md`
- `wiki/error-mainline-call-graph.md`
- `wiki/runtime-lifecycle-call-graph.md`
- `wiki/servertool-ownership-map.md`
- `wiki/virtual-router-ownership-map.md`
- `wiki/metadata-boundary-map.md`
- `wiki/metadata-center-audit.md`
- `wiki/metadata-center-mainline-source.md`
- `wiki/chat-process-protocol-mapping.md`
- `wiki/server-responses-sse-bridge-map.md`
- `wiki/responses-direct-relay-map.md`
- `wiki/servertool-followup-call-graph.md`
- `snapshot-stage-contract.md`
- `responses-direct-tool-shape-rustification-plan.md`
- `responses-request-compat-rustification-plan.md`
  - 定义 `--snap` 默认边界四件套、`--snap-stages` 选择器、模块级 snap 命名族、路径归档与最小测试覆盖

## 文件职责

- `function-map.yml`
  - 记录关键功能的 `feature_id -> owner -> canonical types/builders -> allowed/forbidden paths -> required tests -> migration target`
  - 用于快速定位唯一修改点，防止重复实现和多处同时改
  - quota 生命周期、统一 control surface、`route non-empty` 这类全局不变量也必须显式登记，避免散落到 handler/executor/adapter

- `mainline-call-map.yml`
  - 记录 request / response / error 主线的相邻 caller-callee 绑定
  - 用于识别 facade / wrapper / transitional layer 与 truth owner 的关系，防止只看 feature owner registry 仍改错主线位置
  - 未验证的边必须显式写 `binding_pending`

- `wiki/mainline-call-graph.md`
  - 从 `mainline-call-map.yml` + `function-map.yml` 自动生成的 Mermaid review 面
  - 只负责可视化和 review，不是第二份 SSOT；禁止手改

- `wiki/html/*.html`
  - 从 `wiki/*.md` 自动生成的正式 HTML render 文档
  - 给人直接浏览 Mermaid 图、表格、说明；属于 repo 内正式文档，不允许再依赖 `/tmp/*.html` 临时页充当正式 review 面
  - 内容必须与对应 Markdown wiki 同源，不允许手写第二份 HTML 真相

- `wiki/README.md`
  - 记录“当你要找架构真源时先看哪、后看哪”
  - 不是第二份设计文档，只做路径索引和使用顺序

- `wiki/coverage-matrix.md`
  - 记录当前 wiki 覆盖状态与下一批待补页面
  - 用于防止 function map / mainline map 已有，但 review 面仍长期缺失

- `wiki/request-mainline-call-graph.md` / `wiki/response-mainline-call-graph.md` / `wiki/error-mainline-call-graph.md` / `wiki/runtime-lifecycle-call-graph.md`
  - 从 `mainline-call-map.yml` 自动生成的分链 review 面
  - 用于只看单条主线，降低总图 review 噪音

- `wiki/servertool-ownership-map.md` / `wiki/virtual-router-ownership-map.md`
  - 从 `function-map.yml` 自动生成的专题 owner 聚合页
  - 用于专题审计时快速收敛 owner、验证栈、允许/禁止修改路径

- `wiki/metadata-boundary-map.md`
  - metadata / continuation scope 的 request/response 闭环 review 面
  - 用于审计 `sessionId / requestId / pipelineId / continuationOwner` 如何传递、哪里必须断开

- `wiki/metadata-center-audit.md`
  - metadata center 设计输入页
  - 用于审计当前 metadata family、重复 merge/backfill 漂移点、以及 request/response 各阶段的现状

- `wiki/metadata-center-mainline-source.md`
  - metadata center 的 request-scoped mainline source review 面
  - 用于锁 `request_truth / continuation_context / runtime_control / provider_observation / client_attachment_scope / debug_snapshot` 的分层与写入 owner

- `metadata-center-manifest.yml`
  - metadata center 的 machine-readable lifecycle/slot/provenance manifest
  - 给 gate/generator/agent 消费，与 wiki 页共用同一组 node ID 和 family/slot 边界

- `mainline-binding-budget.yml`
  - 记录各条 mainline 当前允许保留的 `partial` / `binding pending` 债务预算
  - 用于把“已知未完全绑定”锁成显式预算，禁止无审计增长

- `topology-sync-manifest.yml`
  - 记录 topology 文档当前允许保留但尚未被 call-map/manifest/wiki 消费的节点 debt
  - 用于把 topology review debt 从“信息输出”升级成显式预算锁

- `wiki/stopless-session-mainline-source.md`
  - stopless 的 runtime metadata / current-turn `tool_outputs` 主线 review 面
  - 用于审计 stopless 真源是否仍只来自当前请求闭环，而不是 file persistence / tmux / `ROUTECODEX_SESSION_DIR`

- `wiki/chat-process-protocol-mapping.md`
  - 三协议 `openai-chat / openai-responses / anthropic-messages` 进入统一 chat process 的字段映射 review 面
  - 用于审计哪些语义已 lift 到 `chat/semantics`，哪些还残留在 legacy metadata / transitional surfaces

- `wiki/server-responses-sse-bridge-map.md`
  - server `JSON/SSE` response facade 与 Rust projection owner 的 review 面
  - 用于审计 SSE bridge 是否保持薄壳，以及 JSON/SSE 是否对同一响应语义等价

- `wiki/responses-direct-relay-map.md`
  - `/v1/responses` direct vs relay ownership、合法 continuation 入口、非法 crossing 与 provider pin 的 review 面
  - 用于审计 continuation 是否仍按 `entryKind + continuationOwner + scope` 三重隔离

- `wiki/servertool-followup-call-graph.md`
  - `followup / CLI projection / stopless` 三条 servertool 主链分支的 review 面
  - 用于审计 followup 是否仍只走 relay reenter，CLI/stopless 是否仍与 followup 隔离

- `verification-map.yml`
  - 记录关键功能的最小验证栈：`unit / contract / integration / smoke / build`
  - 用于改动前后快速确定必须跑哪些验证

- `scripts/architecture/verify-architecture-templates.mjs`
  - 检查架构模板文件是否存在、非空、最小字段齐全

- `scripts/architecture/render-architecture-wiki-pages.mjs`
  - 自动生成 wiki 分链页和专题 owner 页

- `scripts/architecture/verify-architecture-wiki-sync.mjs`
  - 检查所有自动生成 wiki 页面是否与真源同步

- `scripts/architecture/render-architecture-wiki-html.mjs`
  - 自动生成 `docs/architecture/wiki/html/*.html` 正式渲染文档

- `scripts/architecture/verify-architecture-wiki-html-sync.mjs`
  - 检查 HTML render artifact 是否与 Markdown wiki 同步

- `scripts/architecture/verify-function-map-coverage.mjs`
  - 检查 function-map 与 verification-map 的 feature 覆盖关系

- `scripts/architecture/verify-function-map-paths.mjs`
  - 检查每个 feature 的 `allowed_paths` / `forbidden_paths` 是否存在并指向真实目录

- `scripts/architecture/verify-function-map-boundary-mentions.mjs`
  - 检查每个 feature 的 `canonical_builders` 至少在 `allowed_paths` 下真实命中一次，并提示 forbidden 区域的字符串越界

- `scripts/architecture/verify-function-map-owner-uniqueness.mjs`
  - 检查 `owner_module` 必须落在 `allowed_paths` 范围内，且同一 `canonical_builders` 不能被多个 feature 重复声明

- `scripts/architecture/verify-function-map-canonical-builder-definitions.mjs`
  - 检查每个 `canonical_builders` 在 `owner_module` 内必须有且只有一个实体定义；对同 stem 的 `.ts/.js` 配对桥接按单定义去重；禁止在其它 `allowed_paths` 或任意 `forbidden_paths` 重定义

- `scripts/architecture/verify-function-map-forbidden-mentions.mjs`
  - 检查 `canonical_builders` 不得出现在 `forbidden_paths`；若确有合法引用，必须显式写入 `forbidden_mentions_allowlist`

- `scripts/architecture/verify-function-map-required-tests.mjs`
  - 检查 `required_tests` 文件真实存在，`required_gates` 对应的 `npm run` 脚本真实存在

- `scripts/architecture/verify-architecture-mainline-binding-pending-gate.mjs`
  - 按 `mainline-binding-budget.yml` 校验各 chain 的 `anchored / partial / binding pending` 不得回退或增长

- `scripts/architecture/verify-architecture-topology-doc-sync.mjs`
  - 按 `topology-sync-manifest.yml` 校验 topology 文档未消费节点 debt 不得静默增长或遗留过期 allowlist

- `docs/architecture/fallback-denylist.json`
  - 定义核心架构路径的 fallback/degrade denylist 与显式 allowlist

- `scripts/architecture/verify-architecture-fallback-denylist.mjs`
  - 扫描核心架构路径中的 fallback/degrade/dual-path 语义，未进入 allowlist 的命中直接失败

- `scripts/architecture/verify-architecture-feature-id-anchors.mjs`
  - 检查每个 `feature_id` 至少在 owner/allowed 路径下有一个源码锚点，支持从代码反查 map

- `scripts/architecture/verify-architecture-nonadjacent-conversion.mjs`
  - 扫描临时编号、明显跨节点 `build*From*` 命名，以及若干已知 shortcut 模式

- `scripts/architecture/verify-architecture-feature-anchor-coverage.mjs`
  - 检查每个 feature 在 owner 区至少有 1 个源码锚点文件，且 canonical builders 至少命中 2 个文件

- `scripts/architecture/verify-architecture-duplicate-dto-patterns.mjs`
  - 扫描 `HubReq* / HubResp* / VrRoute* / ErrorErr*` 的重复定义式声明，拦截 Rust/TS 双份 shape、alias mirror 与本地 envelope 重名；不允许 warning-only 漂移

- `scripts/architecture/verify-architecture-provider-specific-leaks.mjs`
  - 扫描 Hub Pipeline / Virtual Router 核心层中的 provider-specific 分支与兼容泄漏，阻止通用层承载 provider 特例

- `scripts/architecture/verify-architecture-thin-wrapper-only.mjs`
  - 扫描 Hub process / native engine-selection 薄壳层，拦截对 `messages/tool_calls/content/payload` 的直接改写

- `scripts/architecture/verify-architecture-metadata-leak-boundary.mjs`
  - 扫描 provider outbound / client response 投影层，拦截内部 `metadata/__rt/metaCarrier/errorCarrier/snapshot/debug` 混入正常 payload

- `scripts/architecture/verify-architecture-error-chain-bypass.mjs`
  - 扫描非 owner 层里手拼 provider error event、手写 retryable/affectsHealth/cooldown 分类字段，防止旁路统一 `ErrorErr` 主链

- `scripts/architecture/verify-architecture-owner-queryability.mjs`
  - 检查每个 feature 是否具备 `feature_id -> owner_module -> source anchor -> canonical builder -> required tests/gates` 的可查询闭环

- `scripts/architecture/verify-architecture-feature-map-growth-discipline.mjs`
  - 检查源码里的 `feature_id:` 锚点是否都已同步进入 `function-map.yml` 与 `verification-map.yml`，防止新增关键功能重新脱离索引

- `scripts/architecture/verify-architecture-forbidden-path-growth.mjs`
  - 检查 `canonical_types + canonical_builders` 不得在 `forbidden_paths` 生长，防止错误层重新长出第二份实现

- `scripts/architecture/verify-architecture-metadata-center-manifest-code-sync.mjs`
  - 检查 `metadata-center-manifest.yml` 声明的 family/slot/provenance 是否真实绑定到 `MetadataCenter` 类型、state、writer、reader 和 release 路径

- `scripts/architecture/verify-architecture-adjacent-builder-naming.mjs`
  - 检查架构 owner builder/parser/projector 是否显式编码相邻 source/target；除入口 payload、metadata carrier、error chain 特例外，禁止泛化命名与旧 `req_process/resp_process` 退化

- `scripts/architecture/verify-architecture-snapshot-stage-contract.mjs`
  - 检查 snapshot stage contract 是否完整：默认边界四件套、模块级命名族、CLI 入口、文档引用、最小测试覆盖
- `scripts/architecture/verify-architecture-snapshot-stage-owners.mjs`
  - 扫描 snapshot stage 真正使用点，强制只允许批准的边界 stage 与 owner 命名族，防止新增漂移 owner 绕过 contract
- `scripts/architecture/verify-responses-direct-tool-shape-contract.mjs`
  - 检查 Responses direct passthrough 的工具协议 contract：禁止 chat-style `tools[].function.name` 混入 Responses wire，且主 CI 必须跑对应 direct regression
- `scripts/architecture/verify-responses-direct-tool-shape-rust-first.mjs`
  - 检查 direct/provider 两条入口都显式先调用 Rust validator，防止回到纯 TS 校验
- `scripts/architecture/verify-responses-request-compat-rust-only.mjs`
  - 检查 `responses:c4m` / `responses:crs` request compat 与 function normalization 的唯一真源仍在 Rust `req_outbound_stage3_compat`，TS 只能通过 `runReqOutboundStage3CompatJson` 调用

## 使用规则

1. 新增关键功能或发现定位困难的老功能时，先补 `function-map.yml`。
2. 新增回归要求或发现测试经常漏跑时，补 `verification-map.yml`。
3. 规则先落模板，再逐步补脚本 gate；不要反过来只靠口头约定。
4. 模板未补全前，只能宣称“已建立骨架”，不能宣称“全项目已完成架构索引化”。
5. 每次补 feature 行后，至少运行：
   - `npm run verify:architecture-ci`
   - 若需逐项定位，再拆跑各单项 `verify:architecture-*` / `verify:function-map-*`
   - `npm run verify:architecture-adjacent-builder-naming`
   - `npm run verify:architecture-snapshot-stage-contract`
   - `npm run verify:architecture-snapshot-stage-owners`
   - `npm run verify:responses-direct-tool-shape-contract`
   - `npm run verify:responses-direct-tool-shape-rust-first`
   - `npm run verify:responses-request-compat-rust-only`
6. 若某功能跨越多个 facade / wrapper / runtime shell，除 `function-map.yml` 外还应同步补 `mainline-call-map.yml`。
7. `mainline-call-map.yml` 变更后，必须同步运行 `npm run render:architecture-mainline-mermaid` 并让 `wiki/mainline-call-graph.md` 保持同步。
8. 自动生成 wiki 页变更后，必须同步运行 `node scripts/architecture/render-architecture-wiki-pages.mjs` 并通过 `node scripts/architecture/verify-architecture-wiki-sync.mjs`。
9. 需要正式 HTML review 面时，必须生成到 `docs/architecture/wiki/html/*.html` 并通过 `npm run verify:architecture-wiki-html-sync`；浏览器验证也必须针对 repo 内 HTML 文档，而不是 `/tmp` 临时文件。
10. `partial` / `binding pending` 只能作为显式 debt 保留：必须同步更新 `docs/architecture/mainline-binding-budget.yml` 并通过 `npm run verify:architecture-mainline-binding-pending-gate`。
11. topology 文档允许保留的未消费节点必须同步登记到 `docs/architecture/topology-sync-manifest.yml`；未登记增长或已收口未删旧 debt 都会被 `npm run verify:architecture-topology-doc-sync` 拦截。
