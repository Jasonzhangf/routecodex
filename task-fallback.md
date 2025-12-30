# Task: 消灭静默失败和 Fallback 回退违规
**状态**: In Progress  
**开始日期**: 2024-12-29  
**目标**: 消除所有违反 V2 错误处理规范的静默失败代码

## Phase 1: Tools 目录修复 (18 处)
### 任务清单
- [ ] `src/tools/semantic-replay.ts` - 8 处静默失败
- [ ] `src/tools/provider-update/blacklist.ts` - 2 处静默失败  
- [ ] `src/tools/provider-update/fetch-models.ts` - 5 处静默失败
- [ ] `src/tools/provider-update/index.ts` - 3 处静默失败

### 完成标准
- [ ] 所有空 catch 块添加错误日志或重新抛出
- [ ] 使用 `console.warn()` 或 `console.error()` 记录可恢复错误
- [ ] 不可恢复错误抛出异常，调用者处理

## Phase 2: Providers Core Runtime 修复 (12 处)
### 任务清单
- [ ] `src/providers/core/runtime/http-transport-provider.ts` - 5 处静默失败
- [ ] `src/providers/core/runtime/responses-provider.ts` - 2 处静默失败
- [ ] `src/providers/core/runtime/gemini-cli-http-provider.ts` - 2 处静默失败
- [ ] `src/providers/core/runtime/vision-debug-utils.ts` - 3 处静默失败

### 完成标准
- [ ] Provider 层错误调用 `emitProviderError()`
- [ ] 遵循 Fail-Fast 原则，不吞掉关键错误

## Phase 3: Auth 模块修复 (6 处)
### 任务清单
- [ ] `src/providers/auth/oauth-lifecycle.ts` - 4 处静默失败
- [ ] `src/providers/auth/tokenfile-auth.ts` - 2 处静默失败

### 完成标准
- [ ] OAuth 流程错误正确传播
- [ ] Token 相关操作有适当日志记录

## Phase 4: Core & Config 修复 (7 处)
### 任务清单
- [ ] `src/core/provider-health-manager.ts` - 2 处静默失败
- [ ] `src/config/auth-file-resolver.ts` - 3 处静默失败
- [ ] `src/config/unified-config-paths.ts` - 2 处静默失败

### 完成标准
- [ ] 配置加载错误有适当处理
- [ ] 健康检查失败正确记录和报告

## 验证步骤
1. 运行 `npm run build:dev` 确保无编译错误
2. 执行相关测试用例确保功能正常
3. 审查代码确保所有 catch 块有适当处理
4. 更新 `docs/ERROR_HANDLING_AUDIT.md` 标记已修复项

## 参考文档
- `docs/ERROR_HANDLING_AUDIT.md` - 详细违规清单
- `AGENTS.md` 第 4 节 - Error Reporting 规范
