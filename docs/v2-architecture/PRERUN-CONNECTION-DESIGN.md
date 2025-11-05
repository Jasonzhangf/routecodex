# V2 Pipeline Prerun and Dynamic Connection Design
## (Support Zero-Configuration Migration Gradual Switch)

## 🎯 Core Design Objectives

1. **Pipeline Prerun**: V2 can first dry-run validation, ensuring complete compatibility with V1
2. **Dynamic Connection**: Only increase connection process after selecting route, no reassembly
3. **Simplified Assembler**: Only check if modules are statically configured, no connection building
4. **Zero Configuration Migration**: V1 configuration auto-converts to V2 static instance configuration

## 🏗️ Overall Architecture Design

### V1 vs V2 Architecture Comparison

```
V1 Static Assembly (Current):
┌─────────────────────────────────────────────────────────────┐
│                    PipelineAssembler                         │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │ Config Parse │→ │ Instance Create │→ │ Connection Build │        │
│  └─────────────┘  └─────────────┘  └─────────────┘        │
│         ↓                ↓                ↓                 │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              PipelineManager (Static Connection)          │ │
│  │  [ProviderA]─[CompatA]─[LLMSwitchA]  (Connected)       │ │
│  │  [ProviderB]─[CompatB]─[LLMSwitchB]  (Connected)       │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘

V2 Prerun + Dynamic Connection (New Design):
┌─────────────────────────────────────────────────────────────┐
│                    V2PipelineAssembler                       │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │ Config Check │→ │ Instance Verify │→ │ Prerun Validate │        │
│  └─────────────┘  └─────────────┘  └─────────────┘        │
│         ↓                ↓                ↓                 │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │               StaticInstancePool                          │ │
│  │  [ProviderA] [ProviderB] [CompatA] [CompatB] [SwitchA]  │ │
│  │  (Static instance pool, not connected)                   │ │
│  └─────────────────────────────────────────────────────────┘ │
│                              ↓                                │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              DynamicConnector                            │ │
│  │          Request time dynamic connect → Execute → Disconnect │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

## 📋 Detailed Design Plan

### 1. V2 Pipeline Assembler (Simplified Version)

#### 1.1 Prerun Validation Mechanism

```typescript
// src/modules/pipeline/v2/config/v2-pipeline-assembler.ts
export class V2PipelineAssembler {
  constructor(
    private staticInstancePool: StaticInstancePool,
    private configValidator: V2ConfigValidator
  ) {}

  // Assemble pipeline (validation only, no connection)
  async assemble(mergedConfig: MergedConfig): Promise<V2AssembledPipelines> {
    // 1. Convert V1 configuration to V2 format
    const v2Config = this.migrateV1ToV2(mergedConfig);

    // 2. Validate V2 configuration integrity
    await this.validateV2Config(v2Config);

    // 3. Check required modules are statically loaded
    await this.verifyStaticInstances(v2Config);

    // 4. Prerun pipeline route validation
    await this.preRunRoutes(v2Config);

    return {
      v2Config,
      staticInstancePool: this.staticInstancePool,
      routeTable: v2Config.virtualPipelines.routeTable,
      isReady: true
    };
  }

  // Prerun all routes (dry run mode, no actual execution)
  private async preRunRoutes(v2Config: V2SystemConfig): Promise<PreRunReport> {
    const report: PreRunReport = {
      totalRoutes: 0,
      successfulRoutes: 0,
      failedRoutes: [],
      warnings: []
    };

    const { routeTable } = v2Config.virtualPipelines;
    report.totalRoutes = routeTable.routes.length;

    // Create mock requests for dry run
    for (const route of routeTable.routes) {
      try {
        await this.preRunSingleRoute(route);
        report.successfulRoutes++;
      } catch (error) {
        report.failedRoutes.push({
          routeId: route.id,
          error: error.message,
          recoverable: this.isRecoverableError(error)
        });
      }
    }

    return report;
  }

  // Single route prerun
  private async preRunSingleRoute(route: RouteDefinition): Promise<void> {
    // 1. Validate route pattern matching
    this.validateRoutePattern(route);

    // 2. Verify all module instances available
    for (const moduleSpec of route.modules) {
      const config = this.resolveModuleConfig(moduleSpec);
      const instance = this.staticInstancePool.getInstance(moduleSpec.type, config);

      // Check instance health status
      if (!await this.isInstanceHealthy(instance)) {
        throw new Error(`Module instance ${moduleSpec.type} is not healthy`);
      }
    }

    // 3. Simulate data flow validation (dry run)
    await this.simulateDataFlow(route);
  }

