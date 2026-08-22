# 2026-05-24 Virtual Router Architecture 审计

## 索引概要
- L1-L8 `purpose`：审计目标与范围。
- L10-L31 `live-evidence`：本次已核验的代码证据与边界。
- L33-L57 `conclusion`：对“共享函数库 + blocks + 纯编排”的逐项判断。
- L59-L95 `gaps`：当前未完全达标的缺口。
- L97-L126 `improvements`：按优先级排序的改进空间。
- L128-L152 `next-step`：建议执行顺序。
- L154-L173 `goal-prompt`：可直接复用的 `/goal` 提示词。

## 目的
审计 RouteCodex 当前 `virtual router` 是否已经按照 **“共享函数库 + blocks + 纯编排”** 的方式设计，并基于仓内可见代码证据判断：

- 路由核心语义是否集中在 Rust 共享真源。
- `virtual router` 是否已经形成稳定可复用的 block 边界。
- TS / Host 是否只做 orchestration thin-shell，而没有重写路由与 payload 语义。

本审计严格遵循项目护栏：

- 路由与工具语义真源必须位于 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/`
- Host 仅做编排与桥接，不重写 `llmswitch-core` 语义
- Hub Pipeline / Chat Process 语义必须 Rust-only
- 无文件证据，不宣称完成

## 已核验证据
本次结论基于以下已审到的代码边界与文件职责：

1. **Rust 路由真源集中存在**
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/routing/bootstrap.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/virtual_router_engine/health.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/napi_proxy.rs`

2. **`bootstrap.rs` 已承载 routing 规范化主链**
- `NormalizedRoutePoolConfig`
- `normalize_routing(...)`
- `expand_routing_table(...)`
- `normalize_thinking(...)`

3. **`health.rs` 已承载 provider health 语义主链**
- `ProviderHealthManager`
- `record_failure(...)`
- `cooldown_provider(...)`
- `trip_provider(...)`
- `is_available(...)`

4. **`napi_proxy.rs` 已呈现薄壳特征**
- 负责 JSON 边界转换
- 负责 runtime path override 注入
- 调用 core initialize / route / provider health 接口
- 返回序列化结果

