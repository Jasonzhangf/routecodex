#!/bin/bash

set -euo pipefail

echo "🌍 全局安装 routecodex..."

# 检查npm配置
echo "📋 npm配置信息:"
NPM_PREFIX=$(npm config get prefix)
# 更可靠地获取全局 node_modules 路径
GLOBAL_NODE_MODULES=$(npm root -g 2>/dev/null || true)
if [ -z "${GLOBAL_NODE_MODULES:-}" ]; then
  GLOBAL_NODE_MODULES="$NPM_PREFIX/lib/node_modules"
fi
echo "   全局安装目录: $NPM_PREFIX"
echo "   全局包目录: $GLOBAL_NODE_MODULES"

# 检查权限（对于Homebrew安装的Node.js应该不需要sudo）
if [ -w "$NPM_PREFIX" ]; then
    echo "   ✅ 具有写入权限，无需sudo"
else
    echo "   ⚠️  警告：对 $NPM_PREFIX 没有写入权限"
    echo "   💡 建议：如果是Homebrew安装的Node.js，应该无需sudo"
    echo "   💡 如果需要权限，请先运行: npm config set prefix ~/.npm-global"
fi
echo ""

# 检查Node.js
check_node() {
    if ! command -v node &> /dev/null; then
        echo "❌ Node.js 未安装"
        exit 1
    fi
    
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 20 ]; then
        echo "❌ Node.js 版本过低，需要 >=20"
        exit 1
    fi
    # Node 24 在部分原生依赖上仍可能触发编译，给出提示但不阻塞
    if [ "$NODE_VERSION" -ge 24 ]; then
        echo "⚠️  检测到 Node $(node -v)，某些原生依赖可能会尝试编译，建议使用 Node 22 以获得更快安装"
    fi

    echo "✅ Node.js: $(node -v)"
}

# 构建项目
build_project() {
    echo "🔨 构建项目..."

    # 清理旧的构建文件
    rm -rf dist

    # 检查是否已有依赖
    if [ ! -d "node_modules" ]; then
        echo "📦 安装项目依赖..."

        # 避免重量级下载/编译：忽略 postinstall、跳过可选依赖
        export PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
        export PUPPETEER_SKIP_DOWNLOAD=1

        if [ -f package-lock.json ]; then
            echo "   使用 npm ci (带忽略脚本)"
            if ! timeout 600 npm ci --no-audit --no-fund --omit=optional --ignore-scripts --loglevel=warn; then
                echo "❌ npm ci 失败或超时"
                echo "💡 尝试清理缓存后重装：rm -rf node_modules package-lock.json && npm cache clean --force"
                exit 1
            fi
        else
            echo "   使用 npm install (带忽略脚本)"
            if ! timeout 600 npm install --no-audit --no-fund --omit=optional --ignore-scripts --prefer-offline --progress=false --loglevel=warn; then
                echo "❌ npm install 失败或超时"
                echo "💡 尝试清理缓存后重装：rm -rf node_modules && npm cache clean --force"
                exit 1
            fi
        fi
    else
        echo "✅ 依赖已存在，跳过安装"
    fi

    # 构建项目
    echo "🔨 编译TypeScript..."
    # dev 包：显式使用 BUILD_MODE=dev 以便在编译期区分 dev/release
   BUILD_MODE=dev timeout 300 npm run build || {
       echo "❌ 构建超时或失败"
       echo "💡 尝试手动构建：npm run build"
       exit 1
   }
    # 确保CLI可执行
    chmod +x dist/cli.js

    # 检查构建结果
    if [ ! -f "dist/cli.js" ]; then
        echo "❌ 构建失败：找不到 dist/cli.js"
        exit 1
    fi
    echo "✅ 构建完成"
}

