# Release Install Closeout Plan

## 1. 目标与验收标准

目标：把 release/install 链路收口为“独立构建真源 + 独立安装真源 + 依赖自检/自动准备 + 安装后真实启动验证”，并清理误导性的旧脚本与未跟踪但已被主线引用的文件。

验收标准：

- `scripts/install-release.sh` 可在干净 checkout 场景独立完成依赖准备、构建、snapshot 安装、shim 安装。
- 安装成功判定不再只看 CLI 文件存在，必须包含一次真实 runtime 启动与 `/health` 通过。
- `scripts/install.sh`、`scripts/quick-install.sh` 这类旧实现被物理删除或显式 fail-fast 废弃，仓库只保留一个 release 安装真源。
- 所有已被源码、gate、文档直接引用的未跟踪文件被纳入版本控制；无主垃圾文件被清理。
- release/install 相关文档、脚本帮助、依赖约束保持一致，不再出现独立安装与 dev link 语义混淆。

## 2. 范围与边界

In Scope：

- `scripts/install-release.sh`
- `scripts/install-release-snapshot.mjs`
- `scripts/install-global.sh`
- `scripts/README.md`
- `package.json`
- release/install 直接依赖的脚本与文档
- 当前已发现的未跟踪但已被主线引用的文件

Out of Scope：

- provider/runtime 业务语义修复
- Hub Pipeline / Virtual Router 架构迁移
- 非 install/release 路径的通用 CLI 重构

## 3. 设计原则

1. release 安装只能有一个 owner 脚本，禁止保留第二套等价安装实现。
2. 安装链必须 fail-fast；缺依赖、构建失败、启动失败、健康检查失败都必须显式报错。
3. release 安装与 dev global link 语义必须分离；不得把 link 本地仓库当作独立安装成功。
4. 成功标准必须包含真实运行体证据，不能只看文件落地或命令可执行。
5. 清理旧脚本与未跟踪文件时必须有引用证据或无引用证据，禁止凭感觉保留。

## 4. 技术方案

### Phase 1：未跟踪文件收口

处理当前已确认被主线引用的文件：

- `docs/goals/config-ssot-function-map-closeout-plan.md`
- `sharedmodule/llmswitch-core/rust-core/crates/servertool-core/src/stop_message_persist_plan.rs`
- `src/config/provider-config-writer.ts`
- `src/config/user-config-writer.ts`
- `tests/config/config-writer.spec.ts`
- `tests/config/unified-config-paths.spec.ts`
- `tests/server/handlers/handler-response-utils.responses-keepalive-ping.spec.ts`

要求：

- 被源码、gate、文档直接引用的文件必须纳入跟踪。
- 若发现无引用旧文件，按证据清理。

### Phase 2：release 安装脚本独立化

改造 `scripts/install-release.sh`：

- 使用隔离构建目录，不污染仓库根目录产物判定。
- 自动准备依赖：优先 `npm ci`，必要时回退到符合策略的 `npm install` 仅用于依赖缺失场景的明确补齐。
- 在隔离构建目录执行 `BUILD_MODE=release ROUTECODEX_SKIP_AUTO_BUMP=1 npm run build:min`。
- 执行 `node scripts/install-release-snapshot.mjs` 完成 snapshot 安装。
- 执行 `ROUTECODEX_SHIM_PREFER_RELEASE_SNAPSHOT=1 node scripts/ensure-cli-command-shim.mjs` 安装 shim。

### Phase 3：真实安装后 smoke

安装后必须执行最小 runtime 验证：

- 使用 `routecodex restart --port <verify-port>` 启动真实运行体。
- 轮询 `http://127.0.0.1:<verify-port>/health`。
- 验证 `status=ok`、`ready=true`、`pipelineReady=true`。

若失败：

- 直接 fail-fast 输出具体阶段，不做 fallback 成功判定。

### Phase 4：旧脚本物理删除或废弃

审计并处理：

- `scripts/install.sh`
- `scripts/quick-install.sh`

要求：

- 若已不符合当前 snapshot/install 体系，则物理删除。
- 若存在保留必要性，必须改为显式 fail-fast 并在 README 中说明“非真源，不可用”。
- 更新 `scripts/README.md` 与相关帮助文本，避免多实现并存。

### Phase 5：一致性与依赖约束收口

检查并对齐：

- `package.json` `engines.node`
- `install-global.sh` Node 版本检查
- `install-release.sh` Node 版本检查
- release/install 帮助文案

目标：

- 不再出现 `package.json` 与脚本各说各话。
- 不再把 dev link 语义描述为独立安装。

## 5. 风险与规避

风险：真实 restart smoke 会影响当前本机端口服务。
规避：只操作用户明确授权的端口；使用 `routecodex restart --port <port>`，禁止 broad kill。

风险：隔离构建目录遗漏必要文件导致安装失败。
规避：以 `install-global.sh` 的 pack/build 真源为参考，只复制必要脚本与 package 输入。

风险：删除旧脚本后仍有文档或命令引用。
规避：先 `rg` 审计引用，再删除并同步更新 README/package scripts。

风险：Node 版本策略不一致导致安装期误判。
规避：以 `package.json engines` 为真源，对脚本校验统一收口。

## 6. 测试计划

静态审计：

- `git status --short --untracked-files=all`
- `rg` 检查旧脚本引用与 release/install 入口唯一性

Gate / Build：

- `npm run verify:repo-sanity`
- `npx tsc --noEmit --pretty false`

Install / Smoke：

- `scripts/install-release.sh`
- `routecodex restart --port 5520`
- `curl http://127.0.0.1:5520/health`

必要时补 focused tests：

- release/install 脚本相关 shell 行为断言
- 依赖检查与失败路径断言

## 7. 实施步骤

1. 审计并确认所有未跟踪文件的引用归属，纳入跟踪或清理。
2. 审计 `install-release.sh` 当前缺口，并以 `install-global.sh` / snapshot 安装链为真源设计独立安装流。
3. 改造 `install-release.sh`，补依赖自检、隔离构建目录、build/min、snapshot 安装、shim 安装。
4. 审计并删除或显式废弃 `scripts/install.sh`、`scripts/quick-install.sh`。
5. 更新 `scripts/README.md` 与相关帮助文案、Node 版本口径。
6. 跑 `verify:repo-sanity` 与 `tsc`。
7. 执行真实 `install-release.sh`、`routecodex restart --port 5520`、`/health` 验证。
8. 若全部通过，整理 `note.md` / `MEMORY.md`，再提交本次变更。

## 8. 完成定义

满足以下条件才可宣称完成：

- release/install 真源唯一，旧实现已删除或显式废弃。
- `install-release.sh` 可独立完成构建与安装。
- 安装成功标准包含真实启动与 `/health` 成功。
- 未跟踪但被主线引用的文件已全部纳入版本控制。
- `verify:repo-sanity`、`npx tsc --noEmit --pretty false`、真实安装 smoke 全部通过。
