# REQ02 GCM实际工具回合验收命令

独占工作树 /Volumes/Intel/playground/routecodex/req02-gcm-roundtrip-harness-20261003，fresh origin/main75cab8267。你不是独自工作；字段算子与consumer由其他worker做。只写tests/blackbox/req02-tools/run-gcm-consumer.mjs、该目录README.md、本树docs/goals/req02-gcm-roundtrip-harness-result-20261003.md；产品、配置真源、已有测试、其他工作树只读。不使用内置subagent、Collab，不启动或重启任何runtime。全新GCM，无resume/fork或父transcript。

已有基线能力已证实gcm的gpt-5.5/5.6可exec/apply_patch/MCP；父黑盒树docs/goals/req02-{blackbox-capabilities,gpt56-baseline}-20261002.md及tests/blackbox/req02-tools/README.md只读参考，不重做基线。缺口是可重复实际consumer命令把三类工具真实执行、结果回传/follow-up绑定到精确隔离candidate端口及binary。

实现最小Node CLI harness：必须由参数传入candidate endpoint、candidate SHA、binary真实path/hash、模型（gpt-5.5或gpt-5.6）、外置受测worktree与证据目录。读取当时gcm profile真源确认实际provider路由，再用child CLI明确config覆盖base_url到指定隔离endpoint，不能按profile名称猜provider id。若override能力不可确认，报缺口而不是默认发4444。不可用默认共享4444，不改全局config，不打印auth/token值；HOME等从process.env派生。启动全新codex exec --profile gcm，独立CODEX_HOME与明确cwd；按codex-orchestrator已有方式隔离必要链接。保留JSON日志/退出回执，工作完成清理自己的child临时home并保留证据；失败保留恢复所需资源和明细。child本轮只在临时受测marker范围写，禁产品/全局改动。

consumer prompt要求实际调用exec_command（完整多行命令、绝对workdir及尾部sentinel）、apply_patch自由文本AddFile/UpdateFile随后exec读回字节与hash、一个真实可用只读MCP工具返回结构化结果（工具发现不能替代真实调用）。最终follow-up实际读取并报告exec输出、patch文件内容及MCP结果。不能让模型仅声称成功；harness从真实CLI事件/执行结果与marker实际文件核验，区分工具执行、结果回传、模型消费终态。不能只以exit0/HTTP200/requires_action为通过，不解析proxy中的工具业务参数来猜身份。两模型分别运行，原始JSON、marker hash和结果summary绑定输入版本/endpoint；保留该请求ID与sample的准确关联方法，不通过猜测或全树搜索配对。

当前没有已接线candidate endpoint：本任务只完成harness实现与可执行使用说明，node --check做针对性检查；通过--help核对参数、缺必需参数明确非零退出且不发请求。不要启动模型或daemon来冒充candidate E2E，不增加mock自测或复杂状态机。实际成功/失败行为待父提供精确endpoint及binary后执行，不算本任务已PASS的层。

完成iff：最小脚本落盘、真实语法与参数入口退出码、具体两模型调用命令/预期/证据目录/缺口写入结果文档、没有未授权runtime动作。不能确定事件contract/CLI override就记录精确缺口和可核实来源，不猜、不扩范围。无需独立review/commit/install；结果落盘后退出，父组合后执行真实两模型回合及后续review。
