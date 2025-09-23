/**
 * Module Status Card Component
 */

import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { ModuleStatus } from '../types';
import {
  Activity,
  AlertTriangle,
  CheckCircle,
  Cpu,
  Database,
  Play,
  Pause,
  Settings,
  Zap
} from 'lucide-react';
import { formatBytes, formatDuration, formatRelativeTime, getStatusColor } from '../utils/formatters';

interface ModuleStatusCardProps {
  module: ModuleStatus;
  onDebugStart: (moduleId: string) => void;
  onDebugStop: (moduleId: string) => void;
}

export function ModuleStatusCard({ module, onDebugStart, onDebugStop }: ModuleStatusCardProps) {
  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'healthy':
        return <CheckCircle className="w-4 h-4" />;
      case 'warning':
        return <AlertTriangle className="w-4 h-4" />;
      case 'error':
        return <AlertTriangle className="w-4 h-4" />;
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
    <Card className="relative overflow-hidden">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2">
            <div className="p-1.5 rounded-md bg-gray-100 dark:bg-gray-800">
              {getTypeIcon(module.type)}
            </div>
            <div>
              <CardTitle className="text-sm font-medium">
                {module.name}
              </CardTitle>
              <p className="text-xs text-gray-600 dark:text-gray-400">
                {module.type} • {module.id}
              </p>
            </div>
          </div>
          <div className={`px-2 py-1 rounded-full text-xs font-medium ${getStatusColor(module.status)}`}>
            <div className="flex items-center space-x-1">
              {getStatusIcon(module.status)}
              <span>{module.status}</span>
            </div>
          </div>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Health Score */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-gray-600 dark:text-gray-400">
              Health Score
            </span>
            <span className="text-sm font-medium">
              {module.healthScore}%
            </span>
          </div>
          <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
            <div
              className={`h-2 rounded-full ${
                module.healthScore >= 90 ? 'bg-green-600' :
                module.healthScore >= 70 ? 'bg-blue-600' :
                module.healthScore >= 50 ? 'bg-yellow-600' :
                module.healthScore >= 30 ? 'bg-orange-600' : 'bg-red-600'
              }`}
              style={{ width: `${module.healthScore}%` }}
            />
          </div>
        </div>

        {/* Metrics */}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1">
            <p className="text-xs text-gray-600 dark:text-gray-400">Requests</p>
            <p className="text-sm font-medium">
              {module.metrics.totalRequests.toLocaleString()}
            </p>
          </div>

          <div className="space-y-1">
            <p className="text-xs text-gray-600 dark:text-gray-400">Error Rate</p>
            <p className="text-sm font-medium">
              {(module.metrics.errorRate * 100).toFixed(2)}%
            </p>
          </div>

          <div className="space-y-1">
            <p className="text-xs text-gray-600 dark:text-gray-400">Avg Response</p>
            <p className="text-sm font-medium">
              {module.metrics.avgResponseTime.toFixed(0)}ms
            </p>
          </div>

          <div className="space-y-1">
            <p className="text-xs text-gray-600 dark:text-gray-400">Memory</p>
            <p className="text-sm font-medium">
              {formatBytes(module.metrics.memoryUsage)}
            </p>
          </div>
        </div>

        {/* Activity Info */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-600 dark:text-gray-400">Uptime</span>
            <span className="font-medium">
              {formatDuration(module.uptime)}
            </span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-600 dark:text-gray-400">Last Activity</span>
            <span className="font-medium">
              {formatRelativeTime(module.lastActivity)}
            </span>
          </div>
        </div>

        {/* Recent Events Count */}
        <div className="pt-2 border-t border-gray-200 dark:border-gray-700">
          <div className="flex items-center justify-between text-xs">
            <span className="text-gray-600 dark:text-gray-400">Recent Events</span>
            <span className="font-medium">
              {module.events.length}
            </span>
          </div>
        </div>

        {/* Actions */}
        <div className="flex space-x-2 pt-2">
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={() => onDebugStart(module.id)}
          >
            <Play className="w-3 h-3 mr-1" />
            Debug
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="flex-1"
            onClick={() => onDebugStop(module.id)}
          >
            <Pause className="w-3 h-3 mr-1" />
            Stop
          </Button>
        </div>
      </CardContent>

      {/* Status indicator bar */}
      <div className={`absolute top-0 left-0 right-0 h-1 ${
        module.status === 'healthy' ? 'bg-green-500' :
        module.status === 'warning' ? 'bg-yellow-500' :
        module.status === 'error' ? 'bg-red-500' : 'bg-gray-500'
      }`} />
    </Card>
  );
}