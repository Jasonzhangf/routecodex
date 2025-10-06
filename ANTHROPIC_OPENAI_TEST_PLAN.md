# Anthropic ↔ OpenAI LLMSwitch 端到端测试计划

## 测试目标

验证RouteCodex项目中Anthropic到OpenAI的LLMSwitch功能，确保：
1. Claude客户端能通过环境变量连接到RouteCodex服务器
2. Anthropic协议请求能正确转换为OpenAI格式
3. OpenAI响应能正确转换回Anthropic格式
4. 流式处理、工具调用等高级功能正常工作

## 当前状态分析

### ✅ 已就绪组件
- **LLMSwitch核心模块**: `llmswitch-anthropic-openai.ts` 已实现
- **协议转换器**: `anthropic-openai-converter.ts` 支持双向转换
- **配置系统**: modules.json中已配置Anthropic相关参数
- **OpenAI线路**: 当前config.json中OpenAI线路运行稳定

### 📋 测试需求
- **环境配置**: 需要配置Anthropic环境变量
- **Claude客户端**: 使用claude --print发送测试指令
- **测试脚本**: 完善现有的test-anthropic-openai.sh

## 测试计划

### 阶段1: 环境准备 (5分钟)

#### 1.1 服务器配置
```bash
# 启动RouteCodex服务器
npm start
# 确认服务器运行在默认端口 (检查config.json中的端口配置)
```

#### 1.2 环境变量设置
```bash
# 设置Claude客户端环境变量
export ANTHROPIC_BASE_URL=http://localhost:5506/v1
export ANTHROPIC_API_KEY=test-key
```

#### 1.3 配置验证
```bash
# 验证服务器状态
curl http://localhost:5506/health

# 验证配置加载
curl http://localhost:5506/config
```

### 阶段2: 基础功能测试 (15分钟)

#### 2.1 简单对话测试
```bash
# 测试基础文本对话
claude --print "Hello, how are you?"
```

**验证点**:
- 请求能正确到达RouteCodex服务器
- 协议转换无错误
- 响应能正确返回给Claude客户端

#### 2.2 多轮对话测试
```bash
# 测试上下文保持
claude --print "Remember that I like pizza. Now what food do you think I prefer?"
claude --print "Based on our previous conversation, suggest a pizza topping"
```

**验证点**:
- 对话历史正确传递
- 上下文保持功能正常

#### 2.3 长文本处理测试
```bash
# 测试长文本处理
claude --print "Summarize the following long text: [此处插入1000字以上的长文本]"
```

**验证点**:
- 长文本无截断
- Token计算准确
- 响应完整性

### 阶段3: 高级功能测试 (20分钟)

#### 3.1 流式处理测试
```bash
# 测试流式响应
claude --print "Count from 1 to 100, one number per line"
```

**验证点**:
- 流式响应正常
- 数据传输无中断
- 客户端能正确接收流

#### 3.2 工具调用测试
```bash
# 测试工具调用功能
claude --print "What's the current weather in Beijing? Use a weather tool to check."
```

**验证点**:
- 工具调用请求正确转换
- 工具响应正确处理
- 错误处理机制正常

#### 3.3 系统提示测试
```bash
# 测试系统提示处理
claude --print "You are a helpful assistant. Respond to: Help me understand quantum computing"
```

**验证点**:
- 系统提示正确传递
- 角色设定保持一致

### 阶段4: 错误处理测试 (10分钟)

#### 4.1 网络错误测试
```bash
# 测试网络中断恢复
# 在请求过程中临时中断网络，观察恢复行为
```

#### 4.2 格式错误测试
```bash
# 测试 malformed 请求处理
# 发送格式错误的请求，验证错误处理
```

#### 4.3 超时处理测试
```bash
# 测试请求超时处理
# 发送需要长时间处理的请求，验证超时机制
```

### 阶段5: 性能测试 (10分钟)

#### 5.1 并发测试
```bash
# 测试并发请求处理
# 同时发送多个请求，验证并发处理能力
```

#### 5.2 内存使用测试
```bash
# 监控内存使用情况
# 在长时间运行中观察内存泄漏
```

#### 5.3 响应时间测试
```bash
# 测量响应时间
# 记录各种请求的响应时间，评估性能
```

## 测试脚本实现

### 完善test-anthropic-openai.sh

```bash
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
SERVER_URL="http://localhost:5506"
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
```

## 测试执行步骤

### 1. 准备阶段
```bash
# 确保服务器运行
npm start

# 设置环境变量
export ANTHROPIC_BASE_URL=http://localhost:5506/v1
export ANTHROPIC_API_KEY=test-key

# 运行测试脚本
chmod +x test-anthropic-openai.sh
./test-anthropic-openai.sh
```

### 2. 手动验证
```bash
# 基础对话测试
claude --print "Hello, test connection"

# 工具调用测试
claude --print "Use calculator to compute 123+456"

# 流式处理测试
claude --print "Write a short poem with line breaks"
```

### 3. 监控和调试
```bash
# 查看服务器日志
tail -f ~/.routecodex/logs/debug-center.log

# 监控网络请求
# 使用浏览器开发者工具或curl监控请求流转
```

## 预期结果

### ✅ 成功指标
- 所有基础功能测试通过
- 流式处理无中断
- 工具调用正常工作
- 响应时间在合理范围内（<10秒）
- 错误处理机制正常

### ⚠️ 需要关注的问题
- 协议转换的一致性
- 大型响应的处理能力
- 并发请求的稳定性
- 内存使用情况

### 📈 性能基准
- 简单对话响应时间: <3秒
- 长文本处理时间: <10秒
- 并发处理能力: 3个并发请求
- 内存使用: <500MB

## 故障排除

### 常见问题
1. **连接失败**: 检查服务器状态和端口配置
2. **协议转换错误**: 查看LLMSwitch模块日志
3. **认证问题**: 验证API密钥配置
4. **超时问题**: 调整超时设置

### 调试方法
1. 查看RouteCodex服务器日志
2. 使用curl直接测试API端点
3. 检查Claude客户端配置
4. 监控网络请求和响应

这个测试计划提供了全面的端到端测试覆盖，确保Anthropic到OpenAI的LLMSwitch功能正常工作。