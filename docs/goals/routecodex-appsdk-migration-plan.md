# RouteCodex AppSDK Migration Plan

## Goal

将 AppSDK 作为 RouteCodex 的外部治理骨架，按模块渐进迁移；保持 RouteCodex 的协议、provider、Hub Pipeline、MetadataCenter、错误链和 Rust runtime 业务语义由 RouteCodex 自己拥有。

## Boundary

- `.appsdk/`：可提交的 RouteCodex 项目治理合同、SDK lock、maps 和生命周期记录。
- `.appsdk-control/`：本地控制面、harness、会话、缓存和 worker 状态；已加入 `.gitignore`，不可提交。
- `playground/`：实验源代码和 debug 证据；实验完成后 archive then remove，不能成为 runtime 输入。
- `active/lib/`：不可变、可消费的编译库；是生成面，不能提交。
- `protected/`：冻结源代码、合同和历史；不能原地修改。
- `generated/`：编译输出和索引；不能提交。
- RouteCodex runtime：继续由现有 Rust owner 控制；AppSDK 不复制或重写业务实现。

## Migration sequence

### Phase 0 — Bootstrap and baseline

1. 固定外部 AppSDK binary version/digest；项目只保存 `.appsdk/sdk.lock`。
2. 将现有 RouteCodex resource/function/mainline/verification maps 绑定为业务架构真源。
3. 建立模块 registry 绑定：每个模块声明 owner、allowed paths、forbidden paths、相邻调用边和 required gates。
4. 运行 `appsdk verify` 与现有 RouteCodex architecture gates；不改 runtime。

Exit evidence: governance contract valid, SDK pinned, RouteCodex maps readable and current, generated surfaces ignored.

### Phase 1 — Freeze governance skeleton

1. 先固化目标澄清、claim、Playground retention、promotion、freeze、debug merge reason comment 合同。
2. 将治理记录和架构文档作为项目管理源提交；编译物、索引、Active library 只在本地或外部 artifact store 产生。
3. 将 `appsdk verify` 接入 RouteCodex 的 prebuild/CI 入口；验证失败必须 fail-fast。
4. 不迁移任何协议或 runtime 代码。

Exit evidence: a clean governance-only change can be verified without touching RouteCodex runtime.

### Phase 2 — First semantic module: MetadataCenter

MetadataCenter 是第一候选模块，但必须先完成 RouteCodex maps 的唯一 owner/调用边核对。

1. 明确 MetadataCenter truth resource、scope key、registration/consume/release operations。
2. 固定它只能通过 typed side-channel/control resource 传播，禁止进入 request/response/provider payload。
3. 在 `playground/` 做单假设实验：registration、跨阶段 consume、scope isolation、闭环 release、payload leakage negative test。
4. 通过 evidence → promotion → compile → Active publish → Protected freeze 后，才替换原 owner。
5. 旧实现不能与新实现双写、fallback 或 shadow writer；切换后物理删除旧 owner。

Exit evidence: positive/negative tests, exact source commit, artifact/public API hashes, record graph, and no payload leakage.

### Phase 3 — Adjacent control modules

按依赖图逐个迁移，不跨模块并行改造：

1. metadata/resource registration boundary；
2. error/snapshot/debug side-channel carriers；
3. continuation/session scope lifecycle；
4. provider selection and availability projections；
5. servertool/stopless orchestration only if the owner map证明属于该模块。

AppSDK 只治理模块生命周期和消费边界，不吸收这些模块的业务判定。

### Phase 4 — Runtime adoption and old-path removal

1. Runtime 只消费 verified manifest 和 Active artifact；不扫描 Playground、Protected、Generated 或 `.appsdk-control/`。
2. 逐入口做 Rust unit、module black-box、project black-box 和真实旧样本验证。
3. 新模块完成在线验证后，删除旧实现、重复 DTO、双路径和临时兼容层。
4. 更新 RouteCodex maps、wiki/manifest、test design 和 local skill。

### Phase 5 — Freeze and delivery

1. 记录 PromotionRecord、EvidenceRecord、ReviewRecord、FreezeRecord 的跨记录一致性。
2. Active version immutable；Protected source 与 source commit 一致；Generated/Active 不进入 Git。
3. 完成安装、聚合重启、所有 listener health 和真实入口重放。
4. 关闭 issue，保留可恢复的 Protected history。

## Per-module admission gates

```text
goal clarification confirmed
  -> resource/function/mainline/verification owner locked
  -> red test and test design
  -> Playground evidence
  -> architecture admission
  -> mainline implementation
  -> compile + artifact hash
  -> Active publish (immutable)
  -> Protected archive/freeze
  -> online verification
  -> issue closeout
```

禁止：direct patch 到 Active、Protected 原地修改、dual ownership、fallback、shadow writer、把控制语义放入业务 payload、把生成物提交到 Git。

## First executable work package

本轮只完成 Phase 0 的 governance bootstrap。下一轮读取并绑定 MetadataCenter 的 RouteCodex resource/function/mainline/verification 定义，随后先写 MetadataCenter 的 migration design 和 red-test design，再进入 Playground；在此之前不修改 runtime。
