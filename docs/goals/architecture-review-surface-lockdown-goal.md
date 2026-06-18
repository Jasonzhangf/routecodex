# Goal: Hub Pipeline 架构 review surface 全量锁门

## 主目标
对 RouteCodex Hub Pipeline 的架构工程质量做 6 项 gate 补强，使 architecture CI 能够捕获流程漂移，且 build 强制完整验证。

## 实现文档路径

- `docs/architecture/mainline-call-map.yml`：主线调用图 YAML（7 chains / 44 edges）
- `docs/architecture/function-map.yml`：feature owner 注册表（71 features）
- `docs/architecture/verification-map.yml`：feature → 验证栈映射
- `docs/architecture/wiki/mainline-call-graph.md`：自动生成 wiki 主图
- `docs/architecture/wiki/metadata-center-manifest.yml`：metadata center 机器可读 manifest（已有）
- `scripts/architecture/mainline-call-map-lib.mjs`：mainline YAML parser + render helper
- `scripts/architecture/architecture-wiki-lib.mjs`：wiki page 生成 + 校验 lib
- `scripts/architecture/verify-function-map-build-wiring.mjs`：build wiring gate
- `package.json`：scripts 节

## 缩略执行规范

### 缺口 A：build 强制完整 CI gate

1. `build:min` 重命名为 `build:base`（仅 function-map compile gate）
2. `build` 改名为 `build:full`，强制 `build:base` + `verify:architecture-ci`
3. `build:dev` / `build:dev:full` 改用 `build:base`
4. `verify:function-map-build-wiring` 同步更新：检查 `build:base` 接 review surface light + function-map compile gate；检查 `build:full` 接 `build:base` + `verify:architecture-ci`

### 缺口 C：7 条 mainline chains 机器可读 manifest + gate

1. 写 `scripts/architecture/generate-mainline-chain-manifests.mjs`：遍历 `mainline-call-map.yml` 7 条 chains，为每条 chain 产出 `docs/architecture/manifests/<chain_id>.yml`（含 lifecycle_id、owner_feature_id、node_ids、entrypoint、call_map_chain_id）
2. 写 `scripts/architecture/verify-architecture-mainline-manifest-sync.mjs`：校验 7 个 manifest 文件存在 + schema 合法 + owner_feature_id 在 function-map + call_map_chain_id 在 mainline-call-map + entrypoint wiki_page 存在 + node_ids 与 chain 节点匹配 + verification.required_gates 非空
3. 将新 gate 接入 `verify:architecture-ci`（拼到末尾）

### 缺口 D：wiki 节点 ID vs call map 节点名一致性 gate

1. 扩展 `scripts/architecture/verify-architecture-mainline-mermaid-sync.mjs`：新增 step 解析 `.md` 中每个 Mermaid `classDef` 行和节点声明行，提取节点 ID；与 `mainline-call-map.yml` 的 `from_node` / `to_node` 做交叉比对
2. 对 7 个 chain wiki pages（如 `request-mainline-call-graph.md`）分别做节点 ID 一致性校验
3. 对 `metadata-center-mainline-source.md` 校验节点 ID 与 `metadata-center-manifest.yml` 的 `node_ids` 一致

### 缺口 E：shared function binding pending 状态 gate

1. 写 `scripts/architecture/verify-mainline-call-map-binding-state.mjs`：读取 `mainline-call-map.yml`，校验 `shared_functions` 下每个 entry 有 `binding_status`（值为 `confirmed` | `pending` | `partial`）；若 `pending` 数量超过阈值（如 3 个）则失败
2. 接入 `verify:architecture-ci`

### 缺口 F：required_tests 反向引用完整性 gate

1. 写 `scripts/architecture/verify-function-map-test-coverage-integrity.mjs`：对每个 feature 的 `required_tests` 中的测试文件，用 `grep` 验证文件中实际 import/describe/call 了该 feature_id 对应的 owner 模块或关键 symbol
2. 允许 "best effort" 模式：只有当测试文件**存在但完全不相关**时报 FAIL；测试文件不存在已在 `verify:function-map-required-tests` 中处理
3. 接入 `verify:architecture-ci`

### 缺口 G：topology 文档 vs code type 命名一致性 gate

1. 写 `scripts/architecture/verify-architecture-topology-type-consistency.mjs`：读取 `docs/design/pipeline-type-topology-and-module-boundaries.md`，提取所有 pipeline 节点类型名（格式 `<Domain><Phase><NN><Node>`）；在 `mainline-call-map.yml` 中校验这些节点名是否全部出现；若代码中存在未注册的 pipeline 节点 type/interface 则告警
2. 接入 `verify:architecture-ci`

## 验证要求

每次修改后必须验证：
1. `npm run verify:function-map-build-wiring` PASS（新 wiring 规则仍绿）
2. `npm run verify:architecture-mainline-call-map` PASS（mainline call map 结构未破坏）
3. `npm run verify:architecture-ci` PASS（38+ 个子 gate 全部绿）
4. `npm run build:base` PASS（不跑完整 CI）
5. `npm run build:full` PASS（跑完整 CI + base）
6. `git diff --check` PASS（无 whitespace 错误）

## 完成标准

- 6 个新 gate 脚本全部写入 `scripts/architecture/`
- `package.json` 更新完毕，`build:base` / `build:full` / `build:dev` wiring 正确
- `verify:function-map-build-wiring` 对新 wiring 规则 PASS
- `verify:architecture-ci` PASS（含所有新 gate）
- 所有验证命令均有 PASS 证据输出
- note.md 更新本次工作记录
