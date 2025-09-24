# RouteCodex 离线记录 CLI 配置指南

## 概述

RouteCodex 提供了完整的 CLI 工具来配置和管理离线日志记录，支持模块级和流水线级的离线日志捕获，无需运行可视化Web界面。

## 安装和设置

### 基本命令结构

```bash
routecodex offline-log <command> [options]
# 或简写
routecodex olog <command> [options]
```

## 核心命令

### 1. 启用/禁用离线记录

```bash
# 启用离线记录
routecodex offline-log enable \
  --level detailed \
  --directory ./logs \
  --max-size 50 \
  --max-files 10 \
  --compression

# 启用所有模块记录
routecodex offline-log enable --all-modules --pipeline

# 禁用离线记录
routecodex offline-log disable
```

### 2. 模块级配置

```bash
# 配置特定模块
routecodex offline-log module \
  --name processor \
  --enable \
  --level detailed \
  --performance \
  --stack-traces \
  --sensitive "password,token,apiKey"

# 禁用模块记录
routecodex offline-log module --name processor --disable

# 查看模块配置
routecodex offline-log module --name processor --show
```

### 3. 流水线级配置

```bash
# 启用流水线记录
routecodex offline-log pipeline \
  --enable \
  --level detailed \
  --capture-requests \
  --capture-responses \
  --capture-errors \
  --capture-performance

# 禁用流水线记录
routecodex offline-log pipeline --disable
```

### 4. 日志分析

```bash
# 分析日志文件
routecodex offline-log analyze \
  --directory ./logs \
  --output ./analysis.json \
  --format json \
  --modules "processor,transformer" \
  --start "2024-01-01" \
  --end "2024-01-02"

# 生成HTML可视化报告
routecodex offline-log analyze \
  --directory ./logs \
  --output ./report.html \
  --format html

# 生成CSV报告
routecodex offline-log analyze \
  --directory ./logs \
  --output ./report.csv \
  --format csv
```

### 5. 时间序列分析

```bash
# 时间序列分析
routecodex offline-log timeseries \
  --directory ./logs \
  --output ./timeseries.json \
  --start "2024-01-01" \
  --end "2024-01-02" \
  --bucket 5 \
  --modules "processor,transformer"
```

### 6. 配置管理

```bash
# 查看当前配置
routecodex offline-log list

# 显示详细配置
routecodex offline-log config show

# 重置为默认配置
routecodex offline-log config reset
```

## 配置选项详解

### 全局配置

| 选项 | 描述 | 默认值 |
|------|------|--------|
| `--level` | 日志级别 (minimal, normal, detailed, verbose) | normal |
| `--directory` | 日志存储目录 | ~/.routecodex/logs |
| `--max-size` | 单个日志文件最大大小 (MB) | 50 |
| `--max-files` | 最大日志文件数量 | 10 |
| `--compression` | 启用日志压缩 | false |

### 模块配置

| 选项 | 描述 | 默认值 |
|------|------|--------|
| `--name` | 模块名称 | 必填 |
| `--enable/--disable` | 启用/禁用模块记录 | - |
| `--level` | 模块日志级别 | normal |
| `--performance` | 包含性能指标 | false |
| `--stack-traces` | 包含堆栈跟踪 | false |
| `--sensitive` | 敏感字段过滤 | 空 |

### 流水线配置

| 选项 | 描述 | 默认值 |
|------|------|--------|
| `--enable/--disable` | 启用/禁用流水线记录 | - |
| `--level` | 流水线日志级别 | normal |
| `--capture-requests` | 记录请求数据 | true |
| `--capture-responses` | 记录响应数据 | true |
| `--capture-errors` | 记录错误数据 | true |
| `--capture-performance` | 记录性能指标 | true |

## 使用示例

### 示例1：基本模块记录

```bash
# 启用离线记录并配置处理器模块
routecodex offline-log enable --level detailed --directory ./my-logs
routecodex offline-log module --name llm-switch --enable --level detailed --performance
routecodex offline-log module --name compatibility --enable --level detailed --performance
routecodex offline-log module --name provider --enable --level detailed --performance --stack-traces

# 运行您的应用
node your-app.js

# 分析结果
routecodex offline-log analyze --directory ./my-logs --output ./analysis.html --format html
```

