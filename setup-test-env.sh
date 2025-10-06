#!/bin/bash

# Anthropic <> OpenAI LLMSwitch 测试环境准备脚本

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# 配置
SERVER_PORT=5506
SERVER_HOST="localhost"
API_KEY="test-key"
LOG_DIR="$HOME/.routecodex/logs"

echo -e "${BLUE}🔧 RouteCodex Anthropic <> OpenAI LLMSwitch 测试环境准备${NC}"
echo ""

# 创建日志目录
create_log_dir() {
    echo -e "${YELLOW}📁 创建日志目录...${NC}"
    mkdir -p "$LOG_DIR"
    echo -e "${GREEN}✓ 日志目录已创建: $LOG_DIR${NC}"
}

# 检查服务器状态
check_server_status() {
    echo -e "${YELLOW}🔍 检查服务器状态...${NC}"
    
    if curl -s "http://$SERVER_HOST:$SERVER_PORT/health" > /dev/null 2>&1; then
        echo -e "${GREEN}✓ 服务器正在运行 (端口: $SERVER_PORT)${NC}"
        return 0
    else
        echo -e "${RED}✗ 服务器未运行或不可访问${NC}"
        return 1
    fi
}

# 启动服务器
start_server() {
    echo -e "${YELLOW}🚀 启动RouteCodex服务器...${NC}"
    
    # 检查是否已有进程运行
    if pgrep -f "node.*index.js" > /dev/null; then
        echo -e "${YELLOW}⚠️  检测到RouteCodex进程正在运行${NC}"
        echo -e "${YELLOW}🔄 重启服务器...${NC}"
        pkill -f "node.*index.js" || true
        sleep 2
    fi
    
    # 启动服务器
    nohup npm start > "$LOG_DIR/server.log" 2>&1 &
    SERVER_PID=$!
    
    echo -e "${GREEN}✓ 服务器启动中 (PID: $SERVER_PID)${NC}"
    echo -e "${BLUE}📋 日志文件: $LOG_DIR/server.log${NC}"
    
    # 等待服务器启动
    echo -e "${YELLOW}⏳ 等待服务器启动...${NC}"
    for i in {1..30}; do
        if curl -s "http://$SERVER_HOST:$SERVER_PORT/health" > /dev/null 2>&1; then
            echo -e "${GREEN}✓ 服务器启动成功${NC}"
            return 0
        fi
        sleep 1
        echo -n "."
    done
    
    echo -e "${RED}✗ 服务器启动失败${NC}"
    echo -e "${BLUE}📋 查看日志: tail -f $LOG_DIR/server.log${NC}"
    return 1
}

# 设置环境变量
setup_environment() {
    echo -e "${YELLOW}🌍 设置环境变量...${NC}"
    
    # 设置Anthropic相关环境变量
    export ANTHROPIC_BASE_URL="http://$SERVER_HOST:$SERVER_PORT/v1"
    export ANTHROPIC_API_KEY="$API_KEY"
    
    # 添加到当前shell会话
    echo "export ANTHROPIC_BASE_URL=\"$ANTHROPIC_BASE_URL\"" >> ~/.bashrc
    echo "export ANTHROPIC_API_KEY=\"$API_KEY\"" >> ~/.bashrc
    
    echo -e "${GREEN}✓ 环境变量已设置:${NC}"
    echo -e "${BLUE}   ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL${NC}"
    echo -e "${BLUE}   ANTHROPIC_API_KEY=$API_KEY${NC}"
}

# 验证配置
verify_configuration() {
    echo -e "${YELLOW}✅ 验证配置...${NC}"
    
    # 检查服务器配置
    echo -e "${BLUE}📋 服务器配置:${NC}"
    curl -s "http://$SERVER_HOST:$SERVER_PORT/config" | jq '.' 2>/dev/null || curl -s "http://$SERVER_HOST:$SERVER_PORT/config"
    
    echo ""
    echo -e "${BLUE}📋 健康检查:${NC}"
    curl -s "http://$SERVER_HOST:$SERVER_PORT/health" | jq '.' 2>/dev/null || curl -s "http://$SERVER_HOST:$SERVER_PORT/health"
    
    echo ""
    echo -e "${BLUE}📋 环境变量:${NC}"
    echo "   ANTHROPIC_BASE_URL=$ANTHROPIC_BASE_URL"
    echo "   ANTHROPIC_API_KEY=$API_KEY"
}

