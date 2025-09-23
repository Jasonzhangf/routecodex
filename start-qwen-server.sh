#!/bin/bash

# Qwen-Only RouteCodex Server Startup Script
# 用于启动仅使用Qwen Provider的RouteCodex服务器

echo "🚀 Starting Qwen-Only RouteCodex Server..."
echo "📝 Configuration: qwen-only-config.json"
echo "🔧 Model: qwen3-coder-plus"
echo "🌐 Port: 5506"

# 检查Node.js是否可用
if ! command -v node &> /dev/null; then
    echo "❌ Node.js is not available. Please install Node.js."
    exit 1
fi

# 检查是否存在构建的代码
if [ ! -d "dist" ] || [ ! -f "dist/index.js" ]; then
    echo "📦 Building RouteCodex..."
    npm run build
    if [ $? -ne 0 ]; then
        echo "❌ Build failed. Please check for errors."
        exit 1
    fi
fi

# 设置环境变量
export NODE_ENV=production
export ROUTECODEX_CONFIG="./config/qwen-only-config.json"

# 启动服务器
echo "🔄 Starting server..."
node dist/index.js --config ./config/qwen-only-config.json