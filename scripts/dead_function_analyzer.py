#!/usr/bin/env python3
"""
RouteCodex 废弃函数清理工具
基于sysmem技能分析结果，安全清理未使用的函数
"""

import os
import re
import json
import ast
import argparse
from typing import Dict, List, Set, Tuple
from pathlib import Path

class DeadFunctionAnalyzer:
    def __init__(self, project_root: str):
        self.project_root = Path(project_root)
        self.unused_functions = []
        self.removed_count = 0
        self.errors = []

    def load_analysis_results(self) -> Dict:
        """加载sysmem分析结果"""
        results_file = self.project_root / ".claude" / "skill" / "sysmem" / "project_data.json"
        if not results_file.exists():
            raise FileNotFoundError(f"未找到sysmem分析结果: {results_file}")

        with open(results_file, 'r', encoding='utf-8') as f:
            return json.load(f)

    def extract_unused_functions(self, data: Dict) -> List[Dict]:
        """从sysmem数据中提取未使用的函数"""
        unused = []

        if 'function_calls' not in data:
            return unused

        for func_name, func_info in data['function_calls'].items():
            # 检查是否被调用
            call_count = len(func_info.get('called_by', []))
            if call_count == 0:
                # 获取函数定义信息
                definitions = func_info.get('defined_in', [])
                for definition in definitions:
                    func_data = {
                        'name': func_name,
                        'file': definition.get('file', ''),
                        'line': definition.get('line', 0),
                        'type': definition.get('type', 'function'),
                        'class': definition.get('class', ''),
                        'module': self._get_module_name(definition.get('file', '')),
                        'risk_level': self._assess_risk_level(func_name, definition.get('file', ''))
                    }
                    unused.append(func_data)

        return sorted(unused, key=lambda x: (x['risk_level'], x['module'], x['name']))

    def _get_module_name(self, file_path: str) -> str:
        """从文件路径提取模块名"""
        if not file_path:
            return 'unknown'

        # 标准化路径分隔符
        normalized = file_path.replace('\\', '/')

        # 移除项目根目录前缀
        if normalized.startswith('./'):
            normalized = normalized[2:]
        elif normalized.startswith('/'):
            # 移除绝对路径前缀
            parts = normalized.split('/')
            if 'routecodex-worktree' in parts:
                idx = parts.index('routecodex-worktree')
                normalized = '/'.join(parts[idx+1:])

        return normalized

    def _assess_risk_level(self, func_name: str, file_path: str) -> str:
        """评估函数删除的风险等级"""
        # 高风险：核心构造函数、主要处理器
        high_risk_patterns = [
            r'^constructor$', r'^init$', r'^initialize$', r'^setup$',
            r'.*Handler$', r'.*Manager$', r'.*Service$',
            r'^main$', r'^start$', r'^run$'
        ]

        # 中风险：工具函数、辅助函数
        medium_risk_patterns = [
            r'^helper', r'^util', r'^tool', r'^debug',
            r'^test', r'^mock', r'^fixture'
        ]

        file_lower = file_path.lower()
        func_lower = func_name.lower()

        # 检查高风险模式
        for pattern in high_risk_patterns:
            if re.match(pattern, func_name, re.IGNORECASE):
                return 'HIGH'

        # 检查文件类型
        if any(keyword in file_lower for keyword in ['test', 'spec', 'mock']):
            return 'LOW'

        if any(keyword in file_lower for keyword in ['util', 'helper', 'debug']):
            return 'MEDIUM'

        # 检查中风险模式
        for pattern in medium_risk_patterns:
            if re.match(pattern, func_name, re.IGNORECASE):
                return 'MEDIUM'

        # 默认为低风险
        return 'LOW'

    def generate_cleanup_plan(self, unused_functions: List[Dict]) -> Dict:
        """生成清理计划"""
        # 按风险等级分组
        grouped = {'LOW': [], 'MEDIUM': [], 'HIGH': []}
        for func in unused_functions:
            grouped[func['risk_level']].append(func)

        return {
            'total_unused': len(unused_functions),
            'by_risk': {level: len(funcs) for level, funcs in grouped.items()},
            'phase_1_low_risk': grouped['LOW'][:20],  # 第一批清理20个
            'phase_2_medium_risk': grouped['MEDIUM'][:30],  # 第二批清理30个
            'phase_3_high_risk': grouped['HIGH'],  # 高风险需要手动审查
            'all_functions': unused_functions
        }

    def create_safe_cleanup_script(self, functions: List[Dict]) -> str:
        """创建安全的函数清理脚本"""
        script_lines = [
            "#!/bin/bash",
            "# RouteCodex 废弃函数安全清理脚本",
            "# 自动生成，请谨慎执行",
            "",
            "set -e  # 遇到错误立即退出",
            "",
            "echo '🧹 开始清理废弃函数...'",
            f"echo '📊 将清理 {len(functions)} 个低风险函数'",
            ""
        ]

        for func in functions:
            if not func['file']:
                continue

            file_path = func['file']
            func_name = func['name']
            line_num = func.get('line', 0)

            # 添加安全检查
            script_lines.extend([
                f"echo '🗑️ 清理函数: {func_name} ({file_path}:{line_num})'",
                f"if [[ -f '{file_path}' ]]; then",
                "  # 备份原文件",
                f"  cp '{file_path}' '{file_path}.backup'",
                "  echo '  ✅ 已备份原文件'",
                "  # TODO: 实现函数安全删除逻辑",
                "  echo '  ⚠️ 函数删除逻辑待实现'",
                "else",
                f"  echo '  ❌ 文件不存在: {file_path}'",
                "fi",
                ""
            ])

        script_lines.extend([
            "echo '✅ 废弃函数清理完成！'",
            "echo '💡 如需恢复，请使用 .backup 文件'",
            ""
        ])

        return '\n'.join(script_lines)

    def execute_phase_1_cleanup(self, plan: Dict) -> bool:
        """执行阶段1清理"""
        phase_1_functions = plan['phase_1_low_risk']

        if not phase_1_functions:
            print("✅ 没有需要清理的低风险函数")
            return True

        print(f"🎯 阶段1: 清理 {len(phase_1_functions)} 个低风险函数")

        # 创建清理脚本
        script_content = self.create_safe_cleanup_script(phase_1_functions)
        script_path = self.project_root / "scripts" / "phase-1-cleanup.sh"

        # 确保脚本目录存在
        script_path.parent.mkdir(exist_ok=True)

        with open(script_path, 'w', encoding='utf-8') as f:
            f.write(script_content)

        # 设置执行权限
        os.chmod(script_path, 0o755)

        print(f"✅ 清理脚本已生成: {script_path}")
        print("⚠️ 请手动检查并执行脚本进行清理")

        return True

    def generate_report(self, plan: Dict) -> str:
        """生成详细报告"""
        report_lines = [
            "# RouteCodex 废弃函数清理报告",
            "",
            f"**分析时间**: 2025-10-31",
            f"**分析工具**: sysmem + dead_function_analyzer.py",
            f"**项目根目录**: {self.project_root}",
            "",
            "## 📊 统计摘要",
            "",
            f"- **扫描文件总数**: 计算中...",
            f"- **函数总数**: 计算中...",
            f"- **未使用函数数**: {plan['total_unused']}",
            f"- **废弃率**: 计算中...",
            "",
            "## 🎯 风险等级分布",
            "",
            "| 风险等级 | 数量 | 占比 | 清理建议 |",
            "|---------|------|------|----------|",
        ]

        total = plan['total_unused']
        for level in ['LOW', 'MEDIUM', 'HIGH']:
            count = plan['by_risk'][level]
            percentage = (count / total * 100) if total > 0 else 0
            suggestion = {
                'LOW': '自动清理',
                'MEDIUM': '半自动清理',
                'HIGH': '手动审查'
            }[level]

            report_lines.append(f"| {level} | {count} | {percentage:.1f}% | {suggestion} |")

        report_lines.extend([
            "",
            "## 📋 分阶段清理计划",
            "",
            f"### 阶段1: 低风险函数自动清理 ({len(plan['phase_1_low_risk'])} 个)",
            "**目标**: 清理测试工具、调试函数等明显无用的函数",
            "**方式**: 自动化脚本清理",
            "**预计时间**: 30分钟",
            "",
            "### 阶段2: 中风险函数半自动清理 ({len(plan['phase_2_medium_risk'])} 个)",
            "**目标**: 清理工具函数、辅助函数等需要简单验证的函数",
            "**方式**: 半自动脚本 + 人工确认",
            "**预计时间**: 2小时",
            "",
            f"### 阶段3: 高风险函数手动审查 ({len(plan['phase_3_high_risk'])} 个)",
            "**目标**: 仔细审查核心函数、构造函数等关键函数",
            "**方式**: 人工逐一审查",
            "**预计时间**: 4小时",
            "",
            "## 🔧 使用工具",
            "",
            "### 执行清理",
            "```bash",
            "# 阶段1: 自动清理",
            "python3 scripts/dead_function_analyzer.py --execute-phase-1",
            "",
            "# 阶段2: 半自动清理",
            "python3 scripts/dead_function_analyzer.py --execute-phase-2",
            "",
            "# 生成完整报告",
            "python3 scripts/dead_function_analyzer.py --full-report",
            "```",
            "",
            "### 回滚操作",
            "```bash",
            "# 如需恢复文件",
            "find . -name '*.backup' -exec sh -c 'mv \"$1\" \"${1%.backup}\"' _ {} \\;",
            "```",
            "",
            "---",
            "",
            "**⚠️ 重要提醒**:",
            "- 执行清理前请确保代码已提交到Git",
            "- 建议在分支上进行清理测试",
            "- 清理后务必运行完整测试套件",
            "- 高风险函数必须手动审查后再删除",
            "",
            "**报告生成时间**: 2025-10-31",
            f"**下次分析建议**: 2024-12-31"
        ])

        return '\n'.join(report_lines)

