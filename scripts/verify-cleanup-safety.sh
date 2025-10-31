#!/bin/bash

# RouteCodex 清理安全验证脚本
# 在执行清理前验证安全性

set -e

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

# 项目根目录
PROJECT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"

# 日志函数
log_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

log_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

log_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

log_error() {
    echo -e "${RED}❌ $1${NC}"
}

# 检查Git状态
check_git_status() {
    log_info "检查Git状态..."

    if [[ -n $(git status --porcelain) ]]; then
        log_warning "检测到未提交的变更:"
        git status --short
        log_info "建议先提交或暂存所有变更"
        return 1
    fi

    log_success "Git状态正常"
}

# 检查分支状态
check_branch_status() {
    log_info "检查当前分支状态..."

    local current_branch=$(git branch --show-current)
    local main_branch=$(git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@')

    if [[ "$current_branch" == "$main_branch" ]]; then
        log_warning "当前在主分支 ($main_branch) 上"
        log_info "建议在特性分支上执行清理操作"
        return 1
    fi

    log_success "当前分支: $current_branch"
}

# 检查测试状态
check_test_status() {
    log_info "检查当前测试状态..."

    # 类型检查
    if npm run typecheck &>/dev/null; then
        log_success "类型检查通过"
    else
        log_error "类型检查失败"
        return 1
    fi

    # 单元测试
    if npm test &>/dev/null; then
        log_success "单元测试通过"
    else
        log_error "单元测试失败"
        return 1
    fi

    # 构建测试
    if npm run build &>/dev/null; then
        log_success "构建测试通过"
    else
        log_error "构建测试失败"
        return 1
    fi

    log_success "所有测试检查通过"
}

# 分析废弃函数风险
analyze_dead_code_risks() {
    log_info "分析废弃函数风险..."

    if [[ ! -f "dead-code-analysis-report.json" ]]; then
        log_error "未找到废弃代码分析报告"
        log_info "请先运行: node dead-code-analyzer.cjs"
        return 1
    fi

    # 统计风险级别
    if command -v jq &> /dev/null; then
        local high_risk=$(jq '.riskAssessment.high | length' dead-code-analysis-report.json)
        local medium_risk=$(jq '.riskAssessment.medium | length' dead-code-analysis-report.json)
        local low_risk=$(jq '.riskAssessment.low | length' dead-code-analysis-report.json)

        log_info "风险分析结果:"
        echo "  高风险项目: $high_risk"
        echo "  中风险项目: $medium_risk"
        echo "  低风险项目: $low_risk"

        if [[ $high_risk -gt 5 ]]; then
            log_warning "高风险项目较多 ($high_risk)，建议谨慎清理"
        fi

        if [[ $high_risk -eq 0 && $medium_risk -lt 10 ]]; then
            log_success "风险较低，可以安全进行清理"
        fi
    else
        log_warning "jq 未找到，无法分析风险级别"
    fi
}

# 检查关键文件
check_critical_files() {
    log_info "检查关键文件状态..."

    local critical_files=(
        "package.json"
        "tsconfig.json"
        "src/index.ts"
        "src/server/http-server.ts"
        "CLAUDE.md"
    )

    for file in "${critical_files[@]}"; do
        if [[ -f "$file" ]]; then
            log_success "关键文件存在: $file"
        else
            log_error "关键文件缺失: $file"
            return 1
        fi
    done
}

# 检查依赖状态
check_dependencies() {
    log_info "检查依赖状态..."

    if [[ -f "package-lock.json" ]]; then
        log_success "package-lock.json 存在"
    else
        log_warning "package-lock.json 不存在"
    fi

    if npm ls --depth=0 &>/dev/null; then
        log_success "依赖状态正常"
    else
        log_error "依赖检查失败，可能存在依赖问题"
        return 1
    fi
}

# 检查CI/CD状态
check_cicd_status() {
    log_info "检查CI/CD配置..."

    if [[ -f ".github/workflows" ]]; then
        local workflows=$(find .github/workflows -name "*.yml" -o -name "*.yaml" | wc -l)
        log_success "找到 $workflows 个CI/CD工作流"
    else
        log_info "未找到CI/CD配置"
    fi
}

# 生成安全报告
generate_safety_report() {
    log_info "生成安全验证报告..."

    local report_file="cleanup-safety-report-$(date +%Y%m%d-%H%M%S).md"

    cat > "$report_file" << EOF
# 清理安全验证报告

**验证时间**: $(date)
**分支**: $(git branch --show-current)
**提交**: $(git rev-parse HEAD)

## 安全检查结果

### ✅ 通过的检查
- Git状态检查
- 测试状态检查
- 关键文件检查
- 依赖状态检查

### ⚠️ 注意事项
- 请在特性分支上执行清理
- 定期提交清理进度
- 监控测试结果

### 📊 风险评估
$(if command -v jq &> /dev/null && [[ -f "dead-code-analysis-report.json" ]]; then
    echo "- 高风险项目: $(jq '.riskAssessment.high | length' dead-code-analysis-report.json)"
    echo "- 中风险项目: $(jq '.riskAssessment.medium | length' dead-code-analysis-report.json)"
    echo "- 低风险项目: $(jq '.riskAssessment.low | length' dead-code-analysis-report.json)"
else
    echo "- 无法分析风险级别（需要jq工具）"
fi)

## 建议

1. **低风险清理** (推荐立即执行):
   - 未使用的导入
   - 明显的死代码块
   - 未使用的常量

2. **中风险清理** (需要测试):
   - 工具函数
   - 类型定义
   - 配置常量

3. **高风险清理** (需要全面测试):
   - 可能动态调用的函数
   - 核心配置类型
   - OAuth相关函数

## 清理步骤

1. 执行低风险清理
   \`\`\`bash
   ./scripts/cleanup-unused-code.sh imports
   ./scripts/cleanup-unused-code.sh dead-code
   ./scripts/cleanup-unused-code.sh constants
   \`\`\`

2. 运行测试验证
   \`\`\`bash
   ./scripts/cleanup-unused-code.sh test
   \`\`\`

3. 执行中风险清理（可选）
   \`\`\`bash
   ./scripts/cleanup-unused-code.sh functions
   \`\`\`

4. 提交变更
   \`\`\`bash
   git add .
   git commit -m "cleanup: remove unused code and imports"
   \`\`\`

5. 创建Pull Request进行Code Review
EOF

    log_success "安全验证报告已生成: $report_file"
}

# 主函数
main() {
    echo "🔒 RouteCodex 清理安全验证脚本"
    echo "=================================="

    local failed_checks=0

    # 执行各项检查
    check_git_status || ((failed_checks++))
    check_branch_status || ((failed_checks++))
    check_test_status || ((failed_checks++))
    check_critical_files || ((failed_checks++))
    check_dependencies || ((failed_checks++))
    check_cicd_status
    analyze_dead_code_risks

    echo ""
    if [[ $failed_checks -eq 0 ]]; then
        log_success "✅ 所有安全检查通过，可以安全执行清理"
        generate_safety_report
        echo ""
        echo "🚀 现在可以执行清理:"
        echo "   ./scripts/cleanup-unused-code.sh all"
    else
        log_error "❌ 发现 $failed_checks 个安全问题，请先解决后再执行清理"
        echo ""
        echo "🔧 建议的修复步骤:"
        if [[ -n $(git status --porcelain) ]]; then
            echo "   1. 提交或暂存所有变更"
        fi
        echo "   2. 确保所有测试通过"
        echo "   3. 创建特性分支"
        echo "   4. 重新运行安全验证"
        exit 1
    fi
}

# 检查是否直接运行脚本
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi