#!/usr/bin/env node

/**
 * 重复代码趋势分析脚本
 * 分析重复代码的历史趋势和改进情况
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

class DuplicateTrendAnalyzer {
  constructor() {
    this.reportsDir = path.join(__dirname, '..', 'historical-reports');
    this.currentReport = null;
    this.historicalReports = [];
  }

  /**
   * 分析重复代码趋势
   */
  async analyzeTrends() {
    console.log('📈 分析重复代码趋势...');
    
    // 收集历史报告
    await this.collectHistoricalReports();
    
    if (this.historicalReports.length < 2) {
      console.log('⚠️  历史数据不足，无法进行趋势分析');
      return;
    }
    
    // 计算趋势指标
    const trends = this.calculateTrends();
    
    // 生成趋势报告
    await this.generateTrendReport(trends);
    
    // 检查是否需要告警
    this.checkAlerts(trends);
    
    console.log('✅ 趋势分析完成');
  }

  /**
   * 收集历史报告
   */
  async collectHistoricalReports() {
    if (!fs.existsSync(this.reportsDir)) {
      fs.mkdirSync(this.reportsDir, { recursive: true });
    }
    
    const files = fs.readdirSync(this.reportsDir)
      .filter(f => f.includes('duplicate-code-report'))
      .sort();
    
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(this.reportsDir, file), 'utf8');
        const report = JSON.parse(content);
        this.historicalReports.push({
          date: new Date(report.timestamp),
          summary: report.summary,
          duplicates: report.duplicates.length,
          suggestions: report.suggestions.length
        });
      } catch (error) {
        console.warn(`⚠️  无法读取报告文件 ${file}:`, error.message);
      }
    }
  }

  /**
   * 计算趋势指标
   */
  calculateTrends() {
    if (this.historicalReports.length < 2) {
      return null;
    }
    
    const latest = this.historicalReports[this.historicalReports.length - 1];
    const previous = this.historicalReports[this.historicalReports.length - 2];
    
    const duplicateChange = latest.duplicates - previous.duplicates;
    const suggestionChange = latest.suggestions - previous.suggestions;
    
    // 计算变化率
    const duplicateChangeRate = previous.duplicates > 0 ? 
      (duplicateChange / previous.duplicates) * 100 : 0;
    const suggestionChangeRate = previous.suggestions > 0 ? 
      (suggestionChange / previous.suggestions) * 100 : 0;
    
    // 计算移动平均（如果有足够数据）
    const movingAverage = this.calculateMovingAverage();
    
    return {
      current: latest,
      previous,
      changes: {
        duplicates: {
          absolute: duplicateChange,
          percentage: duplicateChangeRate
        },
        suggestions: {
          absolute: suggestionChange,
          percentage: suggestionChangeRate
        }
      },
      movingAverage,
      trend: this.determineTrend(duplicateChangeRate),
      healthScore: this.calculateHealthScore(latest)
    };
  }

  /**
   * 计算移动平均
   */
  calculateMovingAverage() {
    if (this.historicalReports.length < 3) {
      return null;
    }
    
    const recent = this.historicalReports.slice(-3);
    const avgDuplicates = recent.reduce((sum, r) => sum + r.duplicates, 0) / recent.length;
    const avgSuggestions = recent.reduce((sum, r) => sum + r.suggestions, 0) / recent.length;
    
    return {
      duplicates: avgDuplicates,
      suggestions: avgSuggestions,
      period: recent.length
    };
  }

  /**
   * 确定趋势方向
   */
  determineTrend(changeRate) {
    if (changeRate > 10) return 'increasing';
    if (changeRate < -10) return 'decreasing';
    return 'stable';
  }

  /**
   * 计算健康分数
   */
  calculateHealthScore(report) {
    const duplicateScore = Math.max(0, 100 - report.duplicates * 2);
    const suggestionScore = Math.max(0, 100 - report.suggestions * 3);
    const priorityScore = report.summary.highPrioritySuggestions * 10 + 
                         report.summary.mediumPrioritySuggestions * 5;
    
    return Math.round((duplicateScore + suggestionScore - priorityScore) / 3);
  }

  /**
   * 生成趋势报告
   */
  async generateTrendReport(trends) {
    const report = {
      timestamp: new Date().toISOString(),
      trends,
      recommendations: this.generateRecommendations(trends),
      alerts: this.generateAlerts(trends)
    };
    
    const reportPath = path.join(this.reportsDir, `trend-analysis-${Date.now()}.json`);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    
    // 生成人类可读的报告
    await this.generateReadableReport(report);
    
    console.log(`📄 趋势报告已生成: ${reportPath}`);
  }

  /**
   * 生成可读报告
   */
  async generateReadableReport(report) {
    const { trends, recommendations, alerts } = report;
    
    const content = `
# 重复代码趋势分析报告

生成时间: ${new Date(report.timestamp).toLocaleString()}

## 📊 当前状态

- **重复代码块数**: ${trends.current.duplicates}
- **重构建议数**: ${trends.current.suggestions}
- **健康分数**: ${trends.healthScore}/100

## 📈 趋势分析

### 重复代码变化
- **绝对变化**: ${trends.changes.duplicates.absolute > 0 ? '+' : ''}${trends.changes.duplicates.absolute}
- **相对变化**: ${trends.changes.duplicates.percentage.toFixed(1)}%
- **趋势**: ${trends.trend}

### 重构建议变化
- **绝对变化**: ${trends.changes.suggestions.absolute > 0 ? '+' : ''}${trends.changes.suggestions.absolute}
- **相对变化**: ${trends.changes.suggestions.percentage.toFixed(1)}%

## 🎯 建议

${recommendations.map(rec => `- ${rec}`).join('\n')}

## 🚨 告警

${alerts.length > 0 ? alerts.map(alert => `- **${alert.level}**: ${alert.message}`).join('\n') : '无告警'}

## 📋 历史数据

最近 ${this.historicalReports.length} 次检查结果：

| 日期 | 重复代码 | 重构建议 | 健康分数 |
|------|----------|----------|----------|
${this.historicalReports.slice(-5).map(r => 
  `| ${r.date.toLocaleDateString()} | ${r.duplicates} | ${r.suggestions} | ${this.calculateHealthScore(r)}/100 |`
).join('\n')}
`;

    const reportPath = path.join(this.reportsDir, 'trend-analysis.md');
    fs.writeFileSync(reportPath, content);
    
    console.log(`📄 可读报告已生成: ${reportPath}`);
  }

  /**
   * 生成建议
   */
  generateRecommendations(trends) {
    const recommendations = [];
    
    if (trends.trend === 'increasing') {
      recommendations.push('重复代码呈上升趋势，建议加强代码审查');
      recommendations.push('考虑实施更严格的编码规范');
    }
    
    if (trends.healthScore < 60) {
      recommendations.push('代码健康分数较低，需要立即关注重复代码问题');
    }
    
    if (trends.changes.duplicates.percentage > 20) {
      recommendations.push('重复代码增长过快，建议暂停新功能开发，专注于重构');
    }
    
    if (trends.movingAverage && trends.current.duplicates > trends.movingAverage.duplicates * 1.2) {
      recommendations.push('当前重复代码数量显著高于历史平均水平');
    }
    
    if (recommendations.length === 0) {
      recommendations.push('重复代码控制良好，继续保持当前实践');
    }
    
    return recommendations;
  }

  /**
   * 生成告警
   */
  generateAlerts(trends) {
    const alerts = [];
    
    if (trends.healthScore < 30) {
      alerts.push({
        level: 'CRITICAL',
        message: '代码健康分数极低，需要立即采取行动'
      });
    } else if (trends.healthScore < 50) {
      alerts.push({
        level: 'WARNING',
        message: '代码健康分数偏低，建议关注'
      });
    }
    
    if (trends.changes.duplicates.percentage > 50) {
      alerts.push({
        level: 'CRITICAL',
        message: '重复代码增长过快（>50%）'
      });
    } else if (trends.changes.duplicates.percentage > 25) {
      alerts.push({
        level: 'WARNING',
        message: '重复代码增长较快（>25%）'
      });
    }
    
    if (trends.current.duplicates > 100) {
      alerts.push({
        level: 'WARNING',
        message: '重复代码总量过高（>100）'
      });
    }
    
    return alerts;
  }

  /**
   * 检查是否需要告警
   */
  checkAlerts(trends) {
    const alerts = this.generateAlerts(trends);
    
    for (const alert of alerts) {
      console.log(`🚨 ${alert.level}: ${alert.message}`);
    }
    
    if (alerts.some(a => a.level === 'CRITICAL')) {
      console.log('💥 发现严重问题，建议立即处理');
      process.exit(1);
    }
  }
}

// CLI接口
async function main() {
  const analyzer = new DuplicateTrendAnalyzer();
  await analyzer.analyzeTrends();
}

// 如果直接运行此脚本
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export { DuplicateTrendAnalyzer };