# CLI 命令模块

## 概述

CLI 命令模块包含 RouteCodex 的所有命令行工具实现，为用户提供了完整的系统管理接口。

## 可用命令

#### `dry-run` 命令

提供配置验证和测试功能：

```bash
# 试运行配置验证
routecodex dry-run

# 指定配置文件试运行
routecodex dry-run --config path/to/config.json

# 启用详细输出
routecodex dry-run --verbose
```

**功能特性**：
- 配置文件验证
- 流水线初始化测试
- 连接性检查
- 性能基准测试

## 架构设计

### 命令结构

```
commands/
└── dry-run.ts        # 试运行和验证
```

### 核心组件

1. **Commander.js 集成**
   - 使用 Commander.js 框架构建 CLI
   - 统一的命令参数处理
   - 自动生成帮助信息

2. **状态管理**
   - 配置状态跟踪
   - 运行时监控
   - 错误处理

## 使用示例

```bash
# 基本配置验证
routecodex dry-run

# 完整系统测试
routecodex dry-run --full-system

# 性能测试
routecodex dry-run --performance
```

## 扩展开发

### 添加新命令

1. 在 `commands/` 目录创建新的命令文件
2. 实现 Command 接口
3. 在主 CLI 文件中注册命令
4. 添加相应的测试用例

### 命令模板

```typescript
import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';

export const createMyCommand = (): Command => {
  const command = new Command('my-command')
    .description('我的命令描述')
    .option('-v, --verbose', '详细输出')
    .action(async (options) => {
      const spinner = ora('处理中...').start();

      try {
        // 命令逻辑
        spinner.succeed('完成');
      } catch (error) {
        spinner.fail('失败');
        console.error(chalk.red('错误:'), error);
      }
    });

  return command;
};
```

## 配置和选项

### 全局选项

- `--config, -c`: 指定配置文件路径
- `--verbose, -v`: 启用详细输出
- `--quiet, -q`: 静默模式
- `--help, -h`: 显示帮助信息

### 命令特定选项

每个命令都有其特定的选项，请使用 `--help` 查看详细信息。

## 错误处理

### 错误类型

1. **配置错误**
   - 配置文件不存在
   - 配置格式错误
   - 缺少必要参数

2. **运行时错误**
   - 连接失败
   - 权限问题
   - 资源不足

3. **用户输入错误**
   - 无效参数
   - 格式错误
   - 范围超出

### 错误处理策略

- 提供清晰的错误信息
- 建议解决方案
- 适当的退出码
- 详细的日志记录

## 最佳实践

### 命令设计

1. **一致性**: 保持命令和参数命名一致
2. **可读性**: 使用清晰的描述和帮助信息
3. **容错性**: 处理各种异常情况
4. **性能**: 避免不必要的资源消耗

### 用户体验

1. **进度反馈**: 使用 spinner 显示进度
2. **颜色编码**: 使用 chalk 库增强可读性
3. **结构化输出**: JSON 或表格格式输出
4. **交互确认**: 危险操作需要确认

## 调试和测试

### 调试模式

```bash
# 启用调试输出
DEBUG=* routecodex my-command

# 详细日志
routecodex my-command --verbose --debug
```

### 测试

```bash
# 运行命令测试
npm test -- commands

# 集成测试
npm run test:integration
```

## 相关依赖

- **commander**: CLI 框架
- **chalk**: 终端颜色输出
- **ora**: 终端 loading 效果
- **fs**: 文件系统操作
- **path**: 路径处理

## 文档

- [RouteCodex 主文档](../../README.md)
- [CLI 使用指南](../../docs/cli.md)
- [配置文档](../../docs/configuration.md)
