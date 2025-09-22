# 服务器模块 (Server Module)

## 功能概述
服务器模块提供RouteCodex的HTTP服务器和API路由功能。它实现了完整的OpenAI兼容API，支持请求路由、响应处理和错误管理。

## 核心特性

### 🌐 HTTP服务器
- **Express.js基础**: 基于Express.js的高性能HTTP服务器
- **中间件支持**: 支持各种Express中间件
- **CORS支持**: 完整的跨域资源共享支持
- **请求限制**: 可配置的请求大小和超时限制

### 🔗 API路由
- **OpenAI兼容**: 完全兼容OpenAI Chat Completions API
- **动态路由**: 智能请求路由和分发
- **协议转换**: 支持不同协议间的转换
- **错误处理**: 统一的错误处理和响应格式

### 📊 类型安全
- **TypeScript支持**: 完整的TypeScript类型定义
- **ESM兼容**: 纯ESM模块系统
- **接口定义**: 标准化的请求和响应接口
- **验证机制**: 请求参数验证和类型检查

### 🔧 配置管理
- **灵活配置**: 支持多种配置方式
- **热重载**: 配置变更时自动重载
- **环境变量**: 支持环境变量配置
- **默认值**: 合理的默认配置值

## 文件结构

### 核心文件
- `http-server.ts`: HTTP服务器实现
- `openai-router.ts`: OpenAI API路由处理
- `types.ts`: 服务器相关类型定义

### 文件说明

#### `http-server.ts`
**用途**: HTTP服务器主实现
**功能**:
- HTTP服务器创建和管理
- 中间件集成和配置
- 请求处理和响应分发
- 错误处理和日志记录

**关键类**:
- `HttpServer`: HTTP服务器类

#### `openai-router.ts`
**用途**: OpenAI API路由处理
**功能**:
- OpenAI兼容API路由
- 请求验证和解析
- 响应格式化和转换
- 错误处理和状态管理

**关键类**:
- `OpenAIRouter`: OpenAI路由器类

#### `types.ts`
**用途**: 类型定义和接口
**功能**:
- 请求和响应类型定义
- 服务器配置接口
- 错误类型定义
- 工具类型和辅助函数

## 依赖关系
```
server/
├── 依赖 core/ - 业务逻辑处理
├── 依赖 modules/ - 模块配置
├── 依赖 config/ - 配置管理
└── 依赖 utils/ - 工具函数
```

## 使用示例

### 基础服务器启动
```typescript
import { HttpServer } from './http-server';
import { OpenAIRouter } from './openai-router';

const server = new HttpServer();
const router = new OpenAIRouter();

// 启动服务器
await server.start({
  port: 5508,
  host: '0.0.0.0',
  cors: {
    origin: '*',
    credentials: true
  }
});

console.log('Server running on port 5508');
```

### 配置化启动
```typescript
import { HttpServer } from './http-server';

const server = new HttpServer();

// 使用模块配置启动
await server.start({
  port: 8080,
  host: '0.0.0.0',
  cors: {
    origin: '*',
    credentials: true
  },
  timeout: 30000,
  bodyLimit: '10mb',
  debug: true
});
```

### 集成虚拟路由器
```typescript
import { HttpServer } from './http-server';
import { VirtualRouterModule } from '../modules/virtual-router/virtual-router-module';

const virtualRouter = new VirtualRouterModule();
await virtualRouter.initialize(routerConfig);

const server = new HttpServer();
await server.start({
  port: 5508,
  virtualRouter: virtualRouter
});
```

## 配置选项

### 服务器配置
```typescript
interface ServerConfig {
  port: number;                    // 服务器端口
  host?: string;                   // 服务器主机
  cors?: CorsOptions;              // CORS配置
  timeout?: number;                // 请求超时时间
  bodyLimit?: string | number;     // 请求体大小限制
  debug?: boolean;                 // 调试模式
  trustProxy?: boolean;            // 信任代理
  https?: HttpsOptions;           // HTTPS配置
}
```

### CORS配置
```typescript
interface CorsOptions {
  origin?: string | RegExp | Array<string | RegExp>;
  credentials?: boolean;
  methods?: string[];
  allowedHeaders?: string[];
  exposedHeaders?: string[];
  maxAge?: number;
}
```

## API端点

### OpenAI兼容端点
- `POST /v1/chat/completions`: 聊天完成接口
- `GET /v1/models`: 模型列表接口
- `POST /v1/embeddings`: 嵌入向量接口

