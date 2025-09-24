/**
 * 时间轴控制器组件
 * 
 * 提供直观的时间导航和历史回放功能
 */

import React, { useState, useEffect, useCallback } from 'react';

/**
 * 时间轴属性
 */
export interface TimelineControllerProps {
  /** 可用的时间戳列表 */
  timestamps: number[];
  /** 当前选中时间戳 */
  currentTimestamp: number;
  /** 时间戳变化回调 */
  onTimestampChange: (timestamp: number) => void;
  /** 是否自动播放 */
  autoPlay?: boolean;
  /** 播放速度 (毫秒) */
  playSpeed?: number;
  /** 主题 */
  theme?: 'light' | 'dark';
  /** 高度 */
  height?: number;
  /** 显示格式 */
  format?: 'datetime' | 'time' | 'relative';
  /** 是否显示播放控制 */
  showControls?: boolean;
  /** 是否显示时间标记 */
  showMarkers?: boolean;
  /** 是否显示缩放控制 */
  showZoom?: boolean;
  /** 时间范围 */
  timeRange?: { start: number; end: number };
  /** 标记点 */
  markers?: TimelineMarker[];
}

/**
 * 时间轴标记
 */
export interface TimelineMarker {
  /** 时间戳 */
  timestamp: number;
  /** 标签 */
  label: string;
  /** 类型 */
  type: 'event' | 'error' | 'milestone' | 'custom';
  /** 颜色 */
  color?: string;
  /** 描述 */
  description?: string;
}

/**
 * 播放状态
 */
export type PlayState = 'playing' | 'paused' | 'stopped';

/**
 * 缩放级别
 */
export type ZoomLevel = 'hour' | 'day' | 'week' | 'month' | 'year' | 'all';

/**
 * 时间轴控制器
 */
