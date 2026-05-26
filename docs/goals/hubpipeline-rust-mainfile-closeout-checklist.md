# HubPipeline Rust 主文件收口清单

## 索引概要
- L1-L9 `purpose`：文档目标与证据边界。
- L11-L28 `current-state`：当前主文件现状判断。
- L30-L58 `closeout-checklist`：主文件收口项。
- L60-L82 `non-goals`：本轮不做的事。
- L84-L101 `verification`：验证要求。
- L103-L111 `done-signal`：完成信号。

## Purpose

本清单用于把 `hub_pipeline.rs` 的“是否还需要继续收口”单独落成可执行核对文档。

证据边界仅基于当前 Rust 真源：

- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline.rs`
- `sharedmodule/llmswitch-core/rust-core/crates/router-hotpath-napi/src/hub_pipeline_blocks/`
- `docs/goals/hubpipeline-rust-shared-helper-closeout-plan.md`

本清单不重新设计 HubPipeline，只用于确认主文件还能继续收什么、哪些不该动。

## Current State

当前证据显示：

1. `hub_pipeline.rs` 只有 `282` 行，已明显低于“大主文件”风险线。
2. 主文件当前主要职责是：
   - 输入/输出结构定义
   - endpoint / protocol / process mode / direction / stage 的薄编排
   - metadata 汇总
   - `stop_message` 路由 metadata 接线
3. 当前主文件没有明显重复的 XML / JSON scan / tool canonicalization helper。
4. 因此它不是本轮 shared helper closeout 的第一优先级。

结论：

- `hub_pipeline.rs` 当前应维持“薄壳编排”定位；
- 本轮对它只做**收口清单核查**，不做无证据重构。

## Closeout Checklist

### 1. 保持结构定义集中

- 保留这些公共 struct 在主文件，前提是它们仍只服务 hub pipeline 主入口：
  - `HubPipelineInput`
  - `HubPipelineOutput`
  - `HubPipelineError`
  - `PipelineStageResult`
  - `FormatEnvelope`
  - `ChatEnvelope`
  - `RoutingDecision`
  - `ProcessedRequest`
- 若未来出现跨模块复用证据，再单独迁出；本轮不为“看起来整洁”而搬动。

### 2. 主函数只保留编排，不吸回 helper

- `run_hub_pipeline(...)` 只允许保留：
  - 输入 shape 校验
  - 调用 `hub_pipeline_blocks::*` 的薄编排
  - metadata merge
  - 最终 envelope 组装
- 不允许再把下列能力回流到本文件：
  - tool canonicalization
  - text harvest / markup normalize
  - JSON balanced scan
  - provider-specific salvage
  - servertool followup compatibility

### 3. 继续压平局部 if/metadata 逻辑的唯一条件

只有满足以下任一条件，才值得继续从主文件下沉：

- 同类 metadata merge 逻辑在两个以上主入口重复出现；
- 主文件新增了模块专属语义判断；
- 单个函数明显超过薄编排阈值，难以直接读懂责任边界。

若没有命中，不允许为了“更像 blocks 架构”而过度拆分。

### 4. 主文件后续唯一可接受修改面

本文件后续变更应只限于：

- 新增/调整对已有 `hub_pipeline_blocks` 的调用编排；
- 新增最小必要的 metadata 字段接线；
- 修正主入口输入输出 contract；
- 删除已经迁出的残余重复逻辑。

### 5. 与 shared helper closeout 的关系

`hub_pipeline.rs` 的正确收口方式不是继续拆自己，而是等待下列 shared 真源收完后自然变薄：

- `shared_tool_mapping.rs`
- `shared_tooling.rs`
- `shared_json_utils.rs`

因此主文件 closeout 的核心动作是：

- **禁止回流**
- **禁止重复实现**
- **只做薄编排**

## Non-goals

本轮明确不做：

- 不把 struct 强行迁到新文件
- 不新建 `hub_pipeline_types.rs`
- 不改 TS 壳层
- 不做 provider 语义迁移
- 不做 chat-process / req-process / resp-process 新设计
- 不为了文件数漂亮而制造第二组织层

## Verification

主文件收口完成的验证方式：

1. 文件检查
   - `hub_pipeline.rs` 未重新长出 helper 实现
   - 仍只依赖 `hub_pipeline_blocks::*` 与基础类型库
2. 相关回归
   - `hub_pipeline_tests.rs` 命中测试通过
   - shared helper closeout 的定向测试通过
3. 架构检查
   - 新增逻辑若属 helper，必须落在 shared/block，而不是主文件

## Done Signal

满足以下条件即可判定主文件收口完成：

- `hub_pipeline.rs` 继续维持薄编排定位；
- 本轮 shared helper 收口未把任何语义细节回灌进主文件；
- 文档与代码一致，后续执行者可按本清单拒绝无证据重构。
