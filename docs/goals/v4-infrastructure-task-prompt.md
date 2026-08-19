/goal
目标：完成 V4 基建，使 `rccv4` 全局安装、cwd-independent、V3 CLI 功能对齐、真实 server/provider 可跑。

说明：本任务不需要再写新的提示词，直接按实现文档执行。

实现文档：
docs/goals/v4-infrastructure-task-plan.md

执行规范：
- CLI 只做解析与分发，server/lifecycle/config/provider 语义归各自 owner；不新增 mock。
- 端口、provider、model、路由全部来自 `config.v4.toml`/compiled manifest；禁止硬编码端口或把端口写进路由名。
- `--version`/`--help` 不加载 manifest；`start --snap` 任意 cwd 可用。
- V4 独立使用 `config.v4.toml`、`~/.rcc/v4`、独立 listener；禁止触碰 V3 config/process/tmux/admin。
- P0 禁止脚本批量语义替换；逐文件核实后用 apply_patch hunk。
- 控制/诊断/error 状态不进入 provider/client payload；无 fallback、无 silent strip。

验证：
- CLI/config/lifecycle 定向测试与红测
- release build、全局安装、codesign/hash 校验
- 任意 cwd `rccv4 --version`、`--help`、`config check`、`start --snap`
- `/health`、`/v1/models`、真实 Responses JSON/SSE live replay
- V4 `verify:ci`、isolation、map/gate 同步
- DSH review（opencode-go/deepseek-v4-flash）语义 PASS

完成标准：
- `rccv4` 在任意 cwd 可运行和管理；V3 CLI 命令面全部对齐或显式登记差异。
- server 和 provider 都不是 mock，真实请求端到端通过；V3 不受影响。
- 无硬编码端口、无路由名带端口、无 fallback、无旁路；DSH 无 P0/P1。
