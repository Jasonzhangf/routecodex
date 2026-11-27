# Memory Index

Index stores short titles, tags, and detail paths. Open the linked Markdown detail for content.

## Raw sources

- [Plan](plan.jsonl)
- [Path](path.jsonl)
- [Knowledge](knowledge.jsonl)
- [Lesson](lesson.jsonl)

## Level 1 — reviewed critical

_Empty._

## Level 2 — reviewed reusable

_Empty._

## Level 3 — new or unreviewed

### Chat Process contract
- tags: `chat-process`, `contract`, `extensions`, `relay`, `semantics`
- details: [L3/knowledge.routecodex.chat-process-contract.md](L3/knowledge.routecodex.chat-process-contract.md)

### 工具由客户端实现，代理不校验
- tags: `client-owned`, `latest-20261110`, `tool`, `transparent-proxy`, `user-audited`
- details: [L3/knowledge.routecodex.client-owned-tools.md](L3/knowledge.routecodex.client-owned-tools.md)

### Provider Compat contract
- tags: `compat`, `contract`, `owner`, `private-protocol`, `provider`
- details: [L3/knowledge.routecodex.compat-contract.md](L3/knowledge.routecodex.compat-contract.md)

### 跨 provider 加密内容响应剥离与请求侧防御
- tags: `ciphertext`, `devsail`, `latest-20261110`, `latest-20261127`, `request-defense`, `response-chat-process`, `user-audited`
- details: [L3/knowledge.routecodex.devsail-ciphertext-response-drop.md](L3/knowledge.routecodex.devsail-ciphertext-response-drop.md)

### Error status policy
- tags: `502`, `598`, `599`, `contract`, `error`, `external-status`
- details: [L3/knowledge.routecodex.error-status-policy.md](L3/knowledge.routecodex.error-status-policy.md)

### 失败的完整 Provider 身份禁止在同一请求重试
- tags: `20261120`, `contract`, `no-same-retry`, `provider-switch`, `request-independence`, `user-audited`
- details: [L3/knowledge.routecodex.failed-provider-no-same-retry.md](L3/knowledge.routecodex.failed-provider-no-same-retry.md)

### 全缓冲业务提交边界
- tags: `20261120`, `buffer`, `commit`, `contract`, `provider`, `reselection`, `sse`, `user-audited`
- details: [L3/knowledge.routecodex.full-attempt-buffer.md](L3/knowledge.routecodex.full-attempt-buffer.md)

### Inbound contract
- tags: `contract`, `extensions`, `inbound`, `lossless`, `normalization`, `request`, `response`, `user-approved`
- details: [L3/knowledge.routecodex.inbound-contract.md](L3/knowledge.routecodex.inbound-contract.md)

### Outbound contract
- tags: `allowlist`, `contract`, `denylist`, `outbound`, `projection`, `request`, `response`, `supersedes`, `user-approved`
- details: [L3/knowledge.routecodex.outbound-contract.md](L3/knowledge.routecodex.outbound-contract.md)

### Provider 真实 HTTP 错误的切换与最终透传
- tags: `20261120`, `contract`, `error-chain`, `ontology`, `provider`, `terminal-projection`, `user-audited`
- details: [L3/knowledge.routecodex.provider-error-terminal-projection.md](L3/knowledge.routecodex.provider-error-terminal-projection.md)

### 正式重启按上游派发状态接续请求
- tags: `20261120`, `admission`, `contract`, `ontology`, `request-continuity`, `restart`, `user-audited`
- details: [L3/knowledge.routecodex.restart-handoff-request-continuity.md](L3/knowledge.routecodex.restart-handoff-request-continuity.md)

### sticky 不实现并移除（旧“暂不启用”已被取代）
- tags: `disabled`, `removed`, `routing`, `sticky`, `superseded`, `user-audited`
- details: [L3/knowledge.routecodex.sticky-disabled.md](L3/knowledge.routecodex.sticky-disabled.md)

