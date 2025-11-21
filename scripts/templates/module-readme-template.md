<!-- 
  模块README模板 - 基于AGENTS.md的函数化、原子化、独立化开发方法论
  使用方法: cp scripts/templates/module-readme-template.md path/to/module/README.md
  然后根据具体模块功能填写相应内容
-->

# {MODULE_NAME}

## 模块职责

<!-- 明确描述模块的核心功能和职责边界 -->
该模块负责：
- [ ] 功能1：简要描述
- [ ] 功能2：简要描述
- [ ] 功能3：简要描述

**边界定义**：
- ✅ 包含：明确列出模块负责的功能范围
- ❌ 不包含：明确列出不属于模块职责的内容

## 依赖关系

### 外部依赖
<!-- 列出所有外部依赖模块和包 -->
- `module-name`: 依赖原因和使用方式
- `package-name`: 版本要求和用途

### 被依赖关系
<!-- 列出哪些模块依赖此模块 -->
- `dependent-module`: 依赖的功能点
- `another-module`: 依赖的功能点

### 循环依赖检查
- [ ] 确认无循环依赖
- [ ] 依赖关系图验证通过

## 接口定义

### 主要函数/类

<!-- 列出模块对外提供的主要接口 -->

#### `functionName(param1: Type1, param2: Type2): ReturnType`

**功能描述**：简要说明函数作用

**参数说明**：
- `param1`: 参数1说明
- `param2`: 参数2说明

**返回值**：返回值说明

**异常处理**：可能抛出的异常和处理方式

**使用示例**：
```typescript
const result = functionName(param1Value, param2Value);
console.log(result);
```

### 类型定义

```typescript
// 主要的类型定义
export interface ModuleConfig {
  property1: string;
  property2: number;
}

export type ModuleState = 'idle' | 'processing' | 'completed';
```

## 使用示例

### 基础用法

```typescript
import { ModuleClass, ModuleConfig } from './index.js';

const config: ModuleConfig = {
  property1: 'value1',
  property2: 42
};

const module = new ModuleClass(config);
await module.initialize();
```

### 高级用法

```typescript
// 展示高级功能和配置选项
const advancedConfig = {
  ...config,
  advancedOption: true
};

const module = new ModuleClass(advancedConfig);
const result = await module.processComplexInput(data);
```

## 测试指南

### 运行测试

```bash
# 单元测试
npm test -- --grep "module-name"

# 集成测试
npm run test:integration -- --grep "module-name"

# 覆盖率测试
npm run test:coverage -- --grep "module-name"
```

### 编写测试

测试文件命名规范：`{module-name}.test.ts`

测试结构模板：
```typescript
describe('{ModuleName}', () => {
  describe('functionName', () => {
    it('should handle normal case', async () => {
      // 测试正常情况
    });

    it('should handle edge case', async () => {
      // 测试边界情况
    });

    it('should throw error for invalid input', async () => {
      // 测试异常情况
    });
  });
});
```

### 测试覆盖率要求
- 函数覆盖率：100%
- 分支覆盖率：>90%
- 行覆盖率：>95%

## 功能清单

<!-- 记录模块提供的所有功能，便于复用检查 -->

### 已实现功能
- [ ] `function1`: 功能描述 (实现日期: YYYY-MM-DD)
- [ ] `function2`: 功能描述 (实现日期: YYYY-MM-DD)
- [ ] `function3`: 功能描述 (实现日期: YYYY-MM-DD)

### 规划中功能
- [ ] `future-function1`: 功能描述 (计划版本: vX.X.X)
- [ ] `future-function2`: 功能描述 (计划版本: vX.X.X)

## 设计决策

### 架构选择
<!-- 记录重要的架构设计决策和原因 -->
- **决策1**: 选择原因和考虑因素
- **决策2**: 替代方案的对比和选择理由

### 性能考虑
- 时间复杂度：O(n)
- 空间复杂度：O(1)
- 性能瓶颈点：分析潜在瓶颈

### 安全考虑
- 输入验证：验证策略和实现
- 错误处理：敏感信息保护
- 权限控制：访问控制机制

## 变更记录

### v{CURRENT_VERSION} - {DATE}
<!-- 记录当前版本的重要变更 -->
- **新增**: 功能1的描述
- **改进**: 性能优化或bug修复
- **破坏性变更**: 如有，详细说明影响和迁移指南
- **废弃**: 如有功能被废弃，说明替代方案

### 历史版本
- v{PREV_VERSION} - {DATE}: 变更描述
- v{PREV_VERSION} - {DATE}: 变更描述

## 故障排除

### 常见问题

**问题1**: 问题描述
**原因**: 根本原因分析
**解决方案**: 解决步骤

**问题2**: 问题描述
**原因**: 根本原因分析
**解决方案**: 解决步骤

### 调试技巧
- 启用调试模式：`DEBUG=module:* node script.js`
- 日志分析：关键日志模式
- 性能分析：使用 `performance.now()` 测量关键路径

## 贡献指南

### 开发流程
1. 阅读AGENTS.md中的开发方法论
2. 扫描现有功能，避免重复开发
3. 创建功能分支：`git checkout -b feature/new-function`
4. 先更新README，再实现代码
5. 编写测试，确保覆盖率达标
6. 提交PR，等待code review

### 代码规范
- 遵循函数化、原子化、独立化原则
- 单个文件不超过500行
- 单个函数不超过50行
- 函数参数不超过5个
- 嵌套层级不超过3层
- 圈复杂度不超过10

### 复用检查清单
- [ ] 已扫描现有代码库确认功能不存在
- [ ] 已检查相关模块是否有类似实现
- [ ] 已咨询团队了解现有解决方案
- [ ] 新功能无法通过扩展现有功能实现
- [ ] 已在模块README中记录功能清单

---

*该README遵循AGENTS.md中定义的函数化、原子化、独立化开发方法论*
*最后更新: {DATE}*
*维护者: {MAINTAINER}*