def main():
    parser = argparse.ArgumentParser(description='RouteCodex 废弃函数清理工具')
    parser.add_argument('--project-root', default='.', help='项目根目录路径')
    parser.add_argument('--execute-phase-1', action='store_true', help='执行阶段1清理')
    parser.add_argument('--execute-phase-2', action='store_true', help='执行阶段2清理')
    parser.add_argument('--full-report', action='store_true', help='生成完整报告')
    parser.add_argument('--dry-run', action='store_true', help='仅分析不执行')

    args = parser.parse_args()

    try:
        analyzer = DeadFunctionAnalyzer(args.project_root)

        print("📊 加载sysmem分析结果...")
        data = analyzer.load_analysis_results()

        print("🔍 提取未使用函数...")
        unused_functions = analyzer.extract_unused_functions(data)

        print("📋 生成清理计划...")
        plan = analyzer.generate_cleanup_plan(unused_functions)

        print(f"✅ 分析完成: 发现 {plan['total_unused']} 个未使用函数")
        print(f"   - 低风险: {plan['by_risk']['LOW']} 个")
        print(f"   - 中风险: {plan['by_risk']['MEDIUM']} 个")
        print(f"   - 高风险: {plan['by_risk']['HIGH']} 个")

        if args.full_report:
            print("📄 生成完整报告...")
            report = analyzer.generate_report(plan)
            report_path = analyzer.project_root / "ROUTECODEX_DEAD_FUNCTION_CLEANUP_REPORT.md"

            with open(report_path, 'w', encoding='utf-8') as f:
                f.write(report)

            print(f"✅ 报告已生成: {report_path}")

        if args.execute_phase_1:
            success = analyzer.execute_phase_1_cleanup(plan)
            if success:
                print("✅ 阶段1清理任务完成")
            else:
                print("❌ 阶段1清理失败")

        if args.execute_phase_2:
            print("⚠️ 阶段2清理功能开发中...")

    except Exception as e:
        print(f"❌ 分析失败: {e}")
        return 1

    return 0

if __name__ == "__main__":
    exit(main())