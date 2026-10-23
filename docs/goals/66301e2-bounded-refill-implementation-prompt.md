# 有界续杯实施提示词

你是RouteCodex工作项66301e2的目标编排者，对实现、解阻、验收、main交付及自有资源收口负责。当前提示词的发送者是Codex聊天01a1345f的任务owner；它交付实施合同，不授予Collab master或其他聊天通信权限。直接实施本任务，不再生成一层提示词。

先读取以下当前文件，恢复已有状态：

- `/Users/fanzhang/Documents/github/routecodex/AGENTS.md`，以及实施树中的适用AGENTS与`.appsdk/requirements.json`。
- `/Volumes/Intel/playground/routecodex/66301e2/docs/goals/66301e2-bounded-refill-plan.md`。
- `/Volumes/Intel/playground/routecodex/66301e2/docs/goals/66301e2-bounded-refill-dag.md`。
- 项目rcc-dev-skills和当前宿主编排入口；Codex Desktop/TUI使用codex-orchestrator。

目标：在Chat Process统一判断完整治理后的响应。若没有工具调用、没有真实错误、没有显式非空summary，且还有连续续杯额度，就构造正常续请求并执行。默认新增一次，0关闭，N最多新增N次。用户已接受短会话被有限额外续杯，不需要另加task/goal完成度分类器。

配置唯一位置是 `/Volumes/Intel/playground/routecodex/66301e2/v3/crates/routecodex-v3-config/src/internal.toml`：

```toml
[chat_process.refill]
max_consecutive_refills = 1
```

通过internal.rs现有owner解析并提供typed策略。该文件编译期嵌入，修改须重建加载。不要新增用户config.toml、server override或环境变量配置入口。0合法；运行计数只存在本请求typed控制中，不与其他会话或端口共享，不写业务metadata。

复用现有独占树 `/Volumes/Intel/playground/routecodex/66301e2` 和分支 `codex/66301e2-bounded-refill`，保留已有设计文档。canonical issue66301e2已登记，不重复建单。不改canonical dirty树、e63d2f2或其他issue的工作树。当前base来自唯一集成分支codex/e63d2f2-postfilter-empty；先查当前origin/main与PR433状态，经标准Git组合依赖，不手工跨树拷贝文件。

实施顺序严格按计划T1—T8：核对当前DAG及需求→补齐operation/resource/caller/gate边→公开入口行为红测→唯一owner实现→黑盒及真实工具往返→完整milestone整体Review→适用CI及main交付→集成后运行验收、issue和自有资源收口。已有独立Plan可复用；仅对当前新增事实补正，不把所有前序检查重跑。

实现关键点：Chat Process是唯一策略owner，Direct hook和Relay复用它，不按协议复制策略。每次新续杯发起时计数加1；同轮Error候选恢复不重复扣次数、不重置次数。真实错误保留原原因走既有Error链。工具／summary／取消／额度耗尽结束当前自动链；耗尽本身不是provider错误。所有业务内容、工具声明、参数、call ID、历史与结果配对、真实finish reason必须保留。summary按计划中的源显式非空事实处理，不能拿RCC合成reasoning summary作依据，也不能用正文关键词猜测。

特别检查已知缺边：现有FollowupRequired不等于通用续杯执行器。必须接好typed决策→请求Chat Process构造→Runtime正常主线新执行→内容累积→最终标准交付。中间不能提前发客户端完成事件，不能只保留最后一轮。禁止伪造echo工具、修改finish reason为tool_calls/stop、复活旧Stopless／reasoningStop／MetadataCenter、自建Provider旁路。

按当前宿主技能编排：通用执行／观察新建GCM worker；Planner与Reviewer按技能的模型选择和独立上下文合同，禁止内置spawn/fork替代。你是编排者，不把长程交付责任推给一次性worker。已注册Collab才沿其goal合同恢复本人目标；未注册则独立推进，不为此注册或维护daemon。无新增授权的跨聊天发送一律不执行。

按计划执行0/默认1/3、有工具、有summary、真实错误、取消、并发隔离、Direct/Relay、内容保留的公开入口用例。必须实际执行客户端工具并回传同call ID结果；HTTP200和内部单测不算工具往返。把准确测试ID和命令写入66301e2并读回。不要把受控token验收当作自然任务完成证据。

源码、测试、build、全局install、restart、health、真实入口、Review、merge、远端回执分别记录。正式restart前说明中断，每次加载只执行一次；失败保留原错，禁止stop/start、自行接管或终止他人进程。不得操作AppSDK/Collab daemon或tmux生命周期。不得外传私有生产日志、用户payload或凭据；外部模型仅接收必要源码、规则和脱敏证据。

范围内常规修复、Plan/Review、Git集成和适用安装/restart沿现有授权执行，不逐步询问。冲突、真实权限拒绝、需求冲突或失败gate须由你调查解阻，只停真实受影响下游。达到完整验收后按项目合同merge到main、核对远端、做集成后验证并清理本issue资源。未完成就明确open、剩余项和恢复条件，不以分支提交或PASS报告替代交付。
