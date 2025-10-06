#!/bin/bash

# LM Studio 集成测试脚本
# 测试 gpt-oss-20b-mlx 模型

echo "🚀 开始 LM Studio 集成测试..."
echo "📋 测试配置:"
echo "  - 模型: gpt-oss-20b-mlx"
echo "  - 端点: http://localhost:1234"
echo "  - 协议: OpenAI兼容"
echo ""

# 检查LM Studio是否运行
echo "🔍 检查 LM Studio 服务状态..."
if curl -s http://localhost:1234/health > /dev/null 2>&1; then
    echo "✅ LM Studio 服务正在运行"
else
    echo "❌ LM Studio 服务未运行，请先启动 LM Studio 并加载 gpt-oss-20b-mlx 模型"
    echo "   确保 LM Studio 在端口 1234 上运行"
    exit 1
fi

# 启动RouteCodex服务器
echo "🔄 启动 RouteCodex 服务器..."
npm start > lmstudio-test.log 2>&1 &
SERVER_PID=$!
sleep 5

# 检查服务器是否启动成功
if ! curl -s http://localhost:5520/health > /dev/null 2>&1; then
    echo "❌ RouteCodex 服务器启动失败"
    tail -20 lmstudio-test.log
    kill $SERVER_PID 2>/dev/null
    exit 1
fi

echo "✅ RouteCodex 服务器启动成功 (PID: $SERVER_PID)"

# 测试1: 基础对话
echo ""
echo "🧪 测试1: 基础对话测试"
RESPONSE=$(curl -s -X POST http://localhost:5520/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer lmstudio-test-key" \
  -d '{
    "model": "gpt-oss-20b-mlx",
    "messages": [
      {"role": "user", "content": "你好，请简单介绍一下自己"}
    ],
    "max_tokens": 100
  }')

if echo "$RESPONSE" | grep -q '"choices"'; then
    echo "✅ 基础对话测试通过"
    echo "📝 响应内容: $(echo "$RESPONSE" | jq -r '.choices[0].message.content' 2>/dev/null | head -c 100)..."
else
    echo "❌ 基础对话测试失败"
    echo "🔍 响应内容: $RESPONSE"
fi

# 测试2: 工具调用
echo ""
echo "🧪 测试2: 工具调用测试"
TOOL_RESPONSE=$(curl -s -X POST http://localhost:5520/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer lmstudio-test-key" \
  -d '{
    "model": "gpt-oss-20b-mlx",
    "messages": [
      {"role": "user", "content": "现在几点了？"}
    ],
    "tools": [
      {
        "type": "function",
        "function": {
          "name": "get_current_time",
          "description": "获取当前时间"
        }
      }
    ],
    "max_tokens": 100
  }')

if echo "$TOOL_RESPONSE" | grep -q '"tool_calls"'; then
    echo "✅ 工具调用测试通过"
    echo "🔧 工具调用: $(echo "$TOOL_RESPONSE" | jq -r '.choices[0].message.tool_calls[0].function.name' 2>/dev/null)"
else
    echo "⚠️  工具调用测试未通过（可能是模型不支持工具调用）"
    echo "🔍 响应内容: $(echo "$TOOL_RESPONSE" | jq -r '.choices[0].message.content' 2>/dev/null | head -c 100)..."
fi

# 测试3: Anthropic协议端点
echo ""
echo "🧪 测试3: Anthropic协议端点测试"
ANTHROPIC_RESPONSE=$(curl -s -X POST http://localhost:5520/v1/messages \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer lmstudio-test-key" \
  -d '{
    "model": "gpt-oss-20b-mlx",
    "max_tokens": 100,
    "messages": [
      {"role": "user", "content": "Hello, please introduce yourself"}
    ]
  }')

if echo "$ANTHROPIC_RESPONSE" | grep -q '"content"'; then
    echo "✅ Anthropic协议端点测试通过"
    echo "📝 响应内容: $(echo "$ANTHROPIC_RESPONSE" | jq -r '.content[0].text' 2>/dev/null | head -c 100)..."
else
    echo "❌ Anthropic协议端点测试失败"
    echo "🔍 响应内容: $ANTHROPIC_RESPONSE"
fi

# 测试4: 流式响应
echo ""
echo "🧪 测试4: 流式响应测试"
STREAM_RESPONSE=$(curl -s -X POST http://localhost:5520/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer lmstudio-test-key" \
  -d '{
    "model": "gpt-oss-20b-mlx",
    "messages": [
      {"role": "user", "content": "请数到5"}
    ],
    "max_tokens": 50,
    "stream": true
  }')

if echo "$STREAM_RESPONSE" | grep -q '"data"'; then
    echo "✅ 流式响应测试通过"
    STREAM_COUNT=$(echo "$STREAM_RESPONSE" | grep -c '"data"' || echo "0")
    echo "📊 流式数据包数量: $STREAM_COUNT"
else
    echo "⚠️  流式响应测试未通过"
fi

# 清理
echo ""
echo "🧹 清理测试环境..."
kill $SERVER_PID 2>/dev/null
sleep 2

echo ""
echo "🎉 LM Studio 集成测试完成！"
echo "📄 详细日志保存在: lmstudio-test.log"
