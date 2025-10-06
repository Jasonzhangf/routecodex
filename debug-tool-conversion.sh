#!/bin/bash

# 工具调用转换测试

echo "=== 工具调用转换详细测试 ==="

# 测试1: 验证Anthropic工具定义转换为OpenAI格式
echo "1. 测试Anthropic工具定义转换..."

anthropic_tool='{
  "name": "calculator",
  "description": "Perform calculations",
  "input_schema": {
    "type": "object",
    "properties": {
      "operation": {"type": "string"},
      "operands": {"type": "array", "items": {"type": "number"}}
    }
  }
}'

openai_tool='{
  "type": "function",
  "function": {
    "name": "calculator",
    "description": "Perform calculations",
    "parameters": {
      "type": "object",
      "properties": {
        "operation": {"type": "string"},
        "operands": {"type": "array", "items": {"type": "number"}}
      }
    }
  }
}'

echo "Anthropic格式工具定义:"
echo "$anthropic_tool" | jq .
echo ""
echo "期望的OpenAI格式:"
echo "$openai_tool" | jq .
echo ""

# 测试2: 发送Anthropic请求并检查响应
echo "2. 发送Anthropic格式请求..."

request='{
  "model": "glm-4.6",
  "max_tokens": 100,
  "tools": [
    {
      "name": "get_current_time",
      "description": "Get the current time",
      "input_schema": {"type": "object", "properties": {}}
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": "What time is it now? Use the get_current_time tool."
    }
  ]
}'

echo "发送请求:"
echo "$request" | jq .
echo ""

response=$(curl -s -X POST "http://localhost:5520/v1/anthropic/messages" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test-key" \
    -d "$request")

echo "收到响应:"
echo "$response" | jq .

# 检查响应格式
finish_reason=$(echo "$response" | jq -r '.choices[0].finish_reason')
has_tool_calls=$(echo "$response" | jq '.choices[0].message.tool_calls // null')

echo ""
echo "=== 分析结果 ==="
echo "Finish Reason: $finish_reason"
echo "Has Tool Calls: $has_tool_calls"

if [ "$finish_reason" = "tool_calls" ] && [ "$has_tool_calls" != "null" ]; then
    echo "✅ OpenAI格式工具调用正常"
elif [ "$finish_reason" = "tool_use" ] && echo "$response" | jq -e '.content[] | select(.type=="tool_use")' > /dev/null; then
    echo "✅ Anthropic格式工具调用正常"
else
    echo "❌ 工具调用转换可能有问题"
fi

# 测试3: 对比OpenAI格式
echo ""
echo "3. 对比OpenAI格式请求..."

openai_request='{
  "model": "glm-4.6",
  "max_tokens": 100,
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "get_current_time",
        "description": "Get the current time",
        "parameters": {"type": "object", "properties": {}}
      }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": "What time is it now? Use the get_current_time tool."
    }
  ]
}'

openai_response=$(curl -s -X POST "http://localhost:5520/v1/openai/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer test-key" \
    -d "$openai_request")

echo "OpenAI格式响应:"
echo "$openai_response" | jq '.choices[0] | {finish_reason, message: {role, content, tool_calls}}'

echo ""
echo "=== 测试完成 ==="