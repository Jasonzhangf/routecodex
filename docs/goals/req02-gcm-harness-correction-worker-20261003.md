# GCM工具回合harness精确纠正

本任务独占既有树/Volumes/Intel/playground/routecodex/req02-gcm-roundtrip-harness-20261003。前worker9348已实际终态exit0但未取得可信完成回执，父发现验收错，候选不接受；父只对已核实自有PID54831及其克隆子进程25114发TERM。全新GCM，不resume/fork；你不是独自工作，其他worker在各自树做Runtime资源和Chat图片，不碰其范围。

只写tests/blackbox/req02-tools/run-gcm-consumer.mjs、该目录README.md、本树docs/goals/req02-gcm-roundtrip-harness-correction-result-20261003.md。原脚本1091行及原结果保留可对比。禁止全库审计、联网clone/curl、样本树无目标扫描、运行模型、daemon/start/restart或发往4444。没有candidate endpoint，当前只准备真实验收命令，绝不冒称候选E2E。

已定位精确问题，直接纠正，不再探索：
1. buildPrompt命令打印sentinel后又打印END，validateExec却要求sentinel最后；改为完整命令以sentinel结束，保留多行和绝对workdir。
2. 本机Codex CLI事件真源可只读用户给定codex仓库：/Users/fanzhang/code/codex/codex-rs/exec/src/exec_events.rs。apply_patch成功为item.completed/item.type=file_change，changes[{path,kind:add|update}]及status:completed，不是command_execution。按真实Add/Update事件的路径/顺序及后续exec实际字节/hash验收；不要接受shell command里出现apply_patch当成原生自由文本工具回执。原始patch自由文本及custom/function身份需从本次精确绑定请求/响应历史验证，CLI仅file_change不证明grammar字符串完整，不猜默认。
3. 硬编码private_wakeup_probe.get_probe_status是此前环境基线，不是当前child契约。当前gcm.config实际有[mcp_servers.mcpx] url=127.0.0.1:9090/mcp。父本轮真实调用mcpx.runtime_read({view:"capabilities"})取得structuredContent.status=succeeded，data.runtime.version=0.9.18、capability_version=clean-core-p13，工具无需session。改CLI显式--mcp-server/--mcp-tool/--mcp-arguments输入，README推荐mcpx、runtime_read、{"view":"capabilities"}。Codex MCP事件字段server与tool分开，按显式参数精确比对及实际structured_content验收，不能按名称split猜identity。实际终态模型消费必须报告返回version/capability_version等观测值；数据类型按返回内容，不要求任意两个key/一个string的猜测规则。
4. CLI help文本整串片段比对脆弱且不能证明行为，删除多余ensureCodexCliContract文本匹配；保留当前必要参数和实际child执行错误，version仅记证据。保留真源profile读取、显式endpoint override、binary/hash/candidate/worktree绑定及必要隔离，不再新增preflight/check状态机。

候选工具实际回合必须断言exec完整输出、两次原生apply_patch及readback完整bytes/hash、真实MCP结果、结果进入后续请求且最终模型消费。成功必须绑定准确requestId/sample；只在本次明确port与child threadId范围定位，absence显式UNVERIFIED，不做全目录猜配对。业务工具参数仅在验收client观测，不给proxy增加参数解析。raw JSONL/result/marker/home清理按已有合同。

验证只运行node --check、--help exit0、缺参数入口非零且不发请求；对当前纠正给逐项源依据与最小diff，不能用mock事件或语法绿当真实工具验收。写exact script hash、参数命令、当前缺口到结果文件，完成立即退出，不进一步找baseline或样本。clone产生的/tmp/codex-src-0.160.0留给父核对自有资源后清理，不能删他人的文件。