  // Simulate data flow validation
  private async simulateDataFlow(route: RouteDefinition): Promise<void> {
    const mockRequest = this.createMockRequest(route);
    const mockContext = { dryRun: true, routeId: route.id };

    // Verify each module's input-output compatibility in order
    let currentData = mockRequest;

    for (let i = 0; i < route.modules.length; i++) {
      const moduleSpec = route.modules[i];
      const config = this.resolveModuleConfig(moduleSpec);
      const instance = this.staticInstancePool.getInstance(moduleSpec.type, config);

      try {
        // Dry run mode, modules only do format validation, no actual processing
        const validatedData = await instance.validateInput(currentData, mockContext);
        currentData = validatedData;
      } catch (error) {
        throw new Error(`Data flow validation failed at module ${moduleSpec.type}: ${error.message}`);
      }
    }
  }
}
```

#### 1.2 V1 Configuration Auto Migration

```typescript
// src/modules/pipeline/v2/config/v1-migrator.ts
export class V1ToV2Migrator {
  // Auto migrate V1 configuration to V2 static instance configuration
  static migrate(mergedConfig: MergedConfig): V2SystemConfig {
    return {
      version: '2.0',

      // System configuration (default V2 mode)
      system: {
        mode: 'v2',
        enableDryRun: true,
        featureFlags: {
          dynamicConnection: true,
          staticInstancePool: true,
          preRunValidation: true
        }
      },

      // Static instance pool configuration (generated based on V1 configuration)
      staticInstances: {
        preloadModules: this.extractRequiredModules(mergedConfig),
        poolConfig: {
          maxInstancesPerType: 10,
          warmupInstances: this.calculateWarmupCount(mergedConfig),
          idleTimeout: 300000 // 5 minutes
        }
      },

      // Virtual pipeline configuration (converted from V1 routePools)
      virtualPipelines: {
        routeTable: this.convertRoutePoolsToRoutes(mergedConfig),
        moduleRegistry: {
          providers: this.extractProviderConfigs(mergedConfig),
          compatibility: this.extractCompatibilityConfigs(mergedConfig),
          llmSwitch: this.extractLLMSwitchConfigs(mergedConfig)
        }
      },

      // Keep original configuration for rollback
      legacy: mergedConfig
    };
  }

  // Convert V1 routePools to V2 routing table
  private static convertRoutePoolsToRoutes(mergedConfig: MergedConfig): RouteTableConfig {
    const pac = this.asRecord(this.asRecord(mergedConfig.pipeline_assembler).config);
    const legacyRoutePools = pac.routePools as Record<string, string[]> || {};
    const legacyRouteMeta = pac.routeMeta as Record<string, any> || {};

    const routes: RouteDefinition[] = [];

    // Create route definition for each routing category
    for (const [routeName, pipelineIds] of Object.entries(legacyRoutePools)) {
      for (const pipelineId of pipelineIds) {
        const route = this.createRouteFromLegacy(pipelineId, routeName, legacyRouteMeta);
        routes.push(route);
      }
    }

    return {
      routes,
      defaultRoute: 'default',
      // Note: No fallback strategies - fail fast when routing fails
      // Mode switching must be explicit operator action
    };
  }

  // Create V2 route from Legacy pipeline ID
  private static createRouteFromLegacy(
    pipelineId: string,
    routeName: string,
    routeMeta: Record<string, any>
  ): RouteDefinition {
    // Parse Legacy ID (e.g.: glm_key1.glm-4.5-air)
    const parsed = this.parseLegacyPipelineId(pipelineId);

    return {
      id: `${routeName}-${pipelineId}`,
      pattern: {
        // Match based on model ID and provider characteristics
        model: new RegExp(`^${parsed.modelId}$`),
        provider: parsed.provider
      },
      modules: [
        {
          type: 'provider',
          config: `${parsed.provider}-provider-config`
        },
        {
          type: 'compatibility',
          config: `${parsed.provider}-compatibility-config`
        },
        {
          type: 'llmSwitch',
          config: 'conversion-router-config'
        }
      ],
      priority: this.calculateRoutePriority(routeName),
      metadata: routeMeta[pipelineId] || {}
    };
  }

