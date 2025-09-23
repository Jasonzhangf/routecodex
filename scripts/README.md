# RouteCodex 构建和安装脚本

本目录包含用于自动构建和安装 RouteCodex 的脚本。

## 脚本列表

### 1. build-and-install.sh (Linux/macOS)
完整的构建和安装脚本，包含所有功能。

**使用方法：**
```bash
# 完整构建和安装（运行测试）
./scripts/build-and-install.sh

# 跳过测试的构建和安装
./scripts/build-and-install.sh --skip-tests

# 显示帮助信息
./scripts/build-and-install.sh --help

# 详细输出
./scripts/build-and-install.sh --verbose
```

**功能特点：**
- 自动检查前置条件（Node.js, npm）
- 清理旧的构建文件
- 可选择是否运行测试
- 自动构建 TypeScript 项目
- 创建 npm 包
- 卸载旧版本
- 安装新版本
- 验证安装结果
- 清理临时文件

### 2. build-and-install.bat (Windows)
Windows 版本的构建和安装脚本。

**使用方法：**
```cmd
# 完整构建和安装
scripts\build-and-install.bat

# 跳过测试
scripts\build-and-install.bat --skip-tests

# 显示帮助
scripts\build-and-install.bat --help
```

### 3. quick-install.sh (Linux/macOS)
快速安装脚本，简化版本。

**使用方法：**
```bash
# 一键快速安装
./scripts/quick-install.sh
```

**功能特点：**
- 自动跳过测试以加快安装速度
- 简化的输出信息
- 适合快速部署和开发环境

## npm 脚本

项目根目录提供了以下 npm 脚本：

```bash
# 完整构建和安装（推荐）
npm run install:global

# 快速安装（跳过测试）
npm run install:quick

# 跳过测试的安装
npm run install:skip-tests
```

## 安装流程

所有脚本都遵循以下安装流程：

1. **前置条件检查** - 确保 Node.js 和 npm 已安装
2. **清理旧文件** - 删除旧的构建产物和包文件
3. **运行测试** - 可选，验证代码质量
4. **构建项目** - 编译 TypeScript 代码
5. **创建包** - 生成 npm tarball 文件
6. **卸载旧版本** - 移除已安装的全局包
7. **安装新版本** - 全局安装最新版本
8. **验证安装** - 确认安装成功并测试基本功能
9. **清理临时文件** - 删除构建过程中产生的临时文件

## 故障排除

### 常见问题

1. **权限错误**
   ```bash
   # Linux/macOS: 使用 sudo
   sudo ./scripts/build-and-install.sh

   # Windows: 以管理员身份运行命令提示符
   ```

2. **Node.js 版本问题**
   - 确保 Node.js 版本 >= 16.0.0
   - 使用 nvm 管理 Node.js 版本

3. **npm 权限问题**
   ```bash
   # 配置 npm 前缀
   npm config set prefix ~/.npm-global
   # 将路径添加到环境变量
   export PATH=~/.npm-global/bin:$PATH
   ```

4. **构建失败**
   - 检查 TypeScript 编译错误
   - 确保所有依赖已安装
   - 使用 `npm run install:skip-tests` 跳过测试

5. **安装验证失败**
   - 确保 npm 全局安装目录在 PATH 中
   - 重启终端或重新加载环境变量

## 手动安装

如果自动脚本失败，可以手动执行以下步骤：

```bash
# 1. 构建项目
npm run build

# 2. 创建包
npm pack

# 3. 卸载旧版本
npm uninstall -g routecodex

# 4. 安装新版本
npm install -g routecodex-*.tgz

# 5. 验证安装
routecodex --version
```

## 更新和维护

要更新 RouteCodex 到最新版本：

```bash
# 拉取最新代码
git pull origin main

# 重新构建和安装
npm run install:global
```

## 贡献

如果您发现脚本有问题或有改进建议，请：

1. 检查现有脚本的功能
2. 测试您的更改
3. 提交 Pull Request
4. 更新相关文档