#!/bin/bash

echo "🚀 开始提交和推送GLM兼容模块更新..."

# 检查git状态
echo "📋 检查git状态..."
git status

# 添加所有更改
echo "📦 添加所有更改..."
git add .

# 检查暂存的文件
echo "📋 暂存的文件:"
git diff --cached --name-only

# 提交更改
echo "💾 提交更改..."
git commit -m "feat(glm): 架构升级为配置驱动的字段映射系统

- 配置驱动字段映射替代硬编码逻辑
- 新增模块化GLM兼容处理架构
- 符合RouteCodex 9大架构原则
- 字段映射100%向后兼容验证
- 支持透明无缝升级
- 添加标准Hook系统集成

🤖 Generated with [Claude Code](https://claude.com/claude-code)

Co-Authored-By: Claude <noreply@anthropic.com>"

# 检查提交是否成功
if [ $? -eq 0 ]; then
    echo "✅ 提交成功！"

    # 推送到远程仓库
    echo "📤 推送到远程仓库..."
    git push origin feature/config-unified

    if [ $? -eq 0 ]; then
        echo "🎉 推送成功！"
        echo ""
        echo "✅ GLM兼容模块更新已成功提交并推送到GitHub！"
        echo ""
        echo "📋 提交摘要:"
        echo "   - 配置驱动字段映射系统"
        echo "   - 模块化GLM兼容架构"
        echo "   - 100%向后兼容验证"
        echo "   - RouteCodex架构原则遵循"
        echo ""
        echo "🔗 可以在GitHub上查看更新内容"
    else
        echo "❌ 推送失败，请检查网络连接和权限"
        echo "💡 你可以手动执行: git push origin feature/config-unified"
    fi
else
    echo "❌ 提交失败，请检查是否有未解决的冲突或其他问题"
    echo "💡 查看详细错误信息: git status"
fi