  // Extract required module types
  private static extractRequiredModules(mergedConfig: MergedConfig): string[] {
    const modules = new Set<string>();

    // Analyze module types used in all routes
    const routeTable = this.convertRoutePoolsToRoutes(mergedConfig);
    for (const route of routeTable.routes) {
      for (const module of route.modules) {
        modules.add(module.type);
      }
    }

    return Array.from(modules);
  }
}
```

### 2. Dynamic Connector Design

#### 2.1 Runtime Dynamic Connection

```typescript
// src/modules/pipeline/v2/core/dynamic-connector.ts
export class DynamicConnector {
  // Handle request (dynamic connection mode)
  async handleRequest(
    request: PipelineRequest,
    v2Config: V2SystemConfig,
    staticInstancePool: StaticInstancePool
  ): Promise<PipelineResponse> {
    // 1. Route matching
    const route = this.matchRoute(request, v2Config.virtualPipelines.routeTable);

    // 2. Dynamic connect modules (only connection, no instance creation)
    const connection = await this.connectModules(route, staticInstancePool);

    try {
      // 3. Execute pipeline processing
      const response = await this.executeConnectedModules(connection, request);
      return response;
    } finally {
      // 4. Disconnect connection (keep instances)
      await this.disconnectModules(connection);
    }
  }

  // Dynamic connect modules (core: only increase connection process)
  private async connectModules(
    route: RouteDefinition,
    staticInstancePool: StaticInstancePool
  ): Promise<ModuleConnection> {
    const instances: ModuleInstance[] = [];
    const connections: InstanceConnection[] = [];

    // 1. Get all required module instances (from static pool)
    for (const moduleSpec of route.modules) {
      const config = this.resolveModuleConfig(moduleSpec);
      const instance = staticInstancePool.getInstance(moduleSpec.type, config);
      instances.push(instance);
    }

    // 2. Create temporary connections (this is "only increase connection process")
    for (let i = 0; i < instances.length - 1; i++) {
      const from = instances[i];
      const to = instances[i + 1];

      // Create lightweight connection
      const connection = new InstanceConnection(from, to, {
        connectionId: `${route.id}-${i}`,
        temporary: true,
        metadata: { routeId: route.id, position: i }
      });

      connections.push(connection);

      // Establish connection
      await this.establishConnection(connection);
    }

    return new ModuleConnection(route.id, instances, connections);
  }

  // Establish connection
  private async establishConnection(connection: InstanceConnection): Promise<void> {
    // Set output to next module's pipeline
    connection.from.setOutputTarget(connection.to);

    // Set input from previous module's pipeline
    connection.to.setInputSource(connection.from);

    // Connection ready notification
    await connection.onConnect();
  }

  // Execute connected modules
  private async executeConnectedModules(
    connection: ModuleConnection,
    request: PipelineRequest
  ): Promise<PipelineResponse> {
    const { instances } = connection;
    let currentData = request;

    // Execute connected modules in order
    for (let i = 0; i < instances.length; i++) {
      const instance = instances[i];

      try {
        // Pass data through connection
        currentData = await instance.processIncoming(currentData, {
          connectionId: connection.id,
          position: i,
          totalModules: instances.length
        });
      } catch (error) {
        // Connection level error handling (fail fast with full context)
        const structuredError = new V2ConnectionError(
          `Connection failed at position ${i} in chain ${connection.id}`,
          {
            connectionId: connection.id,
            position: i,
            moduleType: instances[i]?.type,
            moduleId: instances[i]?.id,
            originalError: error.message,
            timestamp: new Date().toISOString()
          }
        );

        // Log detailed error information
        logger.error('V2 connection error', {
          error: structuredError.toJSON(),
          requestId: connection.metadata?.requestId,
          routeId: connection.metadata?.routeId
        });

        // Fail fast - no recovery attempts
        throw structuredError;
      }
    }

    return currentData as PipelineResponse;
  }

  // Disconnect connection (keep instances)
  private async disconnectModules(connection: ModuleConnection): Promise<void> {
    // Only disconnect, don't destroy instances
    for (const instanceConnection of connection.connections) {
      await this.breakConnection(instanceConnection);
    }
  }

