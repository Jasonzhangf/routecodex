/**
 * Unimplemented Module Analytics
 * Analytics and reporting for unimplemented module usage
 */

import { UnimplementedModuleFactory } from '../modules/unimplemented-module-factory.js';
import {
  type UnimplementedCallAnalytics,
  type ModuleUsageStats,
} from '../config/unimplemented-config-types.js';

/**
 * Analytics configuration
 */
export interface AnalyticsConfig {
  enabled: boolean;
  aggregationInterval?: number;
  retentionPeriod?: number;
  enableTrendAnalysis?: boolean;
  enableCallerAnalysis?: boolean;
  priorityAlgorithm?: 'simple' | 'weighted' | 'machine-learning';
}

/**
 * Time-based aggregation data
 */
interface TimeAggregation {
  hour: Record<string, number>;
  day: Record<string, number>;
  week: Record<string, number>;
  month: Record<string, number>;
}

/**
 * Caller aggregation data
 */
interface CallerAggregation {
  callerFrequency: Record<string, number>;
  callerMethods: Record<string, Set<string>>;
  callerContexts: Record<string, unknown[]>;
}

/**
 * Unimplemented Module Analytics
 * Provides comprehensive analytics for unimplemented module usage
 */
export class UnimplementedModuleAnalytics {
  private factory: UnimplementedModuleFactory;
  private config: AnalyticsConfig;
  private timeAggregation: TimeAggregation;
  private callerAggregation: CallerAggregation;
  private lastAnalysis: UnimplementedCallAnalytics | null;

  constructor(factory: UnimplementedModuleFactory, config: AnalyticsConfig) {
    this.factory = factory;
    this.config = {
      aggregationInterval: 60 * 60 * 1000, // 1 hour
      retentionPeriod: 30 * 24 * 60 * 60 * 1000, // 30 days
      enableTrendAnalysis: true,
      enableCallerAnalysis: true,
      priorityAlgorithm: 'weighted',
      ...config,
    };

    this.timeAggregation = {
      hour: {},
      day: {},
      week: {},
      month: {},
    };

    this.callerAggregation = {
      callerFrequency: {},
      callerMethods: {},
      callerContexts: {},
    };

    this.lastAnalysis = null;

    if (this.config.enabled) {
      this.startAggregation();
    }
  }

  /**
   * Get comprehensive analytics data
   */
  public getAnalytics(): UnimplementedCallAnalytics {
    if (!this.config.enabled) {
      return this.getEmptyAnalytics();
    }

    const calledModules = this.factory.getCalledModules();
    const factoryStats = this.factory.getStats();

    const analytics: UnimplementedCallAnalytics = {
      totalUnimplementedCalls: factoryStats.totalCalls,
      uniqueModulesCalled: calledModules.length,
      mostCalledModules: this.getMostCalledModules(calledModules),
      callsByTime: this.getCallsByTime(),
      callerDistribution: this.getCallerDistribution(),
      implementationPriority: this.calculateImplementationPriority(calledModules),
    };

    this.lastAnalysis = analytics;
    return analytics;
  }

  /**
   * Get detailed module usage statistics
   */
  public getModuleUsageStats(): ModuleUsageStats[] {
    const calledModules = this.factory.getCalledModules();
    const allModules = this.factory.getAllModules();
    const stats: ModuleUsageStats[] = [];

    for (const [moduleId, module] of allModules) {
      const moduleStats = module.getStats();
      const calledModule = calledModules.find(cm => cm.moduleId === moduleId);

      const moduleInfo = (module as any).getInfo ? (module as any).getInfo() : { name: String(moduleId), type: 'unimplemented' };
      const daysSinceFirstCall = this.calculateDaysSince(moduleStats.firstCallTime);
      const averageCallsPerDay =
        daysSinceFirstCall > 0 ? moduleStats.totalCalls / daysSinceFirstCall : 0;

      stats.push({
        moduleId,
        moduleName: moduleInfo.name,
        moduleType: moduleInfo.type as any,
        totalCalls: moduleStats.totalCalls,
        lastCallTime: moduleStats.lastCallTime,
        firstCallTime: moduleStats.firstCallTime,
        averageCallsPerDay: Math.round(averageCallsPerDay * 100) / 100,
        uniqueCallers: new Set(moduleStats.callerInfo.map(call => call.callerId)).size,
        isImplemented: !calledModule,
        implementationPriority: this.calculateModulePriority(moduleStats, calledModule),
      });
    }

    return stats.sort((a, b) => b.implementationPriority - a.implementationPriority);
  }

