# RouteCodex V4 Foundation Framework Plan

## Objective

V4 以 V3 为行为基线，提高工程质量和长期演进能力：职责分离、数据面与控制面物理隔离、性能可测量、共享语义单一 owner、流程和配置可编译固化，provider 差异收敛为配置与 action operators。

## Hard boundary

- V3 是 compatibility baseline；本阶段只读、只审计、只验证，不修改 V3 runtime。
- V4 的新代码、合同、实验、测试、Active、Protected、Generated 全部在 `v4/`。
- V4 core pipeline 不包含 provider-specific 分支。
- control resources、routing、switching、continuation、retry、health、debug、snapshot、scope、error policy 不进入业务 request/response/provider payload。
- 共享语义只有一个 owner；禁止重复实现、fallback、双写和 shadow writer。

## Phase 0 — V3 reuse audit

按 V3 resource map → function map → mainline call map → verification map 审计，不按 grep 结果直接复制代码。每个候选模块记录：

```text
feature/resource id
current owner
allowed/forbidden paths
mainline callers/callees
semantic contract
test and live evidence
reuse decision
V4 target owner
deletion or retirement plan
```

复用决策只有四种：

1. `reuse-as-is`：合同稳定、owner 唯一、边界符合 V4。
2. `extract-and-tighten`：语义可复用，但需要下沉共享 owner 或补类型边界。
3. `rewrite-in-v4`：职责、payload/control 边界或性能模型不符合 V4。
4. `legacy-only`：V3 保留运行，V4 不直接依赖。

## Phase 1 — V4 foundation contracts

先建立不依赖具体 provider 的 Rust 基础框架：

- data plane carrier and typed stage contracts;
- control plane resource and side-channel contracts;
- data center / MetadataCenter resource lifecycle;
- configuration authoring → validate → compile → load;
- shared function owner and module registry;
- deterministic artifact/index boundary;
- error, debug, snapshot and scope side-channel contracts;
- red tests for non-adjacent stage conversion and control leakage。

此阶段不接入 V3 runtime，也不执行 provider 迁移。

## Phase 2 — Provider operator model

Provider runtime 只保留：

- provider configuration;
- validated capability declaration;
- transport/auth codec;
- registered action operators;
- provider-specific wire mapping at the provider boundary。

Route/pipeline/tool/error/continuation 的通用语义不得下沉为 provider 特例。未注册的 provider action 必须 fail-fast。

## Phase 3 — Module-by-module migration

候选顺序由 Phase 0 审计结果决定，优先迁移职责稳定、耦合低、可独立验证的模块。每个模块必须经过：

```text
goal clarification
  -> owner/map lock
  -> red test design
  -> Playground experiment
  -> evidence
  -> V4 implementation
  -> compile
  -> Active artifact
  -> Protected freeze
  -> compatibility verification against V3
```

## Phase 4 — Performance and simplification

性能优化必须建立在语义等价证据上，重点检查：

- 重复转换和重复序列化；
- 多层无意义 DTO；
- 非必要 clone/copy；
- payload 与 control state 的错误混合；
- provider 分支导致的 pipeline 复杂度；
- runtime 动态扫描和非确定性配置加载。

删除代码必须先验证依赖和唯一 owner，删除后补正向/反向测试和 V3 对照样本。

## First deliverables

1. V3 reuse audit matrix。
2. V4 module/resource registry。
3. V4 data/control plane boundary contract。
4. V4 pipeline type topology。
5. V4 configuration compiler contract。
6. V4 MetadataCenter/data-center design。
7. Foundation red-test design。

第一批正式代码之前，以上七项必须在 `v4/` 内可审计、可验证。
