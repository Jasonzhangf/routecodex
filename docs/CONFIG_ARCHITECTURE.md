# RouteCodex 配置系统架构设计

## 1. 系统架构概述

### 1.1 配置层次结构
```
用户配置层 (~/.routecodex/config.json)
    ↓
系统模块默认 (./config/modules.json)
    ↓
配置解析器 (routecodex-config-loader)
    ↓
虚拟路由引导 (bootstrapVirtualRouterConfig)
    ↓
VirtualRouterArtifacts (virtualRouter + targetRuntime)
    ↓
模块初始化 (Hub Pipeline + Provider Runtime)
```

### 1.2 核心设计原则
1. **用户优先**: 用户配置覆盖系统默认配置
2. **模块化**: 每个模块独立配置，支持深度合并
3. **协议兼容**: 支持OpenAI和Anthropic协议输入/输出
4. **密钥安全**: 支持AuthFile机制，密钥存储在用户目录
5. **路由灵活**: 支持多目标负载均衡和协议转换

## 2. 配置文件结构

### 2.1 用户配置文件 (~/.routecodex/config.json)

```json
{
  "version": "1.0.0",
  "description": "RouteCodex User Configuration",
  "user": {
    "name": "Default User",
    "email": "user@example.com"
  },

  "virtualrouter": {
    "inputProtocol": "openai",    // openai | anthropic
    "outputProtocol": "openai",   // openai | anthropic

    "providers": {
      "openai": {
        "type": "openai",
        "baseURL": "https://api.openai.com/v1",
        "apiKey": [
          "sk-your-openai-key-here",
          "authfile-openai-main",
          "authfile-openai-backup"
        ],
        "models": {
          "gpt-4": {
            "maxContext": 128000,  // 可选，不配置使用默认值
            "maxTokens": 32000     // 可选，不配置使用默认值
          }
        }
      }
    },

    "routing": {
      "default": [
        "openai.gpt-4.sk-your-openai-key-here",
        "openai.gpt-4.authfile-openai-main"
      ],
      "longContext": [
        "anthropic.claude-3-5-sonnet-20241022.sk-ant-your-anthropic-key-here"
      ]
    }
  },

  "httpserver": {
    "port": 8080,
    "host": "0.0.0.0"
  }
}
```

#### 2.1.1 Provider `process` 模式
- `process` 是 provider 节点的顶层字段，控制 RouteCodex 是否需要介入编解码。
- 取值 `chat`（默认）：进入 Chat → Virtual Router → Provider 的标准链路，允许跨协议转换（如 `/v1/messages` → Responses）。
- 取值 `passthrough`：RouteCodex 仅负责路由/鉴权/日志，**请求与响应会原样透传**。为了避免协议错配，要求入口协议必须与 provider 类型一致（例如 providerType=`responses` 只能在 `/v1/responses` 入口透传），否则启动时直接抛错。
- Passthrough 模式仍然会写入 `client-request` / `provider-request` / `provider-response` 快照，便于审计，但不会再注入模型、stream、instruction 等治理字段。

### 2.2 系统模块默认 (./config/modules.json)

```json
{
  "modules": {
    "virtualrouter": {
      "enabled": true,
      "config": {
        "moduleType": "virtual-router",
        "timeout": 30000,
        "inputProtocol": "openai",
        "outputProtocol": "openai",
        "userConfigDefaults": {
          "maxContext": 128000,
          "maxTokens": 32000
        }
      }
    },
    "httpserver": {
      "enabled": true,
      "config": {
        "moduleType": "http-server",
        "port": 5506,
        "host": "localhost"
      }
    }
  }
}
```

### 2.3 虚拟路由产物 (VirtualRouterArtifacts)

`bootstrapVirtualRouterConfig` 输出对象包含两部分：

```ts
type VirtualRouterArtifacts = {
  config: {
    routing: Record<string, Array<{ providerKey: string; weight?: number }>>;
    providers: Record<string, any>;
    classifiers?: Record<string, any>;
  };
  targetRuntime: Record<string, ProviderRuntimeProfile>;
};
```

- `config`: 由 Hub Pipeline 消费，包含虚拟路由、分类器、provider 描述等。
- `targetRuntime`: host 初始化 Provider 实例所需的资料（baseUrl、headers、auth、compatProfile、runtimeKey）。

