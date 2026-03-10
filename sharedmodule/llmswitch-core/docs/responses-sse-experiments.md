## Responses↔Chat↔SSE 实验计划

本文记录我们为“Responses in/out conversion + SSE”搭建的端到端实验，确保
lmstudio/llmswitch-core/客户端三方都遵循 OpenAI Responses 协议。

### 共同前置

- LMStudio Responses 端点 (默认 `http://127.0.0.1:1234/v1`)，模型示例 `gpt-oss-20b-mlx`
- 环境变量（可在命令前加）：
  ```bash
  export LMSTUDIO_BASEURL=http://127.0.0.1:1234/v1
  export LMSTUDIO_API_KEY=lm-studio
  ```
- 请求样例：`tools/responses-debug-client/payloads/tool.json`
- 黄金样例存放：`~/.routecodex/codex-samples/openai-responses/lmstudio-golden`

### 实验 1：Responses SDK ↔ LMStudio（直连）

目的：获取官方 Responses SSE 形状（无任何桥接），把原始事件落盘作为黄金样例。

命令：
```bash
npm run capture:responses:lmstudio -- --file tools/responses-debug-client/payloads/tool.json
```

输出：
- `*.request.json`：本次请求 payload
- `*.events.ndjson`：逐事件 SSE 日志

### 实验 2：Responses JSON → llmswitch-core → Chat JSON → LMStudio（脚本直连）

目的：用独立脚本（不启动 server）验证 Responses in-conversion → Chat 输出送入 LMStudio
`/v1/chat/completions` 的正确性，并记录 Chat SSE。

命令：
```bash
MODEL=gpt-oss-20b-mlx \
LMSTUDIO_BASEURL=http://127.0.0.1:1234/v1 \
LMSTUDIO_API_KEY=lm-studio \
TIMEOUT_MS=60000 \
node scripts/exp2-responses-to-chat.mjs \
  --file scripts/payloads/exp2.responses.tool.json \
  --out exp2-local
```

输出：
- `~/.routecodex/codex-samples/exp2-responses-to-chat/*.converted.chat.request.json`
- `~/.routecodex/codex-samples/exp2-responses-to-chat/*.chat.events.ndjson`
- `~/.routecodex/codex-samples/exp2-responses-to-chat/*.chat.final.json`

重点观测：
- conversion 仅做形状映射，未触碰工具治理；
- Chat SSE 正常结束（[DONE]），超时自动中止；
- Final JSON 的 `finish_reason` 可为 `tool_calls`（表示触发工具调用）。

> **快照与输出路径**
>
> 实验脚本默认写入 `~/.routecodex/codex-samples/exp*-*`，若运行环境限制 `$HOME` 写入，可在执行命令前设置：
> ```bash
> export ROUTECODEX_SNAPSHOT_BASE="$(pwd)/test-output/snapshots"
> export LLMSWITCH_EXP3_OUTDIR="$(pwd)/test-output/exp3"
> export LLMSWITCH_EXP4_OUTDIR="$(pwd)/test-output/exp4"
> export LLMSWITCH_EXP5_OUTDIR="$(pwd)/test-output/exp5"
> ```
> 主包也支持 `LLMSWITCH_SNAPSHOT_BASE` / `RCC_SNAPSHOT_BASE` 等等价变量，便于统一管理快照落盘。

### 实验 3：Responses SSE → llmswitch-core → Chat JSON → Chat SSE

目的：在第 2 步基础上，让 llmswitch-core 输出 OpenAI Chat SSE 给 mock 客户端，
测试 Chat SSE inversion/out-conversion。

命令：
```bash
# 默认读取 ~/.routecodex/codex-samples/openai-responses/lmstudio-golden 下最新的 events
npm run replay:responses:chat-sse

# 指定样本 / 输出文件前缀
npm run replay:responses:chat-sse -- \
  --events ~/.routecodex/codex-samples/openai-responses/lmstudio-golden/lmstudio-resp-test.events.ndjson \
  --out lmstudio-resp-test
```

输出：
- `~/.routecodex/codex-samples/exp3-responses-to-chat-sse/<label>.responses.json`：
  Responses SSE 聚合后的 JSON。
- `~/.routecodex/codex-samples/exp3-responses-to-chat-sse/<label>.chat.response.json`：
  经 `buildChatResponseFromResponses` 转换后的 Chat JSON。
- `~/.routecodex/codex-samples/exp3-responses-to-chat-sse/<label>.chat.sse.ndjson`：
  由 `json-to-chat-sse` 合成的 Chat SSE 事件日志（NDJSON）。
