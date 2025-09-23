# RCC4 端到端测试报告（2025-09-23）

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

> 额外说明：尝试使用 `scripts/start-and-test-lmstudio-tools.mjs` 将 `MODEL=qwen3-coder-plus` 发送至 HTTP Router 时，因为默认路由池的轮询优先返回 LM Studio，最终响应仍为 LM Studio 模型。该问题已记录为后续路由权重/分类调优事项。

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
  - Provider 控制台轨迹：脚本执行 stdout
- DebugCenter 文件输出仍为空，原因待排查（模块已记录事件但未落盘，后续需核实 `config/modules.json` 中 DebugCenter 的文件写入权限）。

## OAuth 状态
- **Token 文件**：`~/.qwen/oauth_creds.json`
- **刷新机制**：失效后优先走 refresh → 失败自动触发 `completeOAuthFlow(true)`，要求人工确认设备码。
- **最近写入时间**：2025-09-23T23:23:21Z，过期时间 2025-09-24T05:23:21Z。
- iFlow OAuth 仍沿用自定义逻辑，尚未迁移到统一的 `QwenOAuth` / `OAuthManager` 实现，需要后续对齐。

## 未解决/后续事项
1. **路由轮询导致 Qwen 端到端请求落到 LM Studio**：需要调整路由池权重或在分类器中增加针对 Qwen 模型的显式规则。
2. **DebugCenter 文件日志缺失**：需要确认配置写入路径以及事件订阅是否完整。
3. **iFlow OAuth 统一化**：目前 provider 逻辑与 Qwen OAuth 分离，后续计划复用 `QwenOAuth` 与 `OAuthManager` 中的设备码流程。

## 结论
- Qwen / LM Studio Provider 层与兼容层均已在真实环境下验证通过。
- LM Studio 流水线（LLMSwitch → Compatibility → Provider）具备稳定的端到端工具调用能力。
- Qwen 端到端需要针对路由策略调优，但 Provider + Compatibility 层已工作正常。
- OAuth 认证流程实现符合预期，能在刷新失败时自动进入设备码流程并落盘新的 token。

测试执行人：codex CLI 助手（GPT-5）
执行时间：2025-09-23 23:10–23:27 (UTC+8)
