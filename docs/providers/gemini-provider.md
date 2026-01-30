# Gemini Provider (gemini-chat)

本页介绍 Gemini HTTP Provider 的使用与测试方法（基于 Google Generative Language API）。

## 基本信息
- 基地址：`https://generativelanguage.googleapis.com/v1beta`
- 端点：`/models/{model}:generateContent`
- 认证：API Key（请求头 `x-goog-api-key: <KEY>`，或自动从 `Authorization: Bearer <KEY>` 转换）
- 协议类型：`gemini`（providerProtocol=`gemini-chat`）

## 配置示例

```json
{
  "type": "gemini-http-provider",
  "config": {
    "providerType": "gemini",
    "baseUrl": "https://generativelanguage.googleapis.com/v1beta",
    "model": "gemini-2.5-flash-lite",
    "auth": {
      "type": "apikey",
      "headerName": "x-goog-api-key",
      "apiKey": "<YOUR_GEMINI_API_KEY>"
    }
  }
}
```

> 注意：若 `auth.headerName` 未设置，本 Provider 会在发送前将 `Authorization: Bearer <KEY>` 自动转换为 `x-goog-api-key: <KEY>`。

## 协议映射（最小）
- 入站（OpenAI Chat → Gemini contents）：Provider 在 `preprocessRequest` 做最小映射：
  - `messages[].role=user|assistant` → `contents[].role=user|model`
  - `messages[].content` → `parts[].text`
  - `system` 合并为 `systemInstruction`
  - 可选生成参数：`max_tokens` → `generationConfig.maxOutputTokens`，`temperature`、`top_p` 对应映射
- 返回：保持上游 JSON 原样返回（包含 `candidates` / `content`）。Composite 响应侧已允许 `candidates` 通过形状守卫。

## provider update（模型更新）

`src/tools/provider-update` 已支持 Gemini 的 `/models` 结果（`{ models: [{ name: 'models/<id>'}, ...] }`）。示例：

```bash
node dist/tools/provider-update/index.js \
  --config /Users/you/.routecodex/provider/gemini/config.json \
  --write --probe-keys --verbose
```

要求：配置文件中 `auth.headerName` 为 `x-goog-api-key` 或者确保 `Authorization: Bearer <KEY>` 可用（工具也支持 headerName/prefix 覆盖）。

## 快速联调（本地脚本）

```bash
GEMINI_API_KEY=**** npm run build
GEMINI_API_KEY=**** node scripts/gemini-smoke.mjs
```

脚本默认使用 `gemini-2.5-flash-lite` 并发送简短提示；返回结果仅截断打印前 500 字符。

## 测试建议
- 单元：按 docs/providers/provider-composite-testing.md 中“协议守卫/形状漂移”用例增加 `gemini-chat` 断言；已允许 `candidates` 通过。
- 集成：在 provider_golden_samples 中增加 `gemini-chat` 的 request/response 样例（可按真实 wire 形状扩展），并在蓝图回归中启用 gemini 路径。

## Antigravity (Cloud Code Assist)

如果你走的是 **Antigravity → Gemini（Cloud Code Assist）** 路径（而不是直连 Generative Language API），请看：
- `docs/providers/antigravity-fingerprint-ua-warmup.md`
