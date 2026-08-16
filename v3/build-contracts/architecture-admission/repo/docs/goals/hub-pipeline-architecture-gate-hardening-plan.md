# Hub Pipeline 架构门禁硬化计划

## 目标与验收标准

对 Hub Pipeline 架构体系补 6 个 gate，补 `install:global` 强制完整 CI，锁流程不漂移。

### 缺口量化

| # | 缺口 | 严重度 | 漂移后果 |
|---|------|--------|----------|
| A | `build`/`build:min` 不强制完整 CI | **高** | 本地构建绕 38 个架构 gate |
| C | 7 条 mainline chains 无机器可读 manifest | **高** | agent/gate 无法自动化消费 call map |
| D | wiki 节点 ID vs call map 节点名无一致性 gate | **高** | 改代码只更新一边，wiki 与 reality 漂移 |
| E | shared function binding pending 状态无 gate | 中 | 中长期 binding pending 不收敛 |
| F | `required_tests` 反向引用完整性无 gate | 中 | 测试映射形同虚设 |
| G | topology 文档 vs code type 命名无一致性 gate | 中 | 新 struct 中间插节点不被拦截 |
| B | CI/longtail wiring 依赖无注释 | 低 | wiring gate 逻辑不透明 |

---

## 设计原则

- **最小新增**：复用现有 `mainline-call-map-lib.mjs`、`architecture-wiki-lib.mjs` parser，不重写 YAML 解析
- **不破坏现有 gate**：所有改动必须在 `verify:function-map-build-wiring` 绿的前提下完成
- **正向 + 反向都要**：每条规则必须同时有 "违了就 fail" 和 "符合就 pass" 两套断言
- **引用完整性**：每个 gate 检查的 path 必须在 `function-map.yml` 里登记，不凭空猜路径

---

## 技术方案

### 缺口 A：拆 `install:global` 为 `install:global:ci-gated`

**现有问题**：`build` / `build:min` 只跑 `review-surface-light` + `function-map-compile-gate`，不强制 38 个架构 CI gate。

**方案**：
- `install:global` 改为在 `npm run build` 后追加 `npm run verify:architecture-ci`
- 或拆成 `install:global:base`（当前行为）和 `install:global:full`（追加 CI）
- `build:dev` / `build:dev:full` 保持不动（`build:dev:full` 已有自己的测试链）

**文件**：
- `scripts/install-global.sh`：在 `build_project` 后加 `run_npm_verify_architecture_ci`

**注意**：不拆 `build` / `build:min`——现有工程流已在用，改名会影响所有调用方。只锁 `install:global`。

### 缺口 C：mainline chains 机器可读 manifest + gate

**现有问题**：metadata center 有 `metadata-center-manifest.yml`，但 7 条 mainline chains 无 manifest。

**方案**：
- 为 7 条 chains 各生成一份轻量 manifest：`<chain-id>-manifest.yml`（在 `docs/architecture/manifests/`）
- manifest 内容：chain_id、entrypoint node、all nodes、all edges、owner feature、required gates
- 新 gate：`verify:architecture-mainline-manifest-sync`，校验：
  1. 每个 chain manifest 存在
  2. manifest 的 node_ids 与 `mainline-call-map.yml` 的 node 集合一致
  3. manifest 的 owner_feature_id 在 `function-map.yml` 中存在
  4. manifest 的 entrypoint 与 `mainline-call-map.yml` 的 `entry_contract.node` 一致
  5. manifest 的 required_gates 在 `package.json` 中存在

**manifest schema**（每个 chain 一份）：
```yaml
lifecycle_id: <chain_id>
summary: "<chain summary>"
owner_feature_id: <feature_id>
entrypoint:
  node_id: <entry node>
  call_map_chain_id: <chain_id>
node_ids:
  - <node1>
  - <node2>
  ...
edge_ids:
  - <step_id1>
  - <step_id2>
  ...
verification:
  required_gates:
    - npm run verify:<gate>
```

**文件**：
- `docs/architecture/manifests/request-mainline-manifest.yml`
- `docs/architecture/manifests/response-mainline-manifest.yml`
- `docs/architecture/manifests/error-mainline-manifest.yml`
- `docs/architecture/manifests/runtime-lifecycle-manifest.yml`
- `docs/architecture/manifests/runtime-tmux-client-binding-manifest.yml`
- `docs/architecture/manifests/stopless-session-manifest.yml`
- `docs/architecture/manifests/metadata-center-manifest.yml`（已有，移动到 manifests/）
- `scripts/architecture/verify-architecture-mainline-manifest-sync.mjs`

**现有 `metadata-center-manifest.yml` 处理**：移动到 `docs/architecture/manifests/`，更新 `verify-architecture-manifest-sync.mjs` 路径。

### 缺口 D：wiki 节点 ID vs call map 节点名一致性 gate

**现有问题**：`verify:architecture-mainline-mermaid-sync` 只校验 render artifact 同步，不校验 wiki 节点 ID 与 call map 节点名一致。

**方案**：
- 解析 `mainline-call-graph.md` 里的 Mermaid 块中的 `node_ids`（在 `[]` 里的节点名）
- 解析 `mainline-call-map.yml` 的 `from_node` / `to_node` 集合
- 校验：wiki 里的每个节点名必须出现在 call map 的 node 集合中，反之亦然
- 同时校验 `step_id`（edge label）一致性：wiki 里的 edge label 必须与 call map 的 `step_id` 一致