- `~/.routecodex/codex-samples/exp3-responses-to-chat-sse/<label>.chat.sse.txt`：
  原始 SSE 文本，可直接 diff OpenAI 官方输出。

重点观测：
- Chat SSE 帧数与内容是否与 OpenAI 官方样式一致。
- 工具调用（`finish_reason=tool_calls`）或文本分片是否完整。

### 实验 4：Responses SSE → llmswitch-core → Responses SSE（全链路）

目的：补齐 Responses 出口，让 Responses in/out + SSE 完整闭环（客户端看到的 SSE
与实验 1 黄金样例一致）。

命令：
```bash
# 默认重放最新黄金样本
npm run replay:responses:loop

# 指定样本并设置输出标签
npm run replay:responses:loop -- \
  --events ~/.routecodex/codex-samples/openai-responses/lmstudio-golden/lmstudio-resp-test.events.ndjson \
  --out lmstudio-resp-test
```

输出：
- `~/.routecodex/codex-samples/exp4-responses-loop/<label>.responses.json`：
  Responses 聚合后的 JSON（与实验 3 共享）。
- `~/.routecodex/codex-samples/exp4-responses-loop/<label>.replay.events.ndjson`：
  由 `json-to-responses-sse` 重建的 SSE 事件日志。
- `~/.routecodex/codex-samples/exp4-responses-loop/<label>.replay.sse.txt`：
  SSE 原文，便于与黄金样本 `*.events.ndjson` 对比。

自动 diff：
- 回放脚本会比较事件类型序列，输出 mismatches（若存在）。
- 同时打印事件分布（`response.output_text.delta` 等）用于快速 sanity check。

完成回放后，可使用 `diff`/`rg` 与黄金样本比对字段，从而验证 Responses in/out
链路的稳定性。

### 日志与对比

- 黄金样例事件：`~/.routecodex/codex-samples/openai-responses/lmstudio-golden/*.events.ndjson`
- llmswitch-core 实验事件：`~/.routecodex/logs/sse/*.log`
- Pipeline 聚合：`~/.routecodex/codex-samples/openai-responses/req_*_pipeline.aggregate.json`

对比方法：
```bash
# 示例：比较黄金样例与当前桥接输出的 event 类型序列
rg -o '"type":"[^"]+"' ~/.routecodex/codex-samples/openai-responses/lmstudio-golden/<sample>.events.ndjson
rg -o 'event: [^ ]+' ~/.routecodex/logs/sse/<bridge>.log
```

完成以上四个实验后，我们就拥有了 Responses ↔ Chat ↔ SSE 的独立子模块，并能用黄金
样例随时回归验证。
- `rg -o '"type":"[^"]+"' ~/.routecodex/codex-samples/openai-responses/lmstudio-golden/<sample>.events.ndjson`
- `rg -o 'event: [^ ]+' ~/.routecodex/logs/sse/<bridge>.log`

### 实验 5：Chat SSE 直通（兼容层 / 样本验证）

目的：在不跨协议的前提下，验证 Chat SSE → JSON → SSE 直通通路，并确保兼容层（默认 `lmstudio` profile）会在响应方向介入。

命令：
```bash
# 默认读取 ~/.routecodex/codex-samples/openai-chat/lmstudio-golden 最新样本
npm run replay:chat:bridge

# 指定样本与 provider 元数据
npm run replay:chat:bridge -- \
  --events ~/.routecodex/codex-samples/openai-chat/lmstudio-golden/full-chat-experiment-1-1763865876.events.ndjson \
  --profile lmstudio \
  --provider lmstudio \
  --provider-type openai \
  --protocol lmstudio
```

输出：
- `~/.routecodex/codex-samples/exp5-chat-bridge/<label>.chat.response.json`
- `~/.routecodex/codex-samples/exp5-chat-bridge/<label>.chat.compat.json`
- `~/.routecodex/codex-samples/exp5-chat-bridge/<label>.chat.replay.sse.ndjson`
- `~/.routecodex/codex-samples/exp5-chat-bridge/<label>.chat.replay.sse.txt`

特点：
- `compat/common/ensure-response-tools` 与 `compat/lmstudio/response` 会依据 provider metadata 命中；
- 输入与输出均遵循 OpenAI Chat SSE 形状（仅 JSON ↔ SSE 转换，没有协议切换）；
- 快照目录与前述环境变量共享，可统一指向 `test-output/snapshots`。

> 更完整的样本矩阵与目前的验证状态，参见 `docs/SSE_GOLDEN_SAMPLE_MATRIX.md`。
