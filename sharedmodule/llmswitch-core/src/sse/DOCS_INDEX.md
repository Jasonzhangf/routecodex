# SSE双向转换模块文档索引

## 📖 文档导航

本文档提供了SSE双向转换模块的完整文档导航，按推荐的阅读顺序组织，帮助您快速了解和使用模块。

### 🚀 快速开始（推荐阅读顺序）

1. **[README.md](./README.md)** - 模块总览和快速入门
   - Chat + Responses统一抽象概述
   - 基本使用示例
   - 文件结构总览

2. **[ARCHITECTURE.md](./ARCHITECTURE.md)** - 架构设计原理
   - 统一抽象与分层架构
   - 接口设计建议
   - 核心约束和设计决策

3. **[IMPLEMENTATION_GUIDE.md](./IMPLEMENTATION_GUIDE.md)** - 实现指南
   - 代码组织和命名规范
   - 核心实现要点
   - 最佳实践和陷阱避免

### 🏗️ 技术深度文档

4. **[TEST_PLAN.md](./TEST_PLAN.md)** - 测试策略和计划
   - 回环测试设计
   - 等价性定义
   - 边界用例和验证方法

5. **[ROADMAP.md](./ROADMAP.md)** - 发展路线图
   - 阶段目标和里程碑
   - 最小修复列表
   - 中长期规划

6. **[SSE_IMPLEMENTATION_DATA_ASSESSMENT.md](./SSE_IMPLEMENTATION_DATA_ASSESSMENT.md)** - 数据评估报告
   - 实验数据分析
   - 实现可行性评估
   - 已知问题和修复建议

### 📚 协议专用文档

7. **[README-RESPONSES.md](./README-RESPONSES.md)** - Responses协议专用文档
   - Responses协议详细说明
   - 15种事件类型完整列表
   - 与Chat协议对比分析

## 🎯 按角色阅读建议

### 📝 新手入门
```
README.md → README-RESPONSES.md → 快速示例
```

### 🏛️ 架构师/技术决策者
```
README.md → ARCHITECTURE.md → ROADMAP.md → SSE_IMPLEMENTATION_DATA_ASSESSMENT.md
```

### 👨‍💻 开发者
```
README.md → IMPLEMENTATION_GUIDE.md → TEST_PLAN.md → README-RESPONSES.md
```

### 🧪 测试工程师
```
TEST_PLAN.md → README.md → IMPLEMENTATION_GUIDE.md → ROADMAP.md
```

### 🔧 运维工程师
```
ARCHITECTURE.md → IMPLEMENTATION_GUIDE.md → README-RESPONSES.md
```

## 📂 相关文件快速定位

### 核心实现文件
- **Chat转换器**: `json-to-sse/chat-json-to-sse-converter.ts`
- **Responses转换器**: `json-to-sse/responses-json-to-sse-converter.ts`
- **Chat聚合器**: `sse-to-json/chat-sse-to-json-converter.ts`
- **Responses聚合器**: `sse-to-json/responses-sse-to-json-converter.ts`

### 类型定义文件
- **统一类型**: `types/index.ts`
- **Chat专用类型**: `types/chat-types.ts`
- **Responses专用类型**: `types/responses-types.ts`

### 测试文件
- **单元测试**: `test/chat-converter.test.ts`, `test/responses-converter.test.ts`
- **回环测试脚本**: `../../scripts/test-chat-roundtrip.mjs`, `../../scripts/test-responses-roundtrip.mjs`
- **演示脚本**: `../../scripts/demo-complete-sse-conversion.mjs`

### 实验数据目录
- **Chat黄金样例**: `~/.routecodex/codex-samples/openai-chat/`
- **Responses黄金样例**: `~/.routecodex/codex-samples/openai-responses/`

## 🔍 快速查找

### 按主题查找

| 主题 | 相关文档 | 核心文件 |
|------|----------|----------|
| **架构设计** | ARCHITECTURE.md | `types/`, `index.ts` |
| **API接口** | README.md, README-RESPONSES.md | 各converter文件 |
| **测试方法** | TEST_PLAN.md | `test/`, 脚本文件 |
| **性能优化** | IMPLEMENTATION_GUIDE.md | 各converter核心逻辑 |
| **错误处理** | IMPLEMENTATION_GUIDE.md, ARCHITECTURE.md | 异常处理相关代码 |
| **协议对比** | README-RESPONSES.md | 协议转换相关代码 |
| **配置选项** | README.md, IMPLEMENTATION_GUIDE.md | 各Options接口 |
| **事件类型** | README-RESPONSES.md, SSE_IMPLEMENTATION_DATA_ASSESSMENT.md | types/目录 |

### 按问题类型查找

| 问题类型 | 建议文档 | 解决方案位置 |
|----------|----------|--------------|
| **如何开始使用** | README.md | 快速示例部分 |
| **理解事件流程** | ARCHITECTURE.md, README-RESPONSES.md | 事件序列图 |
| **调试转换问题** | TEST_PLAN.md, IMPLEMENTATION_GUIDE.md | 测试脚本和日志 |
| **性能调优** | IMPLEMENTATION_GUIDE.md | 配置选项和优化建议 |
| **集成到现有系统** | ARCHITECTURE.md, ROADMAP.md | 集成策略和feature flag |
| **实现新协议** | ARCHITECTURE.md, IMPLEMENTATION_GUIDE.md | 协议适配器模式 |

## 📋 检查清单

### ✅ 开发前检查
- [ ] 已阅读ARCHITECTURE.md，理解统一抽象设计
- [ ] 已查看IMPLEMENTATION_GUIDE.md，了解代码规范
- [ ] 已确认TEST_PLAN.md中的测试策略

### ✅ 开发中检查
- [ ] 遵循IMPLEMENTATION_GUIDE.md中的命名规范
- [ ] 实现了完整的错误处理
- [ ] 添加了相应的单元测试
- [ ] 更新了相关文档

### ✅ 发布前检查
- [ ] 所有测试通过（TEST_PLAN.md）
- [ ] 性能指标达到要求
- [ ] 文档更新完整
- [ ] 符合ARCHITECTURE.md中的设计约束

## 🆘 获取帮助

### 常见问题快速解答
1. **Q: Chat和Responses协议的主要区别？**
   - A: 参见README-RESPONSES.md中的协议对比表

2. **Q: 如何调试转换错误？**
   - A: 参见TEST_PLAN.md中的调试策略和脚本

3. **Q: 事件序列不正确怎么办？**
   - A: 参见IMPLEMENTATION_GUIDE.md中的事件处理规范

4. **Q: 性能优化建议？**
   - A: 参见IMPLEMENTATION_GUIDE.md中的性能章节

### 联系方式
- 技术问题：查看各文档中的相关章节
- 文档问题：提交Issue到文档仓库
- 功能请求：参考ROADMAP.md中的规划

---

**📌 提示**: 建议按照"快速开始"部分的顺序阅读文档，这样能够建立完整的认知框架，然后再根据具体需求深入相关技术文档。