  // Break single connection
  private async breakConnection(connection: InstanceConnection): Promise<void> {
    // Clear output target
    connection.from.clearOutputTarget();

    // Clear input source
    connection.to.clearInputSource();

    // Disconnect notification
    await connection.onDisconnect();
  }
}
```

#### 2.2 Connection State Management

```typescript
// src/modules/pipeline/v2/core/module-connection.ts
export class ModuleConnection {
  constructor(
    public readonly id: string,
    public readonly instances: ModuleInstance[],
    public readonly connections: InstanceConnection[]
  ) {}

  // Connection status query
  getConnectionStatus(): ConnectionStatus {
    return {
      id: this.id,
      instanceCount: this.instances.length,
      connectionCount: this.connections.length,
      allConnected: this.connections.every(c => c.isConnected()),
      establishedAt: this.connections[0]?.establishedAt,
      metadata: this.getMetadata()
    };
  }

  // Get connection metadata
  private getMetadata(): Record<string, any> {
    return {
      modules: this.instances.map(i => ({
        id: i.id,
        type: i.type,
        healthy: i.isHealthy()
      })),
      connections: this.connections.map(c => ({
        from: c.from.id,
        to: c.to.id,
        connected: c.isConnected(),
        latency: c.getLatency()
      }))
    };
  }
}

export class InstanceConnection {
  private isConnectedFlag = false;
  private establishedAt?: number;
  private latency = 0;

  constructor(
    public readonly from: ModuleInstance,
    public readonly to: ModuleInstance,
    public readonly options: ConnectionOptions
  ) {}

  // Connection ready callback
  async onConnect(): Promise<void> {
    this.isConnectedFlag = true;
    this.establishedAt = Date.now();

    // Trigger connection establishment event
    await this.from.onConnected?.(this.to);
    await this.to.onConnected?.(this.from);
  }

  // Disconnect callback
  async onDisconnect(): Promise<void> {
    this.isConnectedFlag = false;

    // Trigger connection disconnection event
    await this.from.onDisconnected?.(this.to);
    await this.to.onDisconnected?.(this.from);
  }

  // Check connection status
  isConnected(): boolean {
    return this.isConnectedFlag &&
           this.from.isHealthy() &&
           this.to.isHealthy();
  }

  // Get connection latency
  getLatency(): number {
    return this.latency;
  }
}
```

### 3. V1/V2 Switch Mechanism

#### 3.1 Gradual Switch

```typescript
// src/core/v1-v2-switch.ts
export class V1V2ModeSwitch {
  private currentMode: 'v1' | 'v2' = 'v1';
  private v1Assembler?: V1PipelineAssembler;
  private v2Assembler?: V2PipelineAssembler;
  private dynamicConnector?: DynamicConnector;

  // Gradual mode switch
  async gradualSwitch(targetMode: 'v1' | 'v2', options: SwitchOptions = {}): Promise<SwitchReport> {
    const report: SwitchReport = {
      from: this.currentMode,
      to: targetMode,
      startTime: Date.now(),
      steps: [],
      success: false,
      error: undefined
    };

    try {
      if (targetMode === 'v2' && this.currentMode === 'v1') {
        // V1 → V2 switch process
        await this.switchToV2(report, options);
      } else if (targetMode === 'v1' && this.currentMode === 'v2') {
        // V2 → V1 switch process
        await this.switchToV1(report, options);
      }

      report.success = true;
      this.currentMode = targetMode;

    } catch (error) {
      report.error = error.message;

      // Manual rollback only - no auto fallback
      if (options.manualRollback) {
        await this.executeManualRollback(report);
      }

      // Fail fast - expose problem immediately
      throw new Error(`V2 switch failed: ${error.message}. Manual intervention required.`);
    }

    report.endTime = Date.now();
    report.duration = report.endTime - report.startTime;

    return report;
  }

  // V1 → V2 switch
  private async switchToV2(report: SwitchReport, options: SwitchOptions): Promise<void> {
    // Step 1: Initialize V2 assembler
    report.steps.push('initializing-v2-assembler');
    this.v2Assembler = new V2PipelineAssembler(
      new StaticInstancePool(),
      new V2ConfigValidator()
    );

    // Step 2: Migrate configuration and prerun validation
    report.steps.push('migrating-and-validating-config');
    const v2Assembled = await this.v2Assembler.assemble(this.getCurrentConfig());

    if (!v2Assembled.isReady) {
      throw new Error('V2 pre-run validation failed');
    }

    // Step 3: Initialize dynamic connector
    report.steps.push('initializing-dynamic-connector');
    this.dynamicConnector = new DynamicConnector();

    // Step 4: Verify V2 compatibility (optional)
    if (options.validateCompatibility) {
      report.steps.push('validating-v2-compatibility');
      await this.validateV2Compatibility(v2Assembled);
    }

    // Step 5: Gradual traffic switch (if enabled)
    if (options.trafficShift) {
      report.steps.push('gradual-traffic-shift');
      await this.gradualTrafficShift(v2Assembled, options);
    }
  }

