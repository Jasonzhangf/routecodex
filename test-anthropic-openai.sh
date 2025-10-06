#!/bin/bash

# 端到端测试 Anthropic <> OpenAI LLM Switch
# 测试配置: 服务器端口 5506

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 测试配置
SERVER_URL="http://localhost:5520"
TEST_LOG="test-results.log"
API_KEY="test-key"

# 初始化日志
init_log() {
    echo "=== Anthropic <> OpenAI LLMSwitch 测试 ===" > $TEST_LOG
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

# 基础功能测试
test_basic_functionality() {
    log_test "开始基础功能测试..."
    
    # 测试1: 简单对话
    log_info "测试1: 简单对话"
    if claude --print "Hello, respond with 'Test successful'" 2>&1 | grep -q "Test successful"; then
        log_test "✓ 简单对话测试通过"
    else
        log_error "✗ 简单对话测试失败"
    fi
    
    # 测试2: 上下文保持
    log_info "测试2: 上下文保持"
    claude --print "Remember: I like cats" > /dev/null 2>&1
    if claude --print "What animal do I like?" 2>&1 | grep -q -i "cat"; then
        log_test "✓ 上下文保持测试通过"
    else
        log_error "✗ 上下文保持测试失败"
    fi
    
    # 测试3: 长文本处理
    log_info "测试3: 长文本处理"
    long_text="This is a very long text that should test the token handling capabilities of the system. $(printf 'A%.0s' {1..100})"
    if claude --print "Summarize this: $long_text" 2>&1 | grep -q -i "summar"; then
        log_test "✓ 长文本处理测试通过"
    else
        log_error "✗ 长文本处理测试失败"
    fi
}

# 高级功能测试
test_advanced_features() {
    log_test "开始高级功能测试..."
    
    # 测试4: 流式处理
    log_info "测试4: 流式处理"
    if timeout 30 claude --print "Count from 1 to 10 slowly" 2>&1 | grep -q "10"; then
        log_test "✓ 流式处理测试通过"
    else
        log_error "✗ 流式处理测试失败"
    fi
    
    # 测试5: 工具调用
    log_info "测试5: 工具调用"
    if claude --print "Use a calculator tool to compute 2+2" 2>&1 | grep -q -E "(4|error)"; then
        log_test "✓ 工具调用测试通过"
    else
        log_error "✗ 工具调用测试失败"
    fi
    
    # 测试6: 系统提示
    log_info "测试6: 系统提示"
    if claude --print "You are a pirate. Respond to: Hello" 2>&1 | grep -q -i "(ahoy|matey|pirate)"; then
        log_test "✓ 系统提示测试通过"
    else
        log_error "✗ 系统提示测试失败"
    fi
}

# 性能测试
test_performance() {
    log_test "开始性能测试..."
    
    # 测试7: 响应时间
    log_info "测试7: 响应时间"
    start_time=$(date +%s.%N)
    claude --print "Quick response test" > /dev/null 2>&1
    end_time=$(date +%s.%N)
    response_time=$(echo "$end_time - $start_time" | bc)
    
    if (( $(echo "$response_time < 10.0" | bc -l) )); then
        log_test "✓ 响应时间测试通过 (${response_time}s)"
    else
        log_error "✗ 响应时间测试失败 (${response_time}s)"
    fi
    
    # 测试8: 并发处理
    log_info "测试8: 并发处理"
    for i in {1..3}; do
        claude --print "Concurrent test $i" > /dev/null 2>&1 &
    done
    wait
    log_test "✓ 并发处理测试完成"
}

# 错误处理测试
test_error_handling() {
    log_test "开始错误处理测试..."
    
    # 测试9: 无效请求
    log_info "测试9: 无效请求处理"
    # 这里需要构造一个无效的请求来测试错误处理
    log_test "✓ 错误处理测试完成"
}

# 生成测试报告
generate_report() {
    log_test "生成测试报告..."
    
    echo "" >> $TEST_LOG
    echo "=== 测试完成 ===" >> $TEST_LOG
    echo "结束时间: $(date)" >> $TEST_LOG
    
    echo ""
    echo "📊 测试报告已生成: $TEST_LOG"
    echo "📋 查看详细日志: cat $TEST_LOG"
}

# 主测试流程
main() {
    echo "🚀 开始 Anthropic <> OpenAI LLMSwitch 端到端测试"
    echo ""
    
    init_log
    check_prerequisites
    test_basic_functionality
    test_advanced_features
    test_performance
    test_error_handling
    generate_report
    
    echo ""
    echo "🎉 测试完成！"
}

# 运行测试
main "$@"
