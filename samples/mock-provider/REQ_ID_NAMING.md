# 样本 reqId 命名规范

## 统一格式
`{入口}-{providerId}-{model}-{YYYYMMDD}T{HHmmss}-{序号}`

## 字段说明
- 入口：openai-chat / openai-responses / anthropic-messages
- providerId：来自 ~/.routecodex/provider/*/config.v1.json 中 providers 的 key（如 glm）
- model：对应 providers 中的模型 key（如 glm-4.6）
- 时间：UTC 时间戳，精确到秒
- 序号：同一秒内递增的三位数字（001, 002...）

## 示例
- openai-chat-glm-glm-4.6-20251204T120000-001
- openai-responses-glm-glm-4.6-20251204T120100-002
- anthropic-messages-glm-glm-4.6-20251204T120200-003

## 命名转换脚本
后续脚本会根据 ~/.routecodex/codex-samples 中的 provider-request/provider-response 文件，提取以下字段：
- 入口：根据 endpoint 判断（/v1/chat/completions → openai-chat）
- providerId：从 provider config 反查 key（如 glm）
- model：从 request body 中提取 model 字段
- 时间：从样本 timestamp 提取
- 序号：同一秒内递增

然后生成新的 reqId 并重命名文件到 samples/mock-provider/ 目录。
