#!/bin/bash

# 复杂工具多轮调用测试
# 重点关注：工具调用转换、finish reason、工具调用结果双向转换

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 测试配置
SERVER_URL="http://localhost:5520"
TEST_LOG="complex-tools-test.log"
API_KEY="test-key"

# 初始化日志
init_log() {
    echo "=== 复杂工具多轮调用测试 ===" > $TEST_LOG
    echo "开始时间: $(date)" >> $TEST_LOG
}

# 日志记录函数
log_test() {
    echo -e "${GREEN}[TEST]${NC} $1"
    echo "[TEST] $1" >> $TEST_LOG
}

log_info() {
    echo -e "${YELLOW}[INFO]${NC} $1"
    echo "[INFO] $1" >> $TEST_LOG
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
    echo "[ERROR] $1" >> $TEST_LOG
}

log_detail() {
    echo -e "${BLUE}[DETAIL]${NC} $1"
    echo "[DETAIL] $1" >> $TEST_LOG
}

# 测试前置检查
check_prerequisites() {
    log_info "检查测试前置条件..."
    
    # 检查服务器状态
    if ! curl -s "$SERVER_URL/health" > /dev/null; then
        log_error "服务器未运行或不可访问: $SERVER_URL"
        exit 1
    fi
    
    # 检查环境变量
    if [ -z "$ANTHROPIC_BASE_URL" ]; then
        log_info "设置 ANTHROPIC_BASE_URL=$SERVER_URL/v1"
        export ANTHROPIC_BASE_URL="$SERVER_URL/v1"
    fi
    
    if [ -z "$ANTHROPIC_API_KEY" ]; then
        log_info "设置 ANTHROPIC_API_KEY=$API_KEY"
        export ANTHROPIC_API_KEY="$API_KEY"
    fi
    
    log_test "前置条件检查完成"
}

