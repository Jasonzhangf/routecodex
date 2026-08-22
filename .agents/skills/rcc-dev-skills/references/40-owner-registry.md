# 40 Owner Registry

## 何时用
- 你要回答"这个功能谁是唯一 owner？"
- 你要新增 / 删除 / 迁移 `feature_id`
- 你要找最小 gate、最小测试栈、允许改动路径

## 真源 / 权威路径
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- 源码 `feature_id:` anchor
- gate 脚本：`scripts/architecture/*`

## 三件套 contract
- `function-map.yml`：owner 真相
- `verification-map.yml`：验证真相
- 源码 `feature_id:`：落点真相
- 改 critical owner 时三处必须同时同步；少一处都算 contract 破坏

## V3 mainline owner queryability
- V3 `docs/architecture/v3-mainline-call-map.yml` 的 `chains[].owner_feature_id` 和 `chains[].edges[].owner_feature_id` 必须先能在 `docs/architecture/v3-function-map.yml` 反查 owner，再能在 verification-map/source/manifest 反查 gate 和 anchor。
- verification-map-only owner 不够；edge 有 `resource_flow` 也不够。owner 不在 function-map 时，写入、允许路径、禁止路径和 required gates 都不可追踪。
- 审计或补 V3 mainline edge 时，先跑/补 owner-query gate：缺 chain owner、缺 edge owner、manifest edge 未显式声明例外，都必须红。
- 反模式：用 mainline-call-map 里的 `owner_feature_id` 当 owner 真源，却不在 function-map 建 owner row；这会让 edge-locked call chain 变成 map-only 约定。

## 当前 owner_kind 基线
- `rust_ssot=29`
- `ts_runtime_owner=15`
- `server_projection=10`
- `ts_bridge=4`
- `provider_runtime=2`
- `ts_entry_shell=2`

## 反查：feature_id -> owner/gate
1. 查 feature row：
   - `rg -n 'feature_id: hub\.servertool_followup' docs/architecture/function-map.yml`
2. 看 owner 字段：
   - `owner_kind`
   - `owner_module`
   - `owner_scope`
   - `canonical_builders`
   - `allowed_paths`
   - `forbidden_paths`
3. 查验证：
   - `rg -n 'feature_id: hub\.servertool_followup' docs/architecture/verification-map.yml`
4. 查源码锚点：
   - 宽匹配（推荐）：`rg -n 'hub\.servertool_followup' sharedmodule src tests`
   - 严格注释匹配：`rg -n '//\s*feature_id: hub\.servertool_followup' sharedmodule src tests`
   - 关键点：Rust anchor 是 `// feature_id: <id>` 注释，匹配要把 `//\s*feature_id:` 写进 pattern
   - 真实命中：`sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/chat_servertool_orchestration.rs:1:// feature_id: hub.servertool_followup`

## 正查：owner_kind -> feature
- 数量：`rg -n 'owner_kind: rust_ssot' docs/architecture/function-map.yml | wc -l`
- 列表：`rg -n 'owner_kind: rust_ssot|feature_id:' docs/architecture/function-map.yml`
- 某 owner_module 被哪些 feature 共用：`rg -n 'owner_module: .*router-hotpath-napi' docs/architecture/function-map.yml`

## 新增 owner 流程
1. 先定 `feature_id`
2. 先写 `function-map.yml`
3. 再写 `verification-map.yml`
4. 再给源码加 `feature_id:` anchor
5. 再写代码
6. 跑 gate：
   - `npm run verify:function-map-compile-gate`
   - `npm run verify:architecture-owner-queryability`
   - `npm run verify:architecture-feature-map-growth-discipline`
7. 再跑 feature 自己的 `required_gates`
8. 再做 live probe

## 删除 / 迁移 owner 流程
1. 先确认无 caller / 无 active tests 依赖
2. 同步删或迁 `function-map.yml`
3. 同步删或迁 `verification-map.yml`
4. 同步删或迁源码 `feature_id:` anchor
5. 跑：
   - `git diff --check`
   - `npm run verify:function-map-compile-gate`
   - `npm run verify:architecture-owner-queryability`

## 反模式 / 边界
- 先写代码，最后补 `feature_id`
- 只改 `function-map.yml`，不改 `verification-map.yml`
- 用 TS handler / adapter 假装语义 owner
- 允许 server handler 自己解析协议、再让 bridge 也解析一遍
- critical feature 先登记，再编码，再 gate，再 live

## 快查字段
- `owner_kind`：谁拥有语义层
- `owner_scope`：owner 的一句话职责
- `canonical_builders`：该 feature 的唯一 builder/parser
- `required_tests`：最小测试集合
- `required_gates`：最小 gate 集合

## 相关 references
- 50-rcc-config-ssot.md
- 70-gate-discovery.md
- 80-skill-routing-convention.md
