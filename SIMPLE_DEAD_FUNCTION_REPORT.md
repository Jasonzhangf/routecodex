# RouteCodex 废弃函数分析报告

**分析时间**: 2025-10-31
**分析工具**: simple_dead_function_finder.py
**项目根目录**: .

## 📊 统计摘要

- **分析文件数**: 339
- **函数总数**: 19092
- **导出函数**: 557
- **内部函数**: 18535
- **函数调用总数**: 2951
- **未使用函数**: 494
- **废弃率**: 2.6%

## 🎯 风险等级分布

| 风险等级 | 数量 | 占比 | 清理建议 |
|---------|------|------|----------|
| LOW | 61 | 12.3% | 建议删除 |
| MEDIUM | 330 | 66.8% | 谨慎评估 |
| HIGH | 103 | 20.9% | 手动审查 |

## 📁 模块分布

- **src/modules/pipeline**: 90 个未使用函数
- **src/server/handlers**: 44 个未使用函数
- **src/components/RoutingManager.tsx**: 28 个未使用函数
- **src/components/RoutingRuleEditor.tsx**: 25 个未使用函数
- **tests/server**: 16 个未使用函数
- **src/server/protocol-handler.ts**: 15 个未使用函数
- **src/components/RoutingTestPanel.tsx**: 15 个未使用函数
- **src/cli.ts**: 13 个未使用函数
- **src/commands/dry-run.ts**: 13 个未使用函数
- **src/conversion/responses**: 12 个未使用函数

## 🔍 详细函数列表

### 低风险函数 (建议删除)

