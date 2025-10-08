/**
 * Routing Rule Editor Component
 */

import { useState } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from './ui/card';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select';
import {
  Plus,
  Save,
  Trash2,
  Copy,
  ArrowUp,
  ArrowDown,
  TestTube,
  Eye,
  EyeOff
} from 'lucide-react';
import {
  RoutingRule,
  RoutingCondition,
  RoutingAction,
  RoutingTestRequest,
  RoutingTestResult
} from '../types';
import { toast } from 'react-hot-toast';

interface RoutingRuleEditorProps {
  rule?: RoutingRule;
  onSave: (rule: RoutingRule) => void;
  onCancel: () => void;
  onTest: (request: RoutingTestRequest) => Promise<RoutingTestResult>;
  isNew?: boolean;
}

export function RoutingRuleEditor({
  rule,
  onSave,
  onCancel,
  onTest,
  isNew = false
}: RoutingRuleEditorProps) {
  const [currentRule, setCurrentRule] = useState<RoutingRule>(() =>
    rule || createEmptyRule()
  );
  const [showTestRequest, setShowTestRequest] = useState(false);
  const [testRequest, setTestRequest] = useState<RoutingTestRequest>({
    model: 'gpt-4',
    messages: [
      { role: 'user', content: 'Hello, how are you?' }
    ]
  });
  const [testResult, setTestResult] = useState<RoutingTestResult | null>(null);
  const [testing, setTesting] = useState(false);

  function createEmptyRule(): RoutingRule {
    return {
      id: `rule-${Date.now()}`,
      name: '',
      description: '',
      enabled: true,
      priority: 50,
      conditions: [],
      actions: [],
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  }

  const addCondition = () => {
    const newCondition: RoutingCondition = {
      type: 'model',
      operator: 'equals',
      value: ''
    };

    setCurrentRule(prev => ({
      ...prev,
      conditions: [...prev.conditions, newCondition],
      updatedAt: Date.now()
    }));
  };

  const updateCondition = (index: number, condition: RoutingCondition) => {
    setCurrentRule(prev => ({
      ...prev,
      conditions: prev.conditions.map((c, i) => i === index ? condition : c),
      updatedAt: Date.now()
    }));
  };

  const removeCondition = (index: number) => {
    setCurrentRule(prev => ({
      ...prev,
      conditions: prev.conditions.filter((_, i) => i !== index),
      updatedAt: Date.now()
    }));
  };

  const moveCondition = (index: number, direction: 'up' | 'down') => {
    const conditions = [...currentRule.conditions];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;

    if (targetIndex >= 0 && targetIndex < conditions.length) {
      [conditions[index], conditions[targetIndex]] = [conditions[targetIndex], conditions[index]];
      setCurrentRule(prev => ({
        ...prev,
        conditions,
        updatedAt: Date.now()
      }));
    }
  };

  const addAction = () => {
    const newAction: RoutingAction = {
      type: 'route_to',
      value: ''
    };

    setCurrentRule(prev => ({
      ...prev,
      actions: [...prev.actions, newAction],
      updatedAt: Date.now()
    }));
  };

  const updateAction = (index: number, action: RoutingAction) => {
    setCurrentRule(prev => ({
      ...prev,
      actions: prev.actions.map((a, i) => i === index ? action : a),
      updatedAt: Date.now()
    }));
  };

  const removeAction = (index: number) => {
    setCurrentRule(prev => ({
      ...prev,
      actions: prev.actions.filter((_, i) => i !== index),
      updatedAt: Date.now()
    }));
  };

  const moveAction = (index: number, direction: 'up' | 'down') => {
    const actions = [...currentRule.actions];
    const targetIndex = direction === 'up' ? index - 1 : index + 1;

    if (targetIndex >= 0 && targetIndex < actions.length) {
      [actions[index], actions[targetIndex]] = [actions[targetIndex], actions[index]];
      setCurrentRule(prev => ({
        ...prev,
        actions,
        updatedAt: Date.now()
      }));
    }
  };

  const handleSave = () => {
    if (!currentRule.name.trim()) {
      toast.error('Rule name is required');
      return;
    }

    if (currentRule.conditions.length === 0) {
      toast.error('At least one condition is required');
      return;
    }

    if (currentRule.actions.length === 0) {
      toast.error('At least one action is required');
      return;
    }

    onSave(currentRule);
    toast.success(isNew ? 'Rule created successfully' : 'Rule updated successfully');
  };

  const handleTest = async () => {
    setTesting(true);
    try {
      const result = await onTest(testRequest);
      setTestResult(result);
      toast.success('Test completed successfully');
    } catch (error) {
      toast.error('Test failed: ' + (error instanceof Error ? error.message : 'Unknown error'));
    } finally {
      setTesting(false);
    }
  };

  const duplicateCondition = (condition: RoutingCondition) => {
    const newCondition = { ...condition };
    setCurrentRule(prev => ({
      ...prev,
      conditions: [...prev.conditions, newCondition],
      updatedAt: Date.now()
    }));
  };

  const duplicateAction = (action: RoutingAction) => {
    const newAction = { ...action };
    setCurrentRule(prev => ({
      ...prev,
      actions: [...prev.actions, newAction],
      updatedAt: Date.now()
    }));
  };

  return (
    <div className="space-y-6">
      {/* Basic Information */}
      <Card>
        <CardHeader>
          <CardTitle>{isNew ? 'Create New Rule' : 'Edit Rule'}</CardTitle>
          <CardDescription>
            Configure routing rule conditions and actions
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-2">Rule Name</label>
              <Input
                value={currentRule.name}
                onChange={(e) => setCurrentRule(prev => ({ ...prev, name: e.target.value }))}
                placeholder="Enter rule name"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-2">Priority</label>
              <Input
                type="number"
                min="1"
                max="100"
                value={currentRule.priority}
                onChange={(e) => setCurrentRule(prev => ({ ...prev, priority: parseInt(e.target.value) || 50 }))}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium mb-2">Description</label>
            <Input
              value={currentRule.description || ''}
              onChange={(e) => setCurrentRule(prev => ({ ...prev, description: e.target.value }))}
              placeholder="Enter rule description"
            />
          </div>

          <div className="flex items-center space-x-2">
            <input
              type="checkbox"
              id="enabled"
              checked={currentRule.enabled}
              onChange={(e) => setCurrentRule(prev => ({ ...prev, enabled: e.target.checked }))}
              className="rounded"
            />
            <label htmlFor="enabled" className="text-sm font-medium">
              Enabled
            </label>
          </div>
        </CardContent>
      </Card>

      {/* Conditions */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Conditions</CardTitle>
              <CardDescription>
                Define when this rule should be triggered
              </CardDescription>
            </div>
            <Button onClick={addCondition} size="sm">
              <Plus className="w-4 h-4 mr-2" />
              Add Condition
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {currentRule.conditions.length === 0 ? (
            <div className="text-center py-8 text-gray-500 border-2 border-dashed border-gray-300 rounded-lg">
              No conditions configured. Add a condition to get started.
            </div>
          ) : (
            <div className="space-y-3">
              {currentRule.conditions.map((condition, index) => (
                <div key={index} className="border rounded-lg p-4 bg-gray-50">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm font-medium">Condition {index + 1}</span>
                    <div className="flex items-center space-x-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => moveCondition(index, 'up')}
                        disabled={index === 0}
                      >
                        <ArrowUp className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => moveCondition(index, 'down')}
                        disabled={index === currentRule.conditions.length - 1}
                      >
                        <ArrowDown className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => duplicateCondition(condition)}
                      >
                        <Copy className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => removeCondition(index)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                    <Select
                      value={condition.type}
                      onValueChange={(value) => updateCondition(index, {
                        ...condition,
                        type: value as RoutingCondition['type']
                      })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="model">Model</SelectItem>
                        <SelectItem value="token_count">Token Count</SelectItem>
                        <SelectItem value="content_type">Content Type</SelectItem>
                        <SelectItem value="tool_type">Tool Type</SelectItem>
                        <SelectItem value="custom">Custom</SelectItem>
                        <SelectItem value="endpoint">Endpoint</SelectItem>
                        <SelectItem value="protocol">Protocol</SelectItem>
                      </SelectContent>
                    </Select>

                    <Select
                      value={condition.operator}
                      onValueChange={(value) => updateCondition(index, {
                        ...condition,
                        operator: value as RoutingCondition['operator']
                      })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="equals">Equals</SelectItem>
                        <SelectItem value="not_equals">Not Equals</SelectItem>
                        <SelectItem value="contains">Contains</SelectItem>
                        <SelectItem value="not_contains">Not Contains</SelectItem>
                        <SelectItem value="greater_than">Greater Than</SelectItem>
                        <SelectItem value="less_than">Less Than</SelectItem>
                        <SelectItem value="in">In</SelectItem>
                        <SelectItem value="not_in">Not In</SelectItem>
                        <SelectItem value="regex">Regex</SelectItem>
                      </SelectContent>
                    </Select>

                    <Input
                      value={condition.value.toString()}
                      onChange={(e) => updateCondition(index, {
                        ...condition,
                        value: e.target.value
                      })}
                      placeholder="Value"
                    />

                    <Input
                      type="number"
                      min="1"
                      max="100"
                      value={condition.weight || 1}
                      onChange={(e) => updateCondition(index, {
                        ...condition,
                        weight: parseInt(e.target.value) || 1
                      })}
                      placeholder="Weight"
                    />
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Actions */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Actions</CardTitle>
              <CardDescription>
                Define what happens when this rule is triggered
              </CardDescription>
            </div>
            <Button onClick={addAction} size="sm">
              <Plus className="w-4 h-4 mr-2" />
              Add Action
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {currentRule.actions.length === 0 ? (
            <div className="text-center py-8 text-gray-500 border-2 border-dashed border-gray-300 rounded-lg">
              No actions configured. Add an action to get started.
            </div>
          ) : (
            <div className="space-y-3">
              {currentRule.actions.map((action, index) => (
                <div key={index} className="border rounded-lg p-4 bg-gray-50">
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-sm font-medium">Action {index + 1}</span>
                    <div className="flex items-center space-x-2">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => moveAction(index, 'up')}
                        disabled={index === 0}
                      >
                        <ArrowUp className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => moveAction(index, 'down')}
                        disabled={index === currentRule.actions.length - 1}
                      >
                        <ArrowDown className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => duplicateAction(action)}
                      >
                        <Copy className="w-4 h-4" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => removeAction(index)}
                      >
                        <Trash2 className="w-4 h-4" />
                      </Button>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <Select
                      value={action.type}
                      onValueChange={(value) => updateAction(index, {
                        ...action,
                        type: value as RoutingAction['type']
                      })}
                    >
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="route_to">Route To</SelectItem>
                        <SelectItem value="modify_request">Modify Request</SelectItem>
                        <SelectItem value="add_header">Add Header</SelectItem>
                        <SelectItem value="set_param">Set Parameter</SelectItem>
                        <SelectItem value="transform">Transform</SelectItem>
                        <SelectItem value="log">Log</SelectItem>
                        <SelectItem value="metric">Metric</SelectItem>
                      </SelectContent>
                    </Select>

                    <Input
                      value={typeof action.value === 'string' ? action.value : JSON.stringify(action.value)}
                      onChange={(e) => {
                        let value: any = e.target.value;
                        try {
                          // Try to parse as JSON for complex values
                          if (e.target.value.startsWith('{') || e.target.value.startsWith('[')) {
                            value = JSON.parse(e.target.value);
                          }
                        } catch {
                          // Keep as string if not valid JSON
                        }
                        updateAction(index, { ...action, value });
                      }}
                      placeholder="Value (JSON or string)"
                    />

                    <div className="text-sm text-gray-500">
                      Type: {action.type}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Test Section */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle>Test Rule</CardTitle>
              <CardDescription>
                Test this rule with a sample request
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowTestRequest(!showTestRequest)}
            >
              {showTestRequest ? <EyeOff className="w-4 h-4 mr-2" /> : <Eye className="w-4 h-4 mr-2" />}
              {showTestRequest ? 'Hide' : 'Show'} Test Request
            </Button>
          </div>
        </CardHeader>

        {showTestRequest && (
          <CardContent className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-2">Model</label>
                <Input
                  value={testRequest.model}
                  onChange={(e) => setTestRequest(prev => ({ ...prev, model: e.target.value }))}
                  placeholder="gpt-4"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-2">Max Tokens</label>
                <Input
                  type="number"
                  value={testRequest.max_tokens || ''}
                  onChange={(e) => setTestRequest(prev => ({
                    ...prev,
                    max_tokens: e.target.value ? parseInt(e.target.value) : undefined
                  }))}
                  placeholder="2048"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Message</label>
              <textarea
                className="w-full p-3 border rounded-lg"
                rows={4}
                value={testRequest.messages[0]?.content || ''}
                onChange={(e) => setTestRequest(prev => ({
                  ...prev,
                  messages: [{ role: 'user', content: e.target.value }]
                }))}
                placeholder="Enter your test message here..."
              />
            </div>

            <Button onClick={handleTest} disabled={testing} className="w-full">
              <TestTube className="w-4 h-4 mr-2" />
              {testing ? 'Testing...' : 'Test Rule'}
            </Button>

            {testResult && (
              <div className="mt-4 p-4 border rounded-lg bg-blue-50">
                <h4 className="font-medium mb-2">Test Results</h4>
                <div className="space-y-2 text-sm">
                  <div><strong>Matched:</strong> {testResult.matched ? 'Yes' : 'No'}</div>
                  <div><strong>Confidence:</strong> {testResult.confidence}%</div>
                  <div><strong>Selected Route:</strong> {testResult.selectedRoute}</div>
                  <div><strong>Selected Provider:</strong> {testResult.selectedProvider}</div>
                  <div><strong>Selected Model:</strong> {testResult.selectedModel}</div>
                  <div><strong>Reasoning:</strong> {testResult.reasoning}</div>
                  <div><strong>Execution Time:</strong> {testResult.executionTime}ms</div>
                  {testResult.matchedRules.length > 0 && (
                    <div><strong>Matched Rules:</strong> {testResult.matchedRules.map(r => r.name).join(', ')}</div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        )}
      </Card>

      {/* Actions */}
      <div className="flex justify-end space-x-4">
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button onClick={handleSave}>
          <Save className="w-4 h-4 mr-2" />
          {isNew ? 'Create Rule' : 'Save Changes'}
        </Button>
      </div>
    </div>
  );
}