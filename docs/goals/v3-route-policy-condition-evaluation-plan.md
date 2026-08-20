# V3 Route Policy / Condition Evaluation Implementation Plan

## 1. 目标与验收标准

基于 [v3-route-policy-condition-evaluation-design.md](v3-route-policy-condition-evaluation-design.md)，把 V3 路由从“当前轮硬编码分类”演进为：

```text
typed observations
  -> compiled condition evaluation
  -> named route object
  -> one-shot route trigger
  -> Virtual Router selection plan
```

首个实现闭环不默认包含全部 Stage 7 live policy。必须按 design doc 的 Stage 0 到 Stage 7 逐阶段推进。

最终验收：

- Compact 可绑定 manifest 中的命名 route object；
- route policy 支持声明式条件组合；
- 历史窗口 search-like 统计可生成 typed facts；
- 错误窗口统计来自统一 Error chain，不重复计数；
- search-density / error-window policy 可一次性触发主 thinking route object；
- trigger 按 session/conversation scope 隔离并只消费一次；
- route control 不进入 provider/client payload、协议 metadata、continuation 或历史；
- VR 不拥有 provider health、retry、quota、auth、forwarder expansion；
- 所有阶段有正反测试、架构 map、build、安装、重启、在线样本和 DSH Review 证据。

## 2. 范围与边界

### In scope

- V3 route object；
- compiled route policy；
- current-turn observation；
- history-window observation；
- error-window observation；
- condition AST；
- route action；
- one-shot trigger；
- Compact route object binding；
- search-like / error-window 两条干预策略；
- 资源、function、mainline、verification map 对齐；
- 受影响 V3 Rust runtime 与 live 验证。

### Out of scope

- V2 新旧路由双路径；
- provider-specific route branch；
- provider health / cooldown / retry policy 重写；
- Target provider expansion 重写；
- Direct/Relay continuation owner 改造；
- payload cleanup；
- handler/SSE/outbound 补偿；
- 未经批准的 live config 策略扩展；
- V4 pipeline 改动。

## 3. 设计原则

1. Route Policy 是 control plane；业务 payload 不承载 policy、trigger、counter、evidence。
2. Observation 只提取事实；Condition 只判定；Action 只引用 route object；VR 只生成 selection plan。
3. 历史只读、不可变；错误统计从唯一 Error chain 事件投影。
4. 配置先 parse → validate → compile → publish；runtime 只消费 deterministic manifest。
5. 不使用 fallback 隐藏 unknown field、missing route object、invalid scope 或 policy ambiguity。
6. Direct/Relay/continuation owner 先于普通路由条件。
7. 先红后绿；先 focused test/build，再 global install/restart/live replay，最后 DSH Review。
8. 任一编码前决策未锁定，停在 Stage 0，不写 runtime。

## 4. 需要 Jason 先恢复的决策

进入 Stage 1 前必须明确：

1. 最近 10 轮的 eligible turn：只算 assistant/user 完整轮，还是包含工具中间轮？
2. 80% 分母：推荐 search-like turns / eligible turns。
3. search-like 分类：是否包含 search tool、grep、rg、git grep、hosted web search？
4. repeated search signature：按工具类别、命令目标、查询归一化，还是仅要求至少 N 个 search-like turn？
5. 最近 5 轮错误计数：按最终 client-visible failure，还是 provider intermediate failure 也计数？
6. tool execution error 是否计入错误窗口。
7. reroute 后最终成功的 provider error 是否计入。
8. trigger consume 时点：route plan 创建、provider send 前，还是 provider 成功后。
9. trigger expiry / cooldown。
10. scope：session、conversation，还是 session + conversation + port/group。
11. Compact 默认 route object 名称和目标 pool。
12. Compact 与 continuation owner 冲突时是否始终 owner 优先。
13. policy precedence：Compact、explicit model、history intervention、current-turn、static match 的顺序。
14. missing observation：统计条件窗口不足时 fail-fast 还是 not-matched。
15. route object 是否首版只允许引用 pool，不允许直接 provider/model。
16. live reload 是否纳入第一版。

未恢复前，允许继续做合同、schema 草案、red test design；禁止实现 runtime 语义。

## 5. 技术方案与文件清单

### 5.1 Config / manifest

候选 owner：

- v3 route config types / validation / manifest compiler；
- route object authoring；
- route policy AST authoring；
- deterministic manifest publication。

候选文件范围：

- v3/crates/routecodex-v3-config/src
- v3/crates/routecodex-v3-config/tests
- docs/architecture/v3-resource-operation-map.yml
- docs/architecture/v3-function-map.yml
- docs/architecture/v3-mainline-call-map.yml
- docs/architecture/v3-verification-map.yml

### 5.2 Observation / classifier

候选 owner：

- v3/crates/routecodex-v3-route-classifier
- 已有 Rust tool classification owner
- history projection owner需先在 map 中注册
- error-window projection 必须绑定 Error chain 事件 owner

