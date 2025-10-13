# RouteCodex 快速安装指南

本文档提供了 RouteCodex 的快速安装和配置指南，支持安装 `routecodex` 和 `rcc` 两个命令。

## 🚀 一键安装

### 方法 1: 使用快速安装脚本（推荐）

```bash
# 克隆项目
git clone <repository-url>
cd routecodex

# 一键安装（包含 routecodex 和 rcc 命令）
./scripts/quick-install.sh
```

### 方法 2: 使用 npm 命令

```bash
# 快速安装
npm run install:quick

# 跳过测试安装
npm run install:skip-tests

# 使用简单安装脚本
npm run install:simple
```

## 📋 系统要求

- **Node.js**: >= 18.0.0
- **npm**: 最新版本
- **操作系统**: macOS, Linux, Windows (WSL)

## 🔧 安装选项

### 快速安装脚本选项

```bash
# 查看帮助
./scripts/quick-install.sh --help

# 跳过测试（更快）
./scripts/quick-install.sh --skip-tests

# 仅构建，不安装
./scripts/quick-install.sh --build-only
```

### 安装脚本特性

- ✅ **自动依赖管理**: 自动安装和清理项目依赖
- ✅ **TypeScript 构建**: 自动编译 TypeScript 代码
- ✅ **版本检查**: 检查 Node.js 版本兼容性
- ✅ **测试验证**: 可选的测试运行步骤
- ✅ **双命令支持**: 同时安装 `routecodex` 和 `rcc` 命令
- ✅ **智能清理**: 自动清理旧版本和临时文件
- ✅ **错误处理**: 完善的错误处理和回滚机制

## 🎯 安装后验证

### 验证命令可用性

```bash
# 检查 routecodex 命令
routecodex --version

# 检查 rcc 命令（别名）
rcc --version

# 查看帮助
routecodex --help
rcc --help
```

### 预期输出

```
✅ routecodex 0.45.0 安装成功
✅ rcc 0.45.0 别名创建成功
```

## 🛠️ 快速开始

### 1. 初始化配置

```bash
# 创建默认配置
rcc config init

# 或创建 LMStudio 配置模板
rcc config init --template lmstudio

# 或创建 OAuth 配置模板
rcc config init --template oauth
```

### 2. 启动服务器

```bash
# 启动 RouteCodex 服务器
rcc start

# 或指定端口启动
rcc start --port 8080

# 或使用自定义配置
rcc start --config ./my-config.json
```

### 3. 测试安装

访问 http://localhost:5506 测试服务器是否正常运行。

## 📁 文件结构

安装后的重要文件位置：

```
~/.routecodex/
├── config.json          # 主配置文件
├── default.json         # 默认模板
├── simple-log-config.json # 简化日志配置
└── logs/                # 日志文件目录

全局安装位置：
$(npm config get prefix)/bin/
├── routecodex           # 主命令
└── rcc                  # 别名命令
```

## 🔄 更新和卸载

### 更新到最新版本

```bash
cd /path/to/routecodex
git pull
./scripts/quick-install.sh
```

### 卸载

```bash
# 卸载全局包
npm uninstall -g routecodex

# 手动移除 rcc 别名（如果存在）
rm -f $(npm config get prefix)/bin/rcc

# 清理配置文件（可选）
rm -rf ~/.routecodex
```

## 🐛 故障排除

### 常见问题

#### 1. 权限问题

```bash
# 如果遇到权限错误，可能需要使用 sudo
sudo ./scripts/quick-install.sh

# 或者配置 npm 全局目录
npm config set prefix ~/.npm-global
export PATH=~/.npm-global/bin:$PATH
```

#### 2. Node.js 版本过低

```bash
# 检查 Node.js 版本
node --version

# 升级 Node.js 到 18+ 版本
# 使用 nvm:
nvm install 18
nvm use 18
```

#### 3. rcc 命令不可用

```bash
# 检查全局 bin 目录
ls -la $(npm config get prefix)/bin/

# 手动创建 rcc 别名
ln -sf $(npm config get prefix)/bin/routecodex $(npm config get prefix)/bin/rcc
```

#### 4. 端口被占用

```bash
# 查看端口占用
lsof -i :5506

# 停止现有服务器
rcc stop

# 或使用不同端口
rcc start --port 8080
```

### 调试模式

```bash
# 启用详细日志
DEBUG=routecodex:* rcc start --log-level debug

# 查看配置
rcc config show
```

## 📚 更多资源

- [完整文档](./README.md)
- [架构文档](./ARCHITECTURE_DOCUMENTATION.md)
- [配置指南](./docs/CONFIG_ARCHITECTURE.md)
- [示例代码](./examples/)

## 🤝 贡献

如果您遇到问题或有改进建议，请：

1. 检查现有的 [Issues](https://github.com/your-repo/routecodex/issues)
2. 创建新的 Issue 描述问题
3. 提交 Pull Request 贡献代码

---

**提示**: 安装完成后，建议运行 `rcc examples` 查看更多使用示例。