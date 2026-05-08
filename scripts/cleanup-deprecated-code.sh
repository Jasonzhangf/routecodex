#!/bin/bash
# RouteCodex 废弃代码清理审计脚本
# 仅输出候选项，不执行任何删除/回滚/构建产物清理。

set -euo pipefail

echo "🔎 RouteCodex 废弃代码审计开始..."
echo "⏰ 开始时间: $(date)"
echo ""

TEMP_DEBUG_COUNT=$(find . -name "debug-*.js" -not -path "*/node_modules/*" | wc -l | tr -d ' ')
TEMP_TEST_JS_COUNT=$(find . -name "test-*.js" -not -path "*/node_modules/*" -not -path "*/tests/*" | wc -l | tr -d ' ')
TEST_OUTPUT_SIZE=$(du -sh tests/output/ 2>/dev/null | cut -f1 || echo "0")
DIST_SIZE=$(du -sh dist/ 2>/dev/null | cut -f1 || echo "0")
CONFIG_BAK_COUNT=$(find config/ -name "virtual-router-config.*.generated.json.bak" 2>/dev/null | wc -l | tr -d ' ')
CORE_TGZ_COUNT=$(find sharedmodule/llmswitch-core/ -name "rcc-llmswitch-core-*.tgz" 2>/dev/null | wc -l | tr -d ' ')

echo "📊 候选统计:"
echo "  - 临时 debug js: $TEMP_DEBUG_COUNT"
echo "  - 临时 test js: $TEMP_TEST_JS_COUNT"
echo "  - tests/output 大小: $TEST_OUTPUT_SIZE"
echo "  - dist 大小: $DIST_SIZE"
echo "  - config bak 数量: $CONFIG_BAK_COUNT"
echo "  - llmswitch-core tgz 数量: $CORE_TGZ_COUNT"
echo ""

echo "📄 候选文件列表:"
find . -name "debug-*.js" -not -path "*/node_modules/*" -print
find . -name "test-*.js" -not -path "*/node_modules/*" -not -path "*/tests/*" -print
find config/ -name "virtual-router-config.*.generated.json.bak" -print 2>/dev/null || true
find sharedmodule/llmswitch-core/ -name "rcc-llmswitch-core-*.tgz" -print 2>/dev/null || true
[[ -d "tests/output/" ]] && echo "tests/output/"
[[ -d "dist/" ]] && echo "dist/"
echo ""

echo "⚠️ 本脚本不会执行删除、不会清空 dist、不会提供回滚命令。"
echo "⚠️ 如需物理移除，必须先在当前任务中获得明确授权，并单独验证。"
echo ""

echo "🧩 需人工复核的代码候选:"
[[ -f "src/utils/file-watcher.ts" ]] && echo "  - src/utils/file-watcher.ts"
[[ -f "tests/config/user-config-parser.test.ts" ]] && echo "  - tests/config/user-config-parser.test.ts"
[[ -f "tests/commands/three-modes-dry-run.test.ts" ]] && echo "  - tests/commands/three-modes-dry-run.test.ts"
echo ""

echo "✅ 审计完成"
echo "⏰ 结束时间: $(date)"