  // Request handling (auto route to current mode)
  async handleRequest(request: PipelineRequest): Promise<PipelineResponse> {
    if (this.currentMode === 'v1') {
      return this.v1Assembler!.handleRequest(request);
    } else {
      return this.dynamicConnector!.handleRequest(
        request,
        this.v2Assembler!.getV2Config(),
        this.v2Assembler!.getStaticInstancePool()
      );
    }
  }

  // Verify V2 compatibility
  private async validateV2Compatibility(v2Assembled: V2AssembledPipelines): Promise<void> {
    // Use same request to execute in both V1 and V2 modes
    // Compare results to ensure compatibility
    const testRequests = this.generateCompatibilityTestRequests();

    for (const testRequest of testRequests) {
      const v1Response = await this.v1Assembler!.handleRequest(testRequest);
      const v2Response = await this.dynamicConnector!.handleRequest(
        testRequest,
        v2Assembled.v2Config,
        v2Assembled.staticInstancePool
      );

      // Compare responses
      const compatibility = this.compareResponses(v1Response, v2Response);
      if (!compatibility.compatible) {
        throw new Error(`V2 compatibility issue: ${compatibility.differences.join(', ')}`);
      }
    }
  }
}
```

### 4. Configuration Validation and Prerun Tools

#### 4.1 Prerun Validation Tools

```typescript
// src/tools/pre-run-validator.ts
export class PreRunValidator {
  // Comprehensive prerun validation
  async validateV2Setup(v2Config: V2SystemConfig): Promise<ValidationReport> {
    const report: ValidationReport = {
      configValidation: await this.validateConfig(v2Config),
      instanceValidation: await this.validateInstances(v2Config),
      routeValidation: await this.validateRoutes(v2Config),
      dataFlowValidation: await this.validateDataFlow(v2Config),
      performanceValidation: await this.validatePerformance(v2Config)
    };

    return report;
  }

  // Route validation
  private async validateRoutes(v2Config: V2SystemConfig): Promise<RouteValidationResult> {
    const results: RouteTestResult[] = [];

    for (const route of v2Config.virtualPipelines.routeTable.routes) {
      const result = await this.testRoute(route);
      results.push(result);
    }

    return {
      totalRoutes: results.length,
      successfulRoutes: results.filter(r => r.success).length,
      failedRoutes: results.filter(r => !r.success),
      results
    };
  }

  // Data flow validation
  private async validateDataFlow(v2Config: V2SystemConfig): Promise<DataFlowValidationResult> {
    const testData = this.generateTestData();
    const results: DataFlowTestResult[] = [];

    for (const test of testData) {
      // Simulate complete request-response flow
      const result = await this.simulateCompleteFlow(test, v2Config);
      results.push(result);
    }

    return {
      totalTests: results.length,
      successfulTests: results.filter(r => r.success).length,
      failedTests: results.filter(r => !r.success),
      results
    };
  }
}
```

## 🎯 Key Advantages

### Migration Advantages
1. **Zero Configuration Migration**: V1 configuration auto-converts to V2 static instance configuration
2. **Prerun Validation**: Verify all routes and data flow compatibility before switching
3. **Gradual Switch**: Support gradual traffic switching, can rollback anytime
4. **Compatibility Guarantee**: V2 and V1 results completely identical validation

### Performance Advantages
1. **Only Add Connection**: Switch process only adds connections, no reassembly or reinitialization
2. **Static Instances**: All modules preloaded, zero cold start latency
3. **Lightweight Connection**: Temporary connection establishment/disconnection overhead is minimal
4. **Instance Reuse**: Same configuration shared instances between different routes

### Operations Advantages
1. **Visualization Validation**: Prerun report clearly shows compatibility status
2. **Complete Monitoring**: Connection status, instance status, performance metrics full coverage
3. **Fault Isolation**: Single connection failure doesn't affect overall system
4. **Fast Rollback**: Can immediately switch back to V1 mode when problems found

This design ensures V2 and V1 seamless migration while guaranteeing zero-risk switching through prerun validation mechanism.