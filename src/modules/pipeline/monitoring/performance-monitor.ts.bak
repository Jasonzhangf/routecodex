/**
 * Performance monitoring utilities
 */

/**
 * Pipeline metrics interface
 */
export interface PipelineMetrics {
  requestCount: number;
  successCount: number;
  errorCount: number;
  averageResponseTime: number;
  lastActivity: number;
}

/**
 * Pipeline performance monitor
 */
export class PipelinePerformanceMonitor {
  private metrics: PipelineMetrics = {
    requestCount: 0,
    successCount: 0,
    errorCount: 0,
    averageResponseTime: 0,
    lastActivity: 0
  };

  recordRequest(responseTime: number, success: boolean): void {
    this.metrics.requestCount++;
    this.metrics.lastActivity = Date.now();

    if (success) {
      this.metrics.successCount++;
    } else {
      this.metrics.errorCount++;
    }

    // Update average response time
    const totalResponseTime = this.metrics.averageResponseTime * (this.metrics.requestCount - 1) + responseTime;
    this.metrics.averageResponseTime = totalResponseTime / this.metrics.requestCount;
  }

  getMetrics(): PipelineMetrics {
    return { ...this.metrics };
  }

  reset(): void {
    this.metrics = {
      requestCount: 0,
      successCount: 0,
      errorCount: 0,
      averageResponseTime: 0,
      lastActivity: 0
    };
  }
}

/**
 * Create a performance monitor
 */
export function createPerformanceMonitor(): PipelinePerformanceMonitor {
  return new PipelinePerformanceMonitor();
}