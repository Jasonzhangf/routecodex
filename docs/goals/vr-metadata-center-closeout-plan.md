# VR Metadata Center Closeout Plan

## 1. 目标与验收标准

目标：

- 把 VR 的 metadata 读写收口到唯一 request-scoped `MetadataCenter`，让 VR 只消费 Hub 绑定的中心数据，不再维护独立 metadata 视角。
- 先完成 `function-map`、`mainline-call-map`、`verification-map`、wiki review 面与 gate 的对齐，再按 gate 推进运行时收口。

验收标准：

- `MetadataCenter` 仍是唯一 request-scoped metadata 真源，VR 不创建第二个中心。
- VR 只允许读取 `metadataCenterSnapshot` / 绑定后的中心，不再直接从 flat metadata、`__rt`、独立 state store 取路由真源。
- VR 可写的 metadata 仅限已声明 family 内的局部合法写点，不能回写 request truth。
- `function-map`、`mainline-call-map`、`verification-map`、wiki、manifest 自洽。
- 相关 gate 通过后，旧 mirror reader / fallback reader / redundant projection 物理删除。

## 2. 范围与边界

In Scope：

- 为 VR 收口补齐 owner / mainline / gate 定义
- 收紧 VR metadata 读写边界
- 收敛 `runtimeControl` / `providerObservation` 的合法读写点
- 删除 VR 对 flat metadata、`__rt`、旧 mirror 的依赖
- 更新与 VR metadata 边界有关的 wiki / manifest / verification 说明

Out of Scope：

- 新增 fallback、双路径兜底、silent repair
- 把 VR 变成第二个 metadata center
- 改变 Hub Pipeline 的 request-scoped center 模式
- 为旧 reader 保留长期兼容壳

## 3. 设计原则

- 单中心：Hub 创建并携带唯一 `MetadataCenter`，VR 只消费同一个 request-scoped center。
- 相邻转换：VR 只接受相邻节点输入，不允许跨阶段 shortcut 或自己拼装语义真源。
- 家族隔离：`request_truth` / `continuation_context` / `runtime_control` / `provider_observation` 必须分家。
- 禁止 mirror 复活：flat metadata、`__rt`、top-level residue 只能作为迁移证据，不得成为长期 owner truth。
- 先锁 contract 再改实现：先 map、再 gate、后代码。

## 4. 技术方案

### 4.1 先定义的 contract 真源

- [docs/architecture/function-map.yml](/Users/fanzhang/Documents/github/routecodex/docs/architecture/function-map.yml)
- [docs/architecture/mainline-call-map.yml](/Users/fanzhang/Documents/github/routecodex/docs/architecture/mainline-call-map.yml)
- [docs/architecture/verification-map.yml](/Users/fanzhang/Documents/github/routecodex/docs/architecture/verification-map.yml)
- [docs/architecture/wiki/metadata-center-mainline-source.md](/Users/fanzhang/Documents/github/routecodex/docs/architecture/wiki/metadata-center-mainline-source.md)
- [docs/architecture/wiki/metadata-boundary-map.md](/Users/fanzhang/Documents/github/routecodex/docs/architecture/wiki/metadata-boundary-map.md)
- [docs/architecture/metadata-center-manifest.yml](/Users/fanzhang/Documents/github/routecodex/docs/architecture/metadata-center-manifest.yml)

### 4.2 VR 收口目标边界

- VR 读取入口统一走 `MetadataCenterReader` 或等价绑定视图。
- VR 只保留 `runtime_control` 与 `provider_observation` 的局部合法写入面。
- VR 不再直接读写：
  - `metadata.runtime_control` 的 legacy mirror
  - `__rt`
  - flat top-level route/stop/protocol residues
  - 独立 routing state store 里的语义真源

### 4.3 需要对齐的源码区域

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/metadata_center/`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/router_metadata_input.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_types/vr_route_04_selected_target.rs`

### 4.4 Gate 目标

- `function-map` 能唯一定位 VR / metadata center owner。
- `mainline-call-map` 能把 `MetaReq04RuntimeControlBound -> MetaReq05ProviderObservationProjected -> VrRoute04SelectedTarget` 绑定到真实代码。
- `verification-map` 能锁住 VR 只读同一中心、禁止独立 metadata truth 复活、禁止 mirror/fallback reader。
- 架构 gate 失败时，旧 reader 不能靠 runtime 容忍保留。

## 5. 风险与规避

- 风险 1：只改 runtime 不改 contract，导致文档和代码脱节。
  - 规避：先补 map / mainline / gate，再动实现。
- 风险 2：迁移期保留双路径 reader，结果变成长期 fallback。
  - 规避：把旧 reader 视为必须删除对象，不允许常驻。
- 风险 3：VR 写回 request truth 或 continuation truth。
  - 规避：把禁止 family 写入写进 gate 和测试。

## 6. 测试计划

- 架构 gate：
  - `npm run verify:architecture-ci`
  - `npm run verify:architecture-mainline-call-map`
  - `npm run verify:architecture-owner-queryability`
  - `npm run verify:architecture-metadata-leak-boundary`
  - `npm run verify:architecture-nonadjacent-conversion`
- 功能 gate：
  - 证明 VR 只消费同一 `MetadataCenter`
  - 证明 VR 不再从 flat metadata / `__rt` 恢复路由真源
  - 证明 VR 的合法写点仅限已声明 family

## 7. 实施步骤

1. 在 `function-map` 里补齐 VR metadata 收口 owner 与允许路径。
2. 在 `mainline-call-map` 里把 VR 所在边和 metadata center 节点绑定清楚。
3. 在 `verification-map` 里加入 VR metadata 收口 gate。
4. 更新 wiki review 面，明确 VR 只是共享中心的局部消费者。
5. 实现 VR reader 收口到 `MetadataCenterReader` / 同等绑定视图。
6. 删除 flat metadata / `__rt` / legacy mirror reader。
7. 跑 gate，确认通过后再删残留物理代码。

## 8. 完成定义（DoD）

- VR metadata 已收口到唯一 request-scoped `MetadataCenter`
- contract / mainline / verification / wiki 全部对齐
- 旧 mirror reader 与 fallback reader 已删除
- 相关 gate 绿色
- 可直接进入后续 runtime closeout，不再需要靠经验判断 VR metadata 真源
