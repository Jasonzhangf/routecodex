# 66301e2：Servertool 移除与有界续杯整合实施提示词

你是 RouteCodex 工作项66301e2的目标编排者。你负责实施、解阻、完整验收、main交付及自有资源收口。本提示词发送者是当前设计整合任务owner，不授予Collab master或跨聊天发送权限。收到本文件作为实施任务后，直接实施，不再生成另一层提示词。本轮生成文件本身不启动产品实施。

## 先读与恢复

1. 当前canonical与本树适用AGENTS、`.appsdk/requirements.json`、rcc-dev-skills和实际宿主编排入口。
2. 本树 `docs/goals/66301e2-servertool-refill-integrated-plan.md`。
3. 本树 `docs/goals/66301e2-servertool-refill-integrated-dag.md`。
4. 用户原先指定的三文件：`66301e2-bounded-refill-implementation-prompt.md`、`66301e2-bounded-refill-plan.md`、`66301e2-bounded-refill-dag.md`。
5. 原任务有效笔记、issue与依赖记录，按实际变化刷新。

唯一实施树是 `/Volumes/Intel/playground/routecodex/66301e2`，分支 `codex/66301e2-bounded-refill`。复用它，不另开同域工作树，不删除或覆盖原三份设计及其他任务改动。canonical dirty树、e63d2f2及其他issue树只读。当前origin/main、PR433和依赖状态必须实时读取，不能依旧提示词猜测；标准Git组合，不跨树手工抄文件。不重复建立66301e2工单。

## 完整目标

一个milestone完成两件相互约束的工作：删除RCC专用servertool注册、CLI projection、内部搜索执行/状态；实现Chat Process统一的有界自动续杯。保留普通工具、原生hosted search及citations、多模态、透明协议、正常continuation、原Error链与取消清理。

这份整合合同替代canonical旧方案的echo/auto_continue设计。禁止生成echo shell call、伪造工具或call ID，禁止为续杯修改真实finish reason，禁止要求客户端shell执行器驱动续杯。

## 不可改变的续杯合同

配置唯一写入 `v3/crates/routecodex-v3-config/src/internal.toml`：

```toml
[chat_process.refill]
max_consecutive_refills = 1
```

使用该crate `internal.rs`的现有owner解析并发布typed只读策略。不能写runtime crate的同名internal.toml，不能再加用户config、server override、环境变量或动态API。消费侧不复制默认值。0关闭，N最多新增N次，改值须重建正式加载。

完整attempt做完声明治理/工具收割和当前可交付性判断后，Chat Process统一检查非工具、非真实错误、无源显式非空summary与剩余额度。Direct注册hook和Relay复用同一判断，不按协议复制策略，不加task/goal完成度、文本关键词、长度或旧echo特殊终态清单。

summary必须追溯源字段；空白/空数组/缺失不算，RCC合成reasoning/toolreason summary不算，请求中的summary策略不算响应summary。先绑定各协议字段与typed provenance再实施。不从普通正文猜“总结”，不把has_summary或used塞业务metadata。

原请求used=0；真正启动新refill execution才加1。同轮候选恢复只增加attempt，不额外扣续杯次数、不重置used。工具/summary/取消/额度耗尽终结当前自动链；客户端后续新请求另起0。并发会话与端口不共享used。

## 图与实现关键边

先核对本树现图、四maps与接线状态。不要复用canonical旧“仅Node01已接入”的描述。本树README记录的candidate scoped acceptance也不等于本任务runtime完成。

严格按图设计→受影响gate→公开入口红测→唯一owner实现→真实入口黑盒推进。已有独立Plan和用户指定续杯设计可复用；只对整合新增边补正，不重跑所有前序检查。

必须接全：完整治理→共享决策→typed refill处置→请求Chat Process构造标准续请求→Runtime正常Request主线新执行→业务内容累积→最终标准交付。不能只设置FollowupRequired，不能借web-search executor、直接调用Provider或复活MetadataCenter/Stopless。

只删搜索专用servertool_followup/sidecar plan，不笼统删通用execution disposition、internal origin和延期提交。需要的处置改为清楚的refill语义；中间结果使用typed DeferredRefill，不用正常空candidate或空完成。Request/Response/Error图分开，每次续杯新execution，静态图不画回边。

