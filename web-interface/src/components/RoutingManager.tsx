/**
 * RouteCodex Routing Management Component
 */

import { useState, useEffect } from 'react';
import { useRoutingConfig, useRoutingRules, useRoutingInfo } from '../hooks/useApi';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import {
  Plus,
  Edit,
  Trash2,
  Save,
  X,
  Play,
  Settings,
  Server,
  ArrowRight,
  CheckCircle,
  AlertCircle,
  Clock
} from 'lucide-react';
import { RoutingConfig, RoutingRule, RoutingStats } from '../types';

export function RoutingManager() {
  const [activeTab, setActiveTab] = useState('config');
  const [editingRule, setEditingRule] = useState<RoutingRule | null>(null);
  const [testRequest, setTestRequest] = useState({
    model: '',
    messages: [{ role: 'user', content: '' }],
    endpoint: '/v1/chat/completions',
    protocol: 'openai'
  });

  const {
    getRoutingConfig,
    updateRoutingConfig,
    loading: configLoading
  } = useRoutingConfig();

  const {
    getRoutingRules,
    createRoutingRule,
    updateRoutingRule,
    deleteRoutingRule,
    testRoutingRule
  } = useRoutingRules();

  const {
    getProviders,
    getStats
  } = useRoutingInfo();

  const [config, setConfig] = useState<RoutingConfig | null>(null);
  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [stats, setStats] = useState<RoutingStats | null>(null);
  const [testResult, setTestResult] = useState<any>(null);

  useEffect(() => {
    loadRoutingData();
  }, []);

  const loadRoutingData = async () => {
    try {
      const [configData, rulesData, _providersData, statsData] = await Promise.all([
        getRoutingConfig(),
        getRoutingRules(),
        getProviders(),
        getStats()
      ]);

      setConfig(configData);
      setRules(rulesData);
      setStats(statsData);
    } catch (error) {
      console.error('Failed to load routing data:', error);
    }
  };

  const handleSaveConfig = async () => {
    if (!config) return;

    try {
      await updateRoutingConfig(config);
      alert('配置保存成功！');
    } catch (error) {
      alert('配置保存失败：' + (error as Error).message);
    }
  };

  const handleCreateRule = async () => {
    const newRule: RoutingRule = {
      id: `rule-${Date.now()}`,
      name: 'New Routing Rule',
      description: 'New routing rule description',
      enabled: true,
      priority: 50,
      conditions: [],
      actions: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    try {
      await createRoutingRule(newRule);
      loadRoutingData();
      setEditingRule(newRule);
    } catch (error) {
      alert('创建路由规则失败：' + (error as Error).message);
    }
  };

  const handleUpdateRule = async (rule: RoutingRule) => {
    try {
      await updateRoutingRule(rule.id, rule);
      loadRoutingData();
      setEditingRule(null);
    } catch (error) {
      alert('更新路由规则失败：' + (error as Error).message);
    }
  };

  const handleDeleteRule = async (ruleId: string) => {
    if (!confirm('确定要删除这个路由规则吗？')) return;

    try {
      await deleteRoutingRule(ruleId);
      loadRoutingData();
    } catch (error) {
      alert('删除路由规则失败：' + (error as Error).message);
    }
  };

  const handleTestRouting = async () => {
    try {
      const result = await testRoutingRule(testRequest);
      setTestResult(result);
    } catch (error) {
      alert('路由测试失败：' + (error as Error).message);
    }
  };

  const addCondition = (rule: RoutingRule) => {
    const newCondition = {
      type: 'model' as const,
      operator: 'contains' as const,
      value: '',
      weight: 1
    };
    rule.conditions.push(newCondition);
    setEditingRule({ ...rule });
  };

  const addAction = (rule: RoutingRule) => {
    const newAction = {
      type: 'route_to' as const,
      value: ''
    };
    rule.actions.push(newAction);
    setEditingRule({ ...rule });
  };

  const removeCondition = (rule: RoutingRule, index: number) => {
    rule.conditions.splice(index, 1);
    setEditingRule({ ...rule });
  };

  const removeAction = (rule: RoutingRule, index: number) => {
    rule.actions.splice(index, 1);
    setEditingRule({ ...rule });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
            动态路由管理
          </h2>
          <p className="text-gray-600 dark:text-gray-400 mt-1">
            配置和管理智能路由规则，实现动态请求分发
          </p>
        </div>

        <Button
          onClick={loadRoutingData}
          variant="outline"
          className="flex items-center space-x-2"
        >
          <Settings className="w-4 h-4" />
          <span>刷新数据</span>
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
        <TabsList className="grid w-full grid-cols-4">
          <TabsTrigger value="config">配置管理</TabsTrigger>
          <TabsTrigger value="rules">路由规则</TabsTrigger>
          <TabsTrigger value="test">路由测试</TabsTrigger>
          <TabsTrigger value="stats">统计分析</TabsTrigger>
        </TabsList>

        <TabsContent value="config" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>路由配置</CardTitle>
              <CardDescription>
                管理全局路由配置和提供商设置
              </CardDescription>
            </CardHeader>
            <CardContent>
              {config ? (
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">输入协议</label>
                      <Select
                        value={config.virtualrouter.inputProtocol}
                        onValueChange={(value) =>
                          setConfig({
                            ...config,
                            virtualrouter: {
                              ...config.virtualrouter,
                              inputProtocol: value
                            }
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="openai">OpenAI</SelectItem>
                          <SelectItem value="anthropic">Anthropic</SelectItem>
                          <SelectItem value="custom">Custom</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    <div className="space-y-2">
                      <label className="text-sm font-medium">输出协议</label>
                      <Select
                        value={config.virtualrouter.outputProtocol}
                        onValueChange={(value) =>
                          setConfig({
                            ...config,
                            virtualrouter: {
                              ...config.virtualrouter,
                              outputProtocol: value
                            }
                          })
                        }
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="openai">OpenAI</SelectItem>
                          <SelectItem value="anthropic">Anthropic</SelectItem>
                          <SelectItem value="custom">Custom</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">HTTP服务器端口</label>
                    <Input
                      type="number"
                      value={config.httpserver.port}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          httpserver: {
                            ...config.httpserver,
                            port: parseInt(e.target.value)
                          }
                        })
                      }
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">HTTP服务器主机</label>
                    <Input
                      value={config.httpserver.host}
                      onChange={(e) =>
                        setConfig({
                          ...config,
                          httpserver: {
                            ...config.httpserver,
                            host: e.target.value
                          }
                        })
                      }
                    />
                  </div>

                  <Button onClick={handleSaveConfig} className="flex items-center space-x-2">
                    <Save className="w-4 h-4" />
                    <span>保存配置</span>
                  </Button>
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  {configLoading ? '加载中...' : '无配置数据'}
                </div>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="rules" className="space-y-6">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">路由规则管理</h3>
            <Button onClick={handleCreateRule} className="flex items-center space-x-2">
              <Plus className="w-4 h-4" />
              <span>新建规则</span>
            </Button>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {rules.map((rule) => (
              <Card key={rule.id}>
                <CardHeader>
                  <div className="flex items-center justify-between">
                    <div>
                      <CardTitle className="text-base">{rule.name}</CardTitle>
                      <CardDescription>{rule.description}</CardDescription>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setEditingRule(rule)}
                      >
                        <Edit className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleDeleteRule(rule.id)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="space-y-3">
                    <div className="flex items-center space-x-4">
                      <div className="flex items-center space-x-1">
                        {rule.enabled ? (
                          <CheckCircle className="w-4 h-4 text-green-500" />
                        ) : (
                          <AlertCircle className="w-4 h-4 text-gray-400" />
                        )}
                        <span className="text-sm">{rule.enabled ? '启用' : '禁用'}</span>
                      </div>
                      <div className="text-sm text-gray-500">
                        优先级: {rule.priority}
                      </div>
                      <div className="text-sm text-gray-500">
                        条件: {rule.conditions.length}
                      </div>
                    </div>

                    {rule.conditions.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-sm font-medium">条件:</div>
                        {rule.conditions.map((condition, index) => (
                          <div key={index} className="text-sm text-gray-600 bg-gray-50 dark:bg-gray-800 p-2 rounded">
                            {condition.type} {condition.operator} "{condition.value}"
                          </div>
                        ))}
                      </div>
                    )}

                    {rule.actions.length > 0 && (
                      <div className="space-y-1">
                        <div className="text-sm font-medium">动作:</div>
                        {rule.actions.map((action, index) => (
                          <div key={index} className="text-sm text-gray-600 bg-gray-50 dark:bg-gray-800 p-2 rounded">
                            {action.type}: {typeof action.value === 'string' ? action.value : JSON.stringify(action.value)}
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>

          {editingRule && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle>编辑路由规则</CardTitle>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setEditingRule(null)}
                  >
                    <X className="w-4 h-4" />
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                <div className="space-y-4">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <label className="text-sm font-medium">规则名称</label>
                      <Input
                        value={editingRule.name}
                        onChange={(e) =>
                          setEditingRule({ ...editingRule, name: e.target.value })
                        }
                      />
                    </div>
                    <div className="space-y-2">
                      <label className="text-sm font-medium">优先级</label>
                      <Input
                        type="number"
                        value={editingRule.priority}
                        onChange={(e) =>
                          setEditingRule({
                            ...editingRule,
                            priority: parseInt(e.target.value)
                          })
                        }
                      />
                    </div>
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">描述</label>
                    <Input
                      value={editingRule.description}
                      onChange={(e) =>
                        setEditingRule({ ...editingRule, description: e.target.value })
                      }
                    />
                  </div>

                  <div className="flex items-center space-x-2">
                    <input
                      type="checkbox"
                      checked={editingRule.enabled}
                      onChange={(e) =>
                        setEditingRule({ ...editingRule, enabled: e.target.checked })
                      }
                    />
                    <label className="text-sm">启用规则</label>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium">条件</label>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => addCondition(editingRule)}
                      >
                        <Plus className="w-4 h-4" />
                      </Button>
                    </div>
                    {editingRule.conditions.map((condition, index) => (
                      <div key={index} className="grid grid-cols-12 gap-2 items-center">
                        <Select
                          value={condition.type}
                          onValueChange={(value: any) => {
                            condition.type = value;
                            setEditingRule({ ...editingRule });
                          }}
                        >
                          <SelectTrigger className="col-span-3">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="model">模型</SelectItem>
                            <SelectItem value="token_count">令牌数量</SelectItem>
                            <SelectItem value="content_type">内容类型</SelectItem>
                            <SelectItem value="tool_type">工具类型</SelectItem>
                            <SelectItem value="custom">自定义</SelectItem>
                          </SelectContent>
                        </Select>

                        <Select
                          value={condition.operator}
                          onValueChange={(value: any) => {
                            condition.operator = value;
                            setEditingRule({ ...editingRule });
                          }}
                        >
                          <SelectTrigger className="col-span-3">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="equals">等于</SelectItem>
                            <SelectItem value="not_equals">不等于</SelectItem>
                            <SelectItem value="contains">包含</SelectItem>
                            <SelectItem value="not_contains">不包含</SelectItem>
                            <SelectItem value="greater_than">大于</SelectItem>
                            <SelectItem value="less_than">小于</SelectItem>
                          </SelectContent>
                        </Select>

                        <Input
                          className="col-span-4"
                          value={condition.value as string}
                          onChange={(e) => {
                            condition.value = e.target.value;
                            setEditingRule({ ...editingRule });
                          }}
                        />

                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => removeCondition(editingRule, index)}
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <label className="text-sm font-medium">动作</label>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => addAction(editingRule)}
                      >
                        <Plus className="w-4 h-4" />
                      </Button>
                    </div>
                    {editingRule.actions.map((action, index) => (
                      <div key={index} className="grid grid-cols-12 gap-2 items-center">
                        <Select
                          value={action.type}
                          onValueChange={(value: any) => {
                            action.type = value;
                            setEditingRule({ ...editingRule });
                          }}
                        >
                          <SelectTrigger className="col-span-4">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="route_to">路由到</SelectItem>
                            <SelectItem value="modify_request">修改请求</SelectItem>
                            <SelectItem value="add_header">添加头部</SelectItem>
                            <SelectItem value="set_param">设置参数</SelectItem>
                            <SelectItem value="log">日志记录</SelectItem>
                          </SelectContent>
                        </Select>

                        <Input
                          className="col-span-6"
                          value={typeof action.value === 'string' ? action.value : JSON.stringify(action.value)}
                          onChange={(e) => {
                            try {
                              action.value = JSON.parse(e.target.value);
                            } catch {
                              action.value = e.target.value;
                            }
                            setEditingRule({ ...editingRule });
                          }}
                        />

                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => removeAction(editingRule, index)}
                        >
                          <X className="w-4 h-4" />
                        </Button>
                      </div>
                    ))}
                  </div>

                  <div className="flex space-x-2">
                    <Button onClick={() => handleUpdateRule(editingRule)}>
                      保存规则
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() => setEditingRule(null)}
                    >
                      取消
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          )}
        </TabsContent>

        <TabsContent value="test" className="space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>路由测试</CardTitle>
              <CardDescription>
                测试路由规则匹配和执行效果
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-medium">模型名称</label>
                    <Input
                      value={testRequest.model}
                      onChange={(e) =>
                        setTestRequest({ ...testRequest, model: e.target.value })
                      }
                      placeholder="例如: gpt-4, claude-3"
                    />
                  </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">端点</label>
                    <Input
                      value={testRequest.endpoint}
                      onChange={(e) =>
                        setTestRequest({ ...testRequest, endpoint: e.target.value })
                      }
                      placeholder="/v1/chat/completions"
                    />
                  </div>
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">消息内容</label>
                  <textarea
                    className="w-full p-2 border rounded-md min-h-24"
                    value={testRequest.messages[0].content}
                    onChange={(e) =>
                      setTestRequest({
                        ...testRequest,
                        messages: [{ role: 'user', content: e.target.value }]
                      })
                    }
                    placeholder="输入测试消息内容..."
                  />
                </div>

                <Button onClick={handleTestRouting} className="flex items-center space-x-2">
                  <Play className="w-4 h-4" />
                  <span>执行路由测试</span>
                </Button>

                {testResult && (
                  <div className="mt-6 p-4 bg-gray-50 dark:bg-gray-800 rounded-lg">
                    <h4 className="font-medium mb-3">测试结果</h4>
                    <div className="space-y-2 text-sm">
                      <div className="flex items-center space-x-2">
                        <ArrowRight className="w-4 h-4" />
                        <span>匹配规则: {testResult.matchedRules?.map((r: any) => r.name).join(', ') || '无'}</span>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Server className="w-4 h-4" />
                        <span>选定提供商: {testResult.selectedProvider || '无'}</span>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Server className="w-4 h-4" />
                        <span>选定模型: {testResult.selectedModel || '无'}</span>
                      </div>
                      <div className="flex items-center space-x-2">
                        <Clock className="w-4 h-4" />
                        <span>执行时间: {testResult.executionTime || 0}ms</span>
                      </div>
                      <div className="p-2 bg-white dark:bg-gray-700 rounded">
                        <strong>推理过程:</strong>
                        <p className="mt-1">{testResult.reasoning || '无推理信息'}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="stats" className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">总请求数</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats?.totalRequests || 0}</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">成功率</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">
                  {stats ? ((stats.successfulRequests / stats.totalRequests) * 100).toFixed(1) : 0}%
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">平均响应时间</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold">{stats?.averageResponseTime?.toFixed(2) || 0}ms</div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium">失败请求数</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-2xl font-bold text-red-600">{stats?.failedRequests || 0}</div>
              </CardContent>
            </Card>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <Card>
              <CardHeader>
                <CardTitle>路由使用统计</CardTitle>
                <CardDescription>各路由的使用频率</CardDescription>
              </CardHeader>
              <CardContent>
                {stats?.routeUsage ? (
                  <div className="space-y-2">
                    {Object.entries(stats.routeUsage).map(([route, count]) => (
                      <div key={route} className="flex justify-between items-center">
                        <span className="text-sm">{route}</span>
                        <span className="text-sm font-medium">{count as number}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-4 text-gray-500">无数据</div>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>提供商使用统计</CardTitle>
                <CardDescription>各提供商的使用频率</CardDescription>
              </CardHeader>
              <CardContent>
                {stats?.providerUsage ? (
                  <div className="space-y-2">
                    {Object.entries(stats.providerUsage).map(([provider, count]) => (
                      <div key={provider} className="flex justify-between items-center">
                        <span className="text-sm">{provider}</span>
                        <span className="text-sm font-medium">{count as number}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="text-center py-4 text-gray-500">无数据</div>
                )}
              </CardContent>
            </Card>
          </div>

          <Card>
            <CardHeader>
              <CardTitle>错误统计</CardTitle>
              <CardDescription>系统错误类型和频率</CardDescription>
            </CardHeader>
            <CardContent>
              {stats?.errors && stats.errors.length > 0 ? (
                <div className="space-y-2">
                  {stats.errors.map((error, index) => (
                    <div key={index} className="flex justify-between items-center p-2 bg-red-50 dark:bg-red-900/20 rounded">
                      <div>
                        <span className="text-sm font-medium">{error.type}</span>
                        <span className="text-sm text-gray-500 ml-2">
                          {new Date(error.lastOccurred).toLocaleString()}
                        </span>
                      </div>
                      <span className="text-sm font-medium">{error.count}</span>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-center py-4 text-gray-500">无错误数据</div>
              )}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </div>
  );
}