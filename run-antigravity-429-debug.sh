#!/bin/bash
# Antigravity 429 Debug - 按task.md方法执行完整测试序列

set -e

echo "=============================================="
echo "Antigravity 429 Debug - Task.md方法"
echo "=============================================="
echo ""

# 1. 获取Token
echo "📋 Step 1: 获取Antigravity Access Token..."
if [ -f ~/.routecodex/auth/antigravity-oauth-1-geetasamodgeetasamoda.json ]; then
    export ANTIGRAVITY_ACCESS_TOKEN=$(cat ~/.routecodex/auth/antigravity-oauth-1-geetasamodgeetasamoda.json | jq -r '.access_token')
    echo "✅ Token已加载 (${ANTIGRAVITY_ACCESS_TOKEN:0:10}...)"
else
    echo "❌ 错误: 找不到token文件"
    echo "请手动设置: export ANTIGRAVITY_ACCESS_TOKEN='your_token'"
    exit 1
fi

export ANTIGRAVITY_API_BASE="https://daily-cloudcode-pa.sandbox.googleapis.com"

# 2. 检查Python
echo ""
echo "📋 Step 2: 检查Python环境..."
if ! command -v python3 &> /dev/null; then
    echo "❌ 错误: 需要Python 3"
    exit 1
fi

if ! python3 -c "import requests" 2>/dev/null; then
    echo "⚠️  安装requests库..."
    pip3 install requests
fi

echo "✅ Python环境OK"

# 3. 执行Step B测试
echo ""
echo "=============================================="
echo "🔍 Step B: Header深度对齐测试"
echo "=============================================="
python3 test-antigravity-task-b1.py

# 保存B的退出码
B_EXIT=$?

# 4. 执行Step C测试
echo ""
echo "=============================================="
echo "🔍 Step C: Tools差异测试"
echo "=============================================="
python3 test-antigravity-task-c.py

# 保存C的退出码
C_EXIT=$?

# 5. 总结
echo ""
echo "=============================================="
echo "📊 测试总结"
echo "=============================================="
echo ""
echo "根据上面的测试结果，找出第一个从200变成429的测试点。"
echo ""
echo "可能的结论:"
echo "  - 如果B1.4出现429 → Headers问题（X-Goog-Api-Client或Client-Metadata）"
echo "  - 如果C2.1出现429 → 任何MCP tool都会被拒绝"
echo "  - 如果C2.2出现429 → MCP tools数量限制"
echo ""
echo "请查看上方详细输出进行分析。"
echo ""
