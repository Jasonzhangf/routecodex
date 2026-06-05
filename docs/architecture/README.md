# Architecture Templates

本目录承载“规则下沉”的项目级真源骨架，目标是把全局原则落成可查询、可维护、可逐步 gate 化的项目模板。

## 文件职责

- `function-map.yml`
  - 记录关键功能的 `feature_id -> owner -> canonical types/builders -> allowed/forbidden paths -> required tests -> migration target`
  - 用于快速定位唯一修改点，防止重复实现和多处同时改

- `verification-map.yml`
  - 记录关键功能的最小验证栈：`unit / contract / integration / smoke / build`
  - 用于改动前后快速确定必须跑哪些验证

- `scripts/architecture/verify-architecture-templates.mjs`
  - 检查架构模板文件是否存在、非空、最小字段齐全

- `scripts/architecture/verify-function-map-coverage.mjs`
  - 检查 function-map 与 verification-map 的 feature 覆盖关系

- `scripts/architecture/verify-function-map-paths.mjs`
  - 检查每个 feature 的 `allowed_paths` / `forbidden_paths` 是否存在并指向真实目录

- `scripts/architecture/verify-function-map-boundary-mentions.mjs`
  - 检查每个 feature 的 `canonical_builders` 至少在 `allowed_paths` 下真实命中一次，并提示 forbidden 区域的字符串越界

- `scripts/architecture/verify-function-map-owner-uniqueness.mjs`
  - 检查 `owner_module` 必须落在 `allowed_paths` 范围内，且同一 `canonical_builders` 不能被多个 feature 重复声明

- `scripts/architecture/verify-function-map-forbidden-mentions.mjs`
  - 检查 `canonical_builders` 不得出现在 `forbidden_paths`；若确有合法引用，必须显式写入 `forbidden_mentions_allowlist`

- `scripts/architecture/verify-function-map-required-tests.mjs`
  - 检查 `required_tests` 文件真实存在，`required_gates` 对应的 `npm run` 脚本真实存在

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
  - 扫描 `HubReq* / HubResp* / VrRoute* / ErrorErr*` 的重复定义式声明，先拦真实多 owner 定义，alias-like 情况只告警

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

## 使用规则

1. 新增关键功能或发现定位困难的老功能时，先补 `function-map.yml`。
2. 新增回归要求或发现测试经常漏跑时，补 `verification-map.yml`。
3. 规则先落模板，再逐步补脚本 gate；不要反过来只靠口头约定。
4. 模板未补全前，只能宣称“已建立骨架”，不能宣称“全项目已完成架构索引化”。
5. 每次补 feature 行后，至少运行：
   - `npm run verify:architecture`
   - `npm run verify:function-map-coverage`
   - `npm run verify:function-map-paths`
   - `npm run verify:function-map-boundary-mentions`
   - `npm run verify:function-map-owner-uniqueness`
   - `npm run verify:function-map-forbidden-mentions`
   - `npm run verify:function-map-required-tests`
   - `npm run verify:architecture-fallback-denylist`
   - `npm run verify:architecture-feature-id-anchors`
   - `npm run verify:architecture-nonadjacent-conversion`
   - `npm run verify:architecture-feature-anchor-coverage`
   - `npm run verify:architecture-duplicate-dto-patterns`
   - `npm run verify:architecture-provider-specific-leaks`
   - `npm run verify:architecture-thin-wrapper-only`
   - `npm run verify:architecture-metadata-leak-boundary`
   - `npm run verify:architecture-error-chain-bypass`
   - `npm run verify:architecture-owner-queryability`
