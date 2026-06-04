# Error Policy Center Unification Plan

## 目标
把项目错误处理收口到唯一错误策略链，统一由分类驱动处理，消除 `ErrorHandlingCenter` 作为第二套策略中心的可能性。

## 验收标准
- 错误链唯一：`ErrorErr01SourceRaised -> ErrorErr02HostCaptured -> ErrorErr03RuntimeClassified -> ErrorErr04RouterPolicyApplied -> ErrorErr05ExecutionDecision -> ErrorErr06ClientProjected`
- 分类唯一：`recoverable | unrecoverable | special_400 | periodic_recovery`
- `ErrorHandlingCenter` 仅负责 HTTP/server/client projection，不参与 provider policy
- executor/direct/provider runtime 不再自写 retry/reroute/cooldown/health 语义
- 文档、红测、代码命名完全对齐新拓扑
- 每个实施步骤必须在对应测试通过后单独提交，提交前不得进入下一步骤

## 范围与边界
### In Scope
- provider 错误分类与策略收口
- request executor / direct path / provider runtime 的错误链改造
- 错误拓扑文档修正
- 红测补齐与旧命名清理

### Out of Scope
- 与错误处理无关的路由、工具治理、provider 协议改造
- 非错误链的 payload 结构重构
- 额外 fallback / 降级 / 兜底逻辑

## 设计原则
- 真源优先：分类、策略、投影各自唯一 owning module
- Fail-fast：错误显式暴露，不吞错、不兜底
- 相邻转换：只允许相邻节点之间传递错误链数据
- 最小改动：先收口现有重复语义，再删冗余实现
- 步进提交：每步只提交已验证变更，禁止跨步骤混合提交

## 技术方案
### 文件清单
- `docs/design/pipeline-type-topology-and-module-boundaries.md`
- `docs/design/error-pipeline-contract-and-routing-audit.md`
- `docs/design/provider-failure-policy-ssot.md`
- `src/providers/core/runtime/provider-failure-policy-impl.ts`
- `src/providers/core/utils/provider-error-reporter.ts`
- `src/server/runtime/http-server/executor/request-executor-retry-decision.ts`
- `src/server/runtime/http-server/executor/request-executor-retry-backoff.ts`
- `src/server/runtime/http-server/executor/request-executor-retry-execution-plan.ts`
- `src/server/runtime/http-server/request-executor.ts`
- `src/server/runtime/http-server/router-direct-pipeline.ts`
- `src/server/utils/http-error-mapper.ts`
- `src/error-handling/route-error-hub.ts`

### 实施顺序
1. 先修文档拓扑与 owning module 描述；运行文档/命名扫描；通过后提交
2. 再补红测，锁住旧命名和第二中心；确认红测先红；提交红测
3. 收缩 provider/executor/direct 中重复分类与 retry 语义；运行对应红测绿；通过后提交
4. 让唯一错误链成为主路径；运行行为测试与定向集成测试；通过后提交
5. 删除冗余旧实现与残留兼容语义；运行扫描、定向测试、build；通过后提交

## 风险与规避
- 风险：executor/direct 仍保留本地决策分支
  - 规避：红测先红后绿，先锁命名再删代码
- 风险：`ErrorHandlingCenter` 被误用为策略中心
  - 规避：明确其只做 projection，依赖链禁止进入 provider policy
- 风险：周期恢复与 recoverable 语义混淆
  - 规避：把 periodic recovery 明确落到 cooldown/quota/backoff/VR health 流程

## 测试计划
- 命名红测：旧错误节点名扫描
- 唯一中心红测：第二套分类/策略路径扫描
- 行为红测：401/403/404、400、429、503、network、direct 5xx
- 投影红测：client body 不泄漏内部 carrier
- 构建验证：相关模块编译与定向测试

## 完成定义
- 错误处理只有一条可追踪主链
- 分类结果唯一驱动 retry/reroute/cooldown/fail
- 旧命名和冗余策略实现被删除或降为薄壳
- 每个阶段都有测试证据和对应 git commit