- `import` - `tests/e2e-glm-real.spec.ts:15` (tests/e2e-glm-real.spec.ts)
- `import` - `tests/e2e-glm-real.spec.ts:16` (tests/e2e-glm-real.spec.ts)
- `import` - `tests/e2e-glm-real.spec.ts:17` (tests/e2e-glm-real.spec.ts)
- `pm` - `tests/server/protocol-tools-streaming-e2e.spec.ts:77` (tests/server)
- `hasAssistantToolCall` - `tests/server/protocol-tools-streaming-e2e.spec.ts:101` (tests/server)
- `pm` - `tests/server/protocol-tools-streaming-e2e.spec.ts:112` (tests/server)
- `hasToolUse` - `tests/server/protocol-tools-streaming-e2e.spec.ts:137` (tests/server)
- `pm` - `tests/server/protocol-tools-streaming-e2e.spec.ts:148` (tests/server)
- `hasToolUse` - `tests/server/protocol-tools-streaming-e2e.spec.ts:173` (tests/server)
- `hasReasoning` - `tests/server/responses-glm-config.spec.ts:81` (tests/server)
- `pm` - `tests/server/protocol-tools-e2e.spec.ts:75` (tests/server)
- `hasAssistantToolCall` - `tests/server/protocol-tools-e2e.spec.ts:104` (tests/server)
- `hasToolRole` - `tests/server/protocol-tools-e2e.spec.ts:105` (tests/server)
- `pm` - `tests/server/protocol-tools-e2e.spec.ts:114` (tests/server)
- `hasToolUse` - `tests/server/protocol-tools-e2e.spec.ts:145` (tests/server)
- `hasToolResult` - `tests/server/protocol-tools-e2e.spec.ts:147` (tests/server)
- `hasToolResultText` - `tests/server/protocol-tools-e2e.spec.ts:148` (tests/server)
- `pm` - `tests/server/protocol-tools-e2e.spec.ts:162` (tests/server)
- `hasToolUse` - `tests/server/protocol-tools-e2e.spec.ts:192` (tests/server)
- `hasToolUse` - `tests/llmswitch/unified-tools.test.ts:62` (tests/llmswitch)
- `totalWeight` - `tests/commands/real-virtual-router-load-balancer.test.ts:253` (tests/commands)
- `import` - `tests/commands/dry-run.test.ts:281` (tests/commands)
- `import` - `sharedmodule/config-testkit/src/index.ts:43` (src/index.ts)
- `import` - `sharedmodule/config-testkit/src/index.ts:44` (src/index.ts)
- `sorted` - `sharedmodule/config-testkit/src/tests/performance-benchmark.ts:189` (src/tests/performance-benchmark.ts)
- `sorted95` - `sharedmodule/config-testkit/src/tests/performance-benchmark.ts:195` (src/tests/performance-benchmark.ts)
- `sorted99` - `sharedmodule/config-testkit/src/tests/performance-benchmark.ts:199` (src/tests/performance-benchmark.ts)
- `import` - `sharedmodule/config-testkit/src/tests/blackbox-tester.ts:213` (src/tests/blackbox-tester.ts)
- `fastest` - `sharedmodule/llmswitch-ajv/src/core/test-adapter.ts:220` (src/core/test-adapter.ts)
- `slowest` - `sharedmodule/llmswitch-ajv/src/core/test-adapter.ts:223` (src/core/test-adapter.ts)
- `avgImprovement` - `sharedmodule/llmswitch-ajv/src/test/codex-sample-test.ts:163` (src/test/codex-sample-test.ts)
- `fastestTest` - `sharedmodule/llmswitch-ajv/src/test/codex-sample-test.ts:164` (src/test/codex-sample-test.ts)
- `slowestTest` - `sharedmodule/llmswitch-ajv/src/test/codex-sample-test.ts:165` (src/test/codex-sample-test.ts)
- `TestAction` - `src/commands/dry-run.ts:1137` (src/commands/dry-run.ts)
- `TestAction` - `src/commands/dry-run.ts:1167` (src/commands/dry-run.ts)
- `mockedExt` - `src/commands/dry-run.ts:1172` (src/commands/dry-run.ts)
- `mockedExt` - `src/commands/dry-run.ts:1172` (src/commands/dry-run.ts)
- `TestAction` - `src/commands/dry-run.ts:1188` (src/commands/dry-run.ts)
- `TestAction` - `src/commands/dry-run.ts:1196` (src/commands/dry-run.ts)
- `TestAction` - `src/commands/dry-run.ts:1216` (src/commands/dry-run.ts)
- `warnings` - `src/modules/pipeline/dry-run/pipeline-dry-run-examples.ts:353` (src/modules/pipeline)
- `loginComplete` - `src/modules/pipeline/modules/provider/iflow-oauth.ts:276` (src/modules/pipeline)
- `import` - `src/logging/__tests__/UnifiedParser.test.ts:52` (src/logging/__tests__)
- `import` - `src/logging/__tests__/UnifiedParser.test.ts:76` (src/logging/__tests__)
- `import` - `src/logging/__tests__/UnifiedParser.test.ts:111` (src/logging/__tests__)
- `import` - `src/logging/__tests__/UnifiedParser.test.ts:164` (src/logging/__tests__)
- `handleTest` - `web-interface/src/components/RoutingTestPanel.tsx:46` (src/components/RoutingTestPanel.tsx)
- `handleReset` - `web-interface/src/components/RoutingTestPanel.tsx:60` (src/components/RoutingTestPanel.tsx)
- `handleReset` - `web-interface/src/components/RoutingTestPanel.tsx:60` (src/components/RoutingTestPanel.tsx)
- `addMessage` - `web-interface/src/components/RoutingTestPanel.tsx:114` (src/components/RoutingTestPanel.tsx)
- `addMessage` - `web-interface/src/components/RoutingTestPanel.tsx:114` (src/components/RoutingTestPanel.tsx)
- `onChange` - `web-interface/src/components/RoutingTestPanel.tsx:179` (src/components/RoutingTestPanel.tsx)
- `onChange` - `web-interface/src/components/RoutingTestPanel.tsx:187` (src/components/RoutingTestPanel.tsx)
- `onValueChange` - `web-interface/src/components/RoutingTestPanel.tsx:195` (src/components/RoutingTestPanel.tsx)
- `onChange` - `web-interface/src/components/RoutingTestPanel.tsx:215` (src/components/RoutingTestPanel.tsx)
- `onValueChange` - `web-interface/src/components/RoutingTestPanel.tsx:237` (src/components/RoutingTestPanel.tsx)
- `onClick` - `web-interface/src/components/RoutingTestPanel.tsx:249` (src/components/RoutingTestPanel.tsx)
- `onChange` - `web-interface/src/components/RoutingTestPanel.tsx:258` (src/components/RoutingTestPanel.tsx)
- `onClick` - `web-interface/src/components/RoutingTestPanel.tsx:281` (src/components/RoutingTestPanel.tsx)
- `onChange` - `web-interface/src/components/RoutingTestPanel.tsx:291` (src/components/RoutingTestPanel.tsx)
- `onChange` - `web-interface/src/components/RoutingTestPanel.tsx:303` (src/components/RoutingTestPanel.tsx)

