# Codex Samples 回放

`scripts/replay-codex-sample.mjs` 允许我们将 `~/.routecodex/codex-samples/**/*_client-request.json` 等样本重新发送到本地 RouteCodex，确保工具调用、SSE chunk 和最终 JSON 都被完整记录。

## 使用步骤

1. 启动 RouteCodex 主包（默认 `http://127.0.0.1:5555`）。
2. 准备好想要回放的样本文件，例如：
   `~/.routecodex/codex-samples/openai-responses/req_req-v2-1764415000213-z1sxtbhuo_client-request.json`
3. 执行：

```bash
npm run replay:codex-sample -- \
  --sample ~/.routecodex/codex-samples/openai-responses/req_req-v2-1764415000213-z1sxtbhuo_client-request.json \
  --label first-run
```

可选参数：

| 参数 | 说明 |
| --- | --- |
| `--label` | 为本次运行命名（默认使用时间戳）。 |
| `--base`  | RouteCodex 基地址，默认 `http://127.0.0.1:5555`。 |
| `--key`   | API Key / Bearer Token，默认 `routecodex-test`。 |

## 产出内容

脚本会在样本所在目录下生成 `runs/<requestId>/<label>/`，包括：

- `request.json`：发送给 RouteCodex 的 endpoint 与 body；
- `response.meta.json`：状态码、响应头以及是否流式；
- 若为流式：
  - `response.sse.log`：完整的 SSE 文本（`event:`/`data:`）；
  - `response.sse.ndjson`：逐帧 NDJSON，方便与黄金样本 diff；
- 若为 JSON：
  - `response.json`：RouteCodex 返回的 JSON payload；
- 若发生错误，额外写入 `response.error.txt`。

## 配合 proxy replay

对于 responses SSE，可使用 `scripts/responses-sse-proxy.mjs --replay <capture>/response.sse.log` 将黄金样本作为上游输出，再结合本脚本回放客户端 payload，实现“同一份请求 + 同一份 SSE 流”在 RouteCodex 中的完整闭环。

## 常见场景

- **工具调用链路**：先回放 `/v1/responses` 样本捕获 `required_action`，再回放对应的 `/v1/responses.submit_tool_outputs` 样本；
- **对比黄金样本**：和 `npm run verify:sse-loop -- --skip-chat --skip-anthropic --use-proxy-capture` 搭配，先复现请求，再检查 SSE 是否与黄金帧一致；
- **调试快照**：`runs/` 输出可以直接归档到版本库/CI 工件，作为后续 Regression 的输入。

通过上述流程，可以确保 codex samples 中的工具请求、工具返回以及最终响应数据均可被精准复现，并在磁盘上形成完备的 JSON/SSE 证据链。

