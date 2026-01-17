# CI/CD 任务进度与模块修复记录

## 当前任务状态 (2026-01-17)

### ✅ 已完成：Session ID 回传
- HTTP 成功响应路径：`src/server/runtime/http-server/index.ts`
- HTTP 错误响应路径：`src/server/handlers/handler-utils.ts`
- 回传 header: `session_id`, `conversation_id`（SSE + JSON 路径覆盖）

### 🔧 当前优先任务：Host CI 失败修复

#### 根因：测试引用 sharedmodule 绝对路径，CI 环境无 sharedmodule 源码
- 失败样例：
  - `tests/servertool/virtual-router-quota-routing.spec.ts`
  - `tests/servertool/virtual-router-series-cooldown.spec.ts`
  - `tests/server/runtime/request-executor.single-attempt.spec.ts`

#### 解决策略：Host 测试统一使用 release 模式的 @jsonstudio/llms
- ✅ CI 已强制 `BUILD_MODE=release npm run llmswitch:ensure`
- ✅ jest 配置新增 moduleNameMapper，将 sharedmodule 源码路径映射到 npm 包
  - `../../sharedmodule/llmswitch-core/src/* → @jsonstudio/llms/dist/*`
  - `../../../../sharedmodule/llmswitch-core/dist/* → @jsonstudio/llms/dist/*`

#### 本地验证
- ✅ `npm run test:routing-instructions` 通过

---

## 下一阶段：Lint Warning 修复（模块逐步推进）

### 当前模块：`src/server/**`
- ✅ 已修复部分 mixed-tabs、unused imports
- ⛳️ 目标：清零 server 模块 warnings
- 现存 warning 需要继续清理：
  - `src/server/runtime/http-server/routes.ts`（any 类型）
  - `src/server/runtime/http-server/stats-manager.ts`（any 类型）
  - `src/server/runtime/http-server/request-executor.ts`（unused var）
  - `src/server/utils/utf8-chunk-buffer.ts`（var-requires）
  - `src/server/utils/warmup-storm-tracker.ts`（unused var）

### 后续模块修复顺序（按模块逐步推进）
1. `src/server/**`
2. `src/providers/**`
3. `src/config/**`
4. `src/tools/** + src/commands/**`
5. `sharedmodule/llmswitch-core`（独立 CI）

---

## 说明
- Host CI 必须使用 release 模式的 @jsonstudio/llms（不依赖 sharedmodule 源码）
- Sharedmodule CI 由 llmswitch-core 仓库独立运行
- 每个模块 lint 清理完成后再推进下一个模块
