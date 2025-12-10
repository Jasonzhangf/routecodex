### OpenAI Chat Golden Request Samples

存放位置：`~/.routecodex/golden_samples/openai_requests/<slug>/`

> **提示**：仓库内 `samples/chat-blackbox/openai/request-basic.json` 与 `samples/chat-blackbox/responses/request-basic.json`
> 保存了同一场景的版本化副本，便于审查/更新。需要刷新 `provider_golden_samples` 时，执行
> `node scripts/tools/capture-provider-goldens.mjs --update-golden`，脚本会使用这些请求并在检测到字段差异时
> 强制报错或更新黄金文件。

```
<slug>/
  request_payload.json  # 直接发送到 /v1/chat/completions 的 JSON
  meta.json             # 包含来源阶段、endpoint、描述等元数据
```

| slug | 描述 | Source Stage |
|------|------|--------------|
| `chat-toolcall-20251209T225016004-002` | Codex CLI 会话（用户 repeatedly “列出本地文件”，`stream=true`，含完整 system/环境上下文与工具 schema），用于验证 chat 入口 → glm.provider 的骨架路径 | `openai-chat/req_1765291814052_req_inbound_stage1_format_parse.json` |

#### 回放方式

```bash
curl -s http://127.0.0.1:5555/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer test' \
  --data @~/.routecodex/golden_samples/openai_requests/chat-toolcall-20251209T225016004-002/request_payload.json
```

该样本会沿 V2 骨架走 chat 入口 → hub → glm provider，可直接用来对比 legacy/chat-provider 行为。

#### 如何扩展

1. 在 `~/.routecodex/golden_samples/openai-chat/req_*_req_inbound_stage1_format_parse.json` 中找到需要的请求负载。
2. 将 `body.payload` 拷贝为新的 `request_payload.json`；注明 slug、描述后写入 `meta.json`。
3. 更新本文件表格，描述该样本的用途、对应阶段文件。若需要刷新所有 provider 的黄金请求，可运行
   `node scripts/tools/capture-provider-goldens.mjs --update-golden`，脚本将自动覆盖 `provider_golden_samples/` 下对应入口的请求副本。
