# Config SSOT + Function Map Closeout Plan

## 1. 目标与验收标准

目标：把配置模块收口为“路径解析唯一真源 + codec 唯一真源 + 语义加载唯一真源 + function map 显式登记 + gate 锁边界”，并物理删除散点重复实现。

验收标准：

- `src/config` 核心链路进入 `docs/architecture/function-map.yml` 与 `docs/architecture/verification-map.yml`。
- 主用户配置读取、provider v2 配置读取、配置路径解析、主配置写回、provider 配置写回都有唯一 owner。
- `config-admin`、`daemon-admin`、CLI、maintenance 不再直接维护各自的 parse/write 语义。
- 配置主链不再保留 `fallback path` 语义；找不到配置时显式报错。
- TOML/JSON 读取统一走 shared codec；写回统一走 shared writer/update API。
- 旧散点 `JSON.parse/JSON.stringify`、手写 `config.json/config.v2.json` 路径、局部 TOML 分支被物理删除或改为统一入口。

## 2. 范围与边界

In Scope：

- `src/config/**`
- `src/server/handlers/config-admin-handler.ts`
- `src/server/runtime/http-server/daemon-admin/providers-handler.ts`
- `src/server/runtime/http-server/daemon-admin/routing-policy.ts`
- `src/server/runtime/http-server/daemon-admin/control-handler.ts`
- `src/cli/commands/config.ts`
- `src/commands/provider-update.ts`
- `src/commands/provider-update-maintenance.ts`
- `docs/architecture/function-map.yml`
- `docs/architecture/verification-map.yml`
- 对应 architecture verify gates

Out of Scope：

- token/auth/pid/history/quota snapshot 等机器态文件
- Hub Pipeline / Virtual Router 语义迁移
- 非配置域的 CLI/http handler 重构

## 3. 设计原则

1. 配置链只允许一个 reader 入口和一个 writer/update 入口。
2. 路径解析、格式 codec、语义 materialize 必须三层分离，禁止 handler/CLI 混写。
3. 禁止 fallback。缺配置、格式非法、写回失败都必须显式报错。
4. function map 必须能从 `feature_id -> owner_module -> canonical_builders -> required_tests/gates` 反查。
5. 迁移期间允许短期适配层，但只作为过渡壳；完成后必须物理删除旧实现。

## 4. 技术方案

### Phase 1：定义配置 feature map

新增 feature，至少包括：

- `config.path_resolution_surface`
- `config.user_config_codec`
- `config.provider_config_codec`
- `config.user_config_materialization`
- `config.user_config_write_surface`
- `config.provider_config_write_surface`

每个 feature 必须补：

- `owner_module`
- `canonical_types`
- `canonical_builders`
- `allowed_paths`
- `forbidden_paths`
- `required_tests`
- `required_gates`

建议 owner：

- path resolution：`src/config/unified-config-paths.ts` 与 `src/config/config-paths.ts`
- user codec：`src/config/user-config-codec.ts`
- provider codec：`src/config/provider-config-codec.ts`
- user materialization：`src/config/routecodex-config-loader.ts` + `src/config/user-config-loader.ts`
- user write surface：新增 `src/config/user-config-writer.ts`
- provider write surface：新增 `src/config/provider-config-writer.ts`

### Phase 2：收口 reader

要求：

- `config-admin-handler.ts` 读取主配置必须走 `decodeUserConfigFile` 或等价 shared API。
- provider 列表读取必须走 `loadProviderConfigsV2` 或 provider decode API。
- `daemon-admin` routing/settings/providers/control 读路径统一走 shared resolver + codec。
- `provider-update*` 禁止再手写 `JSON.parse(raw)` 读取 provider config。

目标：

- 所有配置读取路径只保留“resolver -> codec -> optional materializer”链。

### Phase 3：收口 writer

新增统一 writer API：

- user config：`read -> mutate -> serialize/update -> atomic write`
- provider config：`read -> mutate -> serialize/update -> atomic write`

要求：

- TOML 与 JSON 写回都从 shared writer 发出。
- handler/CLI/maintenance 不得直接 `JSON.stringify(next)`。
- comment-preserving TOML update 必须是唯一入口；局部字段更新不可各自拼字符串。

### Phase 4：删除 fallback 与 legacy path 语义

改造点：

- `UnifiedConfigPathResolver` 移除 `source: 'fallback'` 语义。
- 找不到配置时直接错误，不返回“虚拟 fallback 路径”。
- 清理帮助文案里默认 `config.json`/`config.v2.json` 的旧真源口径。

### Phase 5：删重与 gate

新增或收紧 gate：

- 配置核心路径 `JSON.parse/JSON.stringify` 禁止名单。
- 配置核心路径 `config.json/config.v2.json` 手写路径禁止名单。
- 新增 feature anchor coverage，确保 config feature 有源码 anchor。
- 若必要，新增 `verify:config-ssot` 聚合命令。

物理删除：

- 被统一 API 替代的本地 parse/write helper。
- 与新 writer 冲突的局部 TOML patch 分支。

## 5. 风险与规避

风险：reader 收口后影响 CLI/admin 现有 JSON 流程。
规避：先补 focused tests，再逐入口切换。

风险：writer 收口后破坏 TOML 注释或格式。
规避：补 round-trip/comment-preserving 测试，先锁 update API 再删旧逻辑。

风险：function map feature 拆分不当，owner 交叉。
规避：以“路径/codec/materialize/write”四轴拆分，不把 handler 作为 owner。

风险：一次性大改过宽。
规避：按 phase 分批提交，每 phase 完成后跑 gate。

## 6. 测试计划

Unit：

- `tests/config/routecodex-config-loader.v2-single-source.spec.ts`
- `tests/config/provider-v2-loader.spec.ts`
- 新增 user/provider writer focused tests
- 新增 path resolver strict/no-fallback tests

Contract：

- config-admin handler focused tests
- daemon-admin providers/routing/control focused tests
- CLI config / provider-update focused tests

Integration：

- `npm run verify:function-map-compile-gate`
- 新增 `npm run verify:config-ssot` 或等价 gate
- `npx tsc --noEmit --pretty false`

Smoke：

- 至少一次真实配置读取 smoke：`routecodex validate --config <real-config>`
- 至少一次真实写回 smoke：CLI 或 admin 改动配置后再次 `loadRouteCodexConfig` 成功

## 7. 实施步骤

1. 在 function-map / verification-map 补齐 config feature。
2. 先加 focused red test，锁 `config-admin` 和 `daemon-admin` 不得绕过 codec/writer。
3. 实现 shared user/provider writer API。
4. 把 `config-admin-handler.ts` 切到 shared reader/writer。
5. 把 `daemon-admin/providers-handler.ts`、`routing-policy.ts`、`control-handler.ts` 切到 shared reader/writer。
6. 把 `src/cli/commands/config.ts`、`src/commands/provider-update*.ts` 切到 shared reader/writer。
7. 删除 `UnifiedConfigPathResolver` fallback path 语义与旧文案。
8. 加 denylist/gate，物理删除旧 helper 和重复分支。
9. 跑最小验证栈，补 live smoke 证据。

## 8. 完成定义

满足以下条件才可宣称完成：

- 配置核心 feature 已入 function-map / verification-map。
- config core 至少有一组 `feature_id` 锚点文件。
- 配置核心区不再有未批准的散点 parse/write。
- `verify:function-map-compile-gate`、新增 config gate、相关 focused tests、TS build 通过。
- 至少一条真实读取 smoke 和一条真实写回后 reload/validate smoke 通过。
