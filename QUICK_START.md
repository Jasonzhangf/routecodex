# RouteCodex 快速开始指南

## 🚀 一键安装

```bash
# 克隆项目
git clone <repository-url>
cd routecodex

# 一键安装（推荐）
./scripts/quick-install.sh

# 或跳过测试安装
./scripts/quick-install.sh --skip-tests
```

## ✅ 验证安装

```bash
# 检查版本
routecodex --version
rcc --version

# 查看帮助
rcc --help
```

## 🛠️ 快速配置和启动

### 1. 初始化配置

```bash
# 创建默认配置
rcc config init

# 或创建 LMStudio 配置模板
rcc config init --template lmstudio
```

### 2. 启动服务器

```bash
# 启动服务器
rcc start

# 指定端口启动
rcc start --port 8080
```

### 3. 测试服务器

访问 http://localhost:5506 测试 API 是否正常工作。

## 📋 可用命令

### 基本命令
- `rcc start` - 启动服务器
- `rcc stop` - 停止服务器
- `rcc restart` - 重启服务器
- `rcc status` - 查看状态

### 配置管理
- `rcc config init` - 初始化配置
- `rcc config show` - 显示配置
- `rcc config edit` - 编辑配置
- `rcc config validate` - 验证配置

### 其他功能
- `rcc examples` - 查看使用示例
- `rcc clean` - 清理日志和缓存
- `rcc --help` - 查看完整帮助

## 📁 重要文件

- 配置文件: `~/.routecodex/config.json`
- 日志目录: `~/.routecodex/logs/`
- 模块配置: `config/modules.json`

## 🔄 更新

```bash
cd /path/to/routecodex
git pull
./scripts/quick-install.sh
```

---

**安装完成！** 现在您可以使用 `routecodex` 或 `rcc` 命令来管理 RouteCodex 服务器。