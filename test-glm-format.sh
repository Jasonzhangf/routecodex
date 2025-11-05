#!/usr/bin/env bash

# GLM API工具调用格式测试脚本

echo "🔍 GLM API工具调用格式验证"
echo "========================="

# 配置（需要从实际配置文件获取）
API_KEY="${GLM_API_KEY:-your-api-key-here}"
BASE_URL="https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"

if [[ "$API_KEY" == "your-api-key-here" ]]; then
  echo "❌ 请设置GLM_API_KEY环境变量"
  exit 1
fi

echo "① 测试数组格式参数（当前错误格式）"

# 数组格式（当前有问题的格式）
cat > /tmp/glm_test_array.json << 'EOF'
{
  "model": "glm-4.5-air",
  "messages": [
    {
      "role": "user",
      "content": "列出当前目录文件"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "shell",
        "description": "Execute shell command",
        "parameters": {
          "type": "object",
          "properties": {
            "command": {
              "type": "array",
              "items": {"type": "string"}
            }
          }
        }
      }
    }
  ],
  "tool_choice": "auto"
}
EOF

echo "② 测试字符串格式参数（修正格式）"

# 字符串格式（修正后的格式）
cat > /tmp/glm_test_string.json << 'EOF'
{
  "model": "glm-4.5-air",
  "messages": [
    {
      "role": "user",
      "content": "列出当前目录文件"
    }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "shell",
        "description": "Execute shell command",
        "parameters": {
          "type": "object",
          "properties": {
            "command": {
              "type": "string"
            }
          }
        }
      }
    }
  ],
  "tool_choice": "auto"
}
EOF

echo "③ 测试无工具调用请求"

# 无工具调用
cat > /tmp/glm_test_no_tools.json << 'EOF'
{
  "model": "glm-4.5-air",
  "messages": [
    {
      "role": "user",
      "content": "列出当前目录文件"
    }
  ]
}
EOF

echo ""
echo "执行测试..."
echo ""

# 测试1：数组格式（预期失败）
echo "🔸 测试1: 数组格式参数（预期1210错误）"
response1=$(curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d @/tmp/glm_test_array.json \
  -w "\nHTTP_STATUS:%{http_code}" \
  "$BASE_URL")

echo "$response1" | grep -E "(HTTP_STATUS|error|message)" || echo "无错误信息"

# 测试2：字符串格式（预期成功）
echo -e "\n🔸 测试2: 字符串格式参数（预期成功)"
response2=$(curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d @/tmp/glm_test_string.json \
  -w "\nHTTP_STATUS:%{http_code}" \
  "$BASE_URL")

echo "$response2" | grep -E "(HTTP_STATUS|error|message)" || echo "请求成功"

# 测试3：无工具调用（预期成功）
echo -e "\n🔸 测试3: 无工具调用（预期成功)"
response3=$(curl -s -X POST \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d @/tmp/glm_test_no_tools.json \
  -w "\nHTTP_STATUS:%{http_code}" \
  "$BASE_URL")

echo "$response3" | grep -E "(HTTP_STATUS|error|message)" || echo "请求成功"

echo ""
echo "📝 测试完成，检查响应状态码和错误信息"
echo "🗂️  临时文件: /tmp/glm_test_*.json"