### 5.3 Policy / action

候选 owner：

- 新 Rust shared route-policy crate，或现有 route-classifier 内已注册 policy module；
- 编码前必须通过 owner review，不能由 VR 直接长出第二套条件逻辑。

### 5.4 Virtual Router

只允许消费：

- compiled route policy action；
- typed request facts；
- route object / pool reference；
- continuation owner constraint。

不允许新增：

- provider health read；
- error classification；
- history raw payload scan；
- provider/model 直接硬编码；
- second VR hit；
- payload rewrite。

### 5.5 Trigger state

候选资源：

- session/conversation scoped control side-channel；
- policy id、scope、generation、expiry、evidence digest；
- 不得进入 continuation payload、provider/client body 或协议 metadata。

## 6. 风险与规避

| 风险 | 规避 |
|---|---|
| 历史统计误改历史 | 只读 projection；immutability red test |
| 同一错误重复计数 | request/call scope 去重；唯一 error event owner |
| 条件逻辑进入 VR | Condition evaluator 独立 owner；VR 只消费 action |
| route object 绕过 Target/VR | object 只引用 pool；one-shot plan 保留 |
| 多条件冲突不确定 | manifest precedence；同级 ambiguity fail-fast |
| 窗口不足被静默当 false | explicit insufficient_observation；policy 声明行为 |
| trigger 重复切主模型 | generation + consume-once + scope test |
| provider failure 触发 VR 重入 | positive/negative one-hit tests |
| 控制状态泄漏 payload | static scanner + red fixture + wire capture |
| 一次改动范围过大 | Stage 1→7；每阶段独立 gate |
| map 把 design 当 active | status 分层；source binding gate |
| live 验证拿旧 binary | install/restart/version/health/old sample evidence |

## 7. 测试计划

### Contract / schema

- unknown field；
- invalid type；
- invalid comparator；
- missing route object；
- unknown pool；
- invalid scope/window；
- precedence ambiguity；
- deterministic compile output。

### Observation

- current-turn parity；
- history 9/10/11 turns；
- 80% exact boundary；
- search-like classification；
- duplicate signature；
- 5-turn error boundaries；
- Error01~06 dedup；
- final success/failure；
- session/conversation isolation；
- insufficient observation。

### Policy / trigger

- all/any/not truth table；
- compact action；
- search-density action；
- error-window action；
- simultaneous policy precedence；
- trigger consume once；
- trigger expiry；
- no-trigger unchanged route；
- no second VR hit。

### Boundary / payload

- route object/control state absent from provider wire；
- absent from client body；
- absent from protocol metadata；
- absent from continuation/history；
- no VR health/retry/auth access；
- no handler/SSE/outbound compensation；
- Direct/Relay owner preserved。

### Runtime

- focused Rust tests；
- V3 build；
- global install；
- managed aggregate restart；
- configured health endpoints；
- exact old sample replay；
- Compact live sample；
- repeated search live sample；
- recent error live sample；
- DSH Review PASS。

## 8. 实施步骤

1. Stage 0：恢复上述决策，补齐 test matrix 与合同。
2. Stage 1：route object + Compact binding。
3. Stage 2：condition AST + current-turn policy parity。
4. Stage 3：history-window read-only projection。
5. Stage 4：error-window projection。
6. Stage 5：search-density one-shot intervention。
7. Stage 6：error-window one-shot intervention。
8. Stage 7：deterministic live manifest、安装、重启、在线旧样本、DSH Review。
9. 每阶段完成后更新 evidence、map status、mainline binding 和 review surface。
10. 任一阶段修改 runtime 后，后续所有运行时证据重新验证；旧 PASS 不继承。

## 9. 完成定义

只有同时满足以下条件才可声明完成：

- 设计决策已全部锁定；
- source、resource map、function map、mainline map、verification map 一致；
- policy manifest deterministic 且 runtime 只消费编译产物；
- 两条历史策略有正反测试；
- trigger 生命周期有正反测试；
- payload/control isolation gates 通过；
- VR one-shot / no-reentry gates 通过；
- V3 build 通过；
- 全局安装版本与源码一致；
- managed aggregate restart 后全部 health 通过；
- 同入口旧样本在线重放通过；
- DSH Review 给出语义 PASS；
- review 后无未重跑的代码、测试、配置或构建变更。

## 10. 参考设计

- docs/goals/v3-route-policy-condition-evaluation-design.md
- docs/goals/v3-virtual-router-full-function-plan.md
- docs/goals/v3-compaction-request-routing-test-design.md
- docs/goals/v3-web-search-current-turn-routing-test-design.md
- docs/architecture/v3-resource-operation-map.yml
- docs/architecture/v3-function-map.yml
- docs/architecture/v3-mainline-call-map.yml
- docs/architecture/v3-verification-map.yml