  /**
   * Get trending unimplemented modules
   */
  public getTrendingModules(timeWindow: 'hour' | 'day' | 'week' | 'month' = 'day'): Array<{
    moduleId: string;
    moduleName: string;
    callCount: number;
    trend: 'increasing' | 'decreasing' | 'stable';
    trendPercentage: number;
  }> {
    if (!this.config.enableTrendAnalysis) {
      return [];
    }

    const timeData = this.timeAggregation[timeWindow];
    const trending: Array<{
      moduleId: string;
      moduleName: string;
      callCount: number;
      trend: 'increasing' | 'decreasing' | 'stable';
      trendPercentage: number;
    }> = [];

    const calledModules = this.factory.getCalledModules();

    for (const calledModule of calledModules) {
      const currentCount = timeData[calledModule.moduleId] || 0;
      const previousCount = this.getPreviousPeriodCount(timeWindow, calledModule.moduleId);

      if (currentCount > 0) {
        const trendPercentage =
          previousCount > 0 ? ((currentCount - previousCount) / previousCount) * 100 : 100;

        let trend: 'increasing' | 'decreasing' | 'stable';
        if (Math.abs(trendPercentage) < 5) {
          trend = 'stable';
        } else if (trendPercentage > 0) {
          trend = 'increasing';
        } else {
          trend = 'decreasing';
        }

        trending.push({
          moduleId: calledModule.moduleId,
          moduleName: calledModule.moduleName,
          callCount: currentCount,
          trend,
          trendPercentage: Math.round(trendPercentage * 100) / 100,
        });
      }
    }

    return trending.sort((a, b) => b.trendPercentage - a.trendPercentage);
  }

  /**
   * Get caller analysis
   */
  public getCallerAnalysis(): {
    topCallers: Array<{ callerId: string; callCount: number; uniqueModules: number }>;
    callerPatterns: Record<string, string[]>;
    callerContexts: Record<string, unknown[]>;
  } {
    if (!this.config.enableCallerAnalysis) {
      return { topCallers: [], callerPatterns: {}, callerContexts: {} };
    }

    const topCallers = Object.entries(this.callerAggregation.callerFrequency)
      .map(([callerId, callCount]) => ({
        callerId,
        callCount,
        uniqueModules: this.callerAggregation.callerMethods[callerId]?.size || 0,
      }))
      .sort((a, b) => b.callCount - a.callCount)
      .slice(0, 10);

    const callerPatterns: Record<string, string[]> = {};
    for (const [callerId, methods] of Object.entries(this.callerAggregation.callerMethods)) {
      callerPatterns[callerId] = Array.from(methods);
    }

    return {
      topCallers,
      callerPatterns,
      callerContexts: this.callerAggregation.callerContexts,
    };
  }

