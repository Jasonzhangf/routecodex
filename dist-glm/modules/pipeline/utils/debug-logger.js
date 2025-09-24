/**
 * Pipeline Debug Logger Implementation
 *
 * Provides structured logging for pipeline operations with integration
 * to DebugCenter for centralized debugging and monitoring.
 */
import { DebugEventBus } from 'rcc-debugcenter';
/**
 * Pipeline Debug Logger
 */
export class PipelineDebugLogger {
    constructor(debugCenter, options = {}) {
        this.debugCenter = debugCenter;
        this.options = options;
        this.logs = [];
        this.transformationLogs = [];
        this.providerLogs = [];
        this.maxLogEntries = 1000;
        this.options = {
            enableConsoleLogging: true,
            enableDebugCenter: true,
            maxLogEntries: 1000,
            logLevel: 'detailed',
            ...options
        };
        this.maxLogEntries = this.options.maxLogEntries;
        // Ensure events also flow into the global DebugEventBus so external DebugCenter listeners can capture session IO
        try {
            this.eventBus = DebugEventBus.getInstance();
        }
        catch {
            // ignore if bus not available at runtime
            this.eventBus = undefined;
        }
    }
    /**
     * Log module-specific information
     */
    logModule(module, action, data) {
        const entry = {
            level: 'info',
            timestamp: Date.now(),
            pipelineId: this.extractPipelineId(module),
            category: 'module',
            message: `${action}: ${module}`,
            data: {
                moduleId: module,
                action,
                ...data
            }
        };
        this.addLogEntry(entry);
        if (this.options.enableConsoleLogging) {
            this.logToConsole(entry);
        }
        if (this.options.enableDebugCenter) {
            this.logToDebugCenter(entry);
        }
    }
    /**
     * Log pipeline lifecycle events
     */
    logPipeline(pipelineId, action, data) {
        const entry = {
            level: 'info',
            timestamp: Date.now(),
            pipelineId,
            category: 'pipeline-lifecycle',
            message: action,
            data
        };
        this.addLogEntry(entry);
        if (this.options.enableConsoleLogging) {
            this.logToConsole(entry);
        }
        if (this.options.enableDebugCenter) {
            this.logToDebugCenter(entry);
        }
    }
    /**
     * Log request processing information
     */
    logRequest(requestId, action, data) {
        const entry = {
            level: 'info',
            timestamp: Date.now(),
            pipelineId: this.extractPipelineIdFromRequest(data),
            category: 'request',
            message: `Request ${action}`,
            data: {
                requestId,
                action,
                ...data
            },
            requestId
        };
        this.addLogEntry(entry);
        if (this.options.enableConsoleLogging && this.options.logLevel !== 'none') {
            this.logToConsole(entry);
        }
        if (this.options.enableDebugCenter) {
            this.logToDebugCenter(entry);
        }
    }
    /**
     * Log response processing information
     */
    logResponse(requestId, action, data) {
        const entry = {
            level: 'info',
            timestamp: Date.now(),
            pipelineId: this.extractPipelineIdFromResponse(data),
            category: 'response',
            message: `Response ${action}`,
            data: {
                requestId,
                action,
                ...data
            },
            requestId
        };
        this.addLogEntry(entry);
        if (this.options.enableConsoleLogging && this.options.logLevel !== 'none') {
            this.logToConsole(entry);
        }
        if (this.options.enableDebugCenter) {
            this.logToDebugCenter(entry);
        }
    }
    /**
     * Log transformation operations
     */
    logTransformation(requestId, action, data, result) {
        const pipelineId = this.extractPipelineIdFromData(data);
        const entry = {
            timestamp: Date.now(),
            pipelineId,
            requestId,
            stage: action,
            originalData: this.sanitizeData(data),
            transformedData: this.sanitizeData(result),
            metadata: {
                ruleId: action,
                processingTime: 0,
                dataSize: data ? JSON.stringify(data).length : 0
            }
        };
        this.transformationLogs.push(entry);
        // Keep only recent transformation logs
        if (this.transformationLogs.length > this.maxLogEntries) {
            this.transformationLogs = this.transformationLogs.slice(-this.maxLogEntries);
        }
        // Log as debug entry
        this.log('debug', pipelineId, 'transformation', action, {
            transformationType: action,
            processingTime: entry.metadata.processingTime,
            dataSize: entry.metadata.dataSize
        });
        // Publish detailed IO to DebugEventBus (if available)
        if (this.eventBus) {
            this.eventBus.publish({
                sessionId: requestId,
                moduleId: pipelineId,
                operationId: `transformation:${action}`,
                timestamp: entry.timestamp,
                type: 'start',
                position: 'middle',
                data: {
                    input: this.sanitizeData(data),
                    output: this.sanitizeData(result)
                }
            });
        }
    }
    /**
     * Log provider request/response operations
     */
    logProviderRequest(requestId, action, request, response) {
        const data = { ...request, response };
        const pipelineId = request?.pipelineId || request?.providerId || 'unknown';
        const entry = {
            timestamp: Date.now(),
            pipelineId,
            requestId,
            action,
            provider: {
                id: request?.providerId || 'unknown',
                type: request?.providerType || 'unknown'
            },
            data: this.sanitizeData(data),
            metrics: response?.metrics || request?.metrics
        };
        this.providerLogs.push(entry);
        // Keep only recent provider logs
        if (this.providerLogs.length > this.maxLogEntries) {
            this.providerLogs = this.providerLogs.slice(-this.maxLogEntries);
        }
        // Log as debug entry
        this.log('debug', pipelineId, 'provider', action, data);
        // Publish detailed IO to DebugEventBus (if available)
        if (this.eventBus) {
            this.eventBus.publish({
                sessionId: requestId,
                moduleId: pipelineId,
                operationId: `provider:${action}`,
                timestamp: entry.timestamp,
                type: action === 'request-error' ? 'error' : 'start',
                position: 'middle',
                data: {
                    input: this.sanitizeData(request),
                    output: this.sanitizeData(response)
                }
            });
        }
    }
    /**
     * Log error information
     */
    logError(error, context) {
        const entry = {
            level: 'error',
            timestamp: Date.now(),
            pipelineId: this.extractPipelineIdFromData(context),
            category: 'error',
            message: error instanceof Error ? error.message : String(error),
            data: {
                error: error instanceof Error ? error.message : String(error),
                stack: error instanceof Error ? error.stack : undefined,
                context
            },
            requestId: context?.requestId
        };
        this.addLogEntry(entry);
        if (this.options.enableConsoleLogging) {
            this.logToConsole(entry);
        }
        if (this.options.enableDebugCenter) {
            this.logToDebugCenter(entry);
        }
    }
    /**
     * Log debug information
     */
    logDebug(message, data) {
        const entry = {
            level: 'debug',
            timestamp: Date.now(),
            pipelineId: this.extractPipelineIdFromData(data),
            category: 'debug',
            message,
            data
        };
        this.addLogEntry(entry);
        if (this.options.enableConsoleLogging) {
            this.logToConsole(entry);
        }
        if (this.options.enableDebugCenter) {
            this.logToDebugCenter(entry);
        }
    }
    /**
     * Get logs for a specific request
     */
    getRequestLogs(requestId) {
        return {
            general: this.logs.filter(log => log.requestId === requestId),
            transformations: this.transformationLogs.filter(log => log.requestId === requestId),
            provider: this.providerLogs.filter(log => log.requestId === requestId)
        };
    }
    /**
     * Get logs for a specific pipeline
     */
    getPipelineLogs(pipelineId) {
        return {
            general: this.logs.filter(log => log.pipelineId === pipelineId),
            transformations: this.transformationLogs.filter(log => log.pipelineId === pipelineId),
            provider: this.providerLogs.filter(log => log.pipelineId === pipelineId)
        };
    }
    /**
     * Get recent logs
     */
    getRecentLogs(count = 100) {
        return this.logs.slice(-count);
    }
    /**
     * Get transformation logs
     */
    getTransformationLogs() {
        return [...this.transformationLogs];
    }
    /**
     * Get provider logs
     */
    getProviderLogs() {
        return [...this.providerLogs];
    }
    /**
     * Get log statistics
     */
    getStatistics() {
        const logsByLevel = {};
        const logsByCategory = {};
        const logsByPipeline = {};
        this.logs.forEach(log => {
            logsByLevel[log.level] = (logsByLevel[log.level] || 0) + 1;
            logsByCategory[log.category] = (logsByCategory[log.category] || 0) + 1;
            logsByPipeline[log.pipelineId] = (logsByPipeline[log.pipelineId] || 0) + 1;
        });
        return {
            totalLogs: this.logs.length,
            logsByLevel,
            logsByCategory,
            logsByPipeline,
            transformationCount: this.transformationLogs.length,
            providerRequestCount: this.providerLogs.length
        };
    }
    /**
     * Clear all logs
     */
    clearLogs() {
        this.logs = [];
        this.transformationLogs = [];
        this.providerLogs = [];
    }
    /**
     * Export logs to file or object
     */
    exportLogs(format = 'json') {
        if (format === 'json') {
            return {
                timestamp: Date.now(),
                general: this.logs,
                transformations: this.transformationLogs,
                provider: this.providerLogs,
                statistics: this.getStatistics()
            };
        }
        // Would implement CSV export here
        return { error: 'CSV export not implemented yet' };
    }
    /**
     * Log general debug messages
     */
    log(level, pipelineId, category, message, data) {
        const entry = {
            level,
            timestamp: Date.now(),
            pipelineId,
            category,
            message,
            data
        };
        this.addLogEntry(entry);
        // Console logging
        if (this.options.enableConsoleLogging) {
            this.logToConsole(entry);
        }
        // DebugCenter integration
        if (this.options.enableDebugCenter) {
            this.logToDebugCenter(entry);
        }
    }
    /**
     * Add log entry with size management
     */
    addLogEntry(entry) {
        this.logs.push(entry);
        // Keep only recent logs
        if (this.logs.length > this.maxLogEntries) {
            this.logs = this.logs.slice(-this.maxLogEntries);
        }
    }
    /**
     * Log to console
     */
    logToConsole(entry) {
        const timestamp = new Date(entry.timestamp).toISOString();
        const prefix = `[${timestamp}] [${entry.level.toUpperCase()}] [${entry.pipelineId}] [${entry.category}]`;
        switch (entry.level) {
            case 'error':
                console.error(prefix, entry.message, entry.data);
                break;
            case 'warn':
                console.warn(prefix, entry.message, entry.data);
                break;
            case 'debug':
                if (this.options.logLevel === 'verbose' || this.options.logLevel === 'detailed') {
                    console.debug(prefix, entry.message, entry.data);
                }
                break;
            default:
                if (this.options.logLevel !== 'none') {
                    console.log(prefix, entry.message, entry.data);
                }
                break;
        }
    }
    /**
     * Log to DebugCenter
     */
    logToDebugCenter(entry) {
        try {
            this.debugCenter.processDebugEvent({
                sessionId: entry.requestId || 'unknown',
                moduleId: entry.pipelineId || 'unknown',
                operationId: `log-${entry.category}`,
                timestamp: entry.timestamp,
                type: 'start',
                position: 'middle',
                data: {
                    level: entry.level,
                    category: entry.category,
                    message: entry.message,
                    data: entry.data,
                    requestId: entry.requestId,
                    stage: entry.stage
                }
            });
            // Also publish to DebugEventBus for file-based session capture by external DebugCenter
            if (this.eventBus) {
                this.eventBus.publish({
                    sessionId: entry.requestId || 'unknown',
                    moduleId: entry.pipelineId || 'pipeline',
                    operationId: `pipeline-${entry.category}`,
                    timestamp: entry.timestamp,
                    type: entry.level === 'error' ? 'error' : 'start',
                    position: 'middle',
                    data: entry.data
                });
            }
        }
        catch (error) {
            // Fallback to console if DebugCenter fails
            console.warn('Failed to log to DebugCenter:', error instanceof Error ? error.message : String(error));
        }
    }
    /**
     * Extract pipeline ID from module ID
     */
    extractPipelineId(moduleId) {
        // Extract pipeline ID from module ID format
        const match = moduleId.match(/^(\w+)-/);
        return match ? match[1] : moduleId;
    }
    /**
     * Extract pipeline ID from request data
     */
    extractPipelineIdFromRequest(data) {
        return data.pipelineId || data.route?.pipelineId || 'unknown';
    }
    /**
     * Extract pipeline ID from response data
     */
    extractPipelineIdFromResponse(data) {
        return data.pipelineId || data.metadata?.pipelineId || 'unknown';
    }
    /**
     * Extract pipeline ID from generic data
     */
    extractPipelineIdFromData(data) {
        return data.pipelineId || data.metadata?.pipelineId || 'unknown';
    }
    /**
     * Sanitize data for logging (remove sensitive information)
     */
    sanitizeData(data) {
        if (!data || typeof data !== 'object') {
            return data;
        }
        const sanitized = { ...data };
        // Remove sensitive fields
        const sensitiveFields = [
            'apiKey', 'api_key', 'token', 'password', 'secret',
            'authorization', 'auth', 'credentials'
        ];
        sensitiveFields.forEach(field => {
            if (field in sanitized) {
                sanitized[field] = '[REDACTED]';
            }
        });
        return sanitized;
    }
}