### 429 响应阶段阻塞回退提案已按用户审计消融
- tags: `429`, `cooldown`, `no-request-wait`, `response-stage`, `superseded`, `user-audited`
- details: [L3/lesson.routecodex.429-response-stage-backoff-revoked-20261108.md](L3/lesson.routecodex.429-response-stage-backoff-revoked-20261108.md)

### 429 自适应收缩已按用户决定移除
- tags: `429`, `adaptive-concurrency`, `cooldown`, `lesson`, `superseded`, `verification`
- details: [L3/lesson.routecodex.adaptive-concurrency-removed-20261107.md](L3/lesson.routecodex.adaptive-concurrency-removed-20261107.md)

### 旧 concurrency 阻塞等待与 backoff 已 superseded
- tags: `blocking-wait`, `concurrency`, `superseded`, `user-audited`
- details: [L3/lesson.routecodex.concurrency-blocking-superseded-20261108.md](L3/lesson.routecodex.concurrency-blocking-superseded-20261108.md)

### 所有冷却只按连续错误计数，不连续就归零
- tags: `consecutive-errors`, `cooldown`, `lesson`, `provider-health`, `reset`, `superseded`
- details: [L3/lesson.routecodex.cooldown-consecutive-only-20261107.md](L3/lesson.routecodex.cooldown-consecutive-only-20261107.md)

### 非 200 调试先做最小 probe 区分上游
- tags: `debug`, `lesson`, `minimal-probe`, `upstream`
- details: [L3/lesson.routecodex.debug-minimal-probe-first-20261107.md](L3/lesson.routecodex.debug-minimal-probe-first-20261107.md)

### 图片路由只看当前轮是否有图附件
- tags: `image`, `lesson`, `multimodal`, `routing`
- details: [L3/lesson.routecodex.image-routing-current-turn-only-20261107.md](L3/lesson.routecodex.image-routing-current-turn-only-20261107.md)

### 最后候选错误透传取代旧 no-client-error 判定
- tags: `error-passthrough`, `lesson`, `transparent-proxy`, `verification`
- details: [L3/lesson.routecodex.last-candidate-error-passthrough-20261106.md](L3/lesson.routecodex.last-candidate-error-passthrough-20261106.md)

### 旧最后 provider 不移出池并 backoff 方案已 superseded
- tags: `backoff`, `last-provider`, `superseded`, `user-audited`
- details: [L3/lesson.routecodex.last-provider-not-evicted-superseded-20261108.md](L3/lesson.routecodex.last-provider-not-evicted-superseded-20261108.md)

### LayerFS 已移除，回归 Git worktree
- tags: `git-worktree`, `latest-20261110`, `layerfs`, `removed`, `user-audited`
- details: [L3/lesson.routecodex.layerfs-removed.md](L3/lesson.routecodex.layerfs-removed.md)

### 旧冷却阶梯（30 分钟/3 小时/15 分钟）已 superseded
- tags: `cooldown`, `latest-20261110`, `legacy-ladder`, `superseded`, `user-audited`
- details: [L3/lesson.routecodex.legacy-cooldown-ladders-superseded-20261108.md](L3/lesson.routecodex.legacy-cooldown-ladders-superseded-20261108.md)

### L2 记忆投影核验：无缺失，不批量 promote
- tags: `l2`, `latest-20261110`, `memory`, `project-memory`, `verification`
- details: [L3/lesson.routecodex.memory-l2-projection-verified-20261110.md](L3/lesson.routecodex.memory-l2-projection-verified-20261110.md)

### Record contract and implementation separately
- tags: `architecture`, `lesson`, `memory`, `remediation`, `v2`, `verification`
- details: [L3/lesson.routecodex.memory-truth-admission.md](L3/lesson.routecodex.memory-truth-admission.md)

### Do not conflate two relay concepts
- tags: `chat-process`, `direct`, `lesson`, `owner`, `relay`, `transport`
- details: [L3/lesson.routecodex.mode-vs-transport-relay.md](L3/lesson.routecodex.mode-vs-transport-relay.md)

