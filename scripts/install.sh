#!/bin/bash

set -e

echo "🚀 开始安装 routecodex..."

# 检查Node.js版本
check_node_version() {
    if ! command -v node &> /dev/null; then
        echo "❌ Node.js 未安装，请先安装 Node.js (>=20 <26)"
        exit 1
    fi
    
    NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
    if [ "$NODE_VERSION" -lt 20 ]; then
        echo "❌ Node.js 版本过低，需要 >=20，当前版本: $(node -v)"
        exit 1
    fi
    
    echo "✅ Node.js 版本检查通过: $(node -v)"
}

# 检查npm
check_npm() {
    if ! command -v npm &> /dev/null; then
        echo "❌ npm 未安装"
        exit 1
    fi
    echo "✅ npm 可用: $(npm -v)"
}

# 清理环境
clean_environment() {
    echo "🧹 清理环境..."
    rm -rf node_modules package-lock.json dist
    npm cache clean --force || true
}

# 安装依赖
install_dependencies() {
    echo "📦 安装依赖..."
    npm install --no-audit --no-fund
}

# 构建项目
build_project() {
    echo "🔨 构建项目..."
    npm run build
}

# 设置执行权限
set_permissions() {
    echo "🔑 设置执行权限..."
    node scripts/ensure-cli-executable.mjs || true
}

# 验证安装
verify_installation() {
    echo "🔍 验证安装..."
    if [ -f "dist/cli.js" ]; then
        echo "✅ CLI 构建成功"
    else
        echo "❌ CLI 构建失败"
        exit 1
    fi
    
    if [ -f "dist/index.js" ]; then
        echo "✅ 主模块构建成功"
    else
        echo "❌ 主模块构建失败"
        exit 1
    fi
}

# 主函数
main() {
    echo "📋 安装环境信息:"
    echo "   Node.js: $(node -v)"
    echo "   npm: $(npm -v)"
    echo "   目录: $(pwd)"
    echo ""
    
    check_node_version
    check_npm
    clean_environment
    install_dependencies
    build_project
    set_permissions
    verify_installation
    
    echo ""
    echo "🎉 routecodex 安装完成!"
    echo ""
    echo "使用方法:"
    echo "  npm start          # 启动服务"
    echo "  npm run dev        # 开发模式"
    echo "  npm test           # 运行测试"
    echo "  ./dist/cli.js      # CLI 工具"
    echo ""
}

# 运行主函数
main "$@"