export const TimelineController: React.FC<TimelineControllerProps> = ({
  timestamps,
  currentTimestamp,
  onTimestampChange,
  autoPlay = false,
  playSpeed = 1000,
  theme = 'light',
  height = 120,
  format = 'datetime',
  showControls = true,
  showMarkers = true,
  showZoom = false,
  timeRange,
  markers = []
}) => {
  const [playState, setPlayState] = useState<PlayState>(autoPlay ? 'playing' : 'stopped');
  const [zoomLevel, setZoomLevel] = useState<ZoomLevel>('all');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [filteredTimestamps, setFilteredTimestamps] = useState<number[]>(timestamps);

  /**
   * 初始化当前索引
   */
  useEffect(() => {
    const index = filteredTimestamps.findIndex(ts => ts === currentTimestamp);
    setCurrentIndex(index >= 0 ? index : 0);
  }, [filteredTimestamps, currentTimestamp]);

  /**
   * 过滤时间戳
   */
  useEffect(() => {
    let filtered = [...timestamps];

    // 应用时间范围过滤
    if (timeRange) {
      filtered = filtered.filter(ts => ts >= timeRange.start && ts <= timeRange.end);
    }

    // 应用缩放级别过滤
    switch (zoomLevel) {
      case 'hour':
        filtered = filtered.filter(ts => 
          ts > Date.now() - 60 * 60 * 1000
        );
        break;
      case 'day':
        filtered = filtered.filter(ts => 
          ts > Date.now() - 24 * 60 * 60 * 1000
        );
        break;
      case 'week':
        filtered = filtered.filter(ts => 
          ts > Date.now() - 7 * 24 * 60 * 60 * 1000
        );
        break;
      case 'month':
        filtered = filtered.filter(ts => 
          ts > Date.now() - 30 * 24 * 60 * 60 * 1000
        );
        break;
      case 'year':
        filtered = filtered.filter(ts => 
          ts > Date.now() - 365 * 24 * 60 * 60 * 1000
        );
        break;
      case 'all':
      default:
        break;
    }

    setFilteredTimestamps(filtered);
  }, [timestamps, timeRange, zoomLevel]);

  /**
   * 自动播放逻辑
   */
  useEffect(() => {
    let interval: NodeJS.Timeout;

    if (playState === 'playing' && filteredTimestamps.length > 0) {
      interval = setInterval(() => {
        setCurrentIndex(prev => {
          const nextIndex = (prev + 1) % filteredTimestamps.length;
          const nextTimestamp = filteredTimestamps[nextIndex];
          
          if (nextTimestamp) {
            onTimestampChange(nextTimestamp);
          }
          
          return nextIndex;
        });
      }, playSpeed);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [playState, playSpeed, filteredTimestamps, onTimestampChange]);

  /**
   * 处理播放控制
   */
  const handlePlay = () => {
    setPlayState('playing');
  };

  const handlePause = () => {
    setPlayState('paused');
  };

  const handleStop = () => {
    setPlayState('stopped');
    setCurrentIndex(0);
    if (filteredTimestamps[0]) {
      onTimestampChange(filteredTimestamps[0]);
    }
  };

  /**
   * 处理时间戳跳转
   */
  const handleTimestampJump = (timestamp: number) => {
    const index = filteredTimestamps.findIndex(ts => ts === timestamp);
    if (index >= 0) {
      setCurrentIndex(index);
      onTimestampChange(timestamp);
    }
  };

  /**
   * 处理滑块变化
   */
  const handleSliderChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const index = parseInt(event.target.value);
    setCurrentIndex(index);
    
    if (filteredTimestamps[index]) {
      onTimestampChange(filteredTimestamps[index]);
    }
  };

  /**
   * 格式化时间戳
   */
  const formatTimestamp = (timestamp: number): string => {
    const date = new Date(timestamp);
    
    switch (format) {
      case 'datetime':
        return date.toLocaleString();
      case 'time':
        return date.toLocaleTimeString();
      case 'relative':
        const now = Date.now();
        const diff = now - timestamp;
        
        if (diff < 60000) return '刚刚';
        if (diff < 3600000) return `${Math.floor(diff / 60000)}分钟前`;
        if (diff < 86400000) return `${Math.floor(diff / 3600000)}小时前`;
        return `${Math.floor(diff / 86400000)}天前`;
      default:
        return date.toLocaleString();
    }
  };

  /**
   * 获取标记颜色
   */
  const getMarkerColor = (marker: TimelineMarker): string => {
    switch (marker.type) {
      case 'error': return '#ef4444';
      case 'event': return '#3b82f6';
      case 'milestone': return '#10b981';
      default: return marker.color || '#6b7280';
    }
  };

  /**
   * 获取最近的标记
   */
  const getRecentMarkers = (): TimelineMarker[] => {
    const recentLimit = Date.now() - 24 * 60 * 60 * 1000; // 最近24小时
    return markers.filter(marker => marker.timestamp > recentLimit);
  };

  return (
    <div className={`timeline-controller timeline-controller-${theme}`} style={{ height }}>
      {/* 时间轴头部 */}
      <div className="timeline-header">
        <div className="timeline-title">
          <h3>时间轴导航</h3>
          <div className="current-time">
            {formatTimestamp(currentTimestamp)}
          </div>
        </div>
        
        {showControls && (
          <div className="playback-controls">
            <button 
              onClick={handleStop} 
              className="control-button"
              disabled={playState === 'stopped'}
            >
              ⏹
            </button>
            <button 
              onClick={handlePause} 
              className="control-button"
              disabled={playState !== 'playing'}
            >
              ⏸
            </button>
            <button 
              onClick={handlePlay} 
              className="control-button"
              disabled={playState === 'playing'}
            >
              ▶
            </button>
          </div>
        )}
      </div>

      {/* 主时间轴 */}
      <div className="timeline-main">
        <div className="timeline-slider-container">
          <input
            type="range"
            min="0"
            max={Math.max(0, filteredTimestamps.length - 1)}
            value={currentIndex}
            onChange={handleSliderChange}
            className="timeline-slider"
          />
          
          <div className="timeline-labels">
            <span className="start-time">
              {filteredTimestamps[0] ? formatTimestamp(filteredTimestamps[0]) : '无数据'}
            </span>
            <span className="end-time">
              {filteredTimestamps[filteredTimestamps.length - 1] ? 
                formatTimestamp(filteredTimestamps[filteredTimestamps.length - 1]) : '无数据'}
            </span>
          </div>
        </div>

        {/* 标记显示 */}
        {showMarkers && markers.length > 0 && (
          <div className="timeline-markers">
            {getRecentMarkers().map((marker, index) => (
              <div
                key={index}
                className="timeline-marker"
                style={{
                  left: `${(marker.timestamp - (filteredTimestamps[0] || Date.now())) / 
                    ((filteredTimestamps[filteredTimestamps.length - 1] || Date.now()) - 
                     (filteredTimestamps[0] || Date.now())) * 100}%`,
                  backgroundColor: getMarkerColor(marker)
                }}
                title={`${marker.label} - ${marker.description || ''}`}
              >
                <div className="marker-dot" />
                <div className="marker-label">{marker.label}</div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* 控制面板 */}
      <div className="timeline-controls">
        {showZoom && (
          <div className="zoom-controls">
            <label>缩放:</label>
            <select 
              value={zoomLevel} 
              onChange={(e) => setZoomLevel(e.target.value as ZoomLevel)}
            >
              <option value="hour">1小时</option>
              <option value="day">1天</option>
              <option value="week">1周</option>
              <option value="month">1月</option>
              <option value="year">1年</option>
              <option value="all">全部</option>
            </select>
          </div>
        )}

        <div className="navigation-controls">
          <button 
            onClick={() => {
              const prevIndex = Math.max(0, currentIndex - 1);
              setCurrentIndex(prevIndex);
              if (filteredTimestamps[prevIndex]) {
                onTimestampChange(filteredTimestamps[prevIndex]);
              }
            }}
            className="nav-button"
            disabled={currentIndex <= 0}
          >
            ⬅ 上一个
          </button>
          
          <button 
            onClick={() => {
              const nextIndex = Math.min(filteredTimestamps.length - 1, currentIndex + 1);
              setCurrentIndex(nextIndex);
              if (filteredTimestamps[nextIndex]) {
                onTimestampChange(filteredTimestamps[nextIndex]);
              }
            }}
            className="nav-button"
            disabled={currentIndex >= filteredTimestamps.length - 1}
          >
            下一个 ➡
          </button>
        </div>
      </div>

      <style jsx>{`
        .timeline-controller {
          display: flex;
          flex-direction: column;
          padding: 1rem;
          border-bottom: 1px solid ${theme === 'dark' ? '#30363d' : '#e5e7eb'};
        }

        .timeline-controller-light {
          background: #ffffff;
          color: #1f2937;
        }

        .timeline-controller-dark {
          background: #0d1117;
          color: #d4d4d4;
        }

        .timeline-header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 1rem;
        }

        .timeline-title h3 {
          margin: 0;
          font-size: 1.1rem;
          font-weight: 600;
        }

        .current-time {
          font-size: 0.9rem;
          opacity: 0.8;
          font-family: monospace;
        }

        .playback-controls {
          display: flex;
          gap: 0.5rem;
        }

        .control-button {
          padding: 0.5rem;
          border: 1px solid ${theme === 'dark' ? '#374151' : '#d1d5db'};
          border-radius: 4px;
          background: ${theme === 'dark' ? '#1f2937' : '#ffffff'};
          color: ${theme === 'dark' ? '#d4d4d4' : '#1f2937'};
          cursor: pointer;
          font-size: 1rem;
          transition: all 0.2s ease;
        }

        .control-button:hover:not(:disabled) {
          background: ${theme === 'dark' ? '#374151' : '#f3f4f6'};
        }

        .control-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .timeline-main {
          position: relative;
          margin-bottom: 1rem;
        }

        .timeline-slider-container {
          position: relative;
        }

        .timeline-slider {
          width: 100%;
          height: 6px;
          background: ${theme === 'dark' ? '#30363d' : '#e5e7eb'};
          border-radius: 3px;
          outline: none;
          -webkit-appearance: none;
          margin-bottom: 0.5rem;
        }

        .timeline-slider::-webkit-slider-thumb {
          -webkit-appearance: none;
          width: 20px;
          height: 20px;
          background: #3b82f6;
          border-radius: 50%;
          cursor: pointer;
          border: 2px solid ${theme === 'dark' ? '#0d1117' : '#ffffff'};
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        }

        .timeline-labels {
          display: flex;
          justify-content: space-between;
          font-size: 0.8rem;
          opacity: 0.7;
        }

        .timeline-markers {
          position: absolute;
          top: -10px;
          left: 0;
          right: 0;
          height: 20px;
        }

        .timeline-marker {
          position: absolute;
          top: 0;
          width: 8px;
          height: 8px;
          border-radius: 50%;
          cursor: pointer;
          transform: translateX(-50%);
        }

        .marker-dot {
          width: 100%;
          height: 100%;
          border-radius: 50%;
          border: 2px solid ${theme === 'dark' ? '#0d1117' : '#ffffff'};
        }

        .marker-label {
          position: absolute;
          top: -25px;
          left: 50%;
          transform: translateX(-50%);
          font-size: 0.7rem;
          white-space: nowrap;
          background: ${theme === 'dark' ? '#1f2937' : '#ffffff'};
          padding: 2px 6px;
          border-radius: 3px;
          border: 1px solid ${theme === 'dark' ? '#374151' : '#d1d5db'};
          opacity: 0;
          transition: opacity 0.2s ease;
        }

        .timeline-marker:hover .marker-label {
          opacity: 1;
        }

        .timeline-controls {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 1rem;
        }

        .zoom-controls {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .zoom-controls label {
          font-size: 0.9rem;
          font-weight: 500;
        }

        .zoom-controls select {
          padding: 0.25rem 0.5rem;
          border: 1px solid ${theme === 'dark' ? '#374151' : '#d1d5db'};
          border-radius: 4px;
          background: ${theme === 'dark' ? '#1f2937' : '#ffffff'};
          color: ${theme === 'dark' ? '#d4d4d4' : '#1f2937'};
          font-size: 0.85rem;
        }

        .navigation-controls {
          display: flex;
          gap: 0.5rem;
        }

        .nav-button {
          padding: 0.5rem 1rem;
          border: 1px solid ${theme === 'dark' ? '#374151' : '#d1d5db'};
          border-radius: 4px;
          background: ${theme === 'dark' ? '#1f2937' : '#ffffff'};
          color: ${theme === 'dark' ? '#d4d4d4' : '#1f2937'};
          cursor: pointer;
          font-size: 0.85rem;
          transition: all 0.2s ease;
        }

        .nav-button:hover:not(:disabled) {
          background: ${theme === 'dark' ? '#374151' : '#f3f4f6'};
        }

        .nav-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
      `}</style>
    </div>
  );
};

export default TimelineController;