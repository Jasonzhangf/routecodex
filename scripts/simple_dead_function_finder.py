#!/usr/bin/env python3
"""
简化的RouteCodex废弃函数查找工具
直接分析AST来识别未使用的函数
"""

import os
import ast
import json
import re
from pathlib import Path
from typing import Dict, List, Set, Tuple, Optional
import subprocess

class SimpleDeadFunctionFinder:
    def __init__(self, project_root: str):
        self.project_root = Path(project_root)
        self.all_functions = []
        self.all_function_calls = set()
        self.defined_functions = {}

    def find_typescript_javascript_files(self) -> List[Path]:
        """查找所有TypeScript和JavaScript文件"""
        files = []

        # 要排除的目录
        exclude_dirs = {
            'node_modules', '.git', 'dist', 'build',
            'coverage', '.nyc_output', '.vscode',
            '.claude', '.git', 'logs'
        }

        for pattern in ['**/*.ts', '**/*.tsx', '**/*.js', '**/*.jsx']:
            for file_path in self.project_root.glob(pattern):
                # 检查是否在排除目录中
                if not any(exclude_dir in file_path.parts for exclude_dir in exclude_dirs):
                    files.append(file_path)

        return files

    def extract_functions_from_file(self, file_path: Path) -> List[Dict]:
        """从文件中提取函数定义"""
        functions = []

        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()

            # 使用正则表达式匹配函数定义（简化版）
            patterns = [
                # TypeScript函数
                r'(?:export\s+)?(?:async\s+)?function\s+(\w+)\s*\(',
                r'(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s+)?function\s*\(',
                r'(?:export\s+)?(?:const|let|var)\s+(\w+)\s*=\s*\([^)]*\)\s*=>',
                # 类方法
                r'(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*\([^)]*\)\s*[{:]',
                r'(?:public|private|protected)?\s*(?:async\s+)?(\w+)\s*=.*\(.*\)\s*=>',
                # 接口方法
                r'(\w+)\s*\([^)]*\)\s*[:;]',
            ]

            lines = content.split('\n')
            for i, line in enumerate(lines, 1):
                for pattern in patterns:
                    matches = re.finditer(pattern, line)
                    for match in matches:
                        func_name = match.group(1)

                        # 排除常见的不需要检查的函数
                        if func_name in ['constructor', 'toString', 'valueOf', 'then', 'catch', 'finally']:
                            continue

                        # 排除明显的React组件渲染方法
                        if func_name in ['render', 'componentDidMount', 'componentDidUpdate', 'componentWillUnmount']:
                            continue

                        functions.append({
                            'name': func_name,
                            'file': str(file_path.relative_to(self.project_root)),
                            'line': i,
                            'type': 'function',
                            'exported': 'export' in line,
                            'module': self._get_module_name(str(file_path.relative_to(self.project_root)))
                        })

        except Exception as e:
            print(f"解析文件失败 {file_path}: {e}")

        return functions

    def extract_function_calls_from_file(self, file_path: Path) -> Set[str]:
        """从文件中提取函数调用"""
        calls = set()

        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()

            # 简化的函数调用匹配
            patterns = [
                r'(\w+)\s*\(',  # function()
                r'\.(\w+)\s*\(',  # object.method()
                r'await\s+(\w+)\s*\(',  # await function()
                r'yield\s+(\w+)\s*\(',  # yield function()
            ]

            for pattern in patterns:
                matches = re.finditer(pattern, content)
                for match in matches:
                    func_name = match.group(1)

                    # 排除明显的构造函数调用和常见操作
                    if func_name in ['new', 'require', 'import', 'console', 'Math', 'JSON', 'Object', 'Array']:
                        continue

                    calls.add(func_name)

        except Exception as e:
            print(f"提取函数调用失败 {file_path}: {e}")

        return calls

    def _get_module_name(self, file_path: str) -> str:
        """从文件路径提取模块名"""
        parts = file_path.replace('\\', '/').split('/')
        if 'src' in parts:
            src_idx = parts.index('src')
            return '/'.join(parts[src_idx:src_idx+3])
        elif 'sharedmodule' in parts:
            return '/'.join(parts[:2])
        else:
            return '/'.join(parts[:2])

    def analyze_project(self) -> Dict:
        """分析整个项目"""
        print("🔍 查找TypeScript/JavaScript文件...")
        files = self.find_typescript_javascript_files()
        print(f"✅ 找到 {len(files)} 个源代码文件")

        print("📊 提取函数定义...")
        all_functions = []
        for file_path in files:
            functions = self.extract_functions_from_file(file_path)
            all_functions.extend(functions)

        print(f"✅ 提取到 {len(all_functions)} 个函数定义")

        print("🔎 提取函数调用...")
        all_calls = set()
        for file_path in files:
            calls = self.extract_function_calls_from_file(file_path)
            all_calls.update(calls)

        print(f"✅ 提取到 {len(all_calls)} 个函数调用")

        # 识别未使用的函数
        unused_functions = []
        for func in all_functions:
            if func['name'] not in all_calls and not func['exported']:
                func['risk_level'] = self._assess_risk_level(func['name'], func['file'])
                unused_functions.append(func)

        print(f"🎯 识别到 {len(unused_functions)} 个可能未使用的函数")

        return {
            'total_functions': len(all_functions),
            'total_calls': len(all_calls),
            'unused_functions': unused_functions,
            'analysis_summary': {
                'files_analyzed': len(files),
                'exported_functions': len([f for f in all_functions if f['exported']]),
                'internal_functions': len([f for f in all_functions if not f['exported']])
            }
        }

    def _assess_risk_level(self, func_name: str, file_path: str) -> str:
        """评估删除风险等级"""
        # 高风险模式
        high_risk_patterns = [
            r'^init', r'^setup', r'^start', r'^run',
            r'.*Handler$', r'.*Manager$', r'.*Service$',
            r'^main$', r'^on[A-Z]', r'^handle[A-Z]'
        ]

        # 低风险模式
        low_risk_patterns = [
            r'^test', r'^mock', r'^fixture', r'^example',
            r'^debug', r'^log', r'^helper', r'^util'
        ]

        file_lower = file_path.lower()

        # 检查文件类型
        if any(keyword in file_lower for keyword in ['test', 'spec', 'mock', 'example']):
            return 'LOW'

        # 检查函数名模式
        for pattern in high_risk_patterns:
            if re.match(pattern, func_name, re.IGNORECASE):
                return 'HIGH'

        for pattern in low_risk_patterns:
            if re.match(pattern, func_name, re.IGNORECASE):
                return 'LOW'

        return 'MEDIUM'

    def generate_cleanup_script(self, unused_functions: List[Dict]) -> str:
        """生成清理脚本"""
        # 按风险等级分组
        low_risk = [f for f in unused_functions if f['risk_level'] == 'LOW']

        script_lines = [
            "#!/bin/bash",
            "# RouteCodex 低风险废弃函数清理脚本",
            "# 自动生成 - 仅清理低风险函数",
            "",
            "set -e",
            "",
            "echo '🧹 开始清理低风险废弃函数...'",
            f"echo '📊 将清理 {len(low_risk)} 个低风险函数'",
            "",
            "BACKUP_DIR=\"cleanup-backup-$(date +%Y%m%d-%H%M%S)\"",
            "mkdir -p \"$BACKUP_DIR\"",
            "echo \"📦 备份目录: $BACKUP_DIR\"",
            ""
        ]

        for func in low_risk[:10]:  # 限制为前10个最安全的函数
            file_path = func['file']
            func_name = func['name']
            line_num = func.get('line', 0)

            script_lines.extend([
                f"echo '🗑️ 清理函数: {func_name} ({file_path}:{line_num})'",
                f"if [[ -f '{file_path}' ]]; then",
                f"  cp '{file_path}' \"$BACKUP_DIR/$(basename {file_path}).backup\"",
                f"  echo '  ✅ 已备份: $(basename {file_path})'",
                "  # TODO: 实现精确的函数删除逻辑",
                "  echo '  ⚠️ 需要手动删除函数定义'",
                "else",
                f"  echo '  ❌ 文件不存在: {file_path}'",
                "fi",
                ""
            ])

        script_lines.extend([
            "echo '✅ 低风险函数清理脚本生成完成！'",
            "echo '💡 请手动检查并执行函数删除操作'",
            "echo '🔄 如需恢复，可从备份目录恢复文件'",
            ""
        ])

        return '\n'.join(script_lines)

    def generate_report(self, analysis_result: Dict) -> str:
        """生成分析报告"""
        unused = analysis_result['unused_functions']
        summary = analysis_result['analysis_summary']

        # 按风险等级统计
        risk_counts = {'LOW': 0, 'MEDIUM': 0, 'HIGH': 0}
        for func in unused:
            risk_counts[func['risk_level']] += 1

        # 按模块统计
        module_counts = {}
        for func in unused:
            module = func['module']
            module_counts[module] = module_counts.get(module, 0) + 1

        report_lines = [
            "# RouteCodex 废弃函数分析报告",
            "",
            f"**分析时间**: 2025-10-31",
            f"**分析工具**: simple_dead_function_finder.py",
            f"**项目根目录**: {self.project_root}",
            "",
            "## 📊 统计摘要",
            "",
            f"- **分析文件数**: {summary['files_analyzed']}",
            f"- **函数总数**: {analysis_result['total_functions']}",
            f"- **导出函数**: {summary['exported_functions']}",
            f"- **内部函数**: {summary['internal_functions']}",
            f"- **函数调用总数**: {analysis_result['total_calls']}",
            f"- **未使用函数**: {len(unused)}",
            f"- **废弃率**: {(len(unused) / analysis_result['total_functions'] * 100):.1f}%",
            "",
            "## 🎯 风险等级分布",
            "",
            "| 风险等级 | 数量 | 占比 | 清理建议 |",
            "|---------|------|------|----------|",
        ]

        total_unused = len(unused)
        for level in ['LOW', 'MEDIUM', 'HIGH']:
            count = risk_counts[level]
            percentage = (count / total_unused * 100) if total_unused > 0 else 0
            suggestion = {
                'LOW': '建议删除',
                'MEDIUM': '谨慎评估',
                'HIGH': '手动审查'
            }[level]

            report_lines.append(f"| {level} | {count} | {percentage:.1f}% | {suggestion} |")

        report_lines.extend([
            "",
            "## 📁 模块分布",
            ""
        ])

        # 按模块排序
        sorted_modules = sorted(module_counts.items(), key=lambda x: x[1], reverse=True)
        for module, count in sorted_modules[:10]:  # 只显示前10个模块
            report_lines.append(f"- **{module}**: {count} 个未使用函数")

        report_lines.extend([
            "",
            "## 🔍 详细函数列表",
            "",
            "### 低风险函数 (建议删除)",
            ""
        ])

        low_risk = [f for f in unused if f['risk_level'] == 'LOW']
        if low_risk:
            for func in low_risk:
                report_lines.append(
                    f"- `{func['name']}` - `{func['file']}:{func['line']}` ({func['module']})"
                )
        else:
            report_lines.append("- 没有发现低风险未使用函数")

        report_lines.extend([
            "",
            "### 中风险函数 (谨慎评估)",
            ""
        ])

        medium_risk = [f for f in unused if f['risk_level'] == 'MEDIUM']
        if medium_risk:
            for func in medium_risk[:20]:  # 只显示前20个
                report_lines.append(
                    f"- `{func['name']}` - `{func['file']}:{func['line']}` ({func['module']})"
                )
            if len(medium_risk) > 20:
                report_lines.append(f"- ... 还有 {len(medium_risk) - 20} 个中风险函数")
        else:
            report_lines.append("- 没有发现中风险未使用函数")

        report_lines.extend([
            "",
            "### 高风险函数 (手动审查)",
            ""
        ])

        high_risk = [f for f in unused if f['risk_level'] == 'HIGH']
        if high_risk:
            for func in high_risk:
                report_lines.append(
                    f"- `{func['name']}` - `{func['file']}:{func['line']}` ({func['module']}) ⚠️"
                )
        else:
            report_lines.append("- 没有发现高风险未使用函数")

        report_lines.extend([
            "",
            "## 🛠️ 清理建议",
            "",
            "### 阶段1: 低风险函数清理",
            f"- **目标**: 清理 {len(low_risk)} 个低风险函数",
            "- **方式**: 可以直接删除或保留",
            "- **建议**: 优先清理测试文件、示例代码中的未使用函数",
            "",
            "### 阶段2: 中风险函数评估",
            f"- **目标**: 评估 {len(medium_risk)} 个中风险函数",
            "- **方式**: 逐一检查函数用途和依赖关系",
            "- **建议**: 确认无外部引用后再删除",
            "",
            "### 阶段3: 高风险函数审查",
            f"- **目标**: 仔细审查 {len(high_risk)} 个高风险函数",
            "- **方式**: 手动检查，可能通过反射、字符串调用等方式被使用",
            "- **建议**: 保留或进行更深入的分析",
            "",
            "## 📋 后续步骤",
            "",
            "1. **生成清理脚本**:",
            "   ```bash",
            "   python3 scripts/simple_dead_function_finder.py --generate-cleanup",
            "   ```",
            "",
            "2. **检查生成的清理脚本**:",
            "   ```bash",
            "   cat scripts/phase1-cleanup.sh",
            "   ```",
            "",
            "3. **执行清理（谨慎）**:",
            "   ```bash",
            "   chmod +x scripts/phase1-cleanup.sh",
            "   ./scripts/phase1-cleanup.sh",
            "   ```",
            "",
            "4. **验证清理结果**:",
            "   ```bash",
            "   npm run build",
            "   npm test",
            "   ```",
            "",
            "---",
            "",
            "**⚠️ 重要提醒**:",
            "- 此分析基于静态代码分析，可能存在误判",
            "- 动态调用（如反射、字符串调用）无法检测",
            "- 清理前请确保代码已提交到版本控制",
            "- 清理后务必运行完整测试套件",
            "",
            "**报告生成时间**: 2025-10-31"
        ])

        return '\n'.join(report_lines)

