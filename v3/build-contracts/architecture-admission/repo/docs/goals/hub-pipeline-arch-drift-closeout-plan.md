# Hub Pipeline 架构漂移收口计划

## 目标

为 Hub Pipeline 补 7 个架构 gate，堵住 function-map / mainline-call-map / wiki / build wiring 4 类漂移路径。

## 验收标准

| # | 缺口 | 验证 |
|---|------|------|
| A | build 不强制完整 CI | package.json build/build:min 含 `verify:architecture-ci` 或有显式分层 |
| C | mainline 无机器可读 manifest | `verify:architecture-mainline-manifest-sync` PASS |
| D | wiki 节点 ID vs call map 不一致 | `verify:architecture-wiki-node-id-sync` PASS |
| E | shared function binding pending 未校验 | `verify:architecture-shared-function-binding-status` PASS |
| F | required_tests 无反向引用校验 | `verify:function-map-test-file-coverage` PASS |
| G | topology 文档 vs code type 命名不一致 | `verify:architecture-topology-naming-guard` PASS |
| B | CI/longtail wiring 无注释 | `scripts/architecture/verify-function-map-build-wiring.mjs` 加注释 |

## 范围

- 只改 `scripts/architecture/`、`package.json`
- 不改业务代码、provider、llmswitch Rust
- 不改 function-map.yml / mainline-call-map.yml 内容

## 技术方案

### 新增 6 个 gate 脚本

#### 1. `verify-architecture-mainline-manifest-sync.mjs`
- 为 7 条 mainline chains 各生成轻量 manifest JSON（chain_id、nodes、owner_feature_id、wiki_page、required_gates）
- manifest 路径：`docs/architecture/mainline-manifests/<chain-id>.json`
- gate 校验：
  - 每个 manifest 的 `nodes`（from_node + to_node）必须与 mainline-call-map.yml 一致
  - `owner_feature_id` 必须在 function-map.yml 存在
  - `wiki_page` 必须在 wiki 目录存在
  - `required_gates` 每个必须对应 package.json script
- 复用现有 `mainline-call-map-lib.mjs` 的 parser，不重写 YAML 读取

#### 2. `verify-architecture-wiki-node-id-sync.mjs`
- 解析 `docs/architecture/wiki/mainline-call-graph.md` 中的 `class <NodeName>` 行
- 解析 `docs/architecture/mainline-call-map.yml` 的所有 `from_node` / `to_node`
- 双向校验：wiki 里的 NodeName 必须都在 call map 里，call map 里的 node 必须都在 wiki 里
- 解析 `docs/architecture/wiki/metadata-center-mainline-source.md` 里的 `class <NodeName>` 行，与 `metadata-center-manifest.yml` 的 `node_ids` 双向校验
- 输出：missing in wiki / missing in call map 两个列表

#### 3. `verify-architecture-shared-function-binding-status.mjs`
- 解析 `mainline-call-map.yml`，提取 `shared_functions` 列表
- 每个 shared function 必须有 `status` 字段（`anchored` / `partial` / `binding pending`）
- 任何 `status: "binding pending"` 且存在于 `anchored` 链路的 shared function，报 warning 但不 fail（允许 seed 阶段存在）
- 任何 `status` 缺失，报 failure

#### 4. `verify-function-map-test-file-coverage.mjs`
- 解析 function-map.yml 每个 feature 的 `required_tests`（路径列表）
- 对每个测试文件，检查是否被至少一个 feature 的 `required_tests` 引用
- 输出：未被引用的测试文件列表（warning），引用它的 feature_id
- 同时：解析每个 feature 的 `required_gates`（npm run 命令），校验脚本存在

#### 5. `verify-architecture-topology-naming-guard.mjs`
- 解析 `docs/design/pipeline-type-topology-and-module-boundaries.md`，提取所有 Pipeline node 名称（如 `ServerReqInbound01*`、`HubReqChatProcess03*` 等）
- 扫描 `src/server/`, `src/modules/`, `sharedmodule/llmswitch-core/src/` 下所有 `.ts` `.rs` 文件
- 检查是否有类型/struct/interface 命名不符合 `(<Domain><Phase><NN>*)` 模板
- 模式：`/^(Server|Hub|Vr|Provider|Error|Meta|Resp|Req|Chat|Virtual|Direct|Executor|Servertool|Stopless|Router|Forwarder|Client)[A-Z][a-zA-Z]*[0-9]{2}[A-Z][a-zA-Z]*$/`
- 不匹配报 failure，说明应在 topology 文档注册或命名应遵循模板

#### 6. `verify-architecture-build-ci-tier.mjs`
- 检查 package.json：
  - `build` / `build:min` 任一脚本里若含 `tsc` 且**不含** `verify:architecture-ci`，则 failure
  - 若 `build` 含 `verify:architecture-ci`，则 warn 说明分层意图
  - `install:global` 必须依赖 `build:min` 或 `build`（不能裸 npm pack）

### 修改 2 个文件

#### 3. `scripts/architecture/verify-function-map-build-wiring.mjs`
- 在 `// verify:architecture-ci must run verify:function-map-build-wiring` 块加注释说明 wiring 逻辑

#### 4. `package.json`
- 在 `scripts` 加 6 个新 gate
- `verify:architecture-ci` 末尾追加 `npm run verify:architecture-mainline-manifest-sync && npm run verify:architecture-wiki-node-id-sync && npm run verify:architecture-shared-function-binding-status && npm run verify:function-map-test-file-coverage && npm run verify:architecture-topology-naming-guard && npm run verify:architecture-build-ci-tier`

## 风险

- `verify-architecture-topology-naming-guard` 初期可能报大量误报，需要调阈值
- 7 条 mainline chains 的 manifest 生成要复用现有 lib，不能写死

## 实施步骤

1. 写 `verify-architecture-mainline-manifest-sync.mjs`
2. 写 `verify-architecture-wiki-node-id-sync.mjs`
3. 写 `verify-architecture-shared-function-binding-status.mjs`
4. 写 `verify-function-map-test-file-coverage.mjs`
5. 写 `verify-architecture-topology-naming-guard.mjs`
6. 写 `verify-architecture-build-ci-tier.mjs`
7. 修改 `verify-function-map-build-wiring.mjs` 加注释
8. 更新 package.json：加 6 个 script，`verify:architecture-ci` 追加新 gate
9. 跑所有新 gate，初始化数据（如第一次生成 manifest 文件）
10. 验证 `npm run verify:function-map-build-wiring` 仍 PASS
11. 验证 `npm run verify:architecture-ci` PASS

## DoD

- 6 个新 gate 全部 PASS（或在 seed 模式下 warn 而不 fail）
- `verify:function-map-build-wiring` PASS
- `npm run verify:architecture-ci` PASS
- 所有新脚本有 `[verify:xxx] ok` 输出格式
- commit 并在 note.md 记录