5. **TS 层至少在结构命名上已朝 thin-shell 收缩**
- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-*.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/process/*.ts`

但本次尚未逐文件核验这些 TS 文件内部是否完全无 payload 语义，因此 TS 纯度结论只可判为“方向正确但证据未闭合”。

## 结论

### 1. 共享函数库：**基本成立**
当前 `virtual router` 的关键运行时语义，已经明显集中在 Rust 共享真源：

- routing bootstrap / normalize / expand 在 Rust
- provider health policy 在 Rust
- NAPI proxy 作为跨语言入口在 Rust

这与项目硬护栏一致：

- **路由语义真源在 Rust**
- **Host / Provider 不应再重建同类语义**

结论：**“共享函数库”方向已基本达标。**

### 2. blocks 化：**部分成立，但边界仍偏粗**
当前已经能看到按职责分文件：

- `routing/bootstrap.rs`
- `health.rs`
- `napi_proxy.rs`

这比“大一统 engine 文件”健康得多，但从证据看仍更接近：

- **按文件拆职责**

而不是：

- **按稳定能力块拆契约**

尤其 `bootstrap.rs` 仍同时承载：

- routing source normalize
- legacy/weighted route 兼容
- target 展开
- alias/model 校验
- thinking 解析
- priority/order 处理

结论：**已有 block 雏形，但还未形成明确、可长期演进的 block contract。**

### 3. 纯编排：**Rust proxy 基本成立，TS 侧仍有证据缺口**
`napi_proxy.rs` 当前表现接近纯编排：

- 处理输入输出边界
- 注入运行时路径上下文
- 转调核心路由逻辑
- 不重写路由决策本身

这符合 thin adapter / orchestration shell 预期。

但 TS 层目前只能确认：

- 文件结构像 thin-shell
- 命名与导出方式像 thin-shell

尚未确认：

- 是否存在对 `messages` / `payload` / `tool_calls` 的直接语义变换
- 是否仍存在兼容逻辑、硬编码 sanitize、metadata 重写

结论：**“纯编排”目前只能判为大体成立，尚未完全验明。**

## 当前缺口

### A. `bootstrap.rs` 仍是粗粒度总装入口
当前最大的结构性缺口不是“没有拆”，而是：

- **拆分还不够细**
- **多个可独立演进的子能力仍揉在一个 bootstrap 主链里**

风险：

- 新需求继续集中堆入 `bootstrap.rs`
- 形成新的 Rust 内部“大总管文件”
- 后续无法清晰证明某一处才是唯一改动点

### B. block 契约不够显式
当前更多依赖函数命名表达职责，而不是显式 block 输入输出契约。

缺口表现为：

- 输入 struct / 输出 struct 不够块级稳定
- 错误边界与副作用边界不够独立
- 后续容易在 block 之间直接穿透内部细节

### C. `thinking` 属于明确路由语义，但仍埋在 bootstrap 大流程里
此前已确认：

- `thinking` 是 pool 级字段
- 未配置时默认 `None`
- 不做 policy group 继承

这类显式路由语义目前仍嵌在 bootstrap 归一化流程里，后续如继续扩展 `reasoning` 兼容字段，复杂度会继续上涨。

### D. health policy 仍存在“状态 + 决策”耦合偏高
`ProviderHealthManager` 目前同时承担：

- provider canonicalization
- success/failure state tracking
- cooldown / tripped 状态更新
- availability 判定
- snapshot 输出

虽仍属同一 domain，但已经接近“状态存储 + 策略引擎 + façade”一体化。

### E. TS thin-shell 证据链尚未闭合
这是本次审计最大的剩余不确定性。

根据项目护栏：

- 被 pipeline stage 直接调用的非薄壳 TS 语义函数属于违规
- 直接 transform request/response payload 的 TS 语义代码属于违规
- 编排逻辑只有在“纯调度 + 无 payload 语义变换 + 至少一层 native + 有测试”下才可接受

而当前我们尚未逐个核验 `native-*.ts` 与 `hub/process/*.ts` 的文件内部实现，因此不能宣称 TS 已完全达标。

## 改进空间

### 1. 优先把 `bootstrap.rs` 拆成稳定 routing blocks
建议从 `bootstrap.rs` 中抽出独立块，例如：

- `routing_source_normalizer`
- `route_target_expander`
- `route_target_validator`
- `route_pool_sorter`
- `route_param_resolver`

目标不是“继续分文件”，而是建立：

- 明确输入
- 明确输出
- 明确错误语义
- 明确副作用边界

### 2. 单独抽出 `thinking` 解析块
建议将：

- `thinking`
- `reasoningEffort`
- `reasoning_effort`

统一收进单独小块，例如：

- `route_thinking_resolver`

好处：

- 路由语义真源更清晰
- 兼容字段扩展不会继续污染 bootstrap 主流程
- 可单测验证“未配置即 None、不继承 group”这些关键不变量

### 3. 将 health 拆为“状态存储”和“判定策略”两层
建议至少抽成：

- `provider_health_state_store`
- `provider_health_policy`

这样可以降低 `ProviderHealthManager` 的总管化趋势，并让 cooldown / trip / availability policy 更易测试与演进。

### 4. 对 TS native wrappers 做一次纯编排合规审计
这是最值得立即补证据的一步。

建议逐文件检查：

- `sharedmodule/llmswitch-core/src/native/router-hotpath/native-*.ts`
- `sharedmodule/llmswitch-core/src/conversion/hub/process/*.ts`

判定标准直接使用 `docs/agent-routing/10-runtime-ssot-routing.md` 中的三层判定：

- 是否被 stage 直接调用且非薄壳
- 是否直接 transform payload / messages / tool_calls
- 是否只是调度 native 且无语义变换

### 5. 让 `napi_proxy.rs` 更接近纯 adapter
当前 `napi_proxy.rs` 已经比较薄，但仍可进一步把通用边界 helper 抽离，例如：

- runtime path override 读取
- JS null / undefined 边界辅助
- runtime metadata bridge

这不是当前最高优先级，但有助于让 NAPI 面更稳定、更容易证明“不含业务策略”。

## 建议执行顺序
1. **先补证据，不先大改**
- 优先审 `native-*.ts` 与 `hub/process/*.ts` 内部实现
- 给出“薄壳合格 / 含语义应迁 Rust / 混合职责应拆块”标注

2. **再收口最粗的 Rust 总装块**
- 从 `bootstrap.rs` 开始做最小必要 block 化
- 优先拆 `thinking` / target expand / validate 这种语义边界清楚的部分

3. **最后处理 health manager 内聚度**
- 将状态存储与 policy 决策分层
- 避免继续演化为第二个策略中心

## /goal 提示词
下面是一个可直接复用的 `/goal`：

```text
/goal 审计并收口 virtual router 架构，使其严格对齐“共享函数库 + blocks + 纯编排”原则。

约束：
1. 路由/工具/Hub Pipeline 语义真源只能在 `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/`。
2. TS 只能保留 thin wrapper / orchestration shell，不得直接变换 messages、payload、tool_calls、metadata 语义。
3. 禁止 fallback、降级、跨层补逻辑；所有错误必须 fail-fast 暴露。
4. 不先做大改，先基于文件证据完成审计矩阵。

执行目标：
1. 审计 `sharedmodule/llmswitch-core/src/native/router-hotpath/native-*.ts` 是否 100% 薄壳。
2. 审计 `sharedmodule/llmswitch-core/src/conversion/hub/process/*.ts` 是否仅做纯编排。
3. 列出所有违反“纯编排”或“Rust-only 语义真源”的 TS 文件与函数。
4. 给出 Rust 迁移去向：哪些应迁入 `router-hotpath-napi`，哪些应拆成独立 blocks。
5. 给出最小合规改造顺序，优先收口 `bootstrap.rs` 的粗粒度职责与 `thinking` 解析块。

交付物：
- 一份审计报告 md
- 一份 TS residue matrix
- 一份最小迁移计划，按“必须先做 / 可以后做”排序
```