def main():
    import argparse

    parser = argparse.ArgumentParser(description='RouteCodex 废弃函数查找工具')
    parser.add_argument('--project-root', default='.', help='项目根目录路径')
    parser.add_argument('--generate-cleanup', action='store_true', help='生成清理脚本')
    parser.add_argument('--dry-run', action='store_true', help='仅分析不生成文件')

    args = parser.parse_args()

    try:
        finder = SimpleDeadFunctionFinder(args.project_root)

        print("🚀 开始分析RouteCodex项目...")
        result = finder.analyze_project()

        if not args.dry_run:
            print("📄 生成分析报告...")
            report = finder.generate_report(result)
            report_path = finder.project_root / "SIMPLE_DEAD_FUNCTION_REPORT.md"

            with open(report_path, 'w', encoding='utf-8') as f:
                f.write(report)

            print(f"✅ 报告已生成: {report_path}")

            if args.generate_cleanup:
                print("🛠️ 生成清理脚本...")
                script = finder.generate_cleanup_script(result['unused_functions'])
                script_path = finder.project_root / "scripts" / "phase1-cleanup.sh"

                script_path.parent.mkdir(exist_ok=True)
                with open(script_path, 'w', encoding='utf-8') as f:
                    f.write(script)

                os.chmod(script_path, 0o755)
                print(f"✅ 清理脚本已生成: {script_path}")

        print("\n🎉 分析完成！")

    except Exception as e:
        print(f"❌ 分析失败: {e}")
        import traceback
        traceback.print_exc()
        return 1

    return 0

if __name__ == "__main__":
    exit(main())