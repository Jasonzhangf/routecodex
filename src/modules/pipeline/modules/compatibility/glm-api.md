# GLM API 参考文档

本文档描述了智谱AI（GLM）模型的API接口，包括对话补全、参数配置、响应格式等详细信息。

## 📋 概述

GLM（General Language Model）是智谱AI开发的大语言模型系列，支持多种任务类型，包括对话、代码生成、推理等。RouteCodex通过`glm-compatibility`模块提供对GLM模型的完整支持。

## 🎯 支持的模型

### GLM-4.6 系列
- **glm-4.6**: 最新旗舰模型，专为智能体应用打造
- **glm-4.5**: 复杂推理、超长上下文支持
- **glm-4.5-air**: 轻量级版本，平衡性能和成本
- **glm-4.5-x**: 增强版本，支持更复杂的任务
- **glm-4.5-airx**: 高性能轻量版本
- **glm-4.5-flash**: 快速响应版本

### GLM-4 系列
- **glm-4-plus**: 增强版本
- **glm-4-air-250414**: 2025年4月版本
- **glm-4-airx**: 高性能版本
- **glm-4-flashx**: 极速版本
- **glm-4-flashx-250414**: 2025年4月极速版本

### GLM-Z1 系列
- **glm-z1-air**: 推理专用轻量版本
- **glm-z1-airx**: 推理专用高性能版本
- **glm-z1-flash**: 推理专用快速版本
- **glm-z1-flashx**: 推理专用极速版本

## 🔧 API端点

### 对话补全
```
POST https://open.bigmodel.cn/api/paas/v4/chat/completions
```

### 认证方式
```
Authorization: Bearer <your-api-key>
Content-Type: application/json
```

## 📨 请求参数

### 基础参数

| 参数 | 类型 | 必需 | 默认值 | 描述 |
|------|------|------|--------|------|
| `model` | string | ✅ | - | 模型名称，详见支持的模型列表 |
| `messages` | array | ✅ | - | 对话消息列表 |
| `stream` | boolean | ❌ | false | 是否启用流式输出 |
| `temperature` | number | ❌ | 1.0 | 采样温度，范围[0.0, 1.0] |
| `top_p` | number | ❌ | 0.95 | 核采样参数，范围(0.0, 1.0] |
| `max_tokens` | integer | ❌ | - | 最大输出token数 |
| `do_sample` | boolean | ❌ | true | 是否启用采样策略 |

### 消息格式

#### 用户消息
```json
{
  "role": "user",
  "content": "用户输入的文本内容"
}
```

#### 系统消息
```json
{
  "role": "system",
  "content": "系统设定内容"
}
```

#### 助手消息
```json
{
  "role": "assistant",
  "content": "助手回复内容"
}
```

#### 工具消息
```json
{
  "role": "tool",
  "content": "工具返回结果",
  "tool_call_id": "工具调用ID"
}
```

### 思考链配置（GLM-4.5+）

```json
{
  "thinking": {
    "type": "enabled" | "disabled"
  }
}
```

### 工具调用

#### 函数工具
```json
{
  "tools": [{
    "type": "function",
    "function": {
      "name": "函数名称",
      "description": "函数描述",
      "parameters": {
        "type": "object",
        "properties": {
          "参数名": {
            "type": "string",
            "description": "参数描述"
          }
        },
        "required": ["必需参数"]
      }
    }
  }]
}
```

#### 工具选择
```json
{
  "tool_choice": "auto"
}
```

### 输出格式

```json
{
  "response_format": {
    "type": "text" | "json_object"
  }
}
```

### 停止词

```json
{
  "stop": ["停止词1", "停止词2"]
}
```

## 📤 响应格式

### 成功响应

```json
{
  "id": "任务ID",
  "request_id": "请求ID",
  "created": 1234567890,
  "model": "使用的模型名称",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "回复内容",
        "reasoning_content": "思考内容（可选）",
        "tool_calls": [
          {
            "id": "调用ID",
            "type": "function",
            "function": {
              "name": "函数名称",
              "arguments": "{"参数": "值"}"
            }
          }
        ]
      },
      "finish_reason": "stop" | "tool_calls" | "length" | "sensitive" | "network_error"
    }
  ],
  "usage": {
    "prompt_tokens": 100,
    "completion_tokens": 50,
    "total_tokens": 150,
    "prompt_tokens_details": {
      "cached_tokens": 0
    }
  }
}
```

### 流式响应

流式响应使用Server-Sent Events (SSE)格式：

```
data: {"id":"","object":"chat.completion.chunk","created":1234567890,"model":"glm-4","choices":[{"index":0,"delta":{"content":"内容片段"},"finish_reason":null}]}

data: [DONE]
```