### 中风险函数 (谨慎评估)

- `averageTokens` - `web-interface/src/services/protocolAnalyzer.ts:410` (src/services/protocolAnalyzer.ts)
- `reconnectTimer` - `web-interface/src/services/native-websocket.ts:143` (src/services/native-websocket.ts)
- `import` - `web-interface/src/services/backendService.ts:203` (src/services/backendService.ts)
- `healthCheckInterval` - `web-interface/src/services/backendService.ts:251` (src/services/backendService.ts)
- `kept` - `sharedmodule/llmswitch-core/src/guidance/index.ts:211` (src/guidance/index.ts)
- `import` - `sharedmodule/llmswitch-core/src/llmswitch/llmswitch-conversion-router.ts:88` (src/llmswitch/llmswitch-conversion-router.ts)
- `import` - `sharedmodule/llmswitch-core/src/llmswitch/llmswitch-conversion-router.ts:92` (src/llmswitch/llmswitch-conversion-router.ts)
- `import` - `sharedmodule/llmswitch-core/src/llmswitch/llmswitch-conversion-router.ts:96` (src/llmswitch/llmswitch-conversion-router.ts)
- `import` - `sharedmodule/llmswitch-core/src/llmswitch/openai-normalizer.ts:45` (src/llmswitch/openai-normalizer.ts)
- `import` - `sharedmodule/llmswitch-core/src/llmswitch/openai-normalizer.ts:70` (src/llmswitch/openai-normalizer.ts)
- `hasGuidance` - `sharedmodule/llmswitch-core/src/llmswitch/openai-normalizer.ts:83` (src/llmswitch/openai-normalizer.ts)
- `hasGuidance` - `sharedmodule/llmswitch-core/src/conversion/codecs/openai-openai-codec.ts:48` (src/conversion/codecs)
- `mappedTools` - `sharedmodule/llmswitch-core/src/conversion/codecs/anthropic-openai-codec.ts:82` (src/conversion/codecs)
- `filtered` - `sharedmodule/llmswitch-core/src/conversion/codecs/anthropic-openai-codec.ts:100` (src/conversion/codecs)
- `import` - `sharedmodule/llmswitch-core/src/conversion/codecs/anthropic-openai-codec.ts:120` (src/conversion/codecs)
- `argStr` - `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts:89` (src/conversion/responses)
- `argStr` - `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts:89` (src/conversion/responses)
- `bodyText` - `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts:90` (src/conversion/responses)
- `args` - `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts:292` (src/conversion/responses)
- `val` - `sharedmodule/llmswitch-core/src/conversion/responses/responses-openai-bridge.ts:297` (src/conversion/responses)
- ... 还有 310 个中风险函数

### 高风险函数 (手动审查)