### 管理端点
- `GET /health`: 健康检查
- `GET /metrics`: 性能指标
- `GET /config`: 当前配置
- `POST /reload`: 重载配置

## 错误处理

### 标准错误响应
```typescript
interface ErrorResponse {
  error: {
    message: string;
    type: string;
    code?: string;
    param?: string;
  };
}
```

### 错误类型
- `invalid_request_error`: 无效请求
- `authentication_error`: 认证错误
- `permission_error`: 权限错误
- `not_found_error`: 资源未找到
- `rate_limit_error`: 速率限制
- `api_error`: API错误
- `overloaded_error`: 服务器过载

## 中间件支持

### 内置中间件
- **CORS**: 跨域资源共享
- **Body Parser**: 请求体解析
- **Rate Limiting**: 速率限制
- **Authentication**: 身份认证
- **Logging**: 请求日志

### 自定义中间件
```typescript
import { HttpServer } from './http-server';

const server = new HttpServer();

// 添加自定义中间件
server.use((req, res, next) => {
  console.log('Request:', req.method, req.path);
  next();
});

// 添加错误处理中间件
server.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});
```

## 性能优化

### 连接管理
- **Keep-Alive**: HTTP Keep-Alive支持
- **连接池**: 数据库连接池管理
- **超时控制**: 请求和响应超时控制
- **资源释放**: 自动资源清理和释放

### 缓存机制
- **响应缓存**: 智能响应缓存
- **配置缓存**: 配置文件缓存
- **路由缓存**: 路由决策缓存
- **静态文件**: 静态文件缓存

### 监控和指标
- **请求计数**: 请求数量统计
- **响应时间**: 响应时间监控
- **错误率**: 错误率统计
- **资源使用**: CPU和内存使用监控

## 安全特性

### 输入验证
- **参数验证**: 请求参数验证
- **类型检查**: 类型安全检查
- **大小限制**: 请求大小限制
- **格式验证**: 格式验证

### 访问控制
- **身份认证**: API密钥认证
- **权限控制**: 基于角色的访问控制
- **IP白名单**: IP地址过滤
- **速率限制**: 请求速率限制

### 数据保护
- **HTTPS**: HTTPS加密传输
- **敏感数据**: 敏感数据保护
- **日志安全**: 安全日志记录
- **错误信息**: 安全错误信息

## 最佳实践

### 配置管理
1. **环境配置**: 使用环境变量配置不同环境
2. **敏感信息**: 敏感信息使用环境变量或密钥管理
3. **配置验证**: 启动时验证配置的正确性
4. **配置备份**: 定期备份重要配置

### 性能优化
1. **连接管理**: 合理配置连接池和Keep-Alive
2. **缓存策略**: 根据业务需求配置缓存
3. **资源监控**: 监控服务器资源使用情况
4. **负载均衡**: 使用负载均衡器分发请求

### 安全加固
1. **HTTPS**: 生产环境必须使用HTTPS
2. **认证**: 实现严格的API认证
3. **输入验证**: 验证所有用户输入
4. **日志记录**: 记录安全相关事件

## 故障排除

### 常见问题
1. **端口占用**: 检查端口是否被其他进程占用
2. **配置错误**: 检查配置文件格式和内容
3. **权限问题**: 检查文件和网络权限
4. **内存泄漏**: 监控内存使用情况

### 调试技巧
```typescript
// 启用调试模式
const server = new HttpServer({
  debug: true,
  logLevel: 'debug'
});

// 查看服务器状态
const status = server.getStatus();
console.log('Server status:', status);

// 获取性能指标
const metrics = server.getMetrics();
console.log('Performance metrics:', metrics);
```

### 日志分析
```typescript
// 查看错误日志
const errorLogs = server.getErrorLogs();
errorLogs.forEach(log => {
  console.log('Error:', log.message);
  console.log('Time:', log.timestamp);
});

// 查看访问日志
const accessLogs = server.getAccessLogs();
accessLogs.forEach(log => {
  console.log('Access:', log.method, log.path, log.status);
});
```

## 版本信息
- **当前版本**: v2.0 (Configuration System Refactor)
- **构建状态**: ✅ ESM兼容，✅ 测试通过，✅ 生产就绪
- **API兼容**: ✅ OpenAI兼容，✅ 标准接口
- **性能评级**: ⚡ 优秀 (高并发支持)