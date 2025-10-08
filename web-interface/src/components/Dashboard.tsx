/**
 * RouteCodex Debug Dashboard Component
 */

import { useState, useEffect } from 'react';
import { useWebSocket } from '../hooks/useWebSocket';
import { useApi } from '../hooks/useApi';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import {
  Activity,
  AlertCircle,
  Clock,
  Cpu,
  MemoryStick,
  Network,
  RefreshCw,
  Server,
  Zap
} from 'lucide-react';
import { formatBytes, formatDuration, formatNumber, getHealthScoreColor } from '../utils/formatters';
import { MetricCard } from './MetricCard';
import { ModuleStatusCard } from './ModuleStatusCard';
import { EventLog } from './EventLog';
import { RoutingManager } from './RoutingManager';
import { BackendStatusIndicator } from './BackendStatusIndicator';

export function Dashboard() {
  const [isAutoRefresh, setIsAutoRefresh] = useState(true);

  const {
    isConnected,
    events,
    systemHealth,
    moduleStatuses,
    performanceMetrics,
    connect,
    refreshSystemHealth,
    refreshModuleStatuses,
    refreshPerformanceMetrics
  } = useWebSocket();

  const { loading: healthLoading, refetch: refetchHealth } = useApi(
    () => fetch('http://localhost:5506/health').then(res => res.json()),
    { autoRefresh: isAutoRefresh, refreshInterval: 30000 }
  );

  // Auto-connect on mount
  useEffect(() => {
    if (!isConnected) {
      connect();
    }
  }, [isConnected, connect]);

  const handleRefresh = () => {
    refreshSystemHealth();
    refreshModuleStatuses();
    refreshPerformanceMetrics();
    refetchHealth();
  };

  const healthyModules = moduleStatuses.filter((m: any) => m.status === 'healthy').length;
  const warningModules = moduleStatuses.filter((m: any) => m.status === 'warning').length;
  const errorModules = moduleStatuses.filter((m: any) => m.status === 'error').length;

  const latestMetrics = performanceMetrics[performanceMetrics.length - 1];
  const totalEvents = events.length;
  const errorEvents = events.filter((e: any) => e.type === 'error').length;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4">
      <div className="max-w-7xl mx-auto space-y-6">
        {/* Header */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between space-y-4 sm:space-y-0">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">
              RouteCodex Debug Dashboard
            </h1>
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              Real-time monitoring and debugging interface
            </p>
          </div>

          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-green-500' : 'bg-red-500'}`} />
              <span className="text-sm text-gray-600 dark:text-gray-400">
                {isConnected ? 'WebSocket Connected' : 'WebSocket Disconnected'}
              </span>
            </div>

            <Button
              onClick={handleRefresh}
              variant="outline"
              size="sm"
              className="flex items-center space-x-2"
            >
              <RefreshCw className="w-4 h-4" />
              <span>Refresh</span>
            </Button>

            <Button
              onClick={() => setIsAutoRefresh(!isAutoRefresh)}
              variant={isAutoRefresh ? "default" : "outline"}
              size="sm"
            >
              Auto Refresh: {isAutoRefresh ? 'ON' : 'OFF'}
            </Button>
          </div>
        </div>

        {/* Backend Status Indicator */}
        <BackendStatusIndicator />

        {/* System Overview Cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          <MetricCard
            title="System Health"
            value={systemHealth?.score || 0}
            unit="%"
            icon={<Activity className="w-5 h-5" />}
            color={getHealthScoreColor(systemHealth?.score || 0)}
            loading={healthLoading}
          />

          <MetricCard
            title="Active Modules"
            value={moduleStatuses.length}
            icon={<Server className="w-5 h-5" />}
            loading={healthLoading}
            details={`${healthyModules} healthy, ${warningModules} warnings, ${errorModules} errors`}
          />

          <MetricCard
            title="Total Events"
            value={totalEvents}
            icon={<Zap className="w-5 h-5" />}
            loading={healthLoading}
            details={`${errorEvents} errors`}
          />

          <MetricCard
            title="System Uptime"
            value={systemHealth?.uptime ? formatDuration(systemHealth.uptime * 1000) : '0s'}
            icon={<Clock className="w-5 h-5" />}
            loading={healthLoading}
          />
        </div>

        {/* Main Content Tabs */}
        <Tabs defaultValue="overview" className="space-y-4">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="modules">Modules</TabsTrigger>
            <TabsTrigger value="routing">Routing</TabsTrigger>
            <TabsTrigger value="events">Events</TabsTrigger>
            <TabsTrigger value="performance">Performance</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-6">
            {/* System Health Details */}
            <Card>
              <CardHeader>
                <CardTitle>System Health Status</CardTitle>
                <CardDescription>
                  Overall system health and module status
                </CardDescription>
              </CardHeader>
              <CardContent>
                {systemHealth ? (
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                          Memory Usage
                        </span>
                        <span className="text-sm font-medium">
                          {formatBytes(systemHealth.memory.used)} / {formatBytes(systemHealth.memory.total)}
                        </span>
                      </div>
                      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                        <div
                          className="bg-blue-600 h-2 rounded-full"
                          style={{ width: `${systemHealth.memory.percentage}%` }}
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                          Average Response Time
                        </span>
                        <span className="text-sm font-medium">
                          {systemHealth.performance.avgResponseTime.toFixed(2)}ms
                        </span>
                      </div>
                    </div>

                    <div className="space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                          Throughput
                        </span>
                        <span className="text-sm font-medium">
                          {formatNumber(systemHealth.performance.throughput)} req/s
                        </span>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="text-center py-8 text-gray-500">
                    No system health data available
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Recent Events */}
            <Card>
              <CardHeader>
                <CardTitle>Recent Events</CardTitle>
                <CardDescription>
                  Latest debug events and system activities
                </CardDescription>
              </CardHeader>
              <CardContent>
                <EventLog events={events.slice(0, 10)} maxEvents={10} />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="modules" className="space-y-6">
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-6">
              {moduleStatuses.map((module: any) => (
                <ModuleStatusCard
                  key={module.id}
                  module={module}
                  onDebugStart={() => {}}
                  onDebugStop={() => {}}
                />
              ))}

              {moduleStatuses.length === 0 && (
                <div className="col-span-full text-center py-8 text-gray-500">
                  No modules found
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="events" className="space-y-6">
            <EventLog events={events} maxEvents={50} />
          </TabsContent>

          <TabsContent value="routing" className="space-y-6">
            <RoutingManager />
          </TabsContent>

          <TabsContent value="performance" className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              <Card>
                <CardHeader>
                  <CardTitle>Performance Metrics</CardTitle>
                  <CardDescription>
                    Current system performance data
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  {latestMetrics ? (
                    <div className="space-y-4">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          <Cpu className="w-4 h-4 text-gray-600" />
                          <span className="text-sm text-gray-600 dark:text-gray-400">CPU Usage</span>
                        </div>
                        <span className="text-sm font-medium">
                          {latestMetrics.cpuUsage.toFixed(1)}%
                        </span>
                      </div>

                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          <MemoryStick className="w-4 h-4 text-gray-600" />
                          <span className="text-sm text-gray-600 dark:text-gray-400">Memory Usage</span>
                        </div>
                        <span className="text-sm font-medium">
                          {formatBytes(latestMetrics.memoryUsage)}
                        </span>
                      </div>

                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          <Zap className="w-4 h-4 text-gray-600" />
                          <span className="text-sm text-gray-600 dark:text-gray-400">Response Time</span>
                        </div>
                        <span className="text-sm font-medium">
                          {latestMetrics.responseTime.toFixed(2)}ms
                        </span>
                      </div>

                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          <Network className="w-4 h-4 text-gray-600" />
                          <span className="text-sm text-gray-600 dark:text-gray-400">Throughput</span>
                        </div>
                        <span className="text-sm font-medium">
                          {formatNumber(latestMetrics.throughput)} req/s
                        </span>
                      </div>

                      <div className="flex items-center justify-between">
                        <div className="flex items-center space-x-2">
                          <AlertCircle className="w-4 h-4 text-gray-600" />
                          <span className="text-sm text-gray-600 dark:text-gray-400">Error Rate</span>
                        </div>
                        <span className="text-sm font-medium">
                          {(latestMetrics.errorRate * 100).toFixed(2)}%
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="text-center py-8 text-gray-500">
                      No performance data available
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle>System Information</CardTitle>
                  <CardDescription>
                    Current system status and configuration
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-400">WebSocket Status:</span>
                      <span className={isConnected ? 'text-green-600' : 'text-red-600'}>
                        {isConnected ? 'Connected' : 'Disconnected'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-400">Active Modules:</span>
                      <span>{moduleStatuses.length}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-400">Total Events:</span>
                      <span>{formatNumber(totalEvents)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-600 dark:text-gray-400">Error Events:</span>
                      <span>{formatNumber(errorEvents)}</span>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}