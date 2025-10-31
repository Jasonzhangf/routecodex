#!/usr/bin/env python3
"""
RouteCodex 持续监控和定期清理工具
自动化监控代码质量，定期检测死函数并生成清理建议
"""

import os
import sys
import json
import subprocess
import datetime
from pathlib import Path
from typing import Dict, List, Optional
import logging

class ContinuousMonitor:
    def __init__(self, project_root: str):
        self.project_root = Path(project_root)
        self.monitor_dir = self.project_root / ".claude" / "skill" / "sysmem" / "monitor"
        self.monitor_dir.mkdir(parents=True, exist_ok=True)

        # 配置日志
        logging.basicConfig(
            level=logging.INFO,
            format='%(asctime)s - %(levelname)s - %(message)s',
            handlers=[
                logging.FileHandler(self.monitor_dir / "monitor.log"),
                logging.StreamHandler()
            ]
        )
        self.logger = logging.getLogger(__name__)

        # 监控配置
        self.config = {
            "max_dead_functions_threshold": 50,
            "max_dead_code_blocks_threshold": 200,
            "cleanup_interval_days": 30,
            "alert_on_new_dead_functions": True
        }

    def load_baseline(self) -> Optional[Dict]:
        """加载基线数据"""
        baseline_file = self.monitor_dir / "baseline.json"
        if baseline_file.exists():
            with open(baseline_file, 'r', encoding='utf-8') as f:
                return json.load(f)
        return None

    def save_baseline(self, data: Dict):
        """保存基线数据"""
        baseline_file = self.monitor_dir / "baseline.json"
        with open(baseline_file, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        self.logger.info(f"基线数据已保存: {baseline_file}")

    def run_analysis(self) -> Dict:
        """运行死函数分析"""
        self.logger.info("开始运行死函数分析...")

        analyzer_script = self.project_root / ".claude" / "skill" / "sysmem" / "dead_function_analyzer.py"

        try:
            result = subprocess.run(
                [sys.executable, str(analyzer_script), str(self.project_root)],
                capture_output=True,
                text=True,
                check=True
            )

            # 读取分析结果
            analysis_file = self.project_root / ".claude" / "skill" / "sysmem" / "dead_function_analysis.json"
            if analysis_file.exists():
                with open(analysis_file, 'r', encoding='utf-8') as f:
                    return json.load(f)
            else:
                raise Exception("分析结果文件未生成")

        except subprocess.CalledProcessError as e:
            self.logger.error(f"分析执行失败: {e}")
            self.logger.error(f"错误输出: {e.stderr}")
            raise

    def compare_with_baseline(self, current: Dict, baseline: Optional[Dict]) -> Dict:
        """与基线数据比较"""
        comparison = {
            "timestamp": datetime.datetime.now().isoformat(),
            "baseline_timestamp": baseline.get("analysis_timestamp") if baseline else None,
            "changes": {}
        }

        if not baseline:
            comparison["changes"]["new_analysis"] = True
            return comparison

        current_summary = current.get("cleanup_plan", {}).get("summary", {})
        baseline_summary = baseline.get("cleanup_plan", {}).get("summary", {})

        # 比较未使用函数数量
        current_unused = current_summary.get("total_unused_functions", 0)
        baseline_unused = baseline_summary.get("total_unused_functions", 0)
        comparison["changes"]["unused_functions"] = {
            "current": current_unused,
            "baseline": baseline_unused,
            "difference": current_unused - baseline_unused
        }

        # 比较死代码块数量
        current_dead_blocks = current_summary.get("dead_code_blocks", 0)
        baseline_dead_blocks = baseline_summary.get("dead_code_blocks", 0)
        comparison["changes"]["dead_code_blocks"] = {
            "current": current_dead_blocks,
            "baseline": baseline_dead_blocks,
            "difference": current_dead_blocks - baseline_dead_blocks
        }

        # 比较风险分布
        current_risks = {
            "high": current_summary.get("high_risk", 0),
            "medium": current_summary.get("medium_risk", 0),
            "low": current_summary.get("low_risk", 0)
        }
        baseline_risks = {
            "high": baseline_summary.get("high_risk", 0),
            "medium": baseline_summary.get("medium_risk", 0),
            "low": baseline_summary.get("low_risk", 0)
        }

        comparison["changes"]["risk_distribution"] = {
            "current": current_risks,
            "baseline": baseline_risks,
            "differences": {
                "high": current_risks["high"] - baseline_risks["high"],
                "medium": current_risks["medium"] - baseline_risks["medium"],
                "low": current_risks["low"] - baseline_risks["low"]
            }
        }

        return comparison

    def check_thresholds(self, current: Dict) -> List[str]:
        """检查阈值并生成警告"""
        warnings = []
        summary = current.get("cleanup_plan", {}).get("summary", {})

        unused_functions = summary.get("total_unused_functions", 0)
        dead_code_blocks = summary.get("dead_code_blocks", 0)

        if unused_functions > self.config["max_dead_functions_threshold"]:
            warnings.append(
                f"未使用函数数量 ({unused_functions}) 超过阈值 ({self.config['max_dead_functions_threshold']})"
            )

        if dead_code_blocks > self.config["max_dead_code_blocks_threshold"]:
            warnings.append(
                f"死代码块数量 ({dead_code_blocks}) 超过阈值 ({self.config['max_dead_code_blocks_threshold']})"
            )

        return warnings

    def generate_alert(self, comparison: Dict, warnings: List[str]) -> Optional[str]:
        """生成警报消息"""
        if not warnings and not self.config["alert_on_new_dead_functions"]:
            return None

        changes = comparison.get("changes", {})

        alert_parts = ["🚨 RouteCodex 代码质量警报"]
        alert_parts.append(f"时间: {comparison['timestamp']}")

        # 添加变化信息
        if "unused_functions" in changes:
            func_change = changes["unused_functions"]
            if func_change["difference"] > 0:
                alert_parts.append(f"新增 {func_change['difference']} 个未使用函数")

        if "dead_code_blocks" in changes:
            block_change = changes["dead_code_blocks"]
            if block_change["difference"] > 0:
                alert_parts.append(f"新增 {block_change['difference']} 个死代码块")

        # 添加警告信息
        if warnings:
            alert_parts.append("\n⚠️ 警告:")
            alert_parts.extend(f"  - {warning}" for warning in warnings)

        # 添加建议
        alert_parts.append("\n💡 建议:")
        alert_parts.append("  - 运行清理脚本: .claude/skill/sysmem/cleanup-scripts/safe-cleanup.sh")
        alert_parts.append("  - 查看详细报告: .claude/skill/sysmem/ROUTECODEX_DEAD_FUNCTION_CLEANUP_REPORT.md")

        return "\n".join(alert_parts)

    def save_monitoring_result(self, result: Dict):
        """保存监控结果"""
        result_file = self.monitor_dir / f"monitoring_{datetime.datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        with open(result_file, 'w', encoding='utf-8') as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        self.logger.info(f"监控结果已保存: {result_file}")

        # 保留最近30天的结果
        self._cleanup_old_results()

    def _cleanup_old_results(self):
        """清理旧的监控结果"""
        cutoff_date = datetime.datetime.now() - datetime.timedelta(days=30)

        for result_file in self.monitor_dir.glob("monitoring_*.json"):
            try:
                file_date = datetime.datetime.strptime(
                    result_file.stem.split("_")[1],
                    "%Y%m%d_%H%M%S"
                )
                if file_date < cutoff_date:
                    result_file.unlink()
                    self.logger.info(f"删除旧的监控结果: {result_file}")
            except (ValueError, IndexError):
                continue

    def should_run_cleanup(self, baseline: Optional[Dict]) -> bool:
        """判断是否应该运行清理"""
        if not baseline:
            return True

        try:
            baseline_time = datetime.datetime.fromisoformat(
                baseline.get("analysis_timestamp", "")
            )
            days_since_baseline = (datetime.datetime.now() - baseline_time).days

            return days_since_baseline >= self.config["cleanup_interval_days"]
        except (ValueError, TypeError):
            return True

    def run_monitoring(self) -> Dict:
        """运行完整的监控流程"""
        self.logger.info("开始持续监控...")

        # 加载基线数据
        baseline = self.load_baseline()

        # 运行分析
        current_analysis = self.run_analysis()

        # 比较分析结果
        comparison = self.compare_with_baseline(current_analysis, baseline)

        # 检查阈值
        warnings = self.check_thresholds(current_analysis)

        # 生成警报
        alert = self.generate_alert(comparison, warnings)

        # 构建监控结果
        monitoring_result = {
            "timestamp": datetime.datetime.now().isoformat(),
            "current_analysis": current_analysis,
            "comparison": comparison,
            "warnings": warnings,
            "alert": alert,
            "should_cleanup": self.should_run_cleanup(baseline)
        }

        # 保存结果
        self.save_monitoring_result(monitoring_result)

        # 输出结果
        if alert:
            print(alert)
            self.logger.warning("生成了代码质量警报")
        else:
            print("✅ 代码质量监控正常，无需警报")

        if monitoring_result["should_cleanup"]:
            print("💡 建议运行清理操作")

        # 更新基线
        self.save_baseline(current_analysis)

        return monitoring_result

    def setup_cron_job(self) -> bool:
        """设置定期任务（仅限Unix系统）"""
        if os.name != 'posix':
            self.logger.warning("定期任务设置仅支持Unix系统")
            return False

        try:
            # 获取当前脚本路径
            script_path = Path(__file__).absolute()

            # 生成cron任务
            cron_command = f"0 2 * * 0 cd {self.project_root} && {sys.executable} {script_path} monitor >> {self.monitor_dir / 'cron.log'} 2>&1"

            self.logger.info("请手动添加以下cron任务:")
            self.logger.info(cron_command)
            self.logger.info("或者运行: crontab -e 然后添加上述行")

            return True
        except Exception as e:
            self.logger.error(f"设置定期任务失败: {e}")
            return False

def main():
    if len(sys.argv) < 2:
        print("使用方法: python continuous-monitor.py <操作>")
        print("操作选项:")
        print("  monitor   - 运行一次监控")
        print("  setup-cron - 设置定期任务")
        sys.exit(1)

    project_root = "/Users/fanzhang/Documents/github/routecodex-worktree/dev"
    monitor = ContinuousMonitor(project_root)

    operation = sys.argv[1]

    if operation == "monitor":
        try:
            result = monitor.run_monitoring()
            print(f"\n监控完成，详细结果保存在: {monitor.monitor_dir}")
        except Exception as e:
            print(f"监控失败: {e}")
            sys.exit(1)

    elif operation == "setup-cron":
        if monitor.setup_cron_job():
            print("定期任务设置说明已显示")
        else:
            print("定期任务设置失败")
            sys.exit(1)

    else:
        print(f"未知操作: {operation}")
        sys.exit(1)

if __name__ == "__main__":
    main()