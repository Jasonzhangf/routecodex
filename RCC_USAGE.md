# RCC 命令使用指南

## 🚀 新的命令结构

RouteCodex 现在使用统一的 `rcc` 命令，支持两种主要功能：

- **`rcc code`** - 启动 Claude Code（通过 RouteCodex 代理）
- **`rcc start/stop`** - 管理 RouteCodex 服务器

## 📋 命令概览

### 主命令
- `rcc` - RouteCodex CLI 主命令

### Claude Code 相关
- `rcc code` - 启动 Claude Code 接口，使用 RouteCodex 作为代理

### 服务器管理
- `rcc start` - 启动 RouteCodex 服务器
- `rcc stop` - 停止 RouteCodex 服务器
- `rcc restart` - 重启 RouteCodex 服务器
- `rcc status` - 查看服务器状态

### 配置管理
- `rcc config init` - 初始化配置
- `rcc config show` - 显示配置
- `rcc config edit` - 编辑配置
- `rcc config validate` - 验证配置

### 其他功能
- `rcc examples` - 查看使用示例
- `rcc clean` - 清理日志和缓存
- `rcc dry-run` - 干运行测试命令

## 🎯 常用使用场景

### 1. 快速启动 Claude Code（推荐）

```bash
# 自动启动服务器并启动 Claude Code
rcc code --ensure-server

# 使用特定模型启动 Claude Code
rcc code --model claude-3-haiku --ensure-server

# 使用自定义配置文件启动 Claude Code
rcc code --config ./my-config.json --ensure-server
```

### 2. 服务器管理模式

```bash
# 手动启动服务器
rcc start

# 在另一个终端启动 Claude Code
rcc code

# 停止服务器
rcc stop
```

### 3. 配置管理

```bash
# 创建默认配置
rcc config init

# 创建 LMStudio 配置模板
rcc config init --template lmstudio

# 查看当前配置
rcc config show

# 编辑配置文件
rcc config edit
```

## 🔧 选项详解

### rcc code 选项

| 选项 | 描述 | 默认值 |
|------|------|--------|
| `-p, --port <port>` | RouteCodex 服务器端口 | `5506` |
| `-h, --host <host>` | RouteCodex 服务器主机 | `localhost` |
| `-c, --config <config>` | 配置文件路径 | `~/.routecodex/config.json` |
| `--claude-path <path>` | Claude Code 可执行文件路径 | `claude` |
| `--model <model>` | 使用的模型 | - |
| `--profile <profile>` | Claude Code 配置文件 | - |
| `--ensure-server` | 自动启动服务器（如果未运行） | `false` |

### rcc start 选项

| 选项 | 描述 | 默认值 |
|------|------|--------|
| `-p, --port <port>` | 服务器端口 | `5506` |
| `-h, --host <host>` | 服务器主机 | `localhost` |
| `-c, --config <config>` | 配置文件路径 | `~/.routecodex/config.json` |
| `--log-level <level>` | 日志级别 | `info` |
| `--codex` | 使用 Codex 系统提示 | `false` |
| `--claude` | 使用 Claude 系统提示 | `false` |
| `--restart` | 如果服务器运行则重启 | `false` |

## 🛠️ 工作流程示例

### 开发工作流

```bash
# 1. 初始化项目配置
rcc config init --template lmstudio

# 2. 启动 Claude Code（自动管理服务器）
rcc code --ensure-server

# 3. 开始使用 Claude Code
# 在 Claude Code 中进行开发工作

# 4. 完成后停止服务器（可选）
rcc stop
```

### 服务器管理工作流

```bash
# 1. 检查服务器状态
rcc status

# 2. 启动服务器
rcc start

# 3. 在多个终端中启动 Claude Code
rcc code --model claude-3-haiku
rcc code --model claude-3-sonnet --profile work

# 4. 重启服务器（如需要）
rcc restart

# 5. 停止服务器
rcc stop
```

### 配置管理工作流

```bash
# 1. 创建新配置
rcc config init --template oauth --force

# 2. 验证配置
rcc config validate

# 3. 查看配置
rcc config show

# 4. 编辑配置
rcc config edit

# 5. 重启服务器以应用新配置
rcc restart
```

## 📁 配置文件

配置文件位置：`~/.routecodex/config.json`

### 基本配置示例

```json
{
  "port": 5506,
  "virtualrouter": {
    "providers": {
      "lmstudio": {
        "type": "lmstudio",
        "baseUrl": "http://localhost:1234",
        "apiKey": "${LM_STUDIO_API_KEY:-}"
      }
    },
    "routing": {
      "default": ["lmstudio.gpt-oss-20b-mlx"]
    }
  }
}
```

## 🔍 故障排除

### 常见问题

#### 1. rcc 命令未找到

```bash
# 重新安装
npm install -g routecodex

# 或使用快速安装脚本
./scripts/quick-install.sh
```

#### 2. Claude Code 启动失败

```bash
# 检查 Claude Code 是否安装
claude --version

# 使用完整路径
rcc code --claude-path /path/to/claude
```

#### 3. 服务器启动失败

```bash
# 检查端口占用
lsof -i :5506

# 使用不同端口
rcc start --port 8080

# 查看详细日志
rcc start --log-level debug
```

#### 4. 配置文件错误

```bash
# 验证配置
rcc config validate

# 重新创建配置
rcc config init --force

# 查看配置文件
cat ~/.routecodex/config.json
```

## 🆚 从旧版本迁移

### 命令变更对照

| 旧命令 | 新命令 |
|--------|--------|
| `routecodex start` | `rcc start` |
| `routecodex stop` | `rcc stop` |
| `routecodex config init` | `rcc config init` |
| `routecodex examples` | `rcc examples` |
| - | `rcc code` (新增) |

### 新功能

- **统一命令**: 所有操作都通过 `rcc` 命令
- **Claude Code 集成**: `rcc code` 直接启动 Claude Code
- **自动服务器管理**: `--ensure-server` 选项
- **更好的用户体验**: 统一的命令行界面

## 📚 更多资源

- [完整文档](./README.md)
- [架构文档](./ARCHITECTURE_DOCUMENTATION.md)
- [配置指南](./docs/CONFIG_ARCHITECTURE.md)
- [安装指南](./INSTALL.md)

---

**提示**: 使用 `rcc examples` 查看更多使用示例。