# 服务器模块

## 功能
- HTTP服务器实现
- OpenAI API路由处理
- 请求/响应类型定义

## 文件说明
- `http-server.ts`: HTTP服务器实现，处理HTTP请求和响应，基于Express.js
- `openai-router.ts`: OpenAI API路由处理，将OpenAI请求转发到Provider，支持动态路由
- `types.ts`: 服务器相关的类型定义，包括请求和响应格式，ESM兼容类型声明

## 依赖关系
- 依赖 `core/request-handler.ts` 处理业务逻辑
- 依赖 `core/response-handler.ts` 处理响应格式化
- 依赖 `utils/logger.ts` 进行日志记录

## 使用示例
```typescript
import { HttpServer } from './http-server';
import { OpenAIRouter } from './openai-router';

const server = new HttpServer();
const router = new OpenAIRouter();
await server.start();
```