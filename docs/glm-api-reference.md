# GLM API 参考文档

> 源文档：https://docs.bigmodel.cn/api-reference/模型-api/对话补全  
> 保存时间：2025年10月29日

## 概述

GLM（General Language Model）对话补全API支持多种模型，提供文本对话、工具调用、流式输出等功能。支持多模态输入输出，包括文本、图片、音频、视频和文件。

## API端点

```
POST https://open.bigmodel.cn/api/paas/v4/chat/completions
```

## 认证

```
Authorization: Bearer <token>
Content-Type: application/json
```

## 请求参数

### 基础调用示例

```bash
curl --request POST \
  --url https://open.bigmodel.cn/api/paas/v4/chat/completions \
  --header 'Authorization: Bearer <token>' \
  --header 'Content-Type: application/json' \
  --data '{
  "model": "glm-4.6",
  "messages": [
    {
      "role": "system",
      "content": "你是一个有用的AI助手。"
    },
    {
      "role": "user",
      "content": "请介绍一下人工智能的发展历程。"
    }
  ],
  "temperature": 1,
  "max_tokens": 65536,
  "stream": false
}'
```

### 参数详情

#### model (必需)
- **类型**: `enum<string>`
- **默认值**: `glm-4.6`
- **描述**: 调用的普通对话模型代码

**可用选项**:
- `glm-4.6` - 最新旗舰模型，专为智能体应用打造
- `glm-4.5` - 复杂推理、超长上下文
- `glm-4.5-air` - 轻量级版本
- `glm-4.5-x` - 增强版本
- `glm-4.5-airx` - 高性能轻量版本
- `glm-4.5-flash` - 快速响应版本
- `glm-4-plus` - GLM-4增强版本
- `glm-4-air-250414` - 2025年4月版本
- `glm-4-airx` - 高性能版本
- `glm-4-flashx` - 极速版本
- `glm-4-flashx-250414` - 2025年4月极速版本
- `glm-z1-air` - 推理专用轻量版本
- `glm-z1-airx` - 推理专用高性能版本
- `glm-z1-flash` - 推理专用快速版本
- `glm-z1-flashx` - 推理专用极速版本

#### messages (必需)
- **类型**: `(用户消息 · object | 系统消息 · object | 助手消息 · object | 工具消息 · object)[]`
- **描述**: 对话消息列表，包含完整的上下文信息
- **最小长度**: 1
- **注意**: 不能只包含系统消息或助手消息

**消息格式**:
```json
{
  "role": "user" | "system" | "assistant" | "tool",
  "content": "消息内容"
}
```

#### stream (可选)
- **类型**: `boolean`
- **默认值**: `false`
- **描述**: 是否启用流式输出模式
  - `false`: 一次性返回完整响应
  - `true`: 通过SSE流式返回内容，结束时返回 `data: [DONE]`

#### thinking (可选，GLM-4.5+支持)
- **类型**: `object`
- **描述**: 控制大模型是否开启思维链

```json
{
  "thinking": {
    "type": "enabled" | "disabled"
  }
}
```

#### do_sample (可选)
- **类型**: `boolean`
- **默认值**: `true`
- **描述**: 是否启用采样策略
  - `true`: 使用temperature、top_p等参数进行随机采样
  - `false`: 选择概率最高的词汇，忽略temperature和top_p

#### temperature (可选)
- **类型**: `number`
- **默认值**: 
  - GLM-4.6系列: 1.0
  - GLM-4.5系列: 0.6
  - GLM-Z1系列和GLM-4系列: 0.75
- **范围**: `0.0 <= x <= 1.0`
- **描述**: 采样温度，控制输出的随机性和创造性

#### top_p (可选)
- **类型**: `number`
- **默认值**: 
  - GLM-4.6/GLM-4.5系列: 0.95
  - GLM-Z1系列和GLM-4系列: 0.9
- **范围**: `0 < x <= 1.0`
- **描述**: 核采样参数，控制候选词汇范围

#### max_tokens (可选)
- **类型**: `integer`
- **范围**: `1 <= x <= 131072`
- **描述**: 模型输出的最大token数限制
  - GLM-4.6: 最大128K
  - GLM-4.5: 最大96K
  - GLM-Z1系列: 最大32K

#### tool_stream (可选)
- **类型**: `boolean`
- **描述**: 是否开启流式响应Function Calls，仅限GLM-4.6支持

#### tools (可选)
- **类型**: `Function Call · object[] | Retrieval · object[] | Web Search · object[] | MCP · object[]`
- **描述**: 模型可以调用的工具列表
- **最大数量**: 128个函数

**函数工具格式**:
```json
{
  "type": "function",
  "function": {
    "name": "函数名称",
    "description": "函数描述",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": ["必需参数"],
      "additionalProperties": true
    }
  }
}
```

#### tool_choice (可选)
- **类型**: `enum<string>`
- **默认值**: `auto`
- **描述**: 控制模型如何选择工具
- **可用选项**: `auto`

#### stop (可选)
- **类型**: `string[]`
- **最大长度**: 1
- **描述**: 停止词列表，遇到指定字符串时停止生成

#### response_format (可选)
- **类型**: `object`
- **描述**: 指定模型的响应输出格式

```json
{
  "response_format": {
    "type": "text" | "json_object"
  }
}
```

#### request_id (可选)
- **类型**: `string`
- **描述**: 请求唯一标识符，建议使用UUID格式

#### user_id (可选)
- **类型**: `string`
- **长度要求**: 6-128个字符
- **描述**: 终端用户的唯一标识符

## 响应格式

### 成功响应示例

