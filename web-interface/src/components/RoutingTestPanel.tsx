/**
 * RouteCodex Routing Test Panel Component
 */

import { useState } from 'react';
import { useRoutingRules } from '../hooks/useApi';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Textarea } from './ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import { Badge } from './ui/badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs';
import {
  Play,
  RotateCcw,
  CheckCircle,
  XCircle,
  Code,
  MessageSquare,
  Zap
} from 'lucide-react';
import { RoutingTestRequest, RoutingTestResult } from '../types';

export function RoutingTestPanel() {
  const [testRequest, setTestRequest] = useState<RoutingTestRequest>({
    model: 'qwen-turbo',
    messages: [
      {
        role: 'user',
        content: '请帮我分析一下这个数据：1, 2, 3, 4, 5'
      }
    ],
    tools: [],
    max_tokens: 1000,
    endpoint: '/v1/chat/completions',
    protocol: 'openai'
  });

  const [testResult, setTestResult] = useState<RoutingTestResult | null>(null);
  const [isTesting, setIsTesting] = useState(false);
  const [activeTab, setActiveTab] = useState('request');

  const { testRoutingRule } = useRoutingRules();

  const handleTest = async () => {
    setIsTesting(true);
    setTestResult(null);

    try {
      const result = await testRoutingRule(testRequest);
      setTestResult(result);
    } catch (err) {
      console.error('Routing test failed:', err);
    } finally {
      setIsTesting(false);
    }
  };

  const handleReset = () => {
    setTestRequest({
      model: 'qwen-turbo',
      messages: [
        {
          role: 'user',
          content: '请帮我分析一下这个数据：1, 2, 3, 4, 5'
        }
      ],
      tools: [],
      max_tokens: 1000,
      endpoint: '/v1/chat/completions',
      protocol: 'openai'
    });
    setTestResult(null);
  };

  const addTool = () => {
    setTestRequest(prev => ({
      ...prev,
      tools: [
        ...(prev.tools || []),
        {
          type: 'function',
          function: {
            name: 'new_tool',
            description: 'New tool description',
            parameters: {
              type: 'object',
              properties: {},
              required: []
            }
          }
        }
      ]
    }));
  };

  const removeTool = (index: number) => {
    setTestRequest(prev => ({
      ...prev,
      tools: prev.tools?.filter((_, i) => i !== index) || []
    }));
  };

  const updateMessage = (index: number, field: 'role' | 'content', value: string) => {
    setTestRequest(prev => ({
      ...prev,
      messages: prev.messages.map((msg, i) =>
        i === index ? { ...msg, [field]: value } : msg
      )
    }));
  };

  const addMessage = () => {
    setTestRequest(prev => ({
      ...prev,
      messages: [
        ...prev.messages,
        { role: 'user', content: '' }
      ]
    }));
  };

  const removeMessage = (index: number) => {
    setTestRequest(prev => ({
      ...prev,
      messages: prev.messages.filter((_, i) => i !== index)
    }));
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>路由测试面板</CardTitle>
              <CardDescription>
                测试路由决策逻辑，验证请求分类和规则匹配
              </CardDescription>
            </div>
            <div className="flex items-center space-x-2">
              <Button
                onClick={handleReset}
                variant="outline"
                size="sm"
                disabled={isTesting}
              >
                <RotateCcw className="w-4 h-4 mr-2" />
                重置
              </Button>
              <Button
                onClick={handleTest}
                disabled={isTesting}
                size="sm"
              >
                <Play className="w-4 h-4 mr-2" />
                {isTesting ? '测试中...' : '开始测试'}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Tabs value={activeTab} onValueChange={setActiveTab} className="space-y-4">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="request">测试请求</TabsTrigger>
              <TabsTrigger value="result" disabled={!testResult}>
                测试结果
              </TabsTrigger>
            </TabsList>

            <TabsContent value="request" className="space-y-4">
              {/* 基本参数 */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">模型</label>
                  <Input
                    value={testRequest.model}
                    onChange={(e) => setTestRequest(prev => ({ ...prev, model: e.target.value }))}
                    placeholder="输入模型名称"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">端点</label>
                  <Input
                    value={testRequest.endpoint}
                    onChange={(e) => setTestRequest(prev => ({ ...prev, endpoint: e.target.value }))}
                    placeholder="API端点"
                  />
                </div>
                <div className="space-y-2">
                  <label className="text-sm font-medium">协议</label>
                  <Select
                    value={testRequest.protocol}
                    onValueChange={(value) => setTestRequest(prev => ({ ...prev, protocol: value }))}
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

              {/* 最大Token数 */}
              <div className="space-y-2">
                <label className="text-sm font-medium">最大Token数</label>
                <Input
                  type="number"
                  value={testRequest.max_tokens}
                  onChange={(e) => setTestRequest(prev => ({
                    ...prev,
                    max_tokens: parseInt(e.target.value) || 1000
                  }))}
                  placeholder="最大token数量"
                />
              </div>

              {/* 消息列表 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">对话消息</label>
                  <Button onClick={addMessage} variant="outline" size="sm">
                    添加消息
                  </Button>
                </div>
                <div className="space-y-3">
                  {testRequest.messages.map((message, index) => (
                    <div key={index} className="border rounded-lg p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <Select
                          value={message.role}
                          onValueChange={(value) => updateMessage(index, 'role', value)}
                        >
                          <SelectTrigger className="w-32">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="user">用户</SelectItem>
                            <SelectItem value="assistant">助手</SelectItem>
                            <SelectItem value="system">系统</SelectItem>
                          </SelectContent>
                        </Select>
                        <Button
                          onClick={() => removeMessage(index)}
                          variant="outline"
                          size="sm"
                        >
                          删除
                        </Button>
                      </div>
                      <Textarea
                        value={message.content}
                        onChange={(e) => updateMessage(index, 'content', e.target.value)}
                        placeholder="输入消息内容"
                        rows={3}
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* 工具列表 */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-sm font-medium">工具调用</label>
                  <Button onClick={addTool} variant="outline" size="sm">
                    添加工具
                  </Button>
                </div>
                <div className="space-y-3">
                  {testRequest.tools?.map((tool, index) => (
                    <div key={index} className="border rounded-lg p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-medium">工具 {index + 1}</span>
                        <Button
                          onClick={() => removeTool(index)}
                          variant="outline"
                          size="sm"
                        >
                          删除
                        </Button>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                        <Input
                          value={tool.function.name}
                          onChange={(e) => {
                            const newTools = [...(testRequest.tools || [])];
                            newTools[index] = {
                              ...tool,
                              function: { ...tool.function, name: e.target.value }
                            };
                            setTestRequest(prev => ({ ...prev, tools: newTools }));
                          }}
                          placeholder="工具名称"
                        />
                        <Input
                          value={tool.function.description}
                          onChange={(e) => {
                            const newTools = [...(testRequest.tools || [])];
                            newTools[index] = {
                              ...tool,
                              function: { ...tool.function, description: e.target.value }
                            };
                            setTestRequest(prev => ({ ...prev, tools: newTools }));
                          }}
                          placeholder="工具描述"
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </TabsContent>

            <TabsContent value="result" className="space-y-4">
              {testResult ? (
                <div className="space-y-6">
                  {/* 测试概要 */}
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                    <Card>
                      <CardContent className="p-4">
                        <div className="flex items-center space-x-2">
                          {testResult.matched ? (
                            <CheckCircle className="w-5 h-5 text-green-500" />
                          ) : (
                            <XCircle className="w-5 h-5 text-red-500" />
                          )}
                          <div>
                            <div className="text-sm font-medium">匹配状态</div>
                            <div className="text-xs text-gray-500">
                              {testResult.matched ? '成功匹配' : '未匹配'}
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardContent className="p-4">
                        <div className="flex items-center space-x-2">
                          <Zap className="w-5 h-5 text-blue-500" />
                          <div>
                            <div className="text-sm font-medium">置信度</div>
                            <div className="text-xs text-gray-500">
                              {(testResult.confidence * 100).toFixed(1)}%
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>

                    <Card>
                      <CardContent className="p-4">
                        <div className="flex items-center space-x-2">
                          <Code className="w-5 h-5 text-purple-500" />
                          <div>
                            <div className="text-sm font-medium">执行时间</div>
                            <div className="text-xs text-gray-500">
                              {testResult.executionTime.toFixed(2)}ms
                            </div>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </div>

                  {/* 路由决策 */}
                  <Card>
                    <CardHeader>
                      <CardTitle>路由决策详情</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-4">
                      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                        <div>
                          <label className="text-sm font-medium">选择的路由</label>
                          <Badge variant="secondary" className="mt-1">
                            {testResult.selectedRoute}
                          </Badge>
                        </div>
                        <div>
                          <label className="text-sm font-medium">选择的提供商</label>
                          <Badge variant="outline" className="mt-1">
                            {testResult.selectedProvider}
                          </Badge>
                        </div>
                        <div>
                          <label className="text-sm font-medium">选择的模型</label>
                          <Badge variant="outline" className="mt-1">
                            {testResult.selectedModel}
                          </Badge>
                        </div>
                        <div>
                          <label className="text-sm font-medium">请求ID</label>
                          <div className="text-xs text-gray-500 mt-1 font-mono">
                            {testResult.requestId}
                          </div>
                        </div>
                      </div>

                      <div>
                        <label className="text-sm font-medium">推理过程</label>
                        <div className="mt-1 p-3 bg-gray-50 rounded-md text-sm">
                          {testResult.reasoning}
                        </div>
                      </div>
                    </CardContent>
                  </Card>

                  {/* 匹配的规则 */}
                  {testResult.matchedRules.length > 0 && (
                    <Card>
                      <CardHeader>
                        <CardTitle>匹配的规则</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <div className="space-y-3">
                          {testResult.matchedRules.map((rule) => (
                            <div key={rule.id} className="border rounded-lg p-3">
                              <div className="flex items-center justify-between mb-2">
                                <span className="font-medium">{rule.name}</span>
                                <Badge variant="outline">
                                  优先级: {rule.priority}
                                </Badge>
                              </div>
                              <p className="text-sm text-gray-600 mb-2">
                                {rule.description}
                              </p>
                              <div className="text-xs text-gray-500">
                                状态: {rule.enabled ? '启用' : '禁用'}
                              </div>
                            </div>
                          ))}
                        </div>
                      </CardContent>
                    </Card>
                  )}
                </div>
              ) : (
                <div className="text-center py-8 text-gray-500">
                  <MessageSquare className="w-12 h-12 mx-auto mb-4 opacity-50" />
                  <p>尚未执行测试</p>
                  <p className="text-sm">配置测试请求并点击"开始测试"</p>
                </div>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>

    </div>
  );
}