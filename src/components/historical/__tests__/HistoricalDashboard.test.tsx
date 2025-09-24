/**
 * 历史数据仪表板测试
 * 
 * 验证历史数据可视化功能
 */

import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { HistoricalDashboard } from '../HistoricalDashboard.js';
import type { UnifiedLogEntry } from '../../../logging/types.js';

// 模拟日志数据
const mockHistoricalData: UnifiedLogEntry[] = [
  {
    timestamp: Date.now() - 3600000,
    level: 'info' as any,
    moduleId: 'test-switch',
    moduleType: 'SwitchModule',
    message: 'Switch模块初始化完成',
    data: { status: 'ready' },
    tags: ['initialization', 'switch'],
    version: '0.0.1'
  },
  {
    timestamp: Date.now() - 1800000,
    level: 'warn' as any,
    moduleId: 'test-compatibility',
    moduleType: 'CompatibilityModule',
    message: '兼容性模块警告',
    data: { threshold: 80, current: 85 },
    tags: ['compatibility', 'warning'],
    version: '0.0.1'
  },
  {
    timestamp: Date.now(),
    level: 'error' as any,
    moduleId: 'test-provider',
    moduleType: 'ProviderModule',
    message: '提供商模块错误',
    error: {
      name: 'ProviderError',
      message: '连接超时',
      code: 'TIMEOUT_ERROR'
    },
    tags: ['provider', 'error'],
    version: '0.0.1'
  }
];

// 模拟 parseHistoricalLogs 函数
jest.mock('../../../logging/index.js', () => ({
  parseHistoricalLogs: jest.fn().mockResolvedValue({
    entries: [
      {
        timestamp: Date.now() - 3600000,
        level: 'info',
        moduleId: 'test-switch',
        moduleType: 'SwitchModule',
        message: 'Switch模块初始化完成',
        data: { status: 'ready' },
        tags: ['initialization', 'switch'],
        version: '0.0.1'
      },
      {
        timestamp: Date.now() - 1800000,
        level: 'warn',
        moduleId: 'test-compatibility',
        moduleType: 'CompatibilityModule',
        message: '兼容性模块警告',
        data: { threshold: 80, current: 85 },
        tags: ['compatibility', 'warning'],
        version: '0.0.1'
      },
      {
        timestamp: Date.now(),
        level: 'error',
        moduleId: 'test-provider',
        moduleType: 'ProviderModule',
        message: '提供商模块错误',
        error: {
          name: 'ProviderError',
          message: '连接超时',
          code: 'TIMEOUT_ERROR'
        },
        tags: ['provider', 'error'],
        version: '0.0.1'
      }
    ],
    index: {
      name: 'test-index',
      documentCount: 3,
      status: 'active'
    },
    stats: {
      totalFiles: 1,
      totalEntries: 3,
      parseTime: 100
    }
  }),
  TimeSeriesIndexEngine: jest.fn().mockImplementation(() => ({
    name: 'test-index',
    documentCount: 3,
    status: 'active'
  }))
}));