该对象在内存中直接传递，**不再写入旧版“合并配置”蓝图文件**。任何磁盘快照仅用于调试，不参与运行时决策。

## 3. 配置解析和合并机制

### 3.1 用户配置解析

#### 3.1.1 路由字符串解析
```typescript
// 路由字符串格式: "provider.model.key"
const routeString = "openai.gpt-4.sk-your-openai-key-here";

// 解析结果
interface RouteTarget {
  providerId: string;
  modelId: string;
  keyId: string;
  actualKey: string;
  inputProtocol: "openai" | "anthropic";
  outputProtocol: "openai" | "anthropic";
}
```

#### 3.1.2 AuthFile解析
```typescript
// AuthFile格式: "authfile-{filename}"
// 密钥文件位置: ~/.routecodex/auth/{filename}
interface AuthFileResolver {
  resolveAuthKey(keyId: string): string;
}
```

#### 3.1.3 模型配置补充
```typescript
// 用户配置 + 系统默认值 = 完整配置
interface ModelConfig {
  maxContext: number;  // 用户配置或系统默认(128000)
  maxTokens: number;   // 用户配置或系统默认(32000)
}
```

### 3.2 配置合并策略

#### 3.2.1 深度合并
```typescript
interface ConfigMerger {
  merge(
    systemConfig: ModulesConfig,
    userConfig: UserConfig
  ): MergedConfig;
}
```

#### 3.2.2 优先级规则
1. 用户配置 > 系统默认配置
2. 具体配置 > 通用配置
3. 运行时配置 > 文件配置

### 3.3 虚拟路由配置生成

#### 3.3.1 路由目标池表
```typescript
interface RouteTargetPool {
  [routeName: string]: RouteTarget[];
}

// 用途: 路由器快速查找目标
{
  "default": [
    {
      "providerId": "openai",
      "modelId": "gpt-4",
      "keyId": "sk-your-openai-key-here",
      "actualKey": "sk-your-openai-key-here",
      "inputProtocol": "openai",
      "outputProtocol": "openai"
    }
  ]
}
```

#### 3.3.2 流水线配置表
```typescript
interface PipelineConfigs {
  [providerModelKey: string]: PipelineConfig;
}

// 用途: 流水线执行详细配置
{
  "openai.gpt-4.sk-your-openai-key-here": {
    "provider": {
      "type": "openai",
      "baseURL": "https://api.openai.com/v1"
    },
    "model": {
      "maxContext": 128000,
      "maxTokens": 32000
    },
    "keyConfig": {
      "keyId": "sk-your-openai-key-here",
      "actualKey": "sk-your-openai-key-here"
    },
    "protocols": {
      "input": "openai",
      "output": "openai"
    }
  }
}
```

## 4. 模块适配

### 4.1 虚拟路由模块

#### 4.1.1 配置接口
```typescript
interface VirtualRouterConfig {
  routeTargets: RouteTargetPool;
  pipelineConfigs: PipelineConfigs;
  inputProtocol: "openai" | "anthropic";
  outputProtocol: "openai" | "anthropic";
  timeout: number;
}
```

#### 4.1.2 初始化流程
```typescript
class VirtualRouterModule {
  async initialize(config: VirtualRouterConfig): Promise<void> {
    // 1. 加载路由目标池
    this.routeTargetPool = config.routeTargets;

    // 2. 初始化流水线配置
    this.pipelineConfigs = config.pipelineConfigs;

    // 3. 设置协议转换
    this.protocolManager.setProtocols(
      config.inputProtocol,
      config.outputProtocol
    );
  }
}
```

### 4.2 配置管理模块

#### 4.2.1 配置文件管理
```typescript
class ConfigManagerModule {
  async loadVirtualRouterArtifacts(): Promise<VirtualRouterArtifacts> {
    const { userConfig } = await loadRouteCodexConfig();
    return bootstrapVirtualRouterConfig(userConfig.virtualrouter ?? userConfig);
  }
}
```

## 5. 密钥管理

### 5.1 AuthFile机制

#### 5.1.1 密钥文件位置
```
~/.routecodex/auth/
├── openai-main
├── openai-backup
└── anthropic-main
```

#### 5.1.2 密钥文件格式
```bash
# ~/.routecodex/auth/openai-main
sk-your-actual-openai-key-here

# ~/.routecodex/auth/anthropic-main
sk-ant-your-actual-anthropic-key-here
```

