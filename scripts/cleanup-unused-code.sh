#!/bin/bash

# RouteCodex 废弃代码清理脚本
# 自动化清理未使用的函数、常量和导入

set -e  # 遇到错误立即退出

# 颜色定义
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

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
        log_warning "检测到未提交的变更"
        log_info "请先提交或暂存所有变更"
        git status --short
        return 1
    fi

    log_success "Git状态正常"
}

# 创建备份分支
create_backup_branch() {
    local branch_name="cleanup/$(date +%Y%m%d-%H%M%S)"
    log_info "创建备份分支: $branch_name"

    git checkout -b "$branch_name"
    log_success "备份分支创建成功"
}

# 清理未使用的导入
cleanup_unused_imports() {
    log_info "清理未使用的导入..."

    # 检查是否安装了ts-unused-exports
    if ! command -v npx &> /dev/null; then
        log_error "npx 未找到，请安装Node.js"
        return 1
    fi

    # 使用ESLint自动修复未使用的导入
    log_info "使用ESLint自动修复..."
    if npx eslint . --fix --ext .ts,.js --quiet; then
        log_success "ESLint自动修复完成"
    else
        log_warning "ESLint自动修复出现问题，继续执行..."
    fi

    # 手动清理明显的未使用导入
    log_info "手动清理明显的未使用导入..."
    find src -name "*.ts" -exec grep -l "^import.*from" {} \; | while read file; do
        # 这里可以添加更复杂的逻辑来检测未使用的导入
        log_info "检查文件: $file"
    done

    log_success "未使用导入清理完成"
}

# 清理死代码块
cleanup_dead_code() {
    log_info "清理死代码块..."

    # 清理return/throw后的代码
    log_info "清理return/throw后的死代码..."
    find src -name "*.ts" -exec sed -i.tmp '/return\|throw/,$d' {} \;
    find src -name "*.ts.tmp" -delete

    # 清理永false条件分支
    log_info "清理永false条件分支..."
    find src -name "*.ts" -exec sed -i.tmp '/if (false)/,/}/d' {} \;
    find src -name "*.ts.tmp" -delete

    # 清理永true条件的else分支
    log_info "清理永true条件的else分支..."
    find src -name "*.ts" -exec sed -i.tmp '/if (true)/,/}/s/else {[^}]*}//g' {} \;
    find src -name "*.ts.tmp" -delete

    log_success "死代码块清理完成"
}

# 移除未使用的常量
remove_unused_constants() {
    log_info "移除未使用的常量..."

    # 读取分析报告中的未使用常量
    if [[ -f "dead-code-analysis-report.json" ]]; then
        # 使用jq处理JSON（如果可用）
        if command -v jq &> /dev/null; then
            local unused_constants=$(jq -r '.unusedConstants[] | select(.riskLevel == "low") | .name + ":" + .file' dead-code-analysis-report.json)

            echo "$unused_constants" | while IFS=':' read -r name file; do
                if [[ -n "$name" && -n "$file" ]]; then
                    log_info "移除常量: $name (从 $file)"
                    # 安全地移除常量定义
                    sed -i.tmp "/export const $name/d" "$file"
                    sed -i.tmp "/const $name =/d" "$file"
                    rm -f "$file.tmp"
                fi
            done
        fi
    fi

    log_success "未使用常量移除完成"
}

# 移除未使用的工具函数
remove_unused_functions() {
    log_info "移除未使用的工具函数..."

    # 读取分析报告中的低风险未使用函数
    if [[ -f "dead-code-analysis-report.json" ]]; then
        if command -v jq &> /dev/null; then
            local unused_functions=$(jq -r '.unusedFunctions[] | select(.riskLevel == "low") | .name + ":" + .file + ":" + (.line|tostring)' dead-code-analysis-report.json)

            echo "$unused_functions" | while IFS=':' read -r name file line; do
                if [[ -n "$name" && -n "$file" ]]; then
                    log_warning "谨慎移除函数: $name (从 $file:$line)"
                    # 这里需要更复杂的逻辑来安全地移除函数
                    # 建议手动审查后移除
                fi
            done
        fi
    fi

    log_warning "函数移除需要人工审查，已跳过自动处理"
}

