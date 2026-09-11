# V3 memory：schema、响应剥离与 L3 Markdown

状态：用户已确认本边界，交由 routecodex-1 实施。本文完整取代前版设计。监督者负责资源、worktree、审核和 merge，不并行修改产品代码。

## 目标

RouteCodex 是 proxy。memory 可选，一般在 end_turn 或协议同语义的完成轮次生成；没有记忆是正常结果，不要求每轮产生。核心验收是 schema 有效、响应剥离完整、其余业务语义不变。

写入只兼容 AppSDK 路径与格式：直接保存新的 `memory/L3/<host-id>.md`。AppSDK 后续访问自动扫描接入；proxy 不调用 entry/import/index、不写 JSONL/SQLite、不要求扩展 AppSDK API，不承担上下文、recall、compaction、晋升或知识组织。

## 来源与已核实契约

- 思路来源 `/Volumes/extension/code/agent-plugins/agent-memory`：参考请求 hook、输出拦截、可选业务 memory 与局部 admission；不是100%移植，不参考上下文设计。
- 最新 `~/.agents/skills/project-memory/SKILL.md` 的 Handwritten L3 additions 明确：新增 marked L3 MD 在 query/get/index/export/verify 时自动接入，已有 SQLite 也扫描，无需 daemon。filename 与 metadata id 相同，新项固定 L3/unreviewed，重复访问不重复追加。修改既有 ID 不属于自动新增。
- 前轮 CLI source_refs/API/共享 JSONL writer 缺口不再是本 feature 前置项。历史 CLI entry 绿测不能替代 MD 自动扫描测试。

## 执行链

```text
typed config: enabled + fixed local project + output contract
 → Req04 registered Direct hook / Relay request Chat Process: schema guidance
 → existing provider execution and complete-attempt selection
 → end_turn / protocol-equivalent typed completion
 → declared envelope parsing, schema validation and memory stripping
    ├─ valid entries → atomic new L3 MD publication → local receipt
    └─ remaining business response → existing codec/SSE → client
 → later AppSDK access scans MD → JSONL/index (AppSDK-owned)
```

不得先把 memory delta 发给客户端，再在 terminal 删除。复用现有完整 attempt、语义聚合与注册 hook，不恢复旧通用 skeleton 或新增第二套 SSE parser。

## Schema 与生成

拟定版本 `routecodex.memory.raw-entry.v1`；业务字段仅 schema/category/title/content/tags。category 严格为 plan/path/knowledge/lesson；title/content 非空，tags为字符串数组；未知字段拒收。Host ID、来源、路径、review level和控制状态不由模型生成。

```json
{"memory":{"entries":[{"schema":"routecodex.memory.raw-entry.v1","category":"knowledge","title":"Self-contained title","content":"Candidate memory content","tags":["topic"]}]}}
```

上例只展示逻辑 memory 段，不意味着模型能修改 provider API 外壳。实施者先用合法短样本锁定真实业务承载及剥离 grammar，不能沿用旧根外壳假设。正常回答允许文本；不得为了避开剥离而擅自只支持已有 JSON schema 的客户端。真实协议限制须给失败证据和最小契约方案。

- end_turn同义终止由协议 typed terminal 映射，不能统一猜 completed/finish_reason。先完成 Responses JSON/SSE，再明确其他协议矩阵。
- tool_calls/tool_use交出工具执行不自动等同end_turn；proxy不拥有真实工具执行，不搬OpenCode tool-after/compaction观察器。
- memory可省略或entries为空；不因没有生成/坏schema重试、切provider或拒绝父响应。
- 不修改已有tools/tool choice/routing/客户端结构化输出要求；契约冲突在typed边界报告，不能强制替换客户端输出格式。
- guidance幂等由本次typed执行状态维护，不扫描历史marker重建。
- 限额针对完整候选校验，不截断为伪合法条目。拟定16条、单条8 KiB、总64 KiB；需覆盖超限时的完整剥离。

## 完整剥离