## 🛠️ 兼容性处理

RouteCodex的`glm-compatibility`模块处理以下兼容性问题：

### 思考内容处理
- **输入**: 自动添加`thinking`参数到GLM-4.5+模型
- **输出**: 清理私有的`<think>...</think>`标签
- **配置**: 支持按模型配置思考功能

### 工具调用兼容
- 格式转换: OpenAI 工具格式 ↔ GLM 工具格式（仅做最小必要的字段规范化，不做语义改写）
- 历史保留: 不再清理历史工具调用，避免模型遗忘或重复调用（此前为规避 1210/1214 的做法已废弃）
- 空值规整: 仅规范当前轮的字段类型（如 function.arguments 字符串化），不会删除历史消息
- 错误处理: 针对 GLM 返回格式差异（如 reasoning_content、usage 字段）做最小修复

### 消息清理
- **空消息删除**: 删除无内容且无工具调用的消息
- **系统消息**: 保留系统消息用于行为设定
- **工具历史**: 仅在“发送前”保留最近一轮的 `assistant.tool_calls`，并将该条 `content=null`；不清理 `role:tool` 历史、不删除早期助手消息（仅移除其 `tool_calls` 字段）。该规范为默认策略，无需任何开关。

### 响应标准化
- **格式转换**: GLM响应格式 → OpenAI标准格式
- **字段映射**: `created_at` → `created`等
- **使用统计**: `output_tokens` → `completion_tokens`

## 🔍 模型特性

### GLM-4.6特性
- **最大上下文**: 128K tokens
- **工具调用**: 完整支持，最多128个函数
- **流式输出**: 支持工具调用的流式响应
- **多模态**: 支持文本、图像、音频、视频
- **推理能力**: 支持复杂推理任务

### GLM-4.5特性
- **最大上下文**: 96K tokens
- **思考链**: 支持可配置的思考过程
- **工具支持**: 支持Web搜索和知识库检索
- **推理优化**: 针对推理任务优化

### GLM-Z1特性
- **推理专用**: 专为推理任务设计
- **最大输出**: 32K tokens
- **思考标签**: 在content中使用`<think>`标签

## 📊 性能参数

### 温度参数建议
- **创意写作**: temperature=0.8-1.0
- **代码生成**: temperature=0.2-0.4
- **事实问答**: temperature=0.1-0.3
- **翻译任务**: temperature=0.1-0.2

### 最大Token建议
- **短对话**: max_tokens=1024-2048
- **长文本**: max_tokens=4096-8192
- **代码生成**: max_tokens=4096-16384
- **文档总结**: max_tokens=8192-32768

## ⚠️ 注意事项

### 消息顺序要求
- 不能只包含系统消息或助手消息
- 用户消息和助手消息必须交替出现
- 工具消息必须跟在对应的助手消息之后

### 工具调用限制
- 最多支持128个函数工具
- 函数名称只能包含字母、数字、下划线和破折号
- 函数名称最大长度64个字符
- 参数必须符合JSON Schema规范

### 内容过滤
- 响应可能包含`content_filter`字段
- `level 0-3`表示严重程度，0最严重
- 可能涉及用户输入、模型推理、历史上下文

## 🔧 环境变量

RouteCodex 支持有限的兼容性环境变量；与“工具历史清理”相关的开关已废弃：

```bash
# 强制禁用思考功能（可选）
export RCC_GLM_DISABLE_THINKING=1

# 已废弃：历史工具清理相关开关（不再需要）
# export RCC_GLM_TRIM_TOOL_HISTORY=1
# export RCC_GLM_TRIM_TOOL_KEEP_LAST_TOOL=3
# export RCC_GLM_TRIM_TOOL_KEEP_LAST_ASSIST=1

# 推理内容策略：auto|strip|preserve（保留，用于响应侧思考内容策略）
export RCC_REASONING_POLICY=auto
```

## 📈 错误码

### 常见错误
- **1210**: 工具调用格式错误
- **1214**: 工具调用配对错误
- **empty_prompt_after_cleanup**: 清理后消息为空
- **sensitive**: 内容被安全审核拦截
- **network_error**: 模型推理异常

### 处理建议
1. 验证消息格式和顺序
2. 检查工具调用格式
3. 确保内容符合使用规范
4. 适当调整参数配置

## 🔗 相关文档

- [GLM兼容性实现](../glm-compatibility.ts)
- [兼容性模块README](./README.md)
- [RouteCodex配置指南](../../../docs/CONFIG_ARCHITECTURE.md)
- [智谱AI官方文档](https://docs.bigmodel.cn/)

---

**最后更新**: 2025-10-29
**文档版本**: v1.0.0
**兼容性版本**: RouteCodex >= 0.2.7
