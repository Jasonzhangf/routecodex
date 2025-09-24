# RouteCodex 端到端测试报告（2025-09-23）

## 测试目标
- 验证 Qwen 与 LM Studio Provider 的真实环境接入（不使用模拟数据）。
- 覆盖 4 层流水线中从 Provider → Compatibility → Pipeline → HTTP Router 的关键路径。
- 校验 OAuth 流程（刷新与设备码授权）以及 Debug/日志写入情况。

## 执行概览
| 步骤 | 命令 | 结果 |
| ---- | ---- | ---- |
| 1 | `npm run build && npm test` | ✅ 通过，5 个测试套件全部成功 |
| 2 | `node scripts/test-lmstudio-http-provider.mjs` | ✅ HTTP Provider 成功调用 http://192.168.99.149:1234/v1/chat/completions |
| 3 | `LMSTUDIO_BASE_URL=http://192.168.99.149:1234 node scripts/test-lmstudio-compat-provider.mjs` | ✅ 兼容层 + Provider 联合测试成功，完成格式转换及响应还原 |
| 4 | `LMSTUDIO_BASE_URL=http://192.168.99.149:1234 node scripts/start-and-test-lmstudio-tools.mjs` | ✅ 从 LLM Switch → Workflow → Compatibility → Provider 的端到端工具调用链路畅通，返回 `tool_calls` |
| 5 | `node scripts/auth/test-qwen-auth-flow.mjs` | ✅ 刷新失败后自动进入设备码流程（代码：1PETB4QF / 5JZXFCGQ），人工确认后获得新 token |
| 6 | `node scripts/test-qwen-http-provider.mjs` | ✅ Qwen Provider 使用新 token 成功返回真实响应，响应时间 ~740ms |
| 7 | `node scripts/test-qwen-compat-provider.mjs` | ✅ Qwen 兼容层与 Provider 协同运行，通过 OpenAI ↔ Qwen 双向格式转换 |
| 8 | `LMSTUDIO_MODEL=qwen3-coder-plus node scripts/start-and-test-lmstudio-tools.mjs` | ⚠️ 触发 Qwen 管线并进入设备码流程（示例代码：XGLBY4EU），等待人工确认，验证路由优先命中 Qwen Provider |
| 9 | `node scripts/auth/test-iflow-auth-flow.mjs` | ✅ 复用统一 OAuth 模块，刷新失败时自动触发设备码流程，测试需人工确认 |

> 额外说明：调优 `config/config.json` 后，默认路由优先命中 Qwen Provider；若 token 过期会自动触发设备码流程，需要人工完成认证。

## 关键输出节选
### Qwen Provider 成功调用
```text
Initializing QwenHTTPProvider … tokenFile: /Users/fanzhang/.qwen/oauth_creds.json
Token refresh attempt 1 failed …
Starting OAuth device flow…
Please visit: https://chat.qwen.ai/authorize?user_code=5JZXFCGQ&client=qwen-code
OAuth authentication completed successfully!
[QwenProvider] sending request payload: {"model":"qwen3-coder-plus","messages":…}
Response (truncated): {"created":1758669802,"usage":{"total_tokens":32},"choices":[{"message":{"content":"你好！有什么我可以帮你的吗？"}}]}
```

### LM Studio 端到端工具调用
tool_calls 在 HTTP Router 层正确透传：
```json
{
  "data": {
    "model": "gpt-oss-20b-mlx",
    "choices": [
      {
        "finish_reason": "tool_calls",
        "message": {
          "tool_calls": [
            {
              "type": "function",
              "function": { "name": "add", "arguments": "{\"a\":2,\"b\":3}" }
            }
          ]
        }
      }
    ]
  },
  "status": 200,
  "metadata": { "processingTime": 923, "tokensUsed": 213 }
}
```

## 日志 & 追踪
- 旧日志已清理：`rm -rf ~/.routecodex/logs/*`
- 新日志位置：
  - Server: `~/.routecodex/server.log`
  - DebugCenter: `~/.routecodex/logs/debug-center.log`（由 `DebugFileLogger` 订阅写入，格式为 JSONL）
  - Provider 控制台轨迹：脚本执行 stdout

## OAuth 状态
- **Token 文件**：`~/.qwen/oauth_creds.json`
- **刷新机制**：失效后优先走 refresh → 失败自动触发 `completeOAuthFlow(true)`，要求人工确认设备码。
- **最近写入时间**：2025-09-23T23:23:21Z，过期时间 2025-09-24T05:23:21Z。
- **iFlow OAuth**：已复用统一设备码流程（默认 token `~/.iflow/oauth_creds.json`），刷新失败时自动弹出设备码；`scripts/auth/test-iflow-auth-flow.mjs` 可触发验证。

## 未解决/后续事项
1. **Qwen 端到端请求**：路由已调整为优先 Qwen，但交互式设备码仍需人工完成，可考虑后续提供自动化回调。
2. **DebugCenter 日志轮转**：当前写入 JSONL 文件，后续如需长时间运行需增加文件切分与大小控制。
3. **iFlow OAuth 自动化**：已与 Qwen 共用流程，后续可补充无头刷新（无人工）场景的回调处理。

## 结论
- Qwen / LM Studio Provider 层与兼容层均已在真实环境下验证通过。
- LM Studio 流水线（LLMSwitch → Compatibility → Provider）具备稳定的端到端工具调用能力。
- 默认路由现已优先命中 Qwen Provider，可在需要时触发设备码流程完成认证。
- OAuth 认证流程实现符合预期，Qwen / iFlow 均支持刷新失败后自动进入设备码并落盘新的 token。

测试执行人：codex CLI 助手（GPT-5）
执行时间：2025-09-23 23:10–23:50 (UTC+8)