### 示例2：流水线全记录

```bash
# 配置完整的流水线记录
routecodex offline-log enable --all-modules --pipeline --level verbose --compression
routecodex offline-log pipeline --enable --capture-requests --capture-responses --capture-errors --capture-performance

# 运行测试
routecodex dry-run request ./test-request.json --pipeline-id test

# 分析流水线性能
routecodex offline-log timeseries --directory ~/.routecodex/logs --bucket 1 --output ./performance.json
```

### 示例3：错误分析

```bash
# 配置错误详细记录
routecodex offline-log module --name processor --enable --level detailed --stack-traces
routecodex offline-log module --name provider --enable --level detailed --stack-traces

# 运行直到出现错误
node your-app.js

# 分析错误模式
routecodex offline-log analyze --directory ./logs --level error --format json --output ./errors.json

# 生成错误报告
routecodex offline-log analyze --directory ./logs --format html --output ./error-report.html
```

## 配置文件格式

离线记录配置存储在 `~/.routecodex/offline-log-config.json`：

```json
{
  "enabled": true,
  "logDirectory": "~/.routecodex/logs",
  "logLevel": "detailed",
  "maxFileSize": 52428800,
  "maxFiles": 10,
  "enableCompression": true,
  "modules": {
    "processor": {
      "enabled": true,
      "logLevel": "detailed",
      "includePerformance": true,
      "includeStackTraces": false,
      "sensitiveFields": []
    },
    "compatibility": {
      "enabled": true,
      "logLevel": "detailed",
      "includePerformance": true,
      "includeStackTraces": false,
      "sensitiveFields": []
    }
  },
  "pipeline": {
    "enabled": true,
    "logLevel": "detailed",
    "captureRequests": true,
    "captureResponses": true,
    "captureErrors": true,
    "capturePerformance": true
  }
}
```

## 日志文件格式

生成的日志文件采用 **JSONL** 格式（每行一个JSON对象）：

```jsonl
{"timestamp":"2024-01-01T12:00:00.000Z","level":"info","moduleId":"processor","message":"Request processing started","data":{"requestId":"req-123","duration":150}}
{"timestamp":"2024-01-01T12:00:00.150Z","level":"info","moduleId":"processor","message":"Request processing completed","data":{"requestId":"req-123","duration":150,"status":"success"}}
{"timestamp":"2024-01-01T12:00:01.000Z","level":"error","moduleId":"provider","message":"Provider error","data":{"errorType":"timeout","requestId":"req-124","stack":"Error: Request timeout"}}
```

## 性能考虑

1. **异步写入** - 所有日志写入都是异步的，不影响主流程
2. **批量处理** - 支持批量日志写入，减少I/O操作
3. **内存缓冲** - 使用内存缓冲区，定期刷新到磁盘
4. **压缩存储** - 可选的日志压缩，节省磁盘空间
5. **自动轮转** - 基于文件大小和时间的自动轮转

## 故障排除

### 常见问题

1. **权限问题**：确保有日志目录的写入权限
2. **磁盘空间**：监控磁盘空间，设置合适的`maxFiles`和`maxFileSize`
3. **日志格式**：确保使用正确的JSONL格式
4. **时间同步**：确保系统时间准确，影响时间序列分析

### 调试命令

```bash
# 检查配置
routecodex offline-log config show

# 验证日志目录权限
ls -la ~/.routecodex/logs/

# 测试日志写入
echo '{"test":"entry"}' >> ~/.routecodex/logs/test.jsonl

# 手动分析日志文件
routecodex offline-log analyze --directory ~/.routecodex/logs --format json
```

## 最佳实践

1. **开发环境**：使用详细级别和栈跟踪
2. **生产环境**：使用正常级别，关闭栈跟踪
3. **性能敏感**：使用最小级别，限制文件大小
4. **安全考虑**：过滤敏感字段，设置合适的权限
5. **存储管理**：定期清理旧日志，监控磁盘使用

这套CLI工具提供了完整的离线日志记录解决方案，无需可视化界面即可捕获和分析系统运行数据。