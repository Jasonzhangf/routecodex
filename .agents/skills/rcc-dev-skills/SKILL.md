---
name: rcc-dev-skills
description: "RouteCodex V3 开发与排障：定位首次偏离和唯一 owner，保持透明代理语义，完成真实入口验收。"
---

# RouteCodex V3 开发与排障

项目语义以 [AGENTS.md](../../../AGENTS.md) 为准；通用方法沿 `coding-principals`，角色、模型与并发沿当前宿主编排入口。本 Skill 只维护项目流程和按需路由。

纯文档/规则修改只检查受影响内容与引用。代码任务先检查受影响 DAG；不为文档编辑运行构建、安装、重启或全量 gate。

## Command-First Flow

1. 读受影响 DAG 和当前任务笔记。DAGPipe 模块从[图入口](../../../docs/architecture/dagpipe/README.md)定位；复用未变图的有效校验。独立设计审查仅在用户或项目明确要求时启动。
2. 按 feature 查询四张 map，确定唯一 owner、允许/禁止路径、调用边和 required gates，再读对应源码。绑定缺失只阻止依赖它的修改，不扩大排查范围。

   ```bash
   rcc_task_feature='<feature_id>'
   rg -n "feature_id: ${rcc_task_feature}" \
     docs/architecture/v3-resource-operation-map.yml \
     docs/architecture/v3-function-map.yml \
     docs/architecture/v3-mainline-call-map.yml \
     docs/architecture/v3-verification-map.yml
   ```

3. Debug 用同一请求的原始证据定位首次偏离，再按已接受计划补正图/gate、取得红测、修改 owner、完成黑盒回归。每个 non-2xx 除已确认传输失败外，仍须查根因和请求形状；切换 Provider 成功不关闭原错。
4. 功能/修复使用真实 HTTP、WebSocket、CLI 或公开 consumer 验收，记录稳定测试 ID 与实际命令。受控上游可以使用，但源码字符串检查和未经过公开入口的 mock 不能替代行为证据。Provider 错误与业务响应的回归要求沿项目合同。
5. 按映射运行受影响测试和 `npm run verify:v3-architecture-ci`。umbrella 已覆盖的子 gate 不再单跑；未覆盖的必需项仍执行，新输入只使受影响证据失效。
6. 运行时变更在本地 gate 通过后沿[运行验收](references/50-rcc-config-ssot.md)完成 build、install、配置检查、正式 restart、各 listener health 和同入口回放；PR CI 可并行，不以其等待阻止候选验收。原失败样本必须覆盖；真实客户端工具须证明完整身份、参数、执行结果及后续配对，200 或 `requires_action` 不算工具成功。

## Defect Lifecycle

缺陷 intake、issue 独占工作树、每次 managed restart 后样本审计、测试 ID 写回确认及资源收口，统一见[缺陷合同](references/60-defect-lifecycle.md)。重复回归须进入映射的回归测试。已有 issue 和有效证据直接复用。

## Review Gate

作者完成适用验收后，沿全局宿主合同取得一次有效独立整体 Review，再提交/集成。finding 修复只补受影响验证。候选、安装运行与 main 交付分开记录，不增加 SHA、冻结快照或身份包装；未交付部分如实保留。

## Routes

只读取本次问题对应的行。配置、样本位置与当前运行状态沿项目真源，不在入口复制。

| 当前问题 | 读取 |
|---|---|
| owner、路径或 gate 变化 | [绑定迁移](references/40-owner-registry.md) |
| 首次偏离与请求/响应 dry-run | [Pipe debug](references/10-pipedebug-flow.md) |
| 协议、SSE、continuation | [协议边界](references/25-protocol-sse-continuation-boundary.md) |
| 普通工具、原生搜索、有界 refill 或旧 servertool 残留 | [工具合同与退役边界](../../../docs/agent-routing/30-servertool-lifecycle-routing.md) |
| ToolThinking / Toolreason 投影 | [专项差异](references/26-toolreason-dryrun-diagnostic.md) |
| 配置、安装、重启、live replay | [运行验收](references/50-rcc-config-ssot.md) |
| typed Error 链 | [错误路径](references/96-unified-error-path-audit.md) |
| provider/model 指定或选错模型 | [模型绑定](references/96-v3-selected-provider-model-binding-sop.md) |
| continuation 前缀漂移 | [前缀对照](references/97-continuation-cache-compliance.md) |
| Provider 请求失败、切换或耗尽 | [请求与错误诊断](references/98-provider-request-dryrun-and-request-error-debug.md) |

## Report

按[反馈合同](../../../docs/agent-routing/05-foundation-contract.md)报告交付、位置、验收和剩余项。详细命令、原错和阶段结果留在原证据记录中，不为汇报重验或复制整份清单。登记或派发缺陷不代表修复完成。