# 测试1: 复杂计算器工具调用
test_complex_calculator() {
    log_test "测试1: 复杂计算器工具调用"
    
    cat > /tmp/test1_request.json << 'EOF'
{
  "model": "glm-4.6",
  "max_tokens": 1024,
  "tools": [
    {
      "name": "calculator",
      "description": "Perform complex mathematical calculations",
      "input_schema": {
        "type": "object",
        "properties": {
          "expression": {
            "type": "string",
            "description": "Mathematical expression to evaluate"
          },
          "operation": {
            "type": "string",
            "enum": ["add", "subtract", "multiply", "divide", "power", "sqrt"],
            "description": "Type of operation"
          },
          "operands": {
            "type": "array",
            "items": {"type": "number"},
            "description": "Numbers to operate on"
          }
        },
        "required": ["operation"]
      }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": "Calculate (15 * 8) + (32 / 4) - sqrt(16)"
    }
  ]
}
EOF

    log_detail "发送复杂计算请求..."
    response=$(curl -s -X POST "$SERVER_URL/v1/anthropic/messages" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $API_KEY" \
        -d @/tmp/test1_request.json)
    
    echo "$response" >> $TEST_LOG
    
    if echo "$response" | grep -q "tool_use"; then
        log_test "✓ 工具调用请求转换正确"
        
        # 提取工具调用ID和参数
        tool_call_id=$(echo "$response" | jq -r '.content[] | select(.type=="tool_use") | .id')
        log_detail "工具调用ID: $tool_call_id"
        
        # 模拟工具调用结果
        cat > /tmp/test1_result.json << EOF
{
  "model": "claude-3-sonnet-20240229",
  "max_tokens": 1024,
  "tools": [
    {
      "name": "calculator",
      "description": "Perform complex mathematical calculations",
      "input_schema": {
        "type": "object",
        "properties": {
          "expression": {"type": "string"},
          "operation": {"type": "string"},
          "operands": {"type": "array", "items": {"type": "number"}}
        },
        "required": ["operation"]
      }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": "Calculate (15 * 8) + (32 / 4) - sqrt(16)"
    },
    {
      "role": "assistant",
      "content": [
        {
          "type": "text",
          "text": "I'll help you calculate this complex expression step by step."
        },
        {
          "type": "tool_use",
          "id": "$tool_call_id",
          "name": "calculator",
          "input": {"operation": "multiply", "operands": [15, 8]}
        }
      ]
    },
    {
      "role": "user",
      "content": [
        {
          "type": "tool_result",
          "tool_use_id": "$tool_call_id",
          "content": "120"
        }
      ]
    }
  ]
}
EOF

        log_detail "发送工具调用结果..."
        result_response=$(curl -s -X POST "$SERVER_URL/v1/anthropic/messages" \
            -H "Content-Type: application/json" \
            -H "Authorization: Bearer $API_KEY" \
            -d @/tmp/test1_result.json)
        
        echo "$result_response" >> $TEST_LOG
        
        if echo "$result_response" | grep -q "end_turn"; then
            log_test "✓ finish reason转换正确"
        else
            log_error "✗ finish reason转换失败"
        fi
    else
        log_error "✗ 工具调用请求转换失败"
    fi
}

# 测试2: 多工具链式调用
test_multi_tool_chain() {
    log_test "测试2: 多工具链式调用"
    
    cat > /tmp/test2_request.json << 'EOF'
{
  "model": "claude-3-sonnet-20240229",
  "max_tokens": 1024,
  "tools": [
    {
      "name": "web_search",
      "description": "Search the web for information",
      "input_schema": {
        "type": "object",
        "properties": {
          "query": {"type": "string"},
          "max_results": {"type": "integer", "default": 5}
        },
        "required": ["query"]
      }
    },
    {
      "name": "data_analyzer",
      "description": "Analyze and process data",
      "input_schema": {
        "type": "object",
        "properties": {
          "data": {"type": "array"},
          "analysis_type": {"type": "string", "enum": ["sum", "average", "max", "min"]}
        },
        "required": ["data", "analysis_type"]
      }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": "Search for 'AI market trends 2024' and then analyze the results for average growth rate"
    }
  ]
}
EOF

    log_detail "发送多工具链式调用请求..."
    response=$(curl -s -X POST "$SERVER_URL/v1/anthropic/messages" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $API_KEY" \
        -d @/tmp/test2_request.json)
    
    echo "$response" >> $TEST_LOG
    
    # 检查是否包含工具调用
    tool_uses=$(echo "$response" | jq '.content[] | select(.type=="tool_use") | .name' | wc -l)
    if [ "$tool_uses" -gt 0 ]; then
        log_test "✓ 多工具调用转换正确 ($tool_uses 个工具)"
        
        # 检查每个工具调用的结构
        tool_names=$(echo "$response" | jq -r '.content[] | select(.type=="tool_use") | .name')
        for tool_name in $tool_names; do
            log_detail "工具调用: $tool_name"
        done
    else
        log_error "✗ 多工具调用转换失败"
    fi
}

# 测试3: 流式工具调用
test_streaming_tools() {
    log_test "测试3: 流式工具调用"
    
    cat > /tmp/test3_request.json << 'EOF'
{
  "model": "claude-3-sonnet-20240229",
  "max_tokens": 1024,
  "stream": true,
  "tools": [
    {
      "name": "code_executor",
      "description": "Execute code and return results",
      "input_schema": {
        "type": "object",
        "properties": {
          "code": {"type": "string"},
          "language": {"type": "string", "enum": ["python", "javascript", "bash"]}
        },
        "required": ["code", "language"]
      }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": "Write a Python function to calculate fibonacci numbers and execute it"
    }
  ]
}
EOF

    log_detail "发送流式工具调用请求..."
    response=$(curl -s -X POST "$SERVER_URL/v1/anthropic/messages" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $API_KEY" \
        -d @/tmp/test3_request.json)
    
    echo "$response" >> $TEST_LOG
    
    # 检查流式响应中的工具调用事件
    if echo "$response" | grep -q "tool_use"; then
        log_test "✓ 流式工具调用转换正确"
    else
        log_error "✗ 流式工具调用转换失败"
    fi
}

# 测试4: 工具调用错误处理
test_tool_error_handling() {
    log_test "测试4: 工具调用错误处理"
    
    cat > /tmp/test4_request.json << 'EOF'
{
  "model": "claude-3-sonnet-20240229",
  "max_tokens": 1024,
  "tools": [
    {
      "name": "file_reader",
      "description": "Read file contents",
      "input_schema": {
        "type": "object",
        "properties": {
          "file_path": {"type": "string"}
        },
        "required": ["file_path"]
      }
    }
  ],
  "messages": [
    {
      "role": "user",
      "content": "Read the file /nonexistent/file.txt"
    }
  ]
}
EOF

    log_detail "发送工具错误处理请求..."
    response=$(curl -s -X POST "$SERVER_URL/v1/anthropic/messages" \
        -H "Content-Type: application/json" \
        -H "Authorization: Bearer $API_KEY" \
        -d @/tmp/test4_request.json)
    
    echo "$response" >> $TEST_LOG
    
    # 检查错误处理
    if echo "$response" | grep -q -E "(error|Error|ERROR)" || echo "$response" | grep -q "tool_result"; then
        log_test "✓ 工具调用错误处理正确"
    else
        log_error "✗ 工具调用错误处理失败"
    fi
}

# 生成测试报告
generate_report() {
    log_test "生成测试报告..."
    
    echo "" >> $TEST_LOG
    echo "=== 测试完成 ===" >> $TEST_LOG
    echo "结束时间: $(date)" >> $TEST_LOG
    
    # 统计测试结果
    total_tests=$(grep -c "\[TEST\]" $TEST_LOG)
    passed_tests=$(grep -c "✓" $TEST_LOG)
    failed_tests=$(grep -c "✗" $TEST_LOG)
    
    echo ""
    echo "📊 测试统计:"
    echo "  总测试数: $total_tests"
    echo "  通过测试: $passed_tests"
    echo "  失败测试: $failed_tests"
    echo "  成功率: $(( passed_tests * 100 / total_tests ))%"
    echo ""
    echo "📋 详细日志: $TEST_LOG"
}

# 主测试流程
main() {
    echo "🚀 开始复杂工具多轮调用测试"
    echo "重点关注：工具调用转换、finish reason、工具调用结果双向转换"
    echo ""
    
    init_log
    check_prerequisites
    test_complex_calculator
    test_multi_tool_chain
    test_streaming_tools
    test_tool_error_handling
    generate_report
    
    echo ""
    echo "🎉 复杂工具多轮调用测试完成！"
}

# 运行测试
main "$@"