请求Chat Process保留原始请求、工具声明、历史、本轮assistant内容、call ID和配对结果，加入计划规定的显式续杯指令。原客户端inverse/history pairing保持请求scope，不从内部续杯payload重建。原工具和真实finish reason保持，不伪造requires_action或stop。

中间轮不向客户端发完成事件；前轮业务内容同时进入续杯历史与最终标准结果。不能仅保留最后轮、丢media、改成reasoning或塞自建metadata。按计划绑定标准内容累积、item身份和usage规则。正常transport-only keepalive按原边界保留。

真实错误保留原原因和上游/本地来源走现有Error链，不当成无summary续杯。额度耗尽正常交付，Error候选耗尽按原合同中止本请求传输；已有前轮文字不能被包装成错误后的成功。取消和finalizer按scope执行，不在refill/重试中提前释放请求级控制与累积。

## Servertool 删除边界

先拆servertool_hooks.rs和混合测试中的ToolThinking/custom/apply_patch/namespace/配对逻辑，再删专用名字识别、CLI projection、搜索Center、sidecar和ExecuteWebSearch。普通工具恰叫web_search/vision_auto也不能被名字拦截。

servertool-core所有真实消费者清零后再移除workspace、Runtime/CLI/hooks依赖和打包残留。保留独立hooks daemon及无关control/调度/AppServer功能，不整包删除MetadataCenter。保持原生搜索机械投影和独立search/multimodal路由；普通本地工具不要求模型有hosted search能力。本地搜索由客户端真实执行，不在RCC兜底执行。退役配置显式诊断，不静默接受。

## 测试与准确入口

按整合方案执行原8个refill ID及servertool整合用例。先用真实HTTP入口和严格可控upstream证明旧实现不发第二次请求；仅缺新类型编译失败不是行为红证据。

现有target属于server crate，拟议filter新增后须验证实际运行测试数非零：

```sh
node v3/scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test no_response_adjudication_blackbox refill_ -- --test-threads=1 --nocapture
node v3/scripts/run-v3-cargo-test.mjs -p routecodex-v3-server --test no_response_adjudication_blackbox servertool_refill_ -- --test-threads=1 --nocapture
```

必需证明0/默认1/3、源与合成summary、工具止链、真实错误和候选恢复计数、并发跨端口隔离、取消、Direct/Relay一致、各轮内容/终态保留、JSON/SSE中间不完成、原生搜索首次接受、本地工具及无效参数完整往返。

实际工具执行由客户端完成，必须有输出、同call ID结果与后续请求；HTTP200、descriptor或受控标记不证明自然任务完成。缺本地执行器只停对应live case；其他无关工作继续，完整milestone仍保持未验收。把稳定ID与准确命令写入verification map及66301e2，保存真实写回回执；失败或不确定时才定向核对，不加例行读回或身份包装。

## 编排、交付与权限

沿整合方案T1–T8推进，按文件分工并发独立ready工作。Config/Chat Process共享策略、Runtime共享文件、四maps、Cargo/package与Git index均有唯一owner。Planner、实现者、Reviewer分离，执行/观察和Plan/Review按实际宿主技能路由，不用内置spawn/fork替代。长程交付责任由你保留，worker自报blocked不自动成为总目标阻塞。

已注册Collab才恢复本人的goal；未注册不初始化，不操作daemon，不向其他聊天发消息。只给外部模型必要源码、规则和脱敏证据，不外传私有生产payload/日志或凭据。

完成作者测试、真实consumer与适用候选runtime验收后，完整milestone做一次独立整体功能/架构Review。适用CI与Review通过再正式集成main、push、核对远端，完成main后运行验收、每次managed restart样本审计、canonical solution/issue disposition与自有资源清理。

正式restart前说明预计中断，每次加载只用一次正式rccv3 restart。失败先查原因，不重复试、不用stop/start或自建接管，不触碰AppSDK/Collab daemon、tmux与其他长任务。保护Git hooks，不做SHA/冻结包装；不重置或清理他人dirty状态。

分别记录source、图、test、build、install、restart、health、公开入口、review、merge、remote和cleanup。缺必要证据时明确open/INCOMPLETE，写清剩余项、owner与恢复条件；有已授权可执行动作就继续，不能以分支提交、health或PASS关闭总目标。
