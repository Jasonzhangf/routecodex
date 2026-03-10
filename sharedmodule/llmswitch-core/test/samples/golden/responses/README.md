# Responses协议金标样本集

## 样本分类

### 1. 基础对话样本 (Basic Conversation)
**文件**: `basic-responses-01.json`
- **目的**: 验证基本对话转换正确性
- **特征**: 简单的用户输入和助手回复
- **验证重点**:
  - messages字段正确映射
  - role字段保持一致
  - content字段完整传递

### 2. 工具调用样本 (Tool Calling)
**文件**: `tool-calling-responses-01.json`
- **目的**: 验证工具调用转换正确性
- **特征**: 包含多个工具定义和工具调用
- **验证重点**:
  - tools字段完整保留
  - tool_calls字段正确映射
  - function参数结构保持一致

### 3. 多轮对话样本 (Multi-turn Conversation)
**文件**: `multi-turn-responses-01.json`
- **目的**: 验证多轮对话上下文保持
- **特征**: 多轮用户和助手交互
- **验证重点**:
  - 消息顺序保持
  - 对话上下文完整
  - 引用关系正确

### 4. 流式响应样本 (Streaming Response)
**文件**: `streaming-responses-01.json`
- **目的**: 验证流式响应转换
- **特征**: 分块响应数据
- **验证重点**:
  - SSE事件格式正确
  - 分块序列保持
  - 流式完整性

### 5. 复杂工具调用样本 (Complex Tool Calling)
**文件**: `complex-tools-responses-01.json`
- **目的**: 验证复杂工具参数处理
- **特征**: 嵌套对象参数、多工具并行调用
- **验证重点**:
  - 复杂参数结构保持
  - 并行调用顺序
  - 错误处理

### 6. 边界情况样本 (Edge Cases)
**文件**: `edge-cases-responses-01.json`
- **目的**: 验证边界情况处理
- **特征**: 空输入、超长内容、特殊字符
- **验证重点**:
  - 错误处理正确
  - 特殊字符不丢失
  - 长内容截断处理

## 样本格式标准

### 请求格式
```json
{
  "sampleId": "unique-identifier",
  "name": "Sample Name",
  "type": "request|response",
  "protocol": "responses",
  "category": "basic|tools|streaming|edge-case",
  "payload": {
    // 标准Responses协议载荷
  },
  "metadata": {
    "description": "Sample description",
    "testFocus": ["focus-point-1", "focus-point-2"],
    "expectedStreaming": false,
    "expectedTools": ["tool1", "tool2"],
    "validationRules": [
      {
        "type": "field-check",
        "field": "messages",
        "rule": "non-empty"
      }
    ]
  }
}
```

### 响应格式
```json
{
  "sampleId": "unique-identifier",
  "name": "Sample Name",
  "type": "response",
  "protocol": "responses",
  "category": "basic|tools|streaming|edge-case",
  "payload": {
    // 标准Responses协议响应
  },
  "metadata": {
    "description": "Sample description",
    "testFocus": ["focus-point-1", "focus-point-2"],
    "isStreaming": false,
    "hasToolCalls": false,
    "validationRules": [
      {
        "type": "field-check",
        "field": "output",
        "rule": "non-empty"
      }
    ]
  }
}
```

## 验证规则定义

### 字段检查规则
```json
{
  "type": "field-check",
  "field": "field.name",
  "rule": "required|optional|type:string|type:number|non-empty"
}
```

### 自定义验证规则
```json
{
  "type": "custom",
  "implementation": "validateToolCalls",
  "parameters": {
    "expectedTools": ["tool1", "tool2"]
  }
}
```

### 语义验证规则
```json
{
  "type": "semantic",
  "rule": "conversation-flow",
  "parameters": {
    "minTurns": 2,
    "maxTurns": 10
  }
}
```

## 使用方法

### 单样本测试
```bash
node scripts/run-roundtrip-test.js --sample basic-responses-01.json
```

### 分类测试
```bash
node scripts/run-roundtrip-test.js --category tools
```

### 全量测试
```bash
node scripts/run-roundtrip-test.js --all
```

### 自定义配置
```bash
node scripts/run-roundtrip-test.js --config custom-test-config.yaml
```