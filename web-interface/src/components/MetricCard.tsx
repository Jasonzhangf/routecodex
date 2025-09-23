/**
 * Metric Card Component
 */

import React from 'react';
import { Card, CardContent } from './ui/card';
import { cn } from '@/utils/cn';

interface MetricCardProps {
  title: string;
  value: number | string;
  unit?: string;
  icon?: React.ReactNode;
  color?: string;
  loading?: boolean;
  details?: string;
  trend?: {
    value: number;
    isPositive: boolean;
  };
}

export function MetricCard({
  title,
  value,
  unit,
  icon,
  color = 'text-blue-600',
  loading = false,
  details,
  trend
}: MetricCardProps) {
  return (
    <Card>
      <CardContent className="p-6">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-3">
            {icon && (
              <div className={cn("p-2 rounded-lg bg-gray-100 dark:bg-gray-800", color)}>
                {icon}
              </div>
            )}
            <div>
              <p className="text-sm font-medium text-gray-600 dark:text-gray-400">
                {title}
              </p>
              {loading ? (
                <div className="animate-pulse">
                  <div className="h-6 bg-gray-200 dark:bg-gray-700 rounded w-20"></div>
                </div>
              ) : (
                <div className="flex items-center space-x-2">
                  <p className={cn("text-2xl font-bold", color)}>
                    {typeof value === 'number' ? value.toLocaleString() : value}
                  </p>
                  {unit && (
                    <span className="text-sm text-gray-600 dark:text-gray-400">
                      {unit}
                    </span>
                  )}
                  {trend && (
                    <div className={cn(
                      "flex items-center space-x-1 text-xs",
                      trend.isPositive ? 'text-green-600' : 'text-red-600'
                    )}>
                      <span>{trend.isPositive ? '↑' : '↓'}</span>
                      <span>{Math.abs(trend.value)}%</span>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>

        {details && (
          <div className="mt-3">
            <p className="text-xs text-gray-600 dark:text-gray-400">
              {details}
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}