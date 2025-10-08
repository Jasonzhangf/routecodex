/**
 * Protocol Analyzer Component
 * 协议分析界面组件
 */

import { useState, useEffect } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import { Badge } from './ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from './ui/table';
import { protocolAnalyzer, ProtocolRecord, FieldInfo } from '../services/protocolAnalyzer';
import {
  Activity,
  Database,
  Eye,
  EyeOff,
  Download,
  Trash2,
  RefreshCw,
  TrendingUp,
  FileText,
  Layers,
  Zap
} from 'lucide-react';

export function ProtocolAnalyzer() {
  const [records, setRecords] = useState<ProtocolRecord[]>([]);
  const [fieldStats, setFieldStats] = useState<Map<string, FieldInfo>>(new Map());
  const [protocolStats, setProtocolStats] = useState<any>(null);
  const [selectedProtocol, setSelectedProtocol] = useState<string>('all');
  const [selectedDirection, setSelectedDirection] = useState<'all' | 'request' | 'response'>('all');
  const [showSensitive, setShowSensitive] = useState(false);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = () => {
    setIsLoading(true);
    try {
      const newRecords = protocolAnalyzer.getRecords(100);
      const newFieldStats = protocolAnalyzer.getFieldStats();
      const newStats = protocolAnalyzer.getProtocolStats();

      setRecords(newRecords);
      setFieldStats(newFieldStats);
      setProtocolStats(newStats);
    } finally {
      setIsLoading(false);
    }
  };

  const filteredRecords = records.filter(record => {
    if (selectedProtocol !== 'all' && record.protocol !== selectedProtocol) return false;
    if (selectedDirection !== 'all' && record.direction !== selectedDirection) return false;
    return true;
  });

  const handleExportData = () => {
    const data = {
      records: filteredRecords,
      fieldStats: Array.from(fieldStats.entries()).map(([name, info]) => ({ name, ...info })),
      protocolStats,
      exportTime: new Date().toISOString()
    };

    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `protocol-analysis-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleClearData = () => {
    if (confirm('确定要清空所有分析数据吗？')) {
      protocolAnalyzer.clear();
      loadData();
    }
  };

  const getComplexityBadge = (complexity: string) => {
    const variants = {
      simple: 'default',
      medium: 'secondary',
      complex: 'destructive'
    };
    return variants[complexity as keyof typeof variants] || 'default';
  };

  const renderRecordData = (data: any, depth = 0) => {
    if (typeof data !== 'object' || data === null) {
      return <span className="font-mono text-sm">{String(data)}</span>;
    }

    return (
      <div className={`ml-${depth * 4}`}>
        {Object.entries(data).map(([key, value]) => (
          <div key={key} className="border-l-2 border-gray-200 dark:border-gray-700 pl-2 py-1">
            <div className="flex items-center space-x-2">
              <span className="font-semibold text-sm">{key}:</span>
              {typeof value === 'object' && value !== null ? (
                <Badge variant="outline" className="text-xs">
                  {Array.isArray(value) ? `Array(${value.length})` : 'Object'}
                </Badge>
              ) : (
                <span className="font-mono text-sm bg-gray-100 dark:bg-gray-800 px-1 rounded">
                  {String(value)}
                </span>
              )}
            </div>
            {typeof value === 'object' && value !== null && (
              <div className="mt-1">
                {renderRecordData(value, depth + 1)}
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
            协议分析器
          </h2>
          <p className="text-gray-600 dark:text-gray-400 mt-1">
            实时分析和记录请求/响应协议，字段统计和数据结构分析
          </p>
        </div>

        <div className="flex items-center space-x-2">
          <Button
            onClick={loadData}
            variant="outline"
            size="sm"
            disabled={isLoading}
            className="flex items-center space-x-2"
          >
            <RefreshCw className={`w-4 h-4 ${isLoading ? 'animate-spin' : ''}`} />
            <span>刷新</span>
          </Button>

          <Button
            onClick={handleExportData}
            variant="outline"
            size="sm"
            className="flex items-center space-x-2"
          >
            <Download className="w-4 h-4" />
            <span>导出</span>
          </Button>

          <Button
            onClick={handleClearData}
            variant="destructive"
            size="sm"
            className="flex items-center space-x-2"
          >
            <Trash2 className="w-4 h-4" />
            <span>清空</span>
          </Button>
        </div>
      </div>

      {/* 过滤器 */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">过滤设置</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center space-x-4">
            <div className="space-y-2">
              <label className="text-sm font-medium">协议类型</label>
              <Select value={selectedProtocol} onValueChange={setSelectedProtocol}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="openai">OpenAI</SelectItem>
                  <SelectItem value="anthropic">Anthropic</SelectItem>
                  <SelectItem value="custom">Custom</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-medium">方向</label>
              <Select value={selectedDirection} onValueChange={(value: any) => setSelectedDirection(value)}>
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">全部</SelectItem>
                  <SelectItem value="request">请求</SelectItem>
                  <SelectItem value="response">响应</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center space-x-2 mt-6">
              <Button
                onClick={() => setShowSensitive(!showSensitive)}
                variant="outline"
                size="sm"
                className="flex items-center space-x-2"
              >
                {showSensitive ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                <span>{showSensitive ? '隐藏敏感' : '显示敏感'}</span>
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Tabs defaultValue="records" className="space-y-4">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="records">协议记录</TabsTrigger>
          <TabsTrigger value="fields">字段统计</TabsTrigger>
          <TabsTrigger value="stats">统计分析</TabsTrigger>
          <TabsTrigger value="insights">洞察分析</TabsTrigger>
        </TabsList>

        <TabsContent value="records" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>协议记录列表</CardTitle>
              <CardDescription>
                共 {filteredRecords.length} 条记录
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                {filteredRecords.map((record) => (
                  <div key={record.id} className="border rounded-lg p-4 space-y-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center space-x-2">
                        <Badge variant={record.direction === 'request' ? 'default' : 'secondary'}>
                          {record.direction}
                        </Badge>
                        <Badge variant="outline">{record.protocol}</Badge>
                        <Badge variant={getComplexityBadge(record.analysis.complexity)}>
                          {record.analysis.complexity}
                        </Badge>
                        {record.analysis.hasTools && (
                          <Badge variant="outline">工具</Badge>
                        )}
                        {record.analysis.hasStreaming && (
                          <Badge variant="outline">流式</Badge>
                        )}
                      </div>
                      <div className="text-sm text-gray-500">
                        {record.timestamp.toLocaleTimeString()}
                      </div>
                    </div>

                    <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                      <div>
                        <span className="font-medium">字段数:</span> {record.analysis.totalFields}
                      </div>
                      <div>
                        <span className="font-medium">估算Token:</span> {record.analysis.estimatedTokens}
                      </div>
                      <div>
                        <span className="font-medium">数据大小:</span> {(record.analysis.dataSize / 1024).toFixed(2)}KB
                      </div>
                      <div>
                        <span className="font-medium">处理时间:</span> {record.metadata.processingTime}ms
                      </div>
                    </div>

                    <div>
                      <div className="text-sm font-medium mb-2">数据预览:</div>
                      <div className="bg-gray-50 dark:bg-gray-800 p-3 rounded-md max-h-64 overflow-auto">
                        {renderRecordData(record.data)}
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="fields" className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>字段统计</CardTitle>
              <CardDescription>
                所有字段的使用频率和类型分布
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>字段名</TableHead>
                    <TableHead>类型</TableHead>
                    <TableHead>频率</TableHead>
                    <TableHead>平均大小</TableHead>
                    <TableHead>深度</TableHead>
                    <TableHead>样本值</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {Array.from(fieldStats.entries())
                    .sort((a, b) => b[1].frequency - a[1].frequency)
                    .slice(0, 50)
                    .map(([name, info]) => (
                      <TableRow key={name}>
                        <TableCell className="font-mono text-sm">{name}</TableCell>
                        <TableCell>
                          <Badge variant="outline">{info.type}</Badge>
                        </TableCell>
                        <TableCell>{info.frequency}</TableCell>
                        <TableCell>{info.size}B</TableCell>
                        <TableCell>{info.depth}</TableCell>
                        <TableCell className="font-mono text-xs max-w-xs truncate">
                          {JSON.stringify(info.samples[0])}
                        </TableCell>
                      </TableRow>
                    ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="stats" className="space-y-4">
          {protocolStats && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">总请求数</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{protocolStats.totalRequests}</div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">总响应数</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{protocolStats.totalResponses}</div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">平均Token数</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{Math.round(protocolStats.averageTokens)}</div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">总数据量</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="text-2xl font-bold">{(protocolStats.totalDataSize / 1024 / 1024).toFixed(2)}MB</div>
                </CardContent>
              </Card>
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>协议分布</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {protocolStats && Array.from(protocolStats.protocols.entries()).map(([protocol, count]) => (
                    <div key={protocol} className="flex justify-between items-center">
                      <Badge variant="outline">{protocol}</Badge>
                      <span className="font-medium">{count}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>内容类型分布</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {protocolStats && Array.from(protocolStats.contentTypes.entries()).map(([type, count]) => (
                    <div key={type} className="flex justify-between items-center">
                      <span className="text-sm">{type}</span>
                      <span className="font-medium">{count}</span>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        <TabsContent value="insights" className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <TrendingUp className="w-5 h-5" />
                  <span>使用趋势</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="text-sm">
                    <div className="font-medium mb-2">高频字段:</div>
                    <div className="space-y-1">
                      {Array.from(fieldStats.entries())
                        .sort((a, b) => b[1].frequency - a[1].frequency)
                        .slice(0, 5)
                        .map(([name, info]) => (
                          <div key={name} className="flex justify-between">
                            <span className="font-mono text-xs">{name}</span>
                            <span>{info.frequency}次</span>
                          </div>
                        ))}
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center space-x-2">
                  <Layers className="w-5 h-5" />
                  <span>复杂度分析</span>
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="text-sm">
                    <div className="font-medium mb-2">复杂度分布:</div>
                    <div className="space-y-2">
                      {['simple', 'medium', 'complex'].map(level => {
                        const count = filteredRecords.filter(r => r.analysis.complexity === level).length;
                        const percentage = filteredRecords.length > 0 ? (count / filteredRecords.length * 100).toFixed(1) : 0;
                        return (
                          <div key={level} className="flex justify-between items-center">
                            <Badge variant={getComplexityBadge(level)}>{level}</Badge>
                            <span>{count} ({percentage}%)</span>
                          </div>
                        );
                      })}
                    </div>
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