你运行进程需要用后台启动的方式，加入&,如果一定要前台运行就要用gtimeout

运行规范
- 后台运行（推荐）：`npm run start:bg`
- 前台限时（必须）：`npm run start:fg`

脚本
- `scripts/run-bg.sh`：后台 + 可选超时守护
- `scripts/run-fg-gtimeout.sh`：前台 + `gtimeout`（或降级 watcher）

