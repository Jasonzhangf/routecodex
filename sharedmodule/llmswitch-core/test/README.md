# LLMSwitch Core 回环测试框架（Legacy）

本目录保留了一套早期的回环测试 CLI，用于验证旧版协议栈与 SSE 行为。当前主线已经迁移到 Hub Pipeline + `src/sse/` 模块，以下内容仅作历史参考。

## 🎯 功能特性

- **协议验证**: 完整的 JSON Schema 验证，匹配旧版协议格式
- **流式验证**: SSE 事件序列和内容完整性验证
- **可插拔接收器**: 支持 LM Studio、Stub 和自定义接收器
- **Mock 客户端**: 真实 HTTP 请求模拟，包含请求录制功能
- **配置驱动**: YAML 配置文件驱动的验证规则和测试执行
- **CLI 工具**: 完整的命令行界面用于测试执行和报告生成

## 📁 项目结构

```
test/
├── cli/                          # CLI 执行器
│   └── roundtrip-test-cli.ts    # 主 CLI 程序
├── config/                       # 配置管理
│   └── rule-loader.ts           # 规则加载器
├── mock/                         # Mock 客户端
│   └── realistic-mock-client.ts # 真实请求模拟客户端
├── receivers/                    # 接收器层
│   └── pluggable-receiver.ts    # 可插拔接收器
├── validation/                   # 验证器
│   └── schema-validator.js      # Schema 验证器
├── validation-rules/             # 验证规则配置
│   ├── responses-validation.yaml
│   └── streaming-validation.yaml
├── samples/golden/              # 金标样本
│   ├── responses/
│   └── chat/
└── package.json                 # 项目配置
```

## 🚀 快速开始

### 安装依赖

```bash
cd test
npm install
```

### 构建项目

```bash
npm run build
```

### 运行所有测试

```bash
npm run test
```

### 列出可用测试

```bash
npm run test:list
```

### 运行单个测试

```bash
npm start test basic-responses-01
```

## 📖 使用指南

### CLI 命令

#### 运行测试

```bash
# 运行所有测试
roundtrip-test run

# 并行运行
roundtrip-test run --parallel

# 过滤测试
roundtrip-test run --filter "streaming"

# 生成报告
roundtrip-test run --output custom-report.json

# 详细输出
roundtrip-test run --verbose
```

#### 列出测试样本

```bash
roundtrip-test list
```

#### 运行单个测试

```bash
roundtrip-test test basic-responses-01
```

### 自定义验证规则

在 `validation-rules/` 目录下创建 YAML 文件定义规则：

```yaml
name: "Custom Validation Rules"
version: "1.0.0"
rules:
  - name: "custom-field-check"
    description: "Custom field validation"
    enabled: true
    severity: "error"
    ruleType: "field-check"
    parameters:
      field: "required_field"
      rule: "required"

  - name: "custom-validation"
    description: "Custom validation logic"
    enabled: true
    severity: "warning"
    ruleType: "custom"
    implementation: "validateCustomFunction"
```

### 自定义接收器

```typescript
import { ReceiverFactory } from './receivers/pluggable-receiver.js';

// 创建 LM Studio 接收器
const receiver = ReceiverFactory.createLMStudio(
  'http://localhost:5506',
  'your-api-key',
  { timeoutMs: 60000 }
);

// 创建 Stub 接收器
const stubReceiver = ReceiverFactory.createStub({
  debugMode: true
});
```

## 🧪 测试样本格式

### Responses 协议样本

```json
{
  "sampleId": "basic-responses-01",
  "name": "基础 Responses 请求",
  "type": "request",
  "protocol": "responses",
  "category": "basic",
  "payload": {
    "model": "gpt-4",
    "input": [
      {
        "role": "user",
        "content": [
          {
            "type": "input_text",
            "text": "Hello, world!"
          }
        ]
      }
    ],
    "max_output_tokens": 100,
    "stream": false
  },
  "metadata": {
    "description": "测试基础 Responses 协议格式",
    "testFocus": ["basic-protocol", "field-preservation"]
  }
}
```

## 📊 报告格式

生成的测试报告包含：

```json
{
  "summary": {
    "total": 10,
    "passed": 9,
    "failed": 1,
    "skipped": 0,
    "successRate": 90.0,
    "totalTime": 1500
  },
  "results": [
    {
      "sampleId": "basic-responses-01",
      "testName": "基础 Responses 请求",
      "protocol": "responses",
      "status": "passed",
      "errors": [],
      "warnings": [],
      "metrics": {
        "requestTime": 50,
        "responseTime": 200,
        "processingTime": 30,
        "totalTime": 280
      }
    }
  ],
  "generatedAt": "2025-01-23T10:30:00.000Z"
}
```

## 🔧 开发指南

### 添加新的验证规则

1. 在 `schema-validator.js` 中实现规则逻辑
2. 在 `rule-loader.ts` 中注册规则
3. 在验证规则 YAML 文件中配置规则

### 添加新的接收器类型

1. 在 `pluggable-receiver.ts` 中实现 `Receiver` 接口
2. 在 `ReceiverFactory` 中添加创建方法
3. 更新配置文件中的类型定义

### 扩展 Mock 客户端

1. 在 `realistic-mock-client.ts` 中添加新功能
2. 更新 `RequestRecorder` 以支持新的录制需求
3. 扩展 SSE 解析逻辑

## 🐛 故障排除

### 常见问题

1. **Schema 验证失败**: 检查样本是否匹配旧协议格式
2. **连接错误**: 确认接收器服务正在运行
3. **规则加载失败**: 检查 YAML 语法和文件路径

### 调试模式

在配置文件中启用 `debugMode: true` 获取详细日志：

```yaml
receivers:
  default:
    type: stub
    debugMode: true
```

### 环境变量

```bash
export DEBUG=roundtrip-test
export NODE_ENV=development
```

## 📝 许可证

MIT License - 详见 LICENSE 文件

## 🤝 贡献

欢迎提交 Issue 和 Pull Request 来改进测试框架。

## 📞 支持

如有问题，请创建 GitHub Issue 或联系开发团队。
