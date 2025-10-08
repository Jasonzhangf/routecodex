/**
 * RouteCodex Debug API Service
 */

import axios, { AxiosInstance } from 'axios';
import { DebugEvent, ModuleStatus, SystemHealth, PerformanceMetrics, ModuleDetails } from '../types';

export class DebugApiService {
  private api: AxiosInstance;

  constructor(baseUrl: string = 'http://localhost:5506') {
    this.api = axios.create({
      baseURL: `${baseUrl}/api/debug`,
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    // Request interceptor
    this.api.interceptors.request.use(
      (config) => {
        console.log(`API Request: ${config.method?.toUpperCase()} ${config.url}`);
        return config;
      },
      (error) => {
        console.error('API Request Error:', error);
        return Promise.reject(error);
      }
    );

    // Response interceptor
    this.api.interceptors.response.use(
      (response) => {
        console.log(`API Response: ${response.status} ${response.config.url}`);
        return response;
      },
      (error) => {
        console.error('API Response Error:', error.response?.data || error.message);
        return Promise.reject(error);
      }
    );
  }

  // System Health
  async getSystemHealth(): Promise<SystemHealth> {
    const response = await this.api.get('/health');
    return response.data;
  }

  // Module Status
  async getModuleStatuses(): Promise<ModuleStatus[]> {
    const response = await this.api.get('/modules');
    return response.data;
  }

  async getModuleDetails(moduleId: string): Promise<ModuleDetails> {
    const response = await this.api.get(`/modules/${moduleId}`);
    return response.data;
  }

  async updateModuleConfig(moduleId: string, config: Record<string, any>): Promise<void> {
    await this.api.put(`/modules/${moduleId}/config`, config);
  }

  // Events
  async getEvents(filters?: {
    type?: string;
    moduleId?: string;
    limit?: number;
    offset?: number;
    startTime?: number;
    endTime?: number;
  }): Promise<DebugEvent[]> {
    const params = new URLSearchParams();
    if (filters) {
      Object.entries(filters).forEach(([key, value]) => {
        if (value !== undefined) {
          params.append(key, value.toString());
        }
      });
    }

    const response = await this.api.get(`/events?${params.toString()}`);
    return response.data;
  }

  async getEventDetails(eventId: string): Promise<DebugEvent> {
    const response = await this.api.get(`/events/${eventId}`);
    return response.data;
  }

  // Performance Metrics
  async getPerformanceMetrics(timeRange?: {
    start: number;
    end: number;
  }): Promise<PerformanceMetrics[]> {
    const params = new URLSearchParams();
    if (timeRange) {
      params.append('start', timeRange.start.toString());
      params.append('end', timeRange.end.toString());
    }

    const response = await this.api.get(`/metrics?${params.toString()}`);
    return response.data;
  }

  // Configuration
  async getDebugConfig(): Promise<any> {
    const response = await this.api.get('/config');
    return response.data;
  }

  async updateDebugConfig(config: any): Promise<void> {
    await this.api.put('/config', config);
  }

  // WebSocket Server Info
  async getWebSocketInfo(): Promise<{ url: string; status: string }> {
    const response = await this.api.get('/websocket/info');
    return response.data;
  }

  // Export/Import
  async exportDebugData(format: 'json' | 'csv' = 'json'): Promise<Blob> {
    const response = await this.api.get(`/export/${format}`, {
      responseType: 'blob',
    });
    return response.data;
  }

  async importDebugData(data: FormData): Promise<void> {
    await this.api.post('/import', data, {
      headers: {
        'Content-Type': 'multipart/form-data',
      },
    });
  }

  // Clear Data
  async clearEvents(): Promise<void> {
    await this.api.delete('/events');
  }

  async clearMetrics(): Promise<void> {
    await this.api.delete('/metrics');
  }

  async clearAll(): Promise<void> {
    await this.api.delete('/all');
  }

  // Health Check
  async healthCheck(): Promise<{ status: string; timestamp: number; uptime: number }> {
    const response = await this.api.get('/health');
    return response.data;
  }

  // Dynamic Routing Configuration
  async getRoutingConfig(): Promise<any> {
    const response = await this.api.get('/routing/config');
    return response.data;
  }

  async updateRoutingConfig(config: any): Promise<void> {
    await this.api.put('/routing/config', config);
  }

  async getRoutingRules(): Promise<any[]> {
    const response = await this.api.get('/routing/rules');
    return response.data;
  }

  async createRoutingRule(rule: any): Promise<void> {
    await this.api.post('/routing/rules', rule);
  }

  async updateRoutingRule(ruleId: string, rule: any): Promise<void> {
    await this.api.put(`/routing/rules/${ruleId}`, rule);
  }

  async deleteRoutingRule(ruleId: string): Promise<void> {
    await this.api.delete(`/routing/rules/${ruleId}`);
  }

  async testRoutingRule(request: any): Promise<any> {
    const response = await this.api.post('/routing/rules/test', { request });
    return response.data;
  }

  async getRoutingProviders(): Promise<any[]> {
    const response = await this.api.get('/routing/providers');
    return response.data;
  }

  async getRoutingStats(): Promise<any> {
    const response = await this.api.get('/routing/stats');
    return response.data;
  }
}

// Singleton instance
export const debugApi = new DebugApiService();