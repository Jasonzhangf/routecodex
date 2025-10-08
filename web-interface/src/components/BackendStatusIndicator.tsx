/**
 * Backend Service Status Indicator
 * 后端服务状态指示器组件
 */

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Badge } from './ui/badge';
import { backendManager, BackendStatus } from '../services/backendService';
import {
  CheckCircle,
  XCircle,
  AlertTriangle,
  Loader2,
  Server,
  Play,
  Square,
  RefreshCw
} from 'lucide-react';

interface BackendStatusIndicatorProps {
  onStatusChange?: (status: BackendStatus) => void;
}

export function BackendStatusIndicator({ onStatusChange }: BackendStatusIndicatorProps) {
  const [status, setStatus] = useState<BackendStatus>(backendManager.getStatus());
  const [isActionInProgress, setIsActionInProgress] = useState(false);

  useEffect(() => {
    // 监听状态变化
    const handleStatusChange = (newStatus: BackendStatus) => {
      setStatus(newStatus);
      onStatusChange?.(newStatus);
    };

    backendManager.on('statusChanged', handleStatusChange);

    // 组件挂载时确保后端运行
    ensureBackend();

    return () => {
      backendManager.off('statusChanged', handleStatusChange);
    };
  }, [onStatusChange]);

  const ensureBackend = async () => {
    setIsActionInProgress(true);
    try {
      await backendManager.ensureBackendRunning();
    } finally {
      setIsActionInProgress(false);
    }
  };

  const handleStartStop = async () => {
    setIsActionInProgress(true);
    try {
      if (status.isRunning) {
        await backendManager.stopBackend();
      } else {
        await backendManager.ensureBackendRunning();
      }
    } finally {
      setIsActionInProgress(false);
    }
  };

  const handleRefresh = async () => {
    setIsActionInProgress(true);
    try {
      await backendManager.checkBackendHealth();
    } finally {
      setIsActionInProgress(false);
    }
  };

  const getStatusIcon = () => {
    if (status.isStarting) {
      return <Loader2 className="w-5 h-5 animate-spin text-blue-500" />;
    }
    if (status.isRunning) {
      return <CheckCircle className="w-5 h-5 text-green-500" />;
    }
    return <XCircle className="w-5 h-5 text-red-500" />;
  };

  const getStatusBadge = () => {
    if (status.isStarting) {
      return <Badge variant="secondary" className="bg-blue-100 text-blue-800">启动中</Badge>;
    }
    if (status.isRunning) {
      return <Badge variant="default" className="bg-green-100 text-green-800">运行中</Badge>;
    }
    return <Badge variant="destructive">已停止</Badge>;
  };

  const getStatusText = () => {
    if (status.isStarting) return '后端服务启动中...';
    if (status.isRunning) return '后端服务正常运行';
    return '后端服务未运行';
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <Server className="w-5 h-5" />
            <div>
              <CardTitle className="text-base">后端服务状态</CardTitle>
              <CardDescription>
                RouteCodex 路由服务器 ({status.port})
              </CardDescription>
            </div>
          </div>
          {getStatusBadge()}
        </div>
      </CardHeader>
      <CardContent>
        <div className="space-y-4">
          {/* 状态显示 */}
          <div className="flex items-center space-x-3">
            {getStatusIcon()}
            <div className="flex-1">
              <div className="font-medium">{getStatusText()}</div>
              <div className="text-sm text-gray-500">
                最后检查: {status.lastCheck.toLocaleTimeString()}
              </div>
            </div>
          </div>

          {/* 错误信息 */}
          {status.error && (
            <div className="flex items-center space-x-2 p-3 bg-red-50 dark:bg-red-900/20 rounded-lg">
              <AlertTriangle className="w-4 h-4 text-red-500 flex-shrink-0" />
              <div className="text-sm text-red-700 dark:text-red-300">
                {status.error}
              </div>
            </div>
          )}

          {/* 健康信息 */}
          {status.health && (
            <div className="space-y-2">
              <div className="text-sm font-medium">健康信息:</div>
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="flex justify-between">
                  <span>评分:</span>
                  <span>{status.health.score}%</span>
                </div>
                <div className="flex justify-between">
                  <span>运行时间:</span>
                  <span>{status.health.uptime}s</span>
                </div>
                <div className="flex justify-between">
                  <span>响应时间:</span>
                  <span>{status.health.performance?.avgResponseTime?.toFixed(2)}ms</span>
                </div>
                <div className="flex justify-between">
                  <span>吞吐量:</span>
                  <span>{status.health.performance?.throughput} req/s</span>
                </div>
              </div>
            </div>
          )}

          {/* 操作按钮 */}
          <div className="flex items-center space-x-2">
            <Button
              onClick={handleStartStop}
              disabled={isActionInProgress || status.isStarting}
              variant={status.isRunning ? "destructive" : "default"}
              size="sm"
              className="flex items-center space-x-2"
            >
              {isActionInProgress || status.isStarting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : status.isRunning ? (
                <Square className="w-4 h-4" />
              ) : (
                <Play className="w-4 h-4" />
              )}
              <span>
                {isActionInProgress || status.isStarting ?
                  (status.isStarting ? '启动中...' : '处理中...') :
                  (status.isRunning ? '停止服务' : '启动服务')
                }
              </span>
            </Button>

            <Button
              onClick={handleRefresh}
              disabled={isActionInProgress}
              variant="outline"
              size="sm"
              className="flex items-center space-x-2"
            >
              <RefreshCw className={`w-4 h-4 ${isActionInProgress ? 'animate-spin' : ''}`} />
              <span>刷新</span>
            </Button>
          </div>

          {/* 快速访问链接 */}
          {status.isRunning && (
            <div className="pt-2 border-t">
              <div className="text-sm font-medium mb-2">快速访问:</div>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline" className="text-xs">
                  <a
                    href="http://localhost:5506/health"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                  >
                    健康检查
                  </a>
                </Badge>
                <Badge variant="outline" className="text-xs">
                  <a
                    href="http://localhost:5506/docs"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:underline"
                  >
                    API文档
                  </a>
                </Badge>
              </div>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}