### Buffer before client commit
- tags: `buffer`, `client`, `error`, `lesson`, `provider`, `sse`
- details: [L3/lesson.routecodex.provider-client-error-decoupling.md](L3/lesson.routecodex.provider-client-error-decoupling.md)

### 旧 session 级 provider 冷却方案已 superseded
- tags: `provider-cooldown`, `session-isolation`, `superseded`, `user-audited`
- details: [L3/lesson.routecodex.provider-cooldown-session-isolation-superseded-20261108.md](L3/lesson.routecodex.provider-cooldown-session-isolation-superseded-20261108.md)

### debug/snap 落盘按输入端点再按端口分类
- tags: `debug`, `lesson`, `sample-storage`, `snap`
- details: [L3/lesson.routecodex.snap-storage-endpoint-port-classification-20261107.md](L3/lesson.routecodex.snap-storage-endpoint-port-classification-20261107.md)

### sticky 选择不实现并移除
- tags: `lesson`, `provider-selection`, `routing`, `sticky`
- details: [L3/lesson.routecodex.sticky-removed-20261107.md](L3/lesson.routecodex.sticky-removed-20261107.md)

### 路由裁决：tier 只是优先级，default 是强制兜底
- tags: `default-pool`, `fallback`, `last-candidate`, `routing`, `tier`, `user-audited`
- details: [L3/lesson.routecodex.tier-priority-default-floor-20261107.md](L3/lesson.routecodex.tier-priority-default-floor-20261107.md)

### 错误补丁缺少反馈本身就是 bug
- tags: `feedback`, `lesson`, `positive-negative-test`, `regression`
- details: [L3/lesson.routecodex.wrong-patch-feedback-is-bug-20261107.md](L3/lesson.routecodex.wrong-patch-feedback-is-bug-20261107.md)

### 2026-11-04 请求路径去限制：capacity/capability/server 准入无条件移除
- tags: `admission`, `capacity`, `request-path`, `transparent-proxy`, `user-directive`
- details: [L3/memory-2ebe76f46d75752b.md](L3/memory-2ebe76f46d75752b.md)

### 历史 sticky 需求已全部 superseded
- tags: `routing`, `sticky`, `superseded`, `user-audited`
- details: [L3/memory-e0d25c51dbf404b9.md](L3/memory-e0d25c51dbf404b9.md)

### Direct request and response flow
- tags: `buffer`, `direct`, `flow`, `hooks`, `provider`, `sse`
- details: [L3/path.routecodex.direct-request-response.md](L3/path.routecodex.direct-request-response.md)

### Error classification and projection
- tags: `502`, `598`, `599`, `error`, `external-status`, `flow`
- details: [L3/path.routecodex.error-projection.md](L3/path.routecodex.error-projection.md)

### Ontology 与双向沟通记录模型
- tags: `20261112`, `bidirectional-communication`, `memory`, `ontology`, `user-audited`
- details: [L3/path.routecodex.memory-ontology-bidirectional-record.md](L3/path.routecodex.memory-ontology-bidirectional-record.md)

### 项目记忆写入前必须经过用户中文审计
- tags: `audit`, `memory`, `user-approval`, `workflow`
- details: [L3/path.routecodex.memory-user-audit.md](L3/path.routecodex.memory-user-audit.md)

### Direct or Relay selection
- tags: `configuration`, `direct`, `flow`, `relay`, `selection`
- details: [L3/path.routecodex.mode-selection.md](L3/path.routecodex.mode-selection.md)

### Relay request flow
- tags: `chat-process`, `compat`, `flow`, `inbound`, `outbound`, `provider`, `relay`, `request`
- details: [L3/path.routecodex.relay-request.md](L3/path.routecodex.relay-request.md)

### Relay response flow
- tags: `buffer`, `chat-process`, `error`, `flow`, `relay`, `response`, `sse`
- details: [L3/path.routecodex.relay-response.md](L3/path.routecodex.relay-response.md)