### 5.2 密钥安全

#### 5.2.1 文件权限
```bash
chmod 600 ~/.routecodex/auth/*
```

#### 5.2.2 密钥缓存
```typescript
interface KeyCache {
  get(keyId: string): string | null;
  set(keyId: string, value: string): void;
  clear(): void;
}
```

## 6. 协议支持

### 6.1 输入协议

#### 6.1.1 OpenAI协议
- 格式: OpenAI Chat Completions API
- 版本: v1
- 内容类型: application/json

#### 6.1.2 Anthropic协议
- 格式: Anthropic Messages API
- 版本: v1
- 内容类型: application/json

### 6.2 输出协议

#### 6.2.1 协议转换
```typescript
interface ProtocolConverter {
  convertOpenAItoAnthropic(request: OpenAIRequest): AnthropicRequest;
  convertAnthropicToOpenAI(request: AnthropicRequest): OpenAIRequest;
}
```

## 7. 负载均衡和容错

### 7.1 路由策略

#### 7.1.1 轮询策略
```typescript
interface RoundRobinStrategy {
  getNextTarget(routeName: string): RouteTarget;
}
```

#### 7.1.2 负载均衡
```typescript
interface LoadBalancer {
  selectTarget(targets: RouteTarget[]): RouteTarget;
  updateMetrics(targetId: string, success: boolean): void;
}
```

### 7.2 错误处理

#### 7.2.1 密钥失效处理
```typescript
interface KeyFailureHandler {
  handleKeyFailure(keyId: string): void;
  isKeyBlacklisted(keyId: string): boolean;
}
```

#### 7.2.2 目标切换
```typescript
interface TargetSwitcher {
  switchTarget(currentTarget: RouteTarget): RouteTarget;
  getAvailableTargets(routeName: string): RouteTarget[];
}
```

## 8. 实施计划

### Phase 1: 配置解析器
1. **UserConfigParser** - 解析用户配置
2. **AuthFileResolver** - 处理AuthFile
3. **RouteTargetParser** - 解析路由字符串

### Phase 2: 配置合并器
1. **ConfigMerger** - 合并系统配置和用户配置
2. **MergedConfigGenerator** - 生成合并后配置文件
3. **ConfigFileManager** - 管理配置文件

### Phase 3: 虚拟路由模块
1. **VirtualRouterModule** - 重构虚拟路由模块
2. **RouteTargetPool** - 路由目标池管理
3. **PipelineConfigManager** - 流水线配置管理

### Phase 4: 协议和密钥管理
1. **ProtocolManager** - 协议转换管理
2. **KeyManager** - 密钥管理和缓存
3. **LoadBalancer** - 负载均衡实现

### Phase 5: 测试和优化
1. **配置解析测试** - 验证配置正确性
2. **路由功能测试** - 验证路由逻辑
3. **性能优化** - 优化配置加载和路由性能

## 9. 配置示例

### 9.1 基础配置
```json
{
  "virtualrouter": {
    "providers": {
      "openai": {
        "apiKey": ["sk-your-key"],
        "models": {
          "gpt-4": {}
        }
      }
    },
    "routing": {
      "default": ["openai.gpt-4.sk-your-key"]
    }
  }
}
```

### 9.2 多供应商配置
```json
{
  "virtualrouter": {
    "providers": {
      "openai": {
        "apiKey": ["sk-openai-key"],
        "models": {
          "gpt-4": {}
        }
      },
      "anthropic": {
        "apiKey": ["sk-ant-key"],
        "models": {
          "claude-3-sonnet": {}
        }
      }
    },
    "routing": {
      "default": [
        "openai.gpt-4.sk-openai-key",
        "anthropic.claude-3-sonnet.sk-ant-key"
      ]
    }
  }
}
```

### 9.3 协议转换配置
```json
{
  "virtualrouter": {
    "inputProtocol": "anthropic",
    "outputProtocol": "openai",
    "providers": {
      "anthropic": {
        "apiKey": ["sk-ant-key"],
        "models": {
          "claude-3-sonnet": {}
        }
      }
    },
    "routing": {
      "default": ["anthropic.claude-3-sonnet.sk-ant-key"]
    }
  }
}
```