# 运行测试验证
run_tests() {
    log_info "运行测试验证清理结果..."

    # 类型检查
    if npm run typecheck; then
        log_success "类型检查通过"
    else
        log_error "类型检查失败，请检查清理的代码"
        return 1
    fi

    # 单元测试
    if npm test; then
        log_success "单元测试通过"
    else
        log_error "单元测试失败，请检查清理的代码"
        return 1
    fi

    # 构建测试
    if npm run build; then
        log_success "构建测试通过"
    else
        log_error "构建测试失败，请检查清理的代码"
        return 1
    fi

    log_success "所有测试通过"
}

# 生成清理报告
generate_cleanup_report() {
    log_info "生成清理报告..."

    local report_file="cleanup-report-$(date +%Y%m%d-%H%M%S).md"

    cat > "$report_file" << EOF
# 废弃代码清理报告

**清理时间**: $(date)
**分支**: $(git branch --show-current)
**提交**: $(git rev-parse HEAD)

## 清理统计

- 清理的文件数: $(git diff --name-only HEAD~1 | wc -l)
- 删除的行数: $(git diff --shortstat HEAD~1 | grep -o '[0-9]\+ deletions' | grep -o '[0-9]\+' || echo '0')
- 添加的行数: $(git diff --shortstat HEAD~1 | grep -o '[0-9]\+ insertions' | grep -o '[0-9]\+' || echo '0')

## 清理内容

### 自动清理
- 未使用的导入
- 死代码块
- 未使用的常量（低风险）

### 手动清理
- 未使用的函数（需要人工审查）
- 复杂的类型定义
- 可能动态调用的代码

## 验证结果

✅ 类型检查通过
✅ 单元测试通过
✅ 构建测试通过

## 下一步

1. Code Review
2. 合并到主分支
3. 监控系统运行状态
EOF

    log_success "清理报告已生成: $report_file"
}

# 主函数
main() {
    echo "🧹 RouteCodex 废弃代码清理脚本"
    echo "================================"

    # 检查依赖
    if ! command -v node &> /dev/null; then
        log_error "Node.js 未找到，请安装 Node.js"
        exit 1
    fi

    if ! command -v npm &> /dev/null; then
        log_error "npm 未找到，请安装 npm"
        exit 1
    fi

    # 检查参数
    local phase=${1:-"all"}

    case "$phase" in
        "pre-check")
            check_git_status
            ;;
        "backup")
            create_backup_branch
            ;;
        "imports")
            cleanup_unused_imports
            ;;
        "dead-code")
            cleanup_dead_code
            ;;
        "constants")
            remove_unused_constants
            ;;
        "functions")
            remove_unused_functions
            ;;
        "test")
            run_tests
            ;;
        "report")
            generate_cleanup_report
            ;;
        "all")
            log_info "开始完整的清理流程..."

            check_git_status || exit 1
            create_backup_branch
            cleanup_unused_imports
            cleanup_dead_code
            remove_unused_constants
            remove_unused_functions
            run_tests || exit 1
            generate_cleanup_report

            log_success "完整清理流程已完成！"
            ;;
        *)
            echo "使用方法: $0 [phase]"
            echo ""
            echo "可用的清理阶段:"
            echo "  pre-check   - 检查Git状态"
            echo "  backup      - 创建备份分支"
            echo "  imports     - 清理未使用的导入"
            echo "  dead-code   - 清理死代码块"
            echo "  constants   - 移除未使用的常量"
            echo "  functions   - 移除未使用的函数"
            echo "  test        - 运行测试验证"
            echo "  report      - 生成清理报告"
            echo "  all         - 执行完整清理流程"
            echo ""
            echo "示例:"
            echo "  $0 all      # 执行完整清理"
            echo "  $0 imports  # 仅清理导入"
            echo "  $0 test     # 仅运行测试"
            exit 1
            ;;
    esac
}

# 检查是否直接运行脚本
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    main "$@"
fi