1. 唯一parser只识别明确声明的memory单元；不递归搜索history、tool arguments、引用代码中的同名内容，不用猜测性正则修复。
2. envelope边界可识别但entry无效：完整剥离memory单元，拒收无效条目并报typed diagnostic；正常响应保留，混合entries只存有效项。
3. 无memory：原响应语义不变；不伪造占位、额外请求或错误。
4. 边界不完整/歧义：不能冒险删除正常回答。实施者必须定义可证明的grammar及截断处理负测；不能把泄漏残留或吞掉整段正文当作通过。确实不可判定的协议模式应提交具体证据由监督者审查，不静默扩大删除。
5. JSON/SSE的正文、output items、delta/done/completed所有客户端可见表示一致；无memory内容、包裹残片、重复正文或非法JSON残片。其他业务字段、工具arguments及finish/error保持语义。
6. 剥离与保存独立：MD写失败也不能重新泄露memory、重试父请求或把成功改失败；另报capture failure。失败attempt、断流、length/incomplete不落盘，客户端错误照常处理。

## L3 Markdown

使用现有格式：

```markdown
<!-- project-memory:v1 {"id":"rcc-memory-host-id","category":"knowledge","tags":["topic"],"source_refs":["host-owned-source-ref"]} -->

# Self-contained title

Candidate memory content
<!-- project-memory:end -->
```

- sink为canonical config显式绑定的本地项目；host生成安全ID/文件名，不允许模型选择路径、跨项目或global写入。
- 只新增L3，禁止覆盖既有人工/reviewed文件；filename等于metadata id。同terminal/entry重复幂等，同ID异内容明确冲突。
- 同目录临时文件写完持久化后，以原子且不覆盖目标的方式发布；扫描器不得看到半写.md。验证多写者、同ID竞争、扫描交错、崩溃/中断。
- metadata用JSON serializer；title/content不能注入AppSDK marker。对 -->、end marker、换行、代码块、Unicode做round-trip测试；不可表达则拒收并诊断，不破坏整个扫描。
- host来源只进入磁盘provenance，不回写业务payload，不塞进tags/content替代source_refs。
- MD published只证明文件保存；AppSDK已接入必须另用真实扫描/get回执证明。proxy不建watcher、JSONL镜像或第二份spool。

## Owner、清理与接管

routecodex-1独占 `playground/memory-0906`（分支 `codex/memory-takeover-20260906`）的产品源码、测试、maps；监督者完成此文移交后只读。先记录继承dirty manifest并登记Collab任务。这些材料是用户明确移交，不能覆盖其他worker；同步新基线先保全材料，不在main开发。

旧crate的PendingIndex/KnowledgeStore、organization、recall、Skill index及专属测试退出候选实现；只选可复用parser/admission思路。旧45个Core绿测/3个缺口探针不能替代新验收，旧maps/混合patch不可整包应用。

现有入口参考 `v3.direct.request_key_hooks`、`v3.hub_relay_runtime_resources_hooks`、`v3.hub_relay_response_semantics`。实施前为 `v3.memory_raw_capture` 在四份当前maps绑定schema、Req04、response strip、L3 writer、typed source/diagnostics和必需gates。Direct修改在注册hook，Relay在Chat Process/相邻标准投影；不把memory语义搬到Provider/routing/health/continuation/SSE transport。

旧agent-memory-foundation已删除，6个孤儿测试服务已停止；185个变更路径恢复材料在主树 `.agent-collab/runs/memory-raw-design-20260906/`，旧分支ref保留。其他活跃树不属本任务清理范围。

## 验收与交付

- Schema：合法/无memory/空entries/未知字段/错类型/混合entry/超限/Unicode/marker注入；可选缺失必须成功。
- 剥离：完整JSON、跨chunk SSE、delta/done/completed一致；正文前后/多段/空正文/坏envelope/截断/引用代码同名内容；正常正文完整，memory零残留。
- 时机：end_turn及同语义完成；tool交接/length/error/断流/被丢弃attempt不误收；重复terminal幂等。
- 文件：合法新L3 MD、来源与host ID、原子不覆盖；既有SQLite下AppSDK自动扫描/get，重复扫描无重复event。MD保存和AppSDK接入分别报告。
- 实际入口：同request id的client request → provider-bound request → raw provider response → stripped client response，加L3 MD及扫描回执。合法短样本先证明可达；不把mock schema测试当模型生成证据。
- routecodex-1负责实现、定向测试、mapped gates、适用真实入口证据、可审查commit；回传SHA、范围、日志、未完成项。不要自行merge/main编辑/重启现有服务；运行资源需求由监督者协调。
- 监督者负责共享标准与AGY审核、资源、integration候选、main merge回执和worktree收尾；审核失败只反馈具体问题，不代写产品实现。证据满足后按既有授权merge，不绕过CI/review。