**文件**：
- `scripts/architecture/verify-architecture-wiki-node-consistency.mjs`
- 集成到 `verify:architecture-ci`

### 缺口 E：shared function binding pending 状态 gate

**现有问题**：call map 里标记 `binding pending` 的 shared function 无 gate 约束，可能无限期 pending。

**方案**：
- 统计当前 `binding_pending: true` 的 shared functions 数量
- 记录为 baseline（`SHARED_FUNCTION_BINDING_BASELINE`）
- gate 要求：每次验证时 pending count 必须 <= baseline
- 禁止：引入新的 `binding_pending: true` 的 shared function 而不更新 baseline
- 可选增强：要求所有 shared function 必须有 `caller_symbol` + `callee_symbol`，无符号必须先声明 `binding pending`

**文件**：
- `scripts/architecture/verify-architecture-mainline-binding-pending.mjs`
- 配置文件：`docs/architecture/.binding-pending-baseline.json`（登记当前 baseline，允许更新但必须 git diff 说明原因）

### 缺口 F：`required_tests` 反向引用完整性 gate

**现有问题**：`verify:function-map-required-tests` 只校验文件存在，不校验文件里是否真正测了该 feature。

**方案**：
- 新 gate：`verify:function-map-test-references`
- 对每个 feature 的 `required_tests`，用 `rg` 扫描对应文件，查找 `feature_id` 相关字符串（如 `feature_id`、`describe`、`it(` 后面跟 feature key）
- 如果 required_tests 列表里有的文件不包含该 feature 的任何特征字符串，报 warn/fail
- 设置白名单：允许某些文件虽然不直接包含 feature 字符串但确实是该 feature 的正确覆盖（如 shared fixture 文件）

**文件**：
- `scripts/architecture/verify-function-map-test-references.mjs`

### 缺口 G：topology 文档 vs code type 命名一致性 gate

**现有问题**：`docs/design/pipeline-type-topology-and-module-boundaries.md` 描述节点命名，但无 gate 校验源码 type/struct 命名是否与文档一致。

**方案**：
- 解析 `pipeline-type-topology-and-module-boundaries.md`，提取允许的节点类型前缀列表
- 扫描 `src/`、`sharedmodule/llmswitch-core/src/` 下所有 `.ts` `.tsx` 文件中的 type/interface/class 声明
- 校验：所有以 `Hub*`/`Vr*`/`Error*`/`Server*`/`Provider*`/`Meta*` 开头的类型名，必须匹配 topology 文档中声明的节点前缀
- 禁止：未在 topology 文档中声明的新 pipeline 节点类型前缀
- 白名单机制：新增类型必须先更新 topology 文档，再运行 gate

**文件**：
- `scripts/architecture/verify-architecture-topology-naming.mjs`
- `docs/design/pipeline-type-topology-and-module-boundaries.md`（可能需要补充 node prefix 列表）

### 缺口 B：wiring 注释补强

**方案**：
- 在 `verify:function-map-build-wiring.mjs` 顶部加注释，说明 CI 与 longtail 的依赖关系逻辑
- 在 `package.json` 的 `verify:architecture-ci` 行加注释，说明 longtail 已内联

---

## 风险与规避

| 风险 | 规避 |
|------|------|
| 移动 `metadata-center-manifest.yml` 破坏已有 gate | 先确认所有引用路径，再批量更新 |
| 新 gate 误报导致 CI 红 | 所有新 gate 先以 warn 模式运行一个周期，再升为 fail |
| `install:global` 加 CI 后本地构建时间过长 | CI gate 已优化为快速失败；不显著影响 install 时间 |
| topology naming gate 扫描范围过大 | 只扫描 `src/` 和 `sharedmodule/llmswitch-core/src/`，不扫描 `node_modules/`、test 文件 |

---

## 实施步骤（顺序）

1. **缺口 C**：生成 7 条 chain manifest，写 `verify-architecture-mainline-manifest-sync.mjs`
2. **缺口 D**：写 `verify-architecture-wiki-node-consistency.mjs`
3. **缺口 E**：写 `verify-architecture-mainline-binding-pending.mjs`
4. **缺口 F**：写 `verify-function-map-test-references.mjs`
5. **缺口 G**：写 `verify-architecture-topology-naming.mjs`
6. **缺口 A**：更新 `install-global.sh`，加 `verify:architecture-ci`
7. **缺口 B**：补 wiring 注释
8. **package.json**：所有新 gate 并入 `verify:architecture-ci`
9. **验证**：所有 gate PASS，`build` 仍绿

---

## 完成定义（DoD）

- `verify:architecture-mainline-manifest-sync` PASS（7 manifests + 1 gate）
- `verify:architecture-wiki-node-consistency` PASS
- `verify:architecture-mainline-binding-pending` PASS
- `verify:function-map-test-references` PASS
- `verify:architecture-topology-naming` PASS
- `install:global` 内嵌 `verify:architecture-ci` PASS
- 所有已有 gate 仍 PASS（`verify:function-map-build-wiring` 绿）
- `build` / `build:min` / `build:dev` 仍绿