- `handleConnected` - `web-interface/src/hooks/useWebSocket.ts:25` (src/hooks/useWebSocket.ts) ⚠️
- `handleConnected` - `web-interface/src/hooks/useWebSocket.ts:25` (src/hooks/useWebSocket.ts) ⚠️
- `handleDisconnected` - `web-interface/src/hooks/useWebSocket.ts:37` (src/hooks/useWebSocket.ts) ⚠️
- `handleDisconnected` - `web-interface/src/hooks/useWebSocket.ts:37` (src/hooks/useWebSocket.ts) ⚠️
- `handleSystemHealth` - `web-interface/src/hooks/useWebSocket.ts:52` (src/hooks/useWebSocket.ts) ⚠️
- `handleSystemHealth` - `web-interface/src/hooks/useWebSocket.ts:52` (src/hooks/useWebSocket.ts) ⚠️
- `handleModuleStatus` - `web-interface/src/hooks/useWebSocket.ts:56` (src/hooks/useWebSocket.ts) ⚠️
- `handleModuleStatus` - `web-interface/src/hooks/useWebSocket.ts:56` (src/hooks/useWebSocket.ts) ⚠️
- `handlePerformanceMetrics` - `web-interface/src/hooks/useWebSocket.ts:87` (src/hooks/useWebSocket.ts) ⚠️
- `handlePerformanceMetrics` - `web-interface/src/hooks/useWebSocket.ts:87` (src/hooks/useWebSocket.ts) ⚠️
- `onopen` - `web-interface/src/services/native-websocket.ts:70` (src/services/native-websocket.ts) ⚠️
- `onclose` - `web-interface/src/services/native-websocket.ts:77` (src/services/native-websocket.ts) ⚠️
- `onerror` - `web-interface/src/services/native-websocket.ts:88` (src/services/native-websocket.ts) ⚠️
- `onmessage` - `web-interface/src/services/native-websocket.ts:94` (src/services/native-websocket.ts) ⚠️
- `handleRefresh` - `web-interface/src/components/Dashboard.tsx:56` (src/components/Dashboard.tsx) ⚠️
- `handleRefresh` - `web-interface/src/components/Dashboard.tsx:56` (src/components/Dashboard.tsx) ⚠️
- `onClick` - `web-interface/src/components/Dashboard.tsx:104` (src/components/Dashboard.tsx) ⚠️
- `handleExport` - `web-interface/src/components/EventLog.tsx:102` (src/components/EventLog.tsx) ⚠️
- `handleExport` - `web-interface/src/components/EventLog.tsx:102` (src/components/EventLog.tsx) ⚠️
- `handleClear` - `web-interface/src/components/EventLog.tsx:115` (src/components/EventLog.tsx) ⚠️
- `handleClear` - `web-interface/src/components/EventLog.tsx:115` (src/components/EventLog.tsx) ⚠️
- `onChange` - `web-interface/src/components/EventLog.tsx:153` (src/components/EventLog.tsx) ⚠️
- `onClick` - `web-interface/src/components/EventLog.tsx:202` (src/components/EventLog.tsx) ⚠️
- `handleSave` - `web-interface/src/components/RoutingRuleEditor.tsx:159` (src/components/RoutingRuleEditor.tsx) ⚠️
- `handleSave` - `web-interface/src/components/RoutingRuleEditor.tsx:159` (src/components/RoutingRuleEditor.tsx) ⚠️
- `handleTest` - `web-interface/src/components/RoutingRuleEditor.tsx:179` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingRuleEditor.tsx:226` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingRuleEditor.tsx:237` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingRuleEditor.tsx:246` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingRuleEditor.tsx:256` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onClick` - `web-interface/src/components/RoutingRuleEditor.tsx:297` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onClick` - `web-interface/src/components/RoutingRuleEditor.tsx:305` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onClick` - `web-interface/src/components/RoutingRuleEditor.tsx:313` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onClick` - `web-interface/src/components/RoutingRuleEditor.tsx:320` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onValueChange` - `web-interface/src/components/RoutingRuleEditor.tsx:330` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onValueChange` - `web-interface/src/components/RoutingRuleEditor.tsx:351` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingRuleEditor.tsx:374` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingRuleEditor.tsx:386` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onClick` - `web-interface/src/components/RoutingRuleEditor.tsx:431` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onClick` - `web-interface/src/components/RoutingRuleEditor.tsx:439` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onClick` - `web-interface/src/components/RoutingRuleEditor.tsx:447` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onClick` - `web-interface/src/components/RoutingRuleEditor.tsx:454` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onValueChange` - `web-interface/src/components/RoutingRuleEditor.tsx:464` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingRuleEditor.tsx:485` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onClick` - `web-interface/src/components/RoutingRuleEditor.tsx:524` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingRuleEditor.tsx:539` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingRuleEditor.tsx:548` (src/components/RoutingRuleEditor.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingRuleEditor.tsx:563` (src/components/RoutingRuleEditor.tsx) ⚠️
- `handleSaveConfig` - `web-interface/src/components/RoutingManager.tsx:83` (src/components/RoutingManager.tsx) ⚠️
- `handleCreateRule` - `web-interface/src/components/RoutingManager.tsx:94` (src/components/RoutingManager.tsx) ⚠️
- `handleTestRouting` - `web-interface/src/components/RoutingManager.tsx:137` (src/components/RoutingManager.tsx) ⚠️
- `onValueChange` - `web-interface/src/components/RoutingManager.tsx:222` (src/components/RoutingManager.tsx) ⚠️
- `onValueChange` - `web-interface/src/components/RoutingManager.tsx:247` (src/components/RoutingManager.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingManager.tsx:274` (src/components/RoutingManager.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingManager.tsx:290` (src/components/RoutingManager.tsx) ⚠️
- `onClick` - `web-interface/src/components/RoutingManager.tsx:338` (src/components/RoutingManager.tsx) ⚠️
- `onClick` - `web-interface/src/components/RoutingManager.tsx:345` (src/components/RoutingManager.tsx) ⚠️
- `onClick` - `web-interface/src/components/RoutingManager.tsx:406` (src/components/RoutingManager.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingManager.tsx:419` (src/components/RoutingManager.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingManager.tsx:429` (src/components/RoutingManager.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingManager.tsx:443` (src/components/RoutingManager.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingManager.tsx:453` (src/components/RoutingManager.tsx) ⚠️
- `onClick` - `web-interface/src/components/RoutingManager.tsx:466` (src/components/RoutingManager.tsx) ⚠️
- `onValueChange` - `web-interface/src/components/RoutingManager.tsx:475` (src/components/RoutingManager.tsx) ⚠️
- `onValueChange` - `web-interface/src/components/RoutingManager.tsx:494` (src/components/RoutingManager.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingManager.tsx:515` (src/components/RoutingManager.tsx) ⚠️
- `onClick` - `web-interface/src/components/RoutingManager.tsx:524` (src/components/RoutingManager.tsx) ⚠️
- `onClick` - `web-interface/src/components/RoutingManager.tsx:538` (src/components/RoutingManager.tsx) ⚠️
- `onValueChange` - `web-interface/src/components/RoutingManager.tsx:547` (src/components/RoutingManager.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingManager.tsx:567` (src/components/RoutingManager.tsx) ⚠️
- `onClick` - `web-interface/src/components/RoutingManager.tsx:580` (src/components/RoutingManager.tsx) ⚠️
- `onClick` - `web-interface/src/components/RoutingManager.tsx:589` (src/components/RoutingManager.tsx) ⚠️
- `onClick` - `web-interface/src/components/RoutingManager.tsx:594` (src/components/RoutingManager.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingManager.tsx:620` (src/components/RoutingManager.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingManager.tsx:631` (src/components/RoutingManager.tsx) ⚠️
- `onChange` - `web-interface/src/components/RoutingManager.tsx:644` (src/components/RoutingManager.tsx) ⚠️
- `handleStatusChange` - `web-interface/src/components/BackendStatusIndicator.tsx:32` (src/components/BackendStatusIndicator.tsx) ⚠️
- `handleStatusChange` - `web-interface/src/components/BackendStatusIndicator.tsx:32` (src/components/BackendStatusIndicator.tsx) ⚠️
- `handleStartStop` - `web-interface/src/components/BackendStatusIndicator.tsx:56` (src/components/BackendStatusIndicator.tsx) ⚠️
- `handleRefresh` - `web-interface/src/components/BackendStatusIndicator.tsx:69` (src/components/BackendStatusIndicator.tsx) ⚠️
- `onClick` - `web-interface/src/components/ModuleStatusCard.tsx:169` (src/components/ModuleStatusCard.tsx) ⚠️
- `onClick` - `web-interface/src/components/ModuleStatusCard.tsx:178` (src/components/ModuleStatusCard.tsx) ⚠️
- `handleConfigSave` - `web-interface/src/components/ModuleDetails.tsx:49` (src/components/ModuleDetails.tsx) ⚠️
- `handleConfigSave` - `web-interface/src/components/ModuleDetails.tsx:49` (src/components/ModuleDetails.tsx) ⚠️
- `handleConfigCancel` - `web-interface/src/components/ModuleDetails.tsx:54` (src/components/ModuleDetails.tsx) ⚠️
- `handleConfigCancel` - `web-interface/src/components/ModuleDetails.tsx:54` (src/components/ModuleDetails.tsx) ⚠️
- `onClick` - `web-interface/src/components/ModuleDetails.tsx:115` (src/components/ModuleDetails.tsx) ⚠️
- `onClick` - `web-interface/src/components/ModuleDetails.tsx:124` (src/components/ModuleDetails.tsx) ⚠️
- `onChange` - `web-interface/src/components/ModuleDetails.tsx:306` (src/components/ModuleDetails.tsx) ⚠️
- `handleExportData` - `web-interface/src/components/ProtocolAnalyzer.tsx:63` (src/components/ProtocolAnalyzer.tsx) ⚠️
- `handleExportData` - `web-interface/src/components/ProtocolAnalyzer.tsx:63` (src/components/ProtocolAnalyzer.tsx) ⚠️
- `handleClearData` - `web-interface/src/components/ProtocolAnalyzer.tsx:80` (src/components/ProtocolAnalyzer.tsx) ⚠️
- `handleClearData` - `web-interface/src/components/ProtocolAnalyzer.tsx:80` (src/components/ProtocolAnalyzer.tsx) ⚠️
- `onClick` - `web-interface/src/components/ProtocolAnalyzer.tsx:212` (src/components/ProtocolAnalyzer.tsx) ⚠️
- `handleDebugStart` - `web-interface/src/pages/ModuleDetailsPage.tsx:18` (src/pages/ModuleDetailsPage.tsx) ⚠️
- `handleDebugStart` - `web-interface/src/pages/ModuleDetailsPage.tsx:18` (src/pages/ModuleDetailsPage.tsx) ⚠️
- `handleDebugStop` - `web-interface/src/pages/ModuleDetailsPage.tsx:22` (src/pages/ModuleDetailsPage.tsx) ⚠️
- `handleDebugStop` - `web-interface/src/pages/ModuleDetailsPage.tsx:22` (src/pages/ModuleDetailsPage.tsx) ⚠️
- `handleConfigUpdate` - `web-interface/src/pages/ModuleDetailsPage.tsx:26` (src/pages/ModuleDetailsPage.tsx) ⚠️
- `handleConfigUpdate` - `web-interface/src/pages/ModuleDetailsPage.tsx:26` (src/pages/ModuleDetailsPage.tsx) ⚠️
- `startupTimeout` - `web-interface/scripts/dev-with-backend.js:78` (web-interface/scripts) ⚠️
- `handleSignal` - `package/scripts/install.js:347` (package/scripts) ⚠️
- `handleSignal` - `package/scripts/install.js:347` (package/scripts) ⚠️

## 🛠️ 清理建议

### 阶段1: 低风险函数清理
- **目标**: 清理 61 个低风险函数
- **方式**: 可以直接删除或保留
- **建议**: 优先清理测试文件、示例代码中的未使用函数

### 阶段2: 中风险函数评估
- **目标**: 评估 330 个中风险函数
- **方式**: 逐一检查函数用途和依赖关系
- **建议**: 确认无外部引用后再删除

### 阶段3: 高风险函数审查
- **目标**: 仔细审查 103 个高风险函数
- **方式**: 手动检查，可能通过反射、字符串调用等方式被使用
- **建议**: 保留或进行更深入的分析

## 📋 后续步骤

1. **生成清理脚本**:
   ```bash
   python3 scripts/simple_dead_function_finder.py --generate-cleanup
   ```

2. **检查生成的清理脚本**:
   ```bash
   cat scripts/phase1-cleanup.sh
   ```

3. **执行清理（谨慎）**:
   ```bash
   chmod +x scripts/phase1-cleanup.sh
   ./scripts/phase1-cleanup.sh
   ```

4. **验证清理结果**:
   ```bash
   npm run build
   npm test
   ```

---

**⚠️ 重要提醒**:
- 此分析基于静态代码分析，可能存在误判
- 动态调用（如反射、字符串调用）无法检测
- 清理前请确保代码已提交到版本控制
- 清理后务必运行完整测试套件

**报告生成时间**: 2025-10-31