describe('HistoricalDashboard', () => {
  
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('应该正确渲染仪表板', async () => {
    render(
      <HistoricalDashboard
        logDirectory="./test-logs"
        autoLoad={true}
        theme="light"
        width={1200}
        height={800}
      />
    );

    // 等待数据加载
    await waitFor(() => {
      expect(screen.getByText('历史数据仪表板')).toBeInTheDocument();
    });

    // 检查控制按钮
    expect(screen.getByText('🔍 状态对比')).toBeInTheDocument();
    expect(screen.getByText('📄 导出报告')).toBeInTheDocument();
    expect(screen.getByText('🔄 刷新数据')).toBeInTheDocument();
  });

  test('应该显示加载状态', () => {
    render(
      <HistoricalDashboard
        logDirectory="./test-logs"
        autoLoad={true}
        theme="light"
      />
    );

    // 初始状态应该显示加载中
    expect(screen.getByText('正在加载历史数据...')).toBeInTheDocument();
  });

  test('应该处理错误状态', async () => {
    // 模拟错误情况
    const mockParseHistoricalLogs = jest.fn().mockRejectedValue(new Error('测试错误'));
    jest.doMock('../../../logging/index.js', () => ({
      parseHistoricalLogs: mockParseHistoricalLogs
    }));

    render(
      <HistoricalDashboard
        logDirectory="./invalid-logs"
        autoLoad={true}
        theme="light"
      />
    );

    // 等待错误状态
    await waitFor(() => {
      expect(screen.getByText('加载失败: 测试错误')).toBeInTheDocument();
    });

    // 检查重试按钮
    expect(screen.getByText('重试')).toBeInTheDocument();
  });

  test('应该支持时间轴控制', async () => {
    render(
      <HistoricalDashboard
        logDirectory="./test-logs"
        autoLoad={true}
        showTimeline={true}
        theme="light"
      />
    );

    // 等待数据加载
    await waitFor(() => {
      expect(screen.getByText('历史数据仪表板')).toBeInTheDocument();
    });

    // 时间轴控制器应该被渲染
    // 注意：由于TimelineController是子组件，我们检查其容器
    const timelineContainer = screen.getByText('历史数据仪表板').closest('.historical-dashboard');
    expect(timelineContainer).toBeInTheDocument();
  });

  test('应该支持状态对比功能', async () => {
    render(
      <HistoricalDashboard
        logDirectory="./test-logs"
        autoLoad={true}
        showComparison={true}
        theme="light"
      />
    );

    // 等待数据加载
    await waitFor(() => {
      expect(screen.getByText('历史数据仪表板')).toBeInTheDocument();
    });

    // 状态对比按钮应该可用
    const compareButton = screen.getByText('🔍 状态对比');
    expect(compareButton).not.toBeDisabled();
  });

  test('应该支持不同的主题', () => {
    const { container } = render(
      <HistoricalDashboard
        logDirectory="./test-logs"
        autoLoad={false}
        theme="dark"
      />
    );

    // 检查暗色主题类名
    expect(container.querySelector('.historical-dashboard-dark')).toBeInTheDocument();
  });

  test('应该支持自定义尺寸', () => {
    render(
      <HistoricalDashboard
        logDirectory="./test-logs"
        autoLoad={false}
        width={1400}
        height={900}
        theme="light"
      />
    );

    // 检查自定义尺寸是否被应用
    const dashboard = screen.getByText('历史数据仪表板').closest('.historical-dashboard');
    expect(dashboard).toBeInTheDocument();
  });

  test('应该调用加载回调', async () => {
    const onDataLoaded = jest.fn();
    
    render(
      <HistoricalDashboard
        logDirectory="./test-logs"
        autoLoad={true}
        onDataLoaded={onDataLoaded}
        theme="light"
      />
    );

    // 等待数据加载完成
    await waitFor(() => {
      expect(onDataLoaded).toHaveBeenCalled();
    });

    // 验证回调参数
    expect(onDataLoaded).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({
        moduleId: expect.any(String),
        level: expect.any(String),
        message: expect.any(String)
      })
    ]));
  });

  test('应该支持加载状态回调', async () => {
    const onLoadingChange = jest.fn();
    
    render(
      <HistoricalDashboard
        logDirectory="./test-logs"
        autoLoad={true}
        onLoadingChange={onLoadingChange}
        theme="light"
      />
    );

    // 验证加载状态变化
    await waitFor(() => {
      expect(onLoadingChange).toHaveBeenCalledTimes(2);
      expect(onLoadingChange).toHaveBeenCalledWith(true);  // 开始加载
      expect(onLoadingChange).toHaveBeenCalledWith(false); // 加载完成
    });
  });

  test('应该支持错误回调', async () => {
    // 模拟错误情况
    const mockParseHistoricalLogs = jest.fn().mockRejectedValue(new Error('数据加载错误'));
    jest.doMock('../../../logging/index.js', () => ({
      parseHistoricalLogs: mockParseHistoricalLogs
    }));

    const onError = jest.fn();
    
    render(
      <HistoricalDashboard
        logDirectory="./invalid-logs"
        autoLoad={true}
        onError={onError}
        theme="light"
      />
    );

    // 等待错误回调
    await waitFor(() => {
      expect(onError).toHaveBeenCalled();
    });

    // 验证错误信息
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(onError.mock.calls[0][0].message).toBe('数据加载错误');
  });

  test('应该支持模块过滤', async () => {
    render(
      <HistoricalDashboard
        logDirectory="./test-logs"
        autoLoad={true}
        moduleFilter={['test-switch', 'test-compatibility']}
        theme="light"
      />
    );

    // 等待数据加载
    await waitFor(() => {
      expect(screen.getByText('历史数据仪表板')).toBeInTheDocument();
    });

    // 仪表板应该正常渲染
    expect(screen.getByText('🔍 状态对比')).toBeInTheDocument();
  });

  test('应该支持时间范围过滤', async () => {
    const timeRange = {
      start: Date.now() - 7200000, // 2小时前
      end: Date.now()
    };

    render(
      <HistoricalDashboard
        logDirectory="./test-logs"
        autoLoad={true}
        timeRange={timeRange}
        theme="light"
      />
    );

    // 等待数据加载
    await waitFor(() => {
      expect(screen.getByText('历史数据仪表板')).toBeInTheDocument();
    });

    // 仪表板应该正常渲染
    expect(screen.getByText('🔍 状态对比')).toBeInTheDocument();
  });
});