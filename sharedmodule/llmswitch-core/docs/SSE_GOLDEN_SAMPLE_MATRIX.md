# SSE 黄金样本矩阵

用于跟踪 Chat / Responses 两条通路的黄金样本、重放脚本以及当前验证状态。

| Provider | 通道 | 样本目录 | 重放命令 | 快照输出 | 状态 |
|----------|------|-----------|-----------|----------|------|
| LM Studio | Responses ↔ Chat ↔ SSE | `~/.rcc/codex-samples/openai-responses/lmstudio-golden/*.events.ndjson` | `ROUTECODEX_SNAPSHOT_BASE="$(pwd)/test-output/snapshots" \`<br>`LLMSWITCH_EXP3_OUTDIR=test-output/exp3 \`<br>`LLMSWITCH_EXP4_OUTDIR=test-output/exp4 \`<br>`npm run replay:responses:chat-sse -- --events <sample>`<br>`npm run replay:responses:loop -- --events <sample>` | `$(pwd)/test-output/snapshots/openai-{chat,responses}` | ✅ 事件序列已与黄金样本一致 |
| LM Studio | Chat 直通 (SSE→JSON→SSE) | `~/.rcc/codex-samples/openai-chat/lmstudio-golden/*.events.ndjson` | `ROUTECODEX_SNAPSHOT_BASE="$(pwd)/test-output/snapshots" \`<br>`LLMSWITCH_EXP5_OUTDIR=test-output/exp5 \`<br>`npm run replay:chat:bridge -- --events <sample>` | `$(pwd)/test-output/snapshots/openai-chat` | ✅ 兼容层（LM Studio profile）已介入 |
| C4M | Responses ↔ Chat ↔ SSE | `test-output/c4m-golden-samples/<stamp>/*-events.json` | _待补充（当前样本文件未包含有效 SSE 事件）_ | - | ⚠️ 样本缺失，需重新捕获 |

## 环境变量快速参考

- `ROUTECODEX_SNAPSHOT_BASE`：指定快照根目录，所有 replay 脚本都会写入 `openai-chat/`、`openai-responses/` 子目录。
- `LLMSWITCH_EXP3_OUTDIR` / `LLMSWITCH_EXP4_OUTDIR` / `LLMSWITCH_EXP5_OUTDIR`：控制对应实验脚本的输出目录，默认落在 `~/.rcc/codex-samples/exp{3,4,5}-*`。
- `LLMSWITCH_SNAPSHOT_BASE`：与 `ROUTECODEX_SNAPSHOT_BASE` 等价（任意其一生效即可），用于主包在运行时写入快照。

> 💡 建议在 CI 或本地调试时统一将 `ROUTECODEX_SNAPSHOT_BASE` 指向工作区下的 `test-output/snapshots`，避免写入 `$HOME` 受限目录。