  /**
   * Generate implementation recommendations
   */
  public getImplementationRecommendations(): Array<{
    moduleId: string;
    priority: number;
    reasoning: string;
    estimatedEffort: 'low' | 'medium' | 'high';
    impact: 'low' | 'medium' | 'high';
    callerDiversity: number;
  }> {
    const moduleStats = this.getModuleUsageStats();
    const analytics = this.getAnalytics();

    return moduleStats
      .filter(module => module.totalCalls > 0)
      .slice(0, 20)
      .map(module => {
        const priorityData = analytics.implementationPriority.find(
          p => p.moduleId === module.moduleId
        );
        const callerAnalysis = this.getCallerAnalysis();

        const reasoning = this.generateReasoning(module, priorityData, callerAnalysis);
        const estimatedEffort = this.estimateImplementationEffort(module);
        const impact = this.assessImplementationImpact(module, analytics);

        return {
          moduleId: module.moduleId,
          priority: module.implementationPriority,
          reasoning,
          estimatedEffort,
          impact,
          callerDiversity: module.uniqueCallers,
        };
      })
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Export analytics data
   */
  public exportAnalytics(format: 'json' | 'csv' | 'report' = 'json'): string {
    const analytics = this.getAnalytics();
    const moduleStats = this.getModuleUsageStats();
    const trending = this.getTrendingModules();
    const recommendations = this.getImplementationRecommendations();

    switch (format) {
      case 'csv':
        return this.exportToCSV(analytics, moduleStats, trending, recommendations);
      case 'report':
        return this.exportToReport(analytics, moduleStats, trending, recommendations);
      case 'json':
      default:
        return JSON.stringify(
          {
            analytics,
            moduleStats,
            trending,
            recommendations,
            exportedAt: new Date().toISOString(),
          },
          null,
          2
        );
    }
  }

  /**
   * Reset analytics data
   */
  public resetAnalytics(): void {
    this.timeAggregation = {
      hour: {},
      day: {},
      week: {},
      month: {},
    };

    this.callerAggregation = {
      callerFrequency: {},
      callerMethods: {},
      callerContexts: {},
    };

    this.lastAnalysis = null;
  }

  /**
   * Get empty analytics (when disabled)
   */
  private getEmptyAnalytics(): UnimplementedCallAnalytics {
    return {
      totalUnimplementedCalls: 0,
      uniqueModulesCalled: 0,
      mostCalledModules: [],
      callsByTime: {},
      callerDistribution: {},
      implementationPriority: [],
    };
  }

  /**
   * Get most called modules
   */
  private getMostCalledModules(
    calledModules: any[]
  ): UnimplementedCallAnalytics['mostCalledModules'] {
    return calledModules
      .sort((a, b) => b.callCount - a.callCount)
      .slice(0, 10)
      .map(module => ({
        moduleId: module.moduleId,
        callCount: module.callCount,
        lastCalled: module.lastCalled,
      }));
  }

  /**
   * Get calls by time period
   */
  private getCallsByTime(): Record<string, number> {
    return {
      hour: Object.values(this.timeAggregation.hour).reduce((sum, count) => sum + count, 0),
      day: Object.values(this.timeAggregation.day).reduce((sum, count) => sum + count, 0),
      week: Object.values(this.timeAggregation.week).reduce((sum, count) => sum + count, 0),
      month: Object.values(this.timeAggregation.month).reduce((sum, count) => sum + count, 0),
    };
  }

  /**
   * Get caller distribution
   */
  private getCallerDistribution(): Record<string, number> {
    return { ...this.callerAggregation.callerFrequency };
  }

  /**
   * Calculate implementation priority
   */
  private calculateImplementationPriority(
    calledModules: any[]
  ): UnimplementedCallAnalytics['implementationPriority'] {
    return calledModules
      .map(module => {
        const priority = this.calculateModulePriority({ totalCalls: module.callCount }, module);

        return {
          moduleId: module.moduleId,
          priority,
          callCount: module.callCount,
          lastCalled: module.lastCalled,
          callerCount: 1, // This would need more detailed caller tracking
        };
      })
      .sort((a, b) => b.priority - a.priority);
  }

  /**
   * Calculate module priority score
   */
  private calculateModulePriority(moduleStats: any, _calledModule?: any): number {
    let score = 0;

    // Base score from call count
    score += Math.min(moduleStats.totalCalls * 10, 1000);

    // Recency bonus
    if (moduleStats.lastCallTime) {
      const hoursSinceLastCall =
        (Date.now() - new Date(moduleStats.lastCallTime).getTime()) / (1000 * 60 * 60);
      const recencyScore = Math.max(0, 100 - hoursSinceLastCall);
      score += recencyScore;
    }

    // Caller diversity bonus
    if (moduleStats.callerInfo) {
      const uniqueCallers = new Set(moduleStats.callerInfo.map((call: any) => call.callerId)).size;
      score += uniqueCallers * 50;
    }

    return Math.round(score);
  }

  /**
   * Calculate days since date
   */
  private calculateDaysSince(dateString?: string): number {
    if (!dateString) {
      return 0;
    }
    const date = new Date(dateString);
    const now = new Date();
    const diffTime = Math.abs(now.getTime() - date.getTime());
    return Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  }

  /**
   * Get previous period count for trend analysis
   */
  private getPreviousPeriodCount(timeWindow: string, moduleId: string): number {
    // This is a simplified implementation
    // In a real implementation, you'd maintain historical data
    return Math.floor(
      (this.timeAggregation[timeWindow as keyof TimeAggregation][moduleId] || 0) * 0.8
    );
  }

  /**
   * Generate implementation reasoning
   */
  private generateReasoning(
    module: ModuleUsageStats,
    _priorityData: any,
    _callerAnalysis: any
  ): string {
    const reasons = [];

    if (module.totalCalls > 100) {
      reasons.push(`High usage (${module.totalCalls} calls)`);
    }

    if (module.uniqueCallers > 5) {
      reasons.push(`Diverse caller base (${module.uniqueCallers} unique callers)`);
    }

    if (module.averageCallsPerDay > 10) {
      reasons.push(`Frequent daily usage (${module.averageCallsPerDay} calls/day)`);
    }

    return reasons.join(', ') || 'Moderate usage indicates potential value';
  }

  /**
   * Estimate implementation effort
   */
  private estimateImplementationEffort(module: ModuleUsageStats): 'low' | 'medium' | 'high' {
    // This would be based on module complexity, type, etc.
    // Simplified implementation
    if (module.moduleType === 'provider' && module.totalCalls < 50) {
      return 'low';
    } else if (module.moduleType === 'core' || module.totalCalls > 200) {
      return 'high';
    }
    return 'medium';
  }

  /**
   * Assess implementation impact
   */
  private assessImplementationImpact(
    module: ModuleUsageStats,
    analytics: UnimplementedCallAnalytics
  ): 'low' | 'medium' | 'high' {
    const usagePercentage = (module.totalCalls / analytics.totalUnimplementedCalls) * 100;

    if (usagePercentage > 20) {
      return 'high';
    } else if (usagePercentage > 5) {
      return 'medium';
    }
    return 'low';
  }

  /**
   * Export to CSV format
   */
  private exportToCSV(
    analytics: UnimplementedCallAnalytics,
    moduleStats: ModuleUsageStats[],
    trending: any[],
    recommendations: any[]
  ): string {
    // Simplified CSV export
    const csvRows = [
      'Module ID,Module Name,Call Count,Unique Callers,Avg Calls/Day,Priority,Recommended Effort,Impact',
      ...moduleStats
        .slice(0, 20)
        .map(
          module =>
            `${module.moduleId},${module.moduleName},${module.totalCalls},${module.uniqueCallers},${module.averageCallsPerDay},${module.implementationPriority},${recommendations.find(r => r.moduleId === module.moduleId)?.estimatedEffort || 'medium'},${recommendations.find(r => r.moduleId === module.moduleId)?.impact || 'medium'}`
        ),
    ];

    return csvRows.join('\n');
  }

  /**
   * Export to human-readable report
   */
  private exportToReport(
    analytics: UnimplementedCallAnalytics,
    moduleStats: ModuleUsageStats[],
    trending: any[],
    recommendations: any[]
  ): string {
    const report = [
      '# Unimplemented Module Analytics Report',
      `Generated: ${new Date().toISOString()}`,
      '',
      '## Summary',
      `- Total Unimplemented Calls: ${analytics.totalUnimplementedCalls}`,
      `- Unique Modules Called: ${analytics.uniqueModulesCalled}`,
      '',
      '## Top 10 Most Called Modules',
      ...analytics.mostCalledModules
        .slice(0, 10)
        .map(
          (module, index) =>
            `${index + 1}. ${module.moduleId} - ${module.callCount} calls (last: ${module.lastCalled})`
        ),
      '',
      '## Implementation Recommendations',
      ...recommendations
        .slice(0, 5)
        .map(
          (rec, index) =>
            `${index + 1}. ${rec.moduleId} (Priority: ${rec.priority}, Effort: ${rec.estimatedEffort}, Impact: ${rec.impact})`
        ),
      '',
      '## Detailed Module Statistics',
      ...moduleStats
        .slice(0, 20)
        .map(
          module =>
            `- ${module.moduleName}: ${module.totalCalls} calls, ${module.uniqueCallers} callers, ${module.averageCallsPerDay}/day`
        ),
    ];

    return report.join('\n');
  }

  /**
   * Start data aggregation
   */
  private startAggregation(): void {
    setInterval(
      () => {
        this.aggregateCurrentData();
      },
      this.config.aggregationInterval || 60 * 60 * 1000
    );
  }

  /**
   * Aggregate current data
   */
  private aggregateCurrentData(): void {
    const calledModules = this.factory.getCalledModules();
    const now = new Date();

    // Aggregate by time periods
    for (const calledModule of calledModules) {
      // const moduleId = calledModule.moduleId;

      // Hour aggregation
      const hourKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}`;
      this.timeAggregation.hour[hourKey] =
        (this.timeAggregation.hour[hourKey] || 0) + calledModule.callCount;

      // Day aggregation
      const dayKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}`;
      this.timeAggregation.day[dayKey] =
        (this.timeAggregation.day[dayKey] || 0) + calledModule.callCount;

      // Week aggregation
      const weekKey = `${now.getFullYear()}-W${this.getWeekNumber(now)}`;
      this.timeAggregation.week[weekKey] =
        (this.timeAggregation.week[weekKey] || 0) + calledModule.callCount;

      // Month aggregation
      const monthKey = `${now.getFullYear()}-${now.getMonth()}`;
      this.timeAggregation.month[monthKey] =
        (this.timeAggregation.month[monthKey] || 0) + calledModule.callCount;
    }

    // Aggregate caller data
    this.aggregateCallerData();
  }

  /**
   * Aggregate caller data
   */
  private aggregateCallerData(): void {
    const allModules = this.factory.getAllModules();

    for (const [, module] of allModules) {
      const stats = module.getStats();

      for (const callerInfo of stats.callerInfo) {
        const callerId = callerInfo.callerId;

        // Update caller frequency
        this.callerAggregation.callerFrequency[callerId] =
          (this.callerAggregation.callerFrequency[callerId] || 0) + 1;

        // Update caller methods
        if (!this.callerAggregation.callerMethods[callerId]) {
          this.callerAggregation.callerMethods[callerId] = new Set();
        }
        this.callerAggregation.callerMethods[callerId].add(callerInfo.method);

        // Update caller contexts
        if (!this.callerAggregation.callerContexts[callerId]) {
          this.callerAggregation.callerContexts[callerId] = [];
        }
        if (callerInfo.context) {
          this.callerAggregation.callerContexts[callerId].push(callerInfo.context);
        }
      }
    }
  }

  /**
   * Get week number from date
   */
  private getWeekNumber(date: Date): number {
    const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    const dayNum = d.getUTCDay() || 7;
    d.setUTCDate(d.getUTCDate() + 4 - dayNum);
    const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
    return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  }
}
