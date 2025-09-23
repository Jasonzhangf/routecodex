/**
 * Module Details Component
 */

import { useState, useEffect } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { PerformanceChart, RealTimePerformanceChart } from './PerformanceChart';
import { ModuleDetails as ModuleDetailsType } from '../types';
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  Clock,
  Cpu,
  Database,
  MemoryStick,
  Pause,
  Play,
  Settings,
  Zap,
  XCircle
} from 'lucide-react';
import { formatBytes, formatDuration, formatRelativeTime, formatNumber, getStatusColor } from '../utils/formatters';

interface ModuleDetailsProps {
  moduleId: string;
  module: ModuleDetailsType;
  onDebugStart: (moduleId: string) => void;
  onDebugStop: (moduleId: string) => void;
  onConfigUpdate: (moduleId: string, config: Record<string, any>) => void;
}

export function ModuleDetails({
  moduleId,
  module,
  onDebugStart,
  onDebugStop,
  onConfigUpdate
}: ModuleDetailsProps) {
  const [isEditingConfig, setIsEditingConfig] = useState(false);
  const [configData, setConfigData] = useState<Record<string, any>>({});

  useEffect(() => {
    setConfigData(module.config);
  }, [module.config]);

  const handleConfigSave = () => {
    onConfigUpdate(moduleId, configData);
    setIsEditingConfig(false);
  };

  const handleConfigCancel = () => {
    setConfigData(module.config);
    setIsEditingConfig(false);
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'healthy':
        return <CheckCircle className="w-4 h-4" />;
      case 'warning':
        return <AlertTriangle className="w-4 h-4" />;
      case 'error':
        return <XCircle className="w-4 h-4" />;
      default:
        return <Activity className="w-4 h-4" />;
    }
  };

  const getTypeIcon = (type: string) => {
    switch (type) {
      case 'module':
        return <Cpu className="w-4 h-4" />;
      case 'server':
        return <Database className="w-4 h-4" />;
      case 'provider':
        return <Zap className="w-4 h-4" />;
      case 'pipeline':
        return <Activity className="w-4 h-4" />;
      default:
        return <Settings className="w-4 h-4" />;
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-3">
              <div className="p-2 rounded-lg bg-gray-100 dark:bg-gray-800">
                {getTypeIcon(module.type)}
              </div>
              <div>
                <CardTitle className="text-xl">{module.name}</CardTitle>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {module.description} • v{module.version}
                </p>
              </div>
            </div>
            <div className="flex items-center space-x-3">
              <div className={`px-3 py-1 rounded-full text-sm font-medium flex items-center space-x-1 ${getStatusColor(module.status)}`}>
                {getStatusIcon(module.status)}
                <span>{module.status}</span>
              </div>
              <div className="text-sm font-medium text-gray-600 dark:text-gray-400">
                Health: {module.healthScore}%
              </div>
              <div className="flex space-x-2">
                <Button
                  size="sm"
                  onClick={() => onDebugStart(moduleId)}
                  className="flex items-center space-x-1"
                >
                  <Play className="w-3 h-3" />
                  <span>Debug</span>
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onDebugStop(moduleId)}
                  className="flex items-center space-x-1"
                >
                  <Pause className="w-3 h-3" />
                  <span>Stop</span>
                </Button>
              </div>
            </div>
          </div>
        </CardHeader>
      </Card>

      {/* Key Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Total Requests</p>
                <p className="text-xl font-semibold">{formatNumber(module.metrics.totalRequests)}</p>
              </div>
              <Database className="w-5 h-5 text-blue-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Error Rate</p>
                <p className="text-xl font-semibold">{(module.metrics.errorRate * 100).toFixed(2)}%</p>
              </div>
              <XCircle className="w-5 h-5 text-red-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Avg Response</p>
                <p className="text-xl font-semibold">{module.metrics.avgResponseTime.toFixed(0)}ms</p>
              </div>
              <Clock className="w-5 h-5 text-green-600" />
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm text-gray-600 dark:text-gray-400">Memory Usage</p>
                <p className="text-xl font-semibold">{formatBytes(module.metrics.memoryUsage)}</p>
              </div>
              <MemoryStick className="w-5 h-5 text-purple-600" />
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Detailed Tabs */}
      <Tabs defaultValue="performance" className="space-y-4">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="performance">Performance</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="config">Configuration</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="performance" className="space-y-4">
          <RealTimePerformanceChart
            data={module.performance}
            maxDataPoints={30}
            height={300}
          />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <PerformanceChart
              data={module.performance}
              type="line"
              metric="responseTime"
              title="Response Time Trend"
              color="#3b82f6"
              height={250}
            />

            <PerformanceChart
              data={module.performance}
              type="area"
              metric="memoryUsage"
              title="Memory Usage"
              color="#8b5cf6"
              height={250}
            />
          </div>
        </TabsContent>

        <TabsContent value="events" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Recent Events</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3 max-h-96 overflow-y-auto custom-scrollbar">
                {module.recentEvents.length === 0 ? (
                  <div className="text-center py-8 text-gray-500">
                    No recent events found
                  </div>
                ) : (
                  module.recentEvents.map((event) => (
                    <div
                      key={event.id}
                      className="p-3 rounded-lg border border-gray-200 dark:border-gray-700"
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex items-start space-x-3">
                          <div className={`p-1.5 rounded-md ${getStatusColor(event.type)}`}>
                            {getStatusIcon(event.type)}
                          </div>
                          <div>
                            <h4 className="text-sm font-medium">
                              {event.operationId || 'Unknown Operation'}
                            </h4>
                            <p className="text-xs text-gray-600 dark:text-gray-400">
                              {formatRelativeTime(event.timestamp)}
                            </p>
                            {event.data && Object.keys(event.data).length > 0 && (
                              <pre className="mt-2 text-xs bg-gray-100 dark:bg-gray-900 p-2 rounded overflow-x-auto">
                                {JSON.stringify(event.data, null, 2)}
                              </pre>
                            )}
                          </div>
                        </div>
                        <span className={`text-xs px-2 py-1 rounded-full ${getStatusColor(event.type)}`}>
                          {event.type}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="config" className="space-y-4">
          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle>Configuration</CardTitle>
                <div className="flex space-x-2">
                  {isEditingConfig ? (
                    <>
                      <Button size="sm" onClick={handleConfigSave}>
                        Save
                      </Button>
                      <Button size="sm" variant="outline" onClick={handleConfigCancel}>
                        Cancel
                      </Button>
                    </>
                  ) : (
                    <Button size="sm" onClick={() => setIsEditingConfig(true)}>
                      Edit
                    </Button>
                  )}
                </div>
              </div>
            </CardHeader>
            <CardContent>
              {isEditingConfig ? (
                <div className="space-y-4">
                  {Object.entries(configData).map(([key, value]) => (
                    <div key={key} className="space-y-2">
                      <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        {key}
                      </label>
                      <input
                        type="text"
                        value={typeof value === 'object' ? JSON.stringify(value) : String(value)}
                        onChange={(e) => {
                          let newValue: any = e.target.value;
                          try {
                            // Try to parse as JSON for complex values
                            const parsed = JSON.parse(newValue);
                            newValue = parsed;
                          } catch {
                            // Keep as string if not valid JSON
                          }
                          setConfigData(prev => ({
                            ...prev,
                            [key]: newValue
                          }));
                        }}
                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-800"
                      />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-3">
                  {Object.entries(module.config).map(([key, value]) => (
                    <div key={key} className="flex justify-between items-start">
                      <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
                        {key}:
                      </span>
                      <span className="text-sm text-gray-600 dark:text-gray-400 font-mono text-right max-w-xs break-all">
                        {typeof value === 'object' ? JSON.stringify(value) : String(value)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="activity" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <Card>
              <CardHeader>
                <CardTitle>Uptime</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-center">
                  <div className="text-3xl font-bold text-blue-600">
                    {formatDuration(module.metrics.uptime)}
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                    Since last restart
                  </p>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Module Information</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">ID:</span>
                    <span className="font-mono">{module.id}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">Type:</span>
                    <span>{module.type}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">Version:</span>
                    <span>{module.version}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-600 dark:text-gray-400">Status:</span>
                    <span className={getStatusColor(module.status).replace('bg-', 'text-').replace('text-gray-600', 'text-gray-800')}>
                      {module.status}
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}