# 测试Claude客户端连接
test_claude_connection() {
    echo -e "${YELLOW}🔌 测试Claude客户端连接...${NC}"
    
    if command -v claude > /dev/null 2>&1; then
        echo -e "${GREEN}✓ Claude客户端已安装${NC}"
        
        echo -e "${BLUE}🧪 测试基础连接...${NC}"
        if timeout 30 claude --print "Hello, respond with 'Connection test successful'" 2>&1 | grep -q "Connection test successful"; then
            echo -e "${GREEN}✓ Claude客户端连接测试通过${NC}"
        else
            echo -e "${RED}✗ Claude客户端连接测试失败${NC}"
            echo -e "${BLUE}💡 请检查Claude客户端配置和网络连接${NC}"
        fi
    else
        echo -e "${RED}✗ Claude客户端未安装${NC}"
        echo -e "${BLUE}💡 请安装Claude客户端: https://docs.anthropic.com/claude/reference/client-api${NC}"
    fi
}

# 生成测试脚本快捷方式
create_test_shortcuts() {
    echo -e "${YELLOW}⚡ 创建测试快捷方式...${NC}"
    
    # 创建快速测试脚本
    cat > quick-test.sh << 'EOF'
#!/bin/bash
echo "🧪 快速测试 Anthropic <> OpenAI LLMSwitch"
echo ""

# 测试基础连接
echo "1. 测试基础连接..."
claude --print "Hello, respond with 'Quick test OK'" || echo "❌ 基础连接失败"

echo ""
echo "2. 测试上下文保持..."
claude --print "Remember: I like coffee" > /dev/null 2>&1
claude --print "What drink do I like?" || echo "❌ 上下文保持失败"

echo ""
echo "3. 测试工具调用..."
claude --print "Use calculator to compute 5+3" || echo "❌ 工具调用失败"

echo ""
echo "✅ 快速测试完成"
EOF
    
    chmod +x quick-test.sh
    echo -e "${GREEN}✓ 快速测试脚本已创建: ./quick-test.sh${NC}"
    
    # 创建监控脚本
    cat > monitor-server.sh << 'EOF'
#!/bin/bash
echo "📊 监控 RouteCodex 服务器状态"
echo ""

echo "🔍 服务器健康状态:"
curl -s http://localhost:5506/health | jq '.' 2>/dev/null || curl -s http://localhost:5506/health

echo ""
echo "📋 最近的服务器日志:"
tail -n 20 ~/.routecodex/logs/server.log

echo ""
echo "📈 系统资源使用:"
top -l 1 | head -n 10
EOF
    
    chmod +x monitor-server.sh
    echo -e "${GREEN}✓ 监控脚本已创建: ./monitor-server.sh${NC}"
}

# 显示使用说明
show_usage() {
    echo ""
    echo -e "${BLUE}📖 使用说明:${NC}"
    echo ""
    echo -e "${GREEN}1. 运行完整测试:${NC}"
    echo "   ./test-anthropic-openai.sh"
    echo ""
    echo -e "${GREEN}2. 快速测试:${NC}"
    echo "   ./quick-test.sh"
    echo ""
    echo -e "${GREEN}3. 监控服务器:${NC}"
    echo "   ./monitor-server.sh"
    echo ""
    echo -e "${GREEN}4. 手动测试:${NC}"
    echo "   claude --print \"Your test message here\""
    echo ""
    echo -e "${GREEN}5. 查看日志:${NC}"
    echo "   tail -f ~/.routecodex/logs/server.log"
    echo ""
    echo -e "${GREEN}6. 停止服务器:${NC}"
    echo "   pkill -f 'node.*index.js'"
    echo ""
}

# 主函数
main() {
    echo -e "${BLUE}开始准备测试环境...${NC}"
    echo ""
    
    # 1. 创建日志目录
    create_log_dir
    
    # 2. 检查服务器状态
    if ! check_server_status; then
        # 3. 启动服务器
        if ! start_server; then
            echo -e "${RED}❌ 无法启动服务器，请检查配置${NC}"
            exit 1
        fi
    fi
    
    # 4. 设置环境变量
    setup_environment
    
    # 5. 验证配置
    verify_configuration
    
    # 6. 测试Claude连接
    test_claude_connection
    
    # 7. 创建测试快捷方式
    create_test_shortcuts
    
    # 8. 显示使用说明
    show_usage
    
    echo ""
    echo -e "${GREEN}🎉 测试环境准备完成！${NC}"
    echo -e "${BLUE}🚀 现在可以运行 ./test-anthropic-openai.sh 进行完整测试${NC}"
}

# 运行主函数
main "$@"