### 429 持续出现时延长身份拉黑且不阻塞请求（已由 2026-11-10 最新冷却规则 superseded）
- tags: `429`, `cooldown`, `latest-20261110`, `noise-control`, `provider`, `request-independence`, `superseded`, `user-audited`
- details: [L3/plan.routecodex.429-persistent-blacklist.md](L3/plan.routecodex.429-persistent-blacklist.md)

### Client and Provider decoupling
- tags: `architecture`, `buffer`, `decoupling`, `error`, `provider`, `sse`
- details: [L3/plan.routecodex.client-provider-decoupling.md](L3/plan.routecodex.client-provider-decoupling.md)

### 已提交 Provider 失败维护通信并继续 Error chain
- tags: `error-chain`, `provider`, `routecodex`, `sse`, `user-approved`
- details: [L3/plan.routecodex.committed-provider-failure-preserves-communication-20261113.md](L3/plan.routecodex.committed-provider-failure-preserves-communication-20261113.md)

### 项目使用 Git worktree，LayerFS 已停用
- tags: `git`, `layerfs-disabled`, `user-audited`, `worktree`
- details: [L3/plan.routecodex.git-worktree-restored.md](L3/plan.routecodex.git-worktree-restored.md)

### 只剩一个可用 Provider 时错误透传
- tags: `error-passthrough`, `last-candidate`, `protocol-conversion-only`, `provider`, `request`, `user-audited`
- details: [L3/plan.routecodex.last-provider-error-passthrough.md](L3/plan.routecodex.last-provider-error-passthrough.md)

### operation+配置节点重构实现程度 13/20
- tags: `candidate-scoped`, `config-declarations`, `node-refactor`, `operation-runner`, `user-audited`, `verification-map`
- details: [L3/plan.routecodex.operation-config-refactor-status.md](L3/plan.routecodex.operation-config-refactor-status.md)

### Payload rewrite owners
- tags: `architecture`, `chat-process`, `direct`, `hooks`, `owner`, `payload`, `relay`
- details: [L3/plan.routecodex.payload-rewrite-owners.md](L3/plan.routecodex.payload-rewrite-owners.md)

### rcc-dev-skills 待补齐流程
- tags: `cooldown`, `devsail`, `latest-20261110`, `rcc-dev-skills`, `routing`, `skill-gap`, `user-audited`
- details: [L3/plan.routecodex.rcc-dev-skills-gap-fill.md](L3/plan.routecodex.rcc-dev-skills-gap-fill.md)

### 冷却策略（2026-11-10 最新裁决）
- tags: `401`, `403`, `429`, `500`, `502`, `account-error`, `cooldown`, `latest-20261110`, `no-same-retry`, `recoverable-error`, `request-independence`, `user-audited`
- details: [L3/plan.routecodex.recoverable-error-cooldown-ladder.md](L3/plan.routecodex.recoverable-error-cooldown-ladder.md)

### RouteCodex servertool 全系列下线消融
- tags: `ablation`, `hosted-search`, `retirement`, `servertool`, `transparent-proxy`, `user-audited`
- details: [L3/plan.routecodex.servertool-full-retirement.md](L3/plan.routecodex.servertool-full-retirement.md)

### Skeleton and plane ownership
- tags: `architecture`, `configuration`, `control-plane`, `data-plane`, `skeleton`
- details: [L3/plan.routecodex.skeleton-and-planes.md](L3/plan.routecodex.skeleton-and-planes.md)

### 2 秒同 session 防风暴
- tags: `anti-storm`, `latest-20261110`, `request-path`, `two-second`, `user-audited`
- details: [L3/plan.routecodex.two-second-session-antistorm.md](L3/plan.routecodex.two-second-session-antistorm.md)

### Production version baseline
- tags: `architecture`, `baseline`, `v2-retired`, `v3`, `v4`
- details: [L3/plan.routecodex.version-baseline.md](L3/plan.routecodex.version-baseline.md)

### 请求路径去掉容量、能力和 Server 准入
- tags: `admission`, `capability`, `capacity`, `request-path`, `server-admission`, `transparent-proxy`, `unrestrict`, `user-audited`
- details: [L3/request-path-unrestrict.md](L3/request-path-unrestrict.md)