# 全局安装
global_install() {
    echo "🌍 执行全局安装..."

    # 先检查当前用户是否对npm prefix有写权限
    NPM_PREFIX=$(npm config get prefix)
    if [ ! -w "$NPM_PREFIX" ]; then
        echo "❌ 错误：对 $NPM_PREFIX 没有写入权限"
        echo "💡 解决方案（三选一）："
        echo "   1. 如果使用Homebrew，确保正确安装: brew install node"
        echo "   2. 设置用户级全局目录: npm config set prefix ~/.npm-global"
        echo "   3. 修复Homebrew权限: sudo chown -R $(whoami) $NPM_PREFIX"
        echo ""
        echo "🔧 尝试自动设置用户级全局目录..."
        USER_GLOBAL_DIR="$HOME/.npm-global"
        mkdir -p "$USER_GLOBAL_DIR/bin"
        npm config set prefix "$USER_GLOBAL_DIR"

        # 更新PATH提示
        if [[ ":$PATH:" != *":$USER_GLOBAL_DIR/bin:"* ]]; then
            echo "⚠️  请将 $USER_GLOBAL_DIR/bin 添加到 PATH:"
            echo "   echo 'export PATH=\"$USER_GLOBAL_DIR/bin:\$PATH\"' >> ~/.zshrc"
            echo "   source ~/.zshrc"
        fi
    fi

    # 执行安装（跳过可选依赖，减少体积；允许脚本执行以生成可执行文件）
    npm install -g . --no-audit --no-fund --omit=optional

    if [ $? -eq 0 ]; then
        echo "✅ 全局安装成功"
    else
        echo "❌ 全局安装失败"
        exit 1
    fi
}

# 验证安装
verify_install() {
    echo "🔍 验证全局安装..."
    if command -v routecodex &> /dev/null; then
        echo "✅ routecodex 已全局安装"
        routecodex --version
    else
        echo "❌ 全局安装失败（未找到 routecodex 命令）"
        exit 1
    fi
}

verify_server_health() {
    local HEALTH_LOG="/tmp/routecodex-install-health-$(date +%s).log"
    echo ""
    echo "🩺 执行服务器健康&端到端检查 (chat + anthropic SSE)..."
    if node scripts/verify-install-e2e.mjs >"$HEALTH_LOG" 2>&1; then
        echo "✅ 全局 CLI 端到端检查通过"
        rm -f "$HEALTH_LOG" || true
        return
    fi
    echo "❌ 端到端检查失败，请查看日志: $HEALTH_LOG"
    tail -n 200 "$HEALTH_LOG" 2>/dev/null || true
    exit 1
}

# 清理旧安装
cleanup_old_install() {
    echo "🧹 检查并清理旧安装..."

    NPM_PREFIX=$(npm config get prefix)
    GLOBAL_NODE_MODULES=$(npm root -g 2>/dev/null || true)
    if [ -z "${GLOBAL_NODE_MODULES:-}" ]; then
      GLOBAL_NODE_MODULES="$NPM_PREFIX/lib/node_modules"
    fi

    # 清理旧的符号链接
    if [ -L "$GLOBAL_NODE_MODULES/routecodex" ]; then
        echo "🗑️  删除旧的routecodex链接..."
        rm -f "$GLOBAL_NODE_MODULES/routecodex"
    fi

    # 清理旧的可执行文件
    if [ -L "$NPM_PREFIX/bin/routecodex" ]; then
        echo "🗑️  删除旧的routecodex可执行文件..."
        rm -f "$NPM_PREFIX/bin/routecodex"
    fi

    # 清理异常生成的本地配置目录（历史脚本bug）
    if [ -d "$HOME/.routecodexundefined" ]; then
        echo "🗑️  移除异常目录 ~/.routecodexundefined ..."
        rm -rf "$HOME/.routecodexundefined" || true
    fi

    echo "✅ 清理完成"
}

# 主函数
main() {
    check_node
    cleanup_old_install
    build_project
    global_install
    verify_install
    verify_server_health

    echo ""
    echo "🎉 全局安装完成!"
    echo ""
    echo "使用方法:"
    echo "  routecodex         # 全局 CLI 命令（dev 包）"
    echo ""

    # 如果有权限问题，给出提示
    NPM_CACHE=$(npm config get cache)
    if find "$NPM_CACHE" -not -user $(whoami) -print -quit | grep -q . 2>/dev/null; then
        echo "⚠️  注意：npm缓存存在权限问题，可能影响后续使用"
        echo "💡 建议运行: sudo chown -R \$(id -u):\$(id -g) \"$NPM_CACHE\""
        echo ""
    fi
}

main "$@"
