# ModelScope 独立验证记录

- 日期: 2025-09-26
- 配置文件: `~/.routecodex/config/modelscope.json`
- 监听端口: 5507（示例环境）

## 验证范围

- 非流式 Chat Completions：返回 OpenAI 标准结构（`id/object/created/model/choices/usage`）
- 流式 Chat Completions（SSE）：`object: chat.completion.chunk`，`delta.content` 正常输出，`[DONE]` 终止
- 严格 JSON 模式：`response_format: { "type": "json_object" }` 时，`message.content` 清洗为纯 JSON 字符串
- 429 调度：由 PipelineManager 统一处理，多 Key/Pipeline 轮询重试；全部枯竭才返回 429
- 统一响应头：`x-request-id`、`Cache-Control: no-store`、`Content-Type: application/json; charset=utf-8`

## 快速验证命令

非流式：

```
curl -i -sS -H 'Content-Type: application/json' \
  -X POST http://localhost:5507/v1/chat/completions \
  -d '{
    "model": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
    "messages": [{"role":"user","content":"Hello from ModelScope test."}],
    "stream": false
  }'
```

流式：

```
curl -sS -N -H 'Content-Type: application/json' \
  -X POST http://localhost:5507/v1/chat/completions \
  -d '{
    "model": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
    "messages": [{"role":"user","content":"Stream a short reply."}],
    "stream": true
  }'
```

严格 JSON 模式：

```
curl -i -sS -H 'Content-Type: application/json' \
  -X POST http://localhost:5507/v1/chat/completions \
  -d '{
    "model": "Qwen/Qwen3-Coder-480B-A35B-Instruct",
    "messages": [{"role":"user","content":"只返回一个JSON对象：{\"ok\":true}"}],
    "response_format": { "type": "json_object" },
    "stream": false
  }'
```

## 日志与追踪

- 运行日志：`server-modelscope.log`
- DebugCenter：`~/.routecodex/logs/debug-center.log`
- 关联方式：使用响应头 `x-request-id` 在日志中检索对应请求链路

