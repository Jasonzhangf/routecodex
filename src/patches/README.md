# 补丁模块

## 功能
- Provider补丁管理
- OpenAI兼容性补丁
- 响应格式转换

## 文件说明
- `patch-manager.ts`: 补丁管理器，负责加载和管理各种Provider补丁，支持ESM动态导入
- `openai-patch.ts`: OpenAI兼容性补丁，处理不同Provider的响应格式转换，确保统一输出

## 依赖关系
- 被 `core/request-handler.ts` 调用
- 被 `core/response-handler.ts` 调用
- 依赖 `utils/logger.ts` 进行补丁应用日志
- 支持 `providers/base-provider.ts` 的补丁机制

## 使用示例
```typescript
import { PatchManager } from './patch-manager';
import { OpenAIPatch } from './openai-patch';

const patchManager = new PatchManager();
const openaiPatch = new OpenAIPatch();

await patchManager.registerPatch('openai', openaiPatch);
const patchedResponse = await patchManager.applyPatch(response, 'openai');
```