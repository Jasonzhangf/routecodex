/**
 * Performance Chart Component using Recharts
 */

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
  Area,
  AreaChart,
  PieChart,
  Pie,
  Cell
} from 'recharts';
import { Card, CardContent, CardHeader, CardTitle } from './ui/card';
import { PerformanceMetrics } from '../types';
import { formatTimestamp } from '../utils/formatters';

interface PerformanceChartProps {
  data: PerformanceMetrics[];
  type: 'line' | 'bar' | 'area' | 'pie';
  metric: 'responseTime' | 'throughput' | 'memoryUsage' | 'cpuUsage' | 'errorRate';
  title: string;
  color?: string;
  height?: number;
}

const COLORS = ['#3b82f6', '#ef4444', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];

export function PerformanceChart({
  data,
  type,
  metric,
  title,
  color = '#3b82f6',
  height = 300
}: PerformanceChartProps) {
  const formatValue = (value: number) => {
    switch (metric) {
      case 'responseTime':
        return `${value.toFixed(2)}ms`;
      case 'throughput':
        return `${value.toFixed(0)} req/s`;
      case 'memoryUsage':
        return `${(value / 1024 / 1024).toFixed(1)}MB`;
      case 'cpuUsage':
        return `${value.toFixed(1)}%`;
      case 'errorRate':
        return `${(value * 100).toFixed(2)}%`;
      default:
        return value.toString();
    }
  };

  const chartData = data.map((item) => ({
    ...item,
    time: formatTimestamp(item.timestamp)
  }));

  const renderChart = () => {
    switch (type) {
      case 'line':
        return (
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="time"
              fontSize={12}
              angle={-45}
              textAnchor="end"
              height={60}
            />
            <YAxis fontSize={12} tickFormatter={formatValue} />
            <Tooltip
              labelFormatter={(value) => `Time: ${value}`}
              formatter={(value: number) => [formatValue(value), title]}
            />
            <Legend />
            <Line
              type="monotone"
              dataKey={metric}
              stroke={color}
              strokeWidth={2}
              dot={{ fill: color, strokeWidth: 2, r: 4 }}
              activeDot={{ r: 6 }}
            />
          </LineChart>
        );

      case 'bar':
        return (
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="time"
              fontSize={12}
              angle={-45}
              textAnchor="end"
              height={60}
            />
            <YAxis fontSize={12} tickFormatter={formatValue} />
            <Tooltip
              labelFormatter={(value) => `Time: ${value}`}
              formatter={(value: number) => [formatValue(value), title]}
            />
            <Legend />
            <Bar dataKey={metric} fill={color} />
          </BarChart>
        );

      case 'area':
        return (
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="time"
              fontSize={12}
              angle={-45}
              textAnchor="end"
              height={60}
            />
            <YAxis fontSize={12} tickFormatter={formatValue} />
            <Tooltip
              labelFormatter={(value) => `Time: ${value}`}
              formatter={(value: number) => [formatValue(value), title]}
            />
            <Legend />
            <Area
              type="monotone"
              dataKey={metric}
              stroke={color}
              fill={color}
              fillOpacity={0.3}
              strokeWidth={2}
            />
          </AreaChart>
        );

      case 'pie': {
        const pieData = data.slice(-5).map((item) => ({
          name: formatTimestamp(item.timestamp),
          value: item[metric]
        }));

        return (
          <PieChart>
            <Pie
              data={pieData}
              cx="50%"
              cy="50%"
              labelLine={false}
              label={({ name, value }) => `${name}: ${formatValue(value)}`}
              outerRadius={80}
              fill="#8884d8"
              dataKey="value"
            >
              {pieData.map((entry) => (
                <Cell key={`cell-${entry.name}`} fill={COLORS[pieData.indexOf(entry) % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip formatter={(value: number) => [formatValue(value), title]} />
          </PieChart>
        );
      }

      default:
        return (
          <div className="flex items-center justify-center h-full text-gray-500">
            Unknown chart type: {type}
          </div>
        );
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={height}>
          {renderChart()}
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

interface MultiMetricChartProps {
  data: PerformanceMetrics[];
  title: string;
  height?: number;
}

export function MultiMetricChart({ data, title, height = 300 }: MultiMetricChartProps) {
  const chartData = data.map((item) => ({
    ...item,
    time: formatTimestamp(item.timestamp),
    responseTimeMs: item.responseTime,
    throughputReqS: item.throughput,
    memoryMB: item.memoryUsage / 1024 / 1024,
    cpuUsagePercent: item.cpuUsage,
    errorRatePercent: item.errorRate * 100
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={height}>
          <LineChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="time"
              fontSize={12}
              angle={-45}
              textAnchor="end"
              height={60}
            />
            <YAxis yAxisId="left" fontSize={12} />
            <YAxis yAxisId="right" orientation="right" fontSize={12} />
            <Tooltip />
            <Legend />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="responseTimeMs"
              stroke="#3b82f6"
              strokeWidth={2}
              name="Response Time (ms)"
              dot={{ fill: '#3b82f6', strokeWidth: 2, r: 4 }}
            />
            <Line
              yAxisId="left"
              type="monotone"
              dataKey="throughputReqS"
              stroke="#10b981"
              strokeWidth={2}
              name="Throughput (req/s)"
              dot={{ fill: '#10b981', strokeWidth: 2, r: 4 }}
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="errorRatePercent"
              stroke="#ef4444"
              strokeWidth={2}
              name="Error Rate (%)"
              dot={{ fill: '#ef4444', strokeWidth: 2, r: 4 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}

interface RealTimePerformanceChartProps {
  data: PerformanceMetrics[];
  maxDataPoints?: number;
  height?: number;
}

export function RealTimePerformanceChart({
  data,
  maxDataPoints = 50,
  height = 300
}: RealTimePerformanceChartProps) {
  const recentData = data.slice(-maxDataPoints);

  const chartData = recentData.map((item) => ({
    ...item,
    time: formatTimestamp(item.timestamp),
    responseTimeMs: item.responseTime,
    throughputReqS: item.throughput,
    memoryMB: item.memoryUsage / 1024 / 1024,
    cpuUsagePercent: item.cpuUsage,
    errorRatePercent: item.errorRate * 100
  }));

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg flex items-center space-x-2">
          <span>Real-time Performance</span>
          <span className="w-2 h-2 bg-green-500 rounded-full animate-pulse"></span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <ResponsiveContainer width="100%" height={height}>
          <AreaChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis
              dataKey="time"
              fontSize={12}
              angle={-45}
              textAnchor="end"
              height={60}
            />
            <YAxis yAxisId="left" fontSize={12} />
            <YAxis yAxisId="right" orientation="right" fontSize={12} />
            <Tooltip />
            <Legend />
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="responseTimeMs"
              stroke="#3b82f6"
              fill="#3b82f6"
              fillOpacity={0.3}
              strokeWidth={2}
              name="Response Time (ms)"
            />
            <Area
              yAxisId="left"
              type="monotone"
              dataKey="throughputReqS"
              stroke="#10b981"
              fill="#10b981"
              fillOpacity={0.3}
              strokeWidth={2}
              name="Throughput (req/s)"
            />
            <Line
              yAxisId="right"
              type="monotone"
              dataKey="errorRatePercent"
              stroke="#ef4444"
              strokeWidth={2}
              name="Error Rate (%)"
              dot={{ fill: '#ef4444', strokeWidth: 2, r: 4 }}
            />
          </AreaChart>
        </ResponsiveContainer>
      </CardContent>
    </Card>
  );
}