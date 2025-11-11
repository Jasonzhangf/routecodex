# V1/V2功能对齐测试工具

## 概述

这套工具用于验证RouteCodex V1和V2架构的功能一致性，确保两个版本在处理相同输入时产生一致的输出。

## 工具组成

### 1. 核心测试组件
- **SnapshotLoader**: 加载和管理快照数据
- **ConsistencyValidator**: 执行一致性验证逻辑
- **V1V2ConsistencyTest**: 主测试协调器

### 2. 测试类型
- **工具处理测试**: 验证工具调用收割、规范化和治理的一致性
- **协议转换测试**: 验证OpenAI ↔ Anthropic ↔ Responses协议转换
- **V1/V2对齐测试**: 验证两个版本的端到端一致性

### 3. 执行脚本
- `run-consistency-test.mjs`: 单独运行V1/V2对齐测试
- `comprehensive-consistency-test.mjs`: 运行所有测试的综合脚本
- `generate-snapshot-data.mjs`: 生成测试所需的快照数据

## 使用方法

### 基本用法

```bash
# 运行所有协议的一致性测试
npm run test:consistency

# 运行特定协议测试
npm run test:consistency openai-chat 10

# 运行综合测试（包含所有测试类型）
pm run test:comprehensive

# 生成快照数据并测试
npm run test:comprehensive --generate-snapshots
```

### 高级选项

```bash
# 跳过特定测试类型
npm run test:comprehensive --skip-tool-processing
npm run test:comprehensive --skip-protocol-conversion
npm run test:comprehensive --skip-v1v2-alignment

# 限制测试用例数量
npm run test:comprehensive --max-cases=5
```

## 测试报告

### 输出格式

测试完成后会生成详细的JSON报告，包含：
- 测试摘要统计
- 失败详情和差异分析
- 分类一致性率
- 改进建议

### 退出码

- `0`: 所有测试通过
- `1`: 发现关键错误
- `2`: 发现重要错误
- `3`: 测试执行失败

## 数据结构

### 快照数据

快照数据存储在 `~/.routecodex/codex-samples/` 目录下，按协议组织：
- `openai-chat/`: OpenAI Chat协议快照
- `anthropic-messages/`: Anthropic Messages协议快照
- `openai-responses/`: OpenAI Responses协议快照

### V1/V2数据对比

- **V1数据**: 包含compat-pre、compat-post等处理阶段数据
- **V2数据**: 包含workflow、provider request/response等阶段数据
- **对比维度**: Provider请求、Provider响应、工具处理、最终响应

## 配置选项

### 忽略字段

默认忽略以下字段进行比较：
- `created`, `created_at`, `timestamp`: 时间戳
- `request_id`, `id`: 标识符
- `meta.buildTime`, `meta.version`: 构建信息

### 容差设置

- 时间差异容差: 5秒
- 数值精度容差: 6位小数

## 扩展性

### 添加新的验证规则

在 `ConsistencyValidator` 类中添加新的验证方法：

```typescript
private validateNewAspect(
  v1Data: V1ProcessingData,
  v2Data: V2ProcessingData
): ConsistencyCheck {
  // 实现新的验证逻辑
}
```

### 添加新的协议支持

1. 在 `SnapshotLoader` 中添加协议特定加载逻辑
2. 更新类型定义文件
3. 添加相应的测试用例

## 故障排除

### 常见问题

1. **模块找不到错误**: 确保已运行 `npm run build`
2. **快照数据缺失**: 运行 `--generate-snapshots` 选项
3. **TypeScript编译错误**: 检查类型定义和导入路径

### 调试技巧

- 使用 `--help` 查看所有选项
- 检查 `test-results/` 目录下的报告文件
- 查看控制台输出的详细错误信息

## 贡献指南

1. 遵循现有的代码结构和命名约定
2. 添加适当的类型定义
3. 编写对应的测试用例
4. 更新文档说明

## 维护说明

- 定期更新忽略字段列表以适应新的数据结构
- 根据架构演进调整验证逻辑
- 监控测试覆盖率并补充缺失的测试场景
