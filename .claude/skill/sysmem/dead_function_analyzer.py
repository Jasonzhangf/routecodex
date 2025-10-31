#!/usr/bin/env python3
"""
深度函数分析器 - 识别未调用的废弃函数
专门针对RouteCodex项目进行死代码检测
"""

import os
import re
import json
import ast
import sys
from pathlib import Path
from typing import Dict, List, Set, Tuple, Optional
from collections import defaultdict, Counter
import logging

class DeadFunctionAnalyzer:
    def __init__(self, project_root: str):
        self.project_root = Path(project_root)
        self.defined_functions = {}
        self.function_calls = defaultdict(set)
        self.exported_functions = defaultdict(set)
        self.imported_functions = defaultdict(set)
        self.unused_functions = {}
        self.dead_code_blocks = []
        self.unused_constants = {}
        self.unused_types = {}

        # 配置日志
        logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
        self.logger = logging.getLogger(__name__)

        # 需要忽略的目录
        self.ignore_dirs = {
            'node_modules', '.git', 'dist', 'build', 'coverage', '.nyc_output',
            '.claude', '.vscode', '__pycache__', '.pytest_cache', 'venv', 'env'
        }

        # 需要分析的文件扩展名
        self.code_extensions = {'.ts', '.tsx', '.js', '.jsx', '.mjs'}

    def scan_project_for_functions(self) -> Dict:
        """扫描项目中的所有函数定义"""
        self.logger.info("🔍 开始扫描函数定义...")

        for file_path in self._get_source_files():
            self._analyze_file_functions(file_path)

        self.logger.info(f"✅ 函数扫描完成，发现 {len(self.defined_functions)} 个函数定义")
        return self.defined_functions

    def _get_source_files(self) -> List[Path]:
        """获取所有源代码文件"""
        source_files = []

        for root, dirs, files in os.walk(self.project_root):
            # 过滤忽略的目录
            dirs[:] = [d for d in dirs if d not in self.ignore_dirs]

            for file in files:
                file_path = Path(root) / file
                if file_path.suffix in self.code_extensions:
                    source_files.append(file_path)

        return source_files

    def _analyze_file_functions(self, file_path: Path):
        """分析单个文件中的函数定义和调用"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()

            # 解析TypeScript/JavaScript代码
            functions = self._extract_functions(content, str(file_path))
            calls = self._extract_function_calls(content, str(file_path))
            exports = self._extract_exports(content, str(file_path))
            imports = self._extract_imports(content, str(file_path))

            # 存储分析结果
            if functions:
                self.defined_functions[str(file_path)] = functions
            if calls:
                self.function_calls[str(file_path)].update(calls)
            if exports:
                self.exported_functions[str(file_path)].update(exports)
            if imports:
                self.imported_functions[str(file_path)].update(imports)

        except Exception as e:
            self.logger.warning(f"⚠️  分析文件失败 {file_path}: {e}")

    def _extract_functions(self, content: str, file_path: str) -> List[Dict]:
        """提取函数定义"""
        functions = []

        # 匹配各种函数定义模式
        patterns = [
            # 函数声明: function name() {}
            r'function\s+(\w+)\s*\([^)]*\)\s*\{',
            # 箭头函数: const name = () => {}
            r'(?:const|let|var)\s+(\w+)\s*=\s*(?:\([^)]*\)|[^=])\s*=>',
            # 方法定义: name() {} 或 name: function() {}
            r'(?:(?:async\s+)?(?:\w+\s*)?)(\w+)\s*\([^)]*\)\s*\{',
            # 类方法: method() {}
            r'(?:async\s+)?(\w+)\s*\([^)]*\)\s*\{',
            # 导出函数: export function name() {}
            r'export\s+(?:async\s+)?function\s+(\w+)',
            # 导出箭头函数: export const name = () => {}
            r'export\s+(?:const|let|var)\s+(\w+)\s*=',
        ]

        for i, line in enumerate(content.split('\n'), 1):
            for pattern in patterns:
                matches = re.finditer(pattern, line)
                for match in matches:
                    func_name = match.group(1)
                    # 过滤掉一些明显不是函数的情况
                    if not self._is_valid_function_name(func_name):
                        continue

                    functions.append({
                        'name': func_name,
                        'line': i,
                        'type': self._determine_function_type(line, match),
                        'exported': 'export' in line,
                        'async': 'async' in line,
                        'content': line.strip()
                    })

        return functions

    def _extract_function_calls(self, content: str, file_path: str) -> Set[str]:
        """提取函数调用"""
        calls = set()

        # 匹配函数调用模式
        patterns = [
            # 直接调用: functionName()
            r'(\w+)\s*\(',
            # 方法调用: object.methodName()
            r'\.(\w+)\s*\(',
            # this调用: this.methodName()
            r'this\.(\w+)\s*\(',
        ]

        for line in content.split('\n'):
            # 跳过函数定义行
            if any(keyword in line for keyword in ['function', '=>', 'const', 'let', 'var']):
                continue

            for pattern in patterns:
                matches = re.finditer(pattern, line)
                for match in matches:
                    func_name = match.group(1)
                    if self._is_valid_function_name(func_name):
                        calls.add(func_name)

        return calls

    def _extract_exports(self, content: str, file_path: str) -> Set[str]:
        """提取导出函数"""
        exports = set()

        # 匹配导出模式
        patterns = [
            r'export\s+(?:async\s+)?function\s+(\w+)',
            r'export\s+(?:const|let|var)\s+(\w+)\s*=',
            r'export\s*{\s*([^}]+)\s*}',
        ]

        for line in content.split('\n'):
            for pattern in patterns:
                match = re.search(pattern, line)
                if match:
                    if pattern == patterns[2]:  # export { ... }
                        exported_items = [item.strip() for item in match.group(1).split(',')]
                        for item in exported_items:
                            if ' as ' in item:
                                item = item.split(' as ')[0].strip()
                            exports.add(item)
                    else:
                        exports.add(match.group(1))

        return exports

    def _extract_imports(self, content: str, file_path: str) -> Set[str]:
        """提取导入函数"""
        imports = set()

        # 匹配导入模式
        patterns = [
            r'import\s*{\s*([^}]+)\s*}\s*from',
            r'import\s+(\w+)\s*from',
        ]

        for line in content.split('\n'):
            for pattern in patterns:
                match = re.search(pattern, line)
                if match:
                    if pattern == patterns[0]:  # import { ... } from
                        imported_items = [item.strip() for item in match.group(1).split(',')]
                        for item in imported_items:
                            if ' as ' in item:
                                item = item.split(' as ')[1].strip()
                            imports.add(item)
                    else:
                        imports.add(match.group(1))

        return imports

    def _is_valid_function_name(self, name: str) -> bool:
        """检查是否为有效的函数名"""
        # 过滤掉JavaScript关键字和明显不是函数的标识符
        invalid_names = {
            'if', 'else', 'for', 'while', 'switch', 'case', 'break', 'continue',
            'return', 'try', 'catch', 'finally', 'throw', 'new', 'typeof',
            'instanceof', 'in', 'of', 'class', 'extends', 'super', 'static',
            'async', 'await', 'yield', 'let', 'const', 'var', 'function',
            'true', 'false', 'null', 'undefined', 'this', 'self', 'window',
            'document', 'console', 'process', 'require', 'import', 'export',
            'default', 'from', 'as', 'with', 'debugger', 'delete', 'void'
        }

        return name.isidentifier() and name not in invalid_names and len(name) > 1

    def _determine_function_type(self, line: str, match) -> str:
        """确定函数类型"""
        if 'function' in line:
            return 'function_declaration'
        elif '=>' in line:
            return 'arrow_function'
        elif 'class' in line:
            return 'class_method'
        elif 'this.' in line:
            return 'instance_method'
        else:
            return 'method'

    def analyze_unused_functions(self) -> Dict:
        """分析未使用的函数"""
        self.logger.info("🔍 分析未使用的函数...")

        # 收集所有函数调用
        all_calls = set()
        for calls in self.function_calls.values():
            all_calls.update(calls)

        # 收集所有导出函数
        all_exports = set()
        for exports in self.exported_functions.values():
            all_exports.update(exports)

        # 分析每个文件中的未使用函数
        for file_path, functions in self.defined_functions.items():
            unused = []
            for func in functions:
                func_name = func['name']

                # 跳过特殊情况
                if self._should_skip_function(func, all_calls, all_exports):
                    continue

                # 检查函数是否被调用
                if func_name not in all_calls:
                    # 进一步检查是否通过字符串调用或其他间接调用
                    if not self._is_indirectly_called(func_name, file_path):
                        unused.append(func)

            if unused:
                self.unused_functions[file_path] = unused

        self.logger.info(f"✅ 未使用函数分析完成，发现 {sum(len(v) for v in self.unused_functions.values())} 个未使用函数")
        return self.unused_functions

    def _should_skip_function(self, func: Dict, all_calls: Set[str], all_exports: Set[str]) -> bool:
        """检查是否应该跳过某个函数的分析"""
        func_name = func['name']

        # 跳过导出的函数（可能被外部使用）
        if func['exported'] or func_name in all_exports:
            return True

        # 跳过常见的生命周期函数和事件处理器
        lifecycle_patterns = [
            r'^on[A-Z]',  # onClick, onLoad
            r'^handle[A-Z]',  # handleSubmit, handleClick
            r'^render',  # render函数
            r'^componentDid',  # React生命周期
            r'^useEffect',  # React Hook
            r'^useState',  # React Hook
            r'^\w+Listener',  # 事件监听器
            r'^\w+Handler',  # 事件处理器
        ]

        for pattern in lifecycle_patterns:
            if re.match(pattern, func_name):
                return True

        # 跳过测试函数
        test_patterns = [r'^test', r'^it', r'^describe', r'^before', r'^after']
        for pattern in test_patterns:
            if re.match(pattern, func_name):
                return True

        return False

    def _is_indirectly_called(self, func_name: str, file_path: str) -> bool:
        """检查函数是否被间接调用（如通过字符串调用）"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read()

            # 检查字符串调用模式
            indirect_patterns = [
                rf'["\']{func_name}["\']',  # "functionName"
                rf'\.call\(.*["\']{func_name}["\']',  # .call(..., "functionName")
                rf'\.apply\(.*["\']{func_name}["\']',  # .apply(..., "functionName")
                rf'addEventListener.*["\']{func_name}["\']',  # addEventListener("functionName")
            ]

            for pattern in indirect_patterns:
                if re.search(pattern, content):
                    return True

        except Exception:
            pass

        return False

    def analyze_dead_code_blocks(self) -> List[Dict]:
        """分析死代码块"""
        self.logger.info("🔍 分析死代码块...")

        for file_path in self._get_source_files():
            try:
                with open(file_path, 'r', encoding='utf-8') as f:
                    content = f.read()

                dead_blocks = self._find_dead_code_blocks(content, str(file_path))
                if dead_blocks:
                    self.dead_code_blocks.extend(dead_blocks)

            except Exception as e:
                self.logger.warning(f"⚠️  分析死代码失败 {file_path}: {e}")

        self.logger.info(f"✅ 死代码分析完成，发现 {len(self.dead_code_blocks)} 个死代码块")
        return self.dead_code_blocks

    def _find_dead_code_blocks(self, content: str, file_path: str) -> List[Dict]:
        """查找死代码块"""
        dead_blocks = []
        lines = content.split('\n')

        # 检查无法到达的代码
        for i, line in enumerate(lines):
            # 检查return、break、continue后的代码
            if any(keyword in line for keyword in ['return ', 'break;', 'continue;']):
                # 检查后面是否有非注释、非空行的代码
                j = i + 1
                while j < len(lines):
                    next_line = lines[j].strip()
                    if next_line and not next_line.startswith('//') and not next_line.startswith('/*'):
                        if not next_line.startswith('}') and not next_line.startswith('case') and not next_line.startswith('default'):
                            dead_blocks.append({
                                'file': file_path,
                                'line': j + 1,
                                'type': 'unreachable_after_return',
                                'content': next_line,
                                'context': f"在 {line.strip()} 之后"
                            })
                        break
                    j += 1

        return dead_blocks

    def generate_cleanup_plan(self) -> Dict:
        """生成清理计划"""
        self.logger.info("📋 生成清理计划...")

        # 按风险等级分类
        high_risk = []
        medium_risk = []
        low_risk = []

        for file_path, functions in self.unused_functions.items():
            for func in functions:
                risk_level = self._assess_risk_level(func, file_path)

                func_info = {
                    'file': file_path,
                    'function': func['name'],
                    'line': func['line'],
                    'type': func['type'],
                    'reason': '未调用',
                    'confidence': 'high'
                }

                if risk_level == 'high':
                    high_risk.append(func_info)
                elif risk_level == 'medium':
                    medium_risk.append(func_info)
                else:
                    low_risk.append(func_info)

        cleanup_plan = {
            'summary': {
                'total_unused_functions': sum(len(v) for v in self.unused_functions.values()),
                'high_risk': len(high_risk),
                'medium_risk': len(medium_risk),
                'low_risk': len(low_risk),
                'dead_code_blocks': len(self.dead_code_blocks)
            },
            'high_risk_functions': high_risk,
            'medium_risk_functions': medium_risk,
            'low_risk_functions': low_risk,
            'dead_code_blocks': self.dead_code_blocks,
            'cleanup_stages': self._generate_cleanup_stages(high_risk, medium_risk, low_risk)
        }

        self.logger.info("✅ 清理计划生成完成")
        return cleanup_plan

    def _assess_risk_level(self, func: Dict, file_path: str) -> str:
        """评估删除函数的风险等级"""
        func_name = func['name']
        file_name = Path(file_path).name

        # 高风险：可能被外部调用或框架使用
        if any(pattern in file_name for pattern in ['index', 'main', 'app', 'server']):
            return 'high'

        if any(pattern in func_name.lower() for pattern in ['init', 'setup', 'config', 'start']):
            return 'high'

        if func['type'] in ['class_method', 'instance_method']:
            return 'high'

        # 中风险：工具函数，可能被测试或其他模块使用
        if any(pattern in file_name for pattern in ['util', 'helper', 'service', 'manager']):
            return 'medium'

        if any(pattern in func_name.lower() for pattern in ['helper', 'util', 'service']):
            return 'medium'

        # 低风险：明显是内部函数或临时函数
        if func_name.startswith('_') or func_name.startswith('temp'):
            return 'low'

        if any(pattern in func_name.lower() for pattern in ['temp', 'test', 'demo', 'example']):
            return 'low'

        return 'medium'

    def _generate_cleanup_stages(self, high_risk: List, medium_risk: List, low_risk: List) -> List[Dict]:
        """生成清理阶段"""
        return [
            {
                'stage': 1,
                'name': '低风险清理',
                'description': '清理明显的临时函数和测试代码',
                'functions': low_risk,
                'estimated_time': f'{len(low_risk) * 2} 分钟',
                'risk': 'low'
            },
            {
                'stage': 2,
                'name': '中风险清理',
                'description': '清理未使用的工具函数和辅助函数',
                'functions': medium_risk,
                'estimated_time': f'{len(medium_risk) * 5} 分钟',
                'risk': 'medium'
            },
            {
                'stage': 3,
                'name': '高风险清理',
                'description': '谨慎清理可能被框架调用的函数',
                'functions': high_risk,
                'estimated_time': f'{len(high_risk) * 10} 分钟',
                'risk': 'high'
            }
        ]

    def save_analysis_report(self, output_path: str):
        """保存分析报告"""
        report = {
            'analysis_timestamp': self._get_timestamp(),
            'project_root': str(self.project_root),
            'defined_functions_count': sum(len(v) for v in self.defined_functions.values()),
            'unused_functions': self.unused_functions,
            'dead_code_blocks': self.dead_code_blocks,
            'cleanup_plan': self.generate_cleanup_plan()
        }

        with open(output_path, 'w', encoding='utf-8') as f:
            json.dump(report, f, indent=2, ensure_ascii=False)

        self.logger.info(f"📄 分析报告已保存到: {output_path}")

    def _get_timestamp(self) -> str:
        """获取时间戳"""
        from datetime import datetime
        return datetime.now().isoformat()

def main():
    if len(sys.argv) != 2:
        print("使用方法: python dead_function_analyzer.py <项目根目录>")
        sys.exit(1)

    project_root = sys.argv[1]
    analyzer = DeadFunctionAnalyzer(project_root)

    # 执行分析
    analyzer.scan_project_for_functions()
    analyzer.analyze_unused_functions()
    analyzer.analyze_dead_code_blocks()

    # 保存报告
    output_path = os.path.join(project_root, '.claude', 'skill', 'sysmem', 'dead_function_analysis.json')
    analyzer.save_analysis_report(output_path)

    # 输出摘要
    cleanup_plan = analyzer.generate_cleanup_plan()
    summary = cleanup_plan['summary']

    print(f"\n🎯 RouteCodex 死函数分析完成")
    print(f"📊 分析摘要:")
    print(f"   - 未使用函数总数: {summary['total_unused_functions']}")
    print(f"   - 高风险函数: {summary['high_risk']}")
    print(f"   - 中风险函数: {summary['medium_risk']}")
    print(f"   - 低风险函数: {summary['low_risk']}")
    print(f"   - 死代码块: {summary['dead_code_blocks']}")
    print(f"\n📋 详细报告已保存到: {output_path}")

if __name__ == '__main__':
    main()