### 巡检员职责（RouteCodex）
- tags: `black-box`, `bug-report`, `gate`, `inspection`, `patrol`, `role`
- details: [L3/role.routecodex.inspector.md](L3/role.routecodex.inspector.md)

### Runtime 错误巡检长期职责
- tags: `error`, `evidence`, `patrol`, `runtime`
- details: [L3/role.routecodex.runtime-error-patrol.md](L3/role.routecodex.runtime-error-patrol.md)

### 每次 Review 必审：错误切换 Provider、请求独立与最后候选错误透传
- tags: `error-passthrough`, `mandatory-review`, `provider-lifecycle`, `provider-switch`, `refill`, `request-isolation`, `user-audited`
- details: [L3/routecodex-provider-switch-request-independence-review.md](L3/routecodex-provider-switch-request-independence-review.md)

### Runtime 构建无需批准，生产重启须逐次批准且只能用 restart
- tags: `approval`, `build`, `restart`, `runtime-lifecycle`, `user-audited`
- details: [L3/routecodex-runtime-build-restart-approval.md](L3/routecodex-runtime-build-restart-approval.md)

### 生产 RCC 升级必须逐次取得明确批准
- tags: `approval`, `incident`, `runtime-lifecycle`
- details: [L3/routecodex-unapproved-runtime-upgrade.md](L3/routecodex-unapproved-runtime-upgrade.md)

### 冷却候选可见性历史导航
- tags: `cooldown`, `error-chain`, `request-independence`, `vr`
- details: [L3/vr-cooldown-candidate-visibility.md](L3/vr-cooldown-candidate-visibility.md)

### 冷却、候选可见性与最后候选错误透传
- tags: `cooldown`, `error-passthrough`, `latest-20261110`, `request-independence`, `routing`, `user-audited`
- details: [L3/vr-cooldown-no-request-admission.md](L3/vr-cooldown-no-request-admission.md)

### VR 当前轮分类与 sticky 移除
- tags: `default-floor`, `fallback`, `review`, `routing`, `sticky-removed`, `user-audited`, `virtual-router`
- details: [L3/vr-current-turn-single-pool-20261027.md](L3/vr-current-turn-single-pool-20261027.md)

## Skill description candidates

Base budget: 8 lines. Copy the compact lines into the project Skill `description` after manual architecture deduplication. Fill level 1 first; use level 2, then level 3, only for remaining slots.

- L3: Chat Process contract (knowledge) [chat-process,contract,extensions,relay,semantics] -> L3/knowledge.routecodex.chat-process-contract.md
- L3: 工具由客户端实现，代理不校验 (knowledge) [client-owned,latest-20261110,tool,transparent-proxy,user-audited] -> L3/knowledge.routecodex.client-owned-tools.md
- L3: Provider Compat contract (knowledge) [compat,contract,owner,private-protocol,provider] -> L3/knowledge.routecodex.compat-contract.md
- L3: 跨 provider 加密内容响应剥离与请求侧防御 (knowledge) [ciphertext,devsail,latest-20261110,latest-20261127,request-defense,response-chat-process,user-audited] -> L3/knowledge.routecodex.devsail-ciphertext-response-drop.md
- L3: Error status policy (knowledge) [502,598,599,contract,error,external-status] -> L3/knowledge.routecodex.error-status-policy.md
- L3: 失败的完整 Provider 身份禁止在同一请求重试 (knowledge) [20261120,contract,no-same-retry,provider-switch,request-independence,user-audited] -> L3/knowledge.routecodex.failed-provider-no-same-retry.md
- L3: 全缓冲业务提交边界 (knowledge) [20261120,buffer,commit,contract,provider,reselection,sse,user-audited] -> L3/knowledge.routecodex.full-attempt-buffer.md
- L3: Inbound contract (knowledge) [contract,extensions,inbound,lossless,normalization,request,response,user-approved] -> L3/knowledge.routecodex.inbound-contract.md
