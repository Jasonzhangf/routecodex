# Mock Provider 样本目录

## 目录结构
```
samples/mock-provider/
├── README.md                 # 本文档
├── _registry/                # 样本元数据注册表（index.json）
│   └── index.json
├── openai-chat/              # /v1/chat/completions 样本
│   ├── _template/
│   │   ├── request/          # 请求模板（仅骨架，不用于回放）
│   │   └── response/         # 响应模板（仅骨架，不用于回放）
│   ├── glm-key1-gpt-4-20251204T120000-001.request.json
│   └── glm-key1-gpt-4-20251204T120000-001.response.json
├── openai-responses/         # /v1/responses 样本
│   ├── _template/
│   │   ├── request/
│   │   └── response/
│   ├── glm-key1-gpt-4-20251204T120100-002.request.json
│   └── glm-key1-gpt-4-20251204T120100-002.response.json
└── anthropic-messages/       # /v1/messages 样本
    ├── _template/
    │   ├── request/
    │   └── response/
    ├── glm-key1-claude-3-20251204T120200-003.request.json
    └── glm-key1-claude-3-20251204T120200-003.response.json
```

## 命名规范
文件名：`{入口}-{providerId}-{model}-{YYYYMMDD}T{HHmmss}-{序号}.{request|response}.json`

示例：
- `openai-chat-glm-key1-gpt-4-20251204T120000-001.request.json`
- `openai-responses-glm-key1-gpt-4-20251204T120100-002.response.json`
- `anthropic-messages-glm-key1-claude-3-20251204T120200-003.request.json`

字段含义：
- 入口：openai-chat / openai-responses / anthropic-messages
- providerId：来自 config 中的 provider key（如 glm-key1）
- model：目标模型（如 gpt-4, claude-3）
- 时间：UTC 时间戳，精确到秒
- 序号：同一秒内递增的三位数字（001, 002...）

## 样本内容格式
### request.json
```json
{
  "reqId": "openai-chat-glm-key1-gpt-4-20251204T120000-001",
  "endpoint": "/v1/chat/completions",
  "providerId": "glm-key1",
  "model": "gpt-4",
  "timestamp": "2025-12-04T12:00:00.000Z",
  "body": { ... }  // 与 codex-samples 中 provider-request 结构一致
}
```

### response.json
```json
{
  "reqId": "openai-chat-glm-key1-gpt-4-20251204T120000-001",
  "endpoint": "/v1/chat/completions",
  "providerId": "glm-key1",
  "model": "gpt-4",
  "timestamp": "2025-12-04T12:00:01.000Z",
  "status": 200,
  "body": { ... }  // 与 codex-samples 中 provider-response 结构一致
}
```

## _registry/index.json
```json
{
  "version": 1,
  "updated": "2025-12-04T12:00:00Z",
  "samples": [
    {
      "reqId": "openai-chat-glm-key1-gpt-4-20251204T120000-001",
      "file": "openai-chat/glm-key1-gpt-4-20251204T120000-001",
      "endpoint": "/v1/chat/completions",
      "providerId": "glm-key1",
      "model": "gpt-4",
      "tags": ["tool-call", "streaming"]
    }
  ]
}
```

## 如何使用
1. 将真实 provider 请求/响应落盘到 `~/.routecodex/codex-samples` 后，运行脚本提取并复制到本目录。
2. 脚本自动重命名并生成 `_registry/index.json`。
3. Mock Provider 在 CI 或本地测试时，根据 reqId 前缀匹配入口，再按 providerId+model 查找最接近时间戳的样本进行回放。

## 脚本接口（待实现）
- `npm run mock:extract`   # 从 ~/.routecodex/codex-samples 提取并落盘到本目录
- `npm run mock:validate`  # 校验命名与格式
- `npm run mock:clean`     # 清理过旧样本
