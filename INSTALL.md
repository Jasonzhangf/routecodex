# RouteCodex 全局安装指南

## 推荐安装方式

### 使用内置脚本（推荐）

```bash
# 一键构建并全局安装
npm run install:global
```

这个脚本会：
1. 检查Node.js版本（需要>=20）
2. 构建项目
3. 检查npm权限配置
4. 自动处理权限问题
5. 全局安装到正确位置
6. 验证安装结果

## 手动安装方式

### 方式一：直接npm全局安装

```bash
# 1. 构建项目
npm run build

# 2. 全局安装
npm install -g .

# 3. 验证安装
routecodex --version
```

### 方式二：打包后安装

```bash
# 1. 构建项目
npm run build

# 2. 打包
npm pack

# 3. 全局安装
npm install -g routecodex-*.tgz

# 4. 验证安装
routecodex --version
```

## 权限配置说明

### Homebrew用户（macOS）

如果使用Homebrew安装的Node.js，npm应该已经正确配置：

```bash
# 检查npm配置
npm config get prefix
# 应该显示：/opt/homebrew

# 验证权限
ls -la $(npm config get prefix)
# 应该显示你的用户具有写权限
```

### 如果遇到权限问题

#### 解决方案1：修复Homebrew权限

```bash
# 修复Homebrew目录权限
sudo chown -R $(whoami) /opt/homebrew
```

#### 解决方案2：使用用户级全局目录

```bash
# 设置用户级全局目录
npm config set prefix ~/.npm-global

# 添加到PATH（zsh）
echo 'export PATH="~/.npm-global/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# 或者添加到PATH（bash）
echo 'export PATH="~/.npm-global/bin:$PATH"' >> ~/.bash_profile
source ~/.bash_profile

# 重新安装
npm install -g .
```

#### 解决方案3：使用nvm管理Node.js

```bash
# 安装nvm
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.0/install.sh | bash

# 重启终端或执行
source ~/.bashrc

# 安装Node.js
nvm install 20
nvm use 20

# npm现在应该自动配置正确
npm install -g .
```

## 验证安装

```bash
# 检查版本
routecodex --version

# 检查配置
routecodex config validate

# 测试帮助
routecodex --help
```

## 可用命令

安装后可以使用以下命令：

- `routecodex` - 完整命令
- `rcc` - 简写命令

## 卸载

```bash
# 卸载全局安装的包
npm uninstall -g routecodex

# 或者如果使用了其他名称
npm uninstall -g rcc
```

## 常见问题

### Q: 安装时提示权限不足
A: 参考上面的"权限配置说明"部分，根据你的安装方式选择合适的解决方案。

### Q: 找不到routecodex命令
A: 确保全局安装目录在PATH中：
```bash
echo $PATH | grep $(npm config get prefix)/bin
```

### Q: 安装成功但运行时报错
A: 可能是构建问题，尝试重新构建：
```bash
npm run clean
npm run build
npm install -g .
```

### Q: 在Linux上遇到权限问题
A: 对于系统npm，可能需要配置用户级全局目录：
```bash
mkdir ~/.npm-global
npm config set prefix ~/.npm-global
echo 'export PATH=~/.npm-global/bin:$PATH' >> ~/.bashrc
source ~/.bashrc
```

## 开发者安装

如果你是开发者，想要开发RouteCodex：

```bash
# 克隆仓库
git clone <repository-url>
cd routecodex

# 安装依赖
npm install

# 构建项目
npm run build

# 创建全局链接（开发模式）
npm link

# 现在可以使用了
routecodex --version

# 开发完成后取消链接
npm unlink -g routecodex
```