```json
{
  "id": "<string>",
  "request_id": "<string>",
  "created": 123,
  "model": "<string>",
  "choices": [
    {
      "index": 123,
      "message": {
        "role": "assistant",
        "content": "<string>",
        "reasoning_content": "<string>",
        "audio": {
          "id": "<string>",
          "data": "<string>",
          "expires_at": "<string>"
        },
        "tool_calls": [
          {
            "function": {
              "name": "<string>",
              "arguments": {}
            },
            "mcp": {
              "id": "<string>",
              "type": "mcp_list_tools",
              "server_label": "<string>",
              "error": "<string>",
              "tools": [
                {
                  "name": "<string>",
                  "description": "<string>",
                  "annotations": {},
                  "input_schema": {
                    "type": "object",
                    "properties": {},
                    "required": ["<any>"],
                    "additionalProperties": true
                  }
                }
              ],
              "arguments": "<string>",
              "name": "<string>",
              "output": {}
            },
            "id": "<string>",
            "type": "<string>"
          }
        ]
      },
      "finish_reason": "<string>"
    }
  ],
  "usage": {
    "prompt_tokens": 123,
    "completion_tokens": 123,
    "prompt_tokens_details": {
      "cached_tokens": 123
    },
    "total_tokens": 123
  },
  "video_result": [
    {
      "url": "<string>",
      "cover_image_url": "<string>"
    }
  ],
  "web_search": [
    {
      "icon": "<string>",
      "title": "<string>",
      "link": "<string>",
      "media": "<string>",
      "publish_date": "<string>",
      "content": "<string>",
      "refer": "<string>"
    }
  ],
  "content_filter": [
    {
      "role": "<string>",
      "level": 123
    }
  ]
}
```

### 响应字段说明

#### choices
- **类型**: `object[]`
- **描述**: 模型响应列表

##### message
- **role**: 当前对话角色，默认为 `assistant`
- **content**: 当前对话文本内容
  - 对于GLM-Z1系列模型，可能包含思考过程标签 `<think> </think>`
  - 对于GLM-4.5V系列模型，可能包含文本边界标签 `<|begin_of_box|> <|end_of_box|>`
- **reasoning_content**: 思维链内容，仅在使用glm-4.5系列、glm-4.1v-thinking系列模型时返回
- **audio**: 当使用glm-4-voice模型时返回的音频内容
- **tool_calls**: 生成的应该被调用的函数名称和参数

##### finish_reason
推理终止原因：
- `stop`: 自然结束或触发stop词
- `tool_calls`: 模型命中函数
- `length`: 达到token长度限制
- `sensitive`: 内容被安全审核接口拦截
- `network_error`: 模型推理异常

#### usage
- **prompt_tokens**: 用户输入的Token数量
- **completion_tokens**: 输出的Token数量
- **total_tokens**: Token总数
  - 对于glm-4-voice模型，1秒音频=12.5 Tokens，向上取整

#### video_result
视频生成结果（当使用视频生成功能时）

#### web_search
返回与网页搜索相关的信息（当使用WebSearchToolSchema时）

#### content_filter
返回内容安全的相关信息
- **role**: 安全生效环节（assistant, user, history）
- **level**: 严重程度，0-3，0最严重，3轻微

## 流式输出

当`stream=true`时，使用Server-Sent Events (SSE)格式返回：

```
data: {"id":"","object":"chat.completion.chunk","created":1234567890,"model":"glm-4","choices":[{"index":0,"delta":{"content":"内容片段"},"finish_reason":null}]}

data: [DONE]
```

## 模型特性对比

| 模型系列 | 最大上下文 | 最大输出 | 工具调用 | 思考链 | 多模态 |
|---------|-----------|----------|----------|--------|--------|
| GLM-4.6 | 128K | 128K | ✅ 完整支持 | ✅ | ✅ |
| GLM-4.5 | 96K | 96K | ✅ Web搜索+知识库 | ✅ | ✅ |
| GLM-Z1 | 32K | 32K | ❌ | ✅ `<think>`标签 | ❌ |

## 使用建议

### 温度参数
- **创意写作**: temperature=0.8-1.0
- **代码生成**: temperature=0.2-0.4
- **事实问答**: temperature=0.1-0.3
- **翻译任务**: temperature=0.1-0.2

### 最大Token设置
- **短对话**: max_tokens=1024-2048
- **长文本**: max_tokens=4096-8192
- **代码生成**: max_tokens=4096-16384
- **文档总结**: max_tokens=8192-32768

### 工具调用最佳实践
1. 最多支持128个函数
2. 函数名称只能包含字母、数字、下划线和破折号
3. 函数名称最大长度64个字符
4. 参数必须符合JSON Schema规范

## 错误处理

### 常见错误码
- **1210**: 工具调用格式错误
- **1214**: 工具调用配对错误
- **sensitive**: 内容被安全审核拦截
- **network_error**: 模型推理异常

### 内容过滤
响应中的`content_filter`字段表示内容安全检查结果：
- `role=assistant`: 模型推理环节
- `role=user`: 用户输入环节  
- `role=history`: 历史上下文环节

## 相关文档

- [RouteCodex GLM兼容性文档（历史）](../src/providers/compat/glm-api.md)
- [GLM兼容性实现（已迁移至 sharedmodule/llmswitch-core/src/conversion/compat/）](../src/providers/compat/glm-compatibility.ts)
- [智谱AI官方文档](https://docs.bigmodel.cn/)

---

**文档版本**: v1.0.0  
**最后更新**: 2025-10-29  
**来源**: 智谱AI官方文档快照
