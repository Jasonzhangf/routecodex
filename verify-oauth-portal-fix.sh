#!/bin/bash
# OAuth Portal 修复验证脚本
# 运行此脚本以快速验证修复是否生效

set -e

echo "════════════════════════════════════════════════════════"
echo "  OAuth Portal 修复验证"
echo "════════════════════════════════════════════════════════"
echo ""

# 检测端口
ROUTECODEX_PORT=${ROUTECODEX_PORT:-${RCC_PORT:-5555}}
BASE_URL="http://127.0.0.1:${ROUTECODEX_PORT}"

echo "📌 服务器地址: ${BASE_URL}"
echo ""

# 测试 1: Health 端点
echo "🔍 测试 1: Health 端点"
if curl -s -f "${BASE_URL}/health" > /dev/null 2>&1; then
    echo "✅ Health 端点可访问"
    curl -s "${BASE_URL}/health" | jq . 2>/dev/null || curl -s "${BASE_URL}/health"
else
    echo "❌ Health 端点不可访问"
    echo "   请确保服务器正在运行: routecodex start"
    exit 1
fi

echo ""

# 测试 2: OAuth Portal 端点
echo "🔍 测试 2: OAuth Portal 端点"
PORTAL_URL="${BASE_URL}/token-auth/demo?provider=verification-test&alias=test-alias&tokenFile=~/.routecodex/test.json&oauthUrl=https://example.com&sessionId=test-123"

if curl -s -f "${PORTAL_URL}" > /dev/null 2>&1; then
    echo "✅ OAuth Portal 端点可访问"
    
    # 检查 HTML 内容
    RESPONSE=$(curl -s "${PORTAL_URL}")
    
    if echo "$RESPONSE" | grep -q "RouteCodex Token Auth Demo"; then
        echo "   ✓ HTML 标题正确"
    else
        echo "   ⚠ HTML 标题未找到"
    fi
    
    if echo "$RESPONSE" | grep -q "verification-test"; then
        echo "   ✓ Provider 信息显示正确"
    else
        echo "   ⚠ Provider 信息未找到"
    fi
    
    if echo "$RESPONSE" | grep -q "test-alias"; then
        echo "   ✓ Alias 信息显示正确"
    else
        echo "   ⚠ Alias 信息未找到"
    fi
    
    if echo "$RESPONSE" | grep -q "Continue to OAuth"; then
        echo "   ✓ OAuth 按钮存在"
    else
        echo "   ⚠ OAuth 按钮未找到"
    fi
    
else
    echo "❌ OAuth Portal 端点不可访问"
    echo "   这是主要问题！修复应该解决这个问题。"
    exit 1
fi

echo ""
echo "════════════════════════════════════════════════════════"
echo "  🎉 验证完成！"
echo "════════════════════════════════════════════════════════"
echo ""
echo "如果所有测试都通过，说明 OAuth Portal 修复已生效。"
echo "现在启动服务器时，OAuth Portal 页面应该可以正常访问。"
echo ""
