# Hub Pipeline 架构门禁补强计划

## 目标
补强 7 个已识别的架构门禁缺口，锁住 hub pipeline 工程质量，防止流程漂移。

## 验收标准
- 缺口 A：build 不强制完整 CI → 补强后 `build:dev` / `build:dev:full` 明确分层
- 缺口 C：mainline 无 machine-readable manifest → 7 条 chains 各有 manifest + gate PASS
- 缺口 D：wiki 节点 ID 与 call map 节点名无一致性 gate → 新 gate PASS
- 缺口 E：shared function binding pending 状态无 budget gate → 新 gate PASS
- 缺口 F：required_tests 反向引用无 gate → 新 gate PASS
- 缺口 G：topology 文档 vs review surface 无 debt budget gate → 新 gate PASS
- 缺口 B：wiring 依赖无注释 → 注释补入
- 全量回归：所有 gate PASS、build wiring 仍绿

## 范围

### In Scope
- 6 个新 gate 脚本（缺口 C/D/E/F/G + 缺口 A 的 wiring 逻辑）
- package.json build 脚本分层补强
- `verify:function-map-build-wiring.mjs` 补注释
- 现有 `mainline-call-map-lib.mjs` parser 复用

### Out of Scope
- 不修改 function-map.yml / mainline-call-map.yml 内容
- 不新增/修改任何生产代码
- 不改现有 28 个 architecture gate 逻辑

## 设计原则
- 复用 `mainline-call-map-lib.mjs` YAML parser，不重复造轮子
- 新 gate 模式与现有 gate 脚本（verify-architecture-*.mjs）一致
- 每个 gate 独立文件、标签格式统一、失败即 exit(1)

## 技术方案

### 新 gate 1：verify-architecture-mainline-node-id-consistency.mjs（缺口 D）
- 解析 `mainline-call-map.yml`，收集所有 `chain_id` / `step_id` / `from_node` / `to_node`
- 解析对应 wiki markdown 文件（`GENERATED_WIKI_PAGES` 中 kind=mainline-chain 的页面）：
  - 从 `mermaid flowchart LR` 中提取 `node["NodeId"]` / `NodeId["..."]` 定义
  - 从 `class NodeId` 中提取 class 绑定
  - 从 `| step | ... |` 表格中提取 step_id
- 校验两边 node_id 完全一致，step_id 完全一致
- 失败即 exit(1)，报告具体哪个 node_id / step_id 不匹配

### 新 gate 2：verify-architecture-mainline-manifest.mjs（缺口 C）
- 复用 `mainline-call-map-lib.mjs` 的 YAML parser
- 读取 `docs/architecture/mainline-call-map.yml`
- 对每条 chain 提取：chain_id、node_ids（from_node + to_node 汇总）、owner_feature_id（取 edges[0]）
- 输出 7 个 manifest 文件：`docs/architecture/mainline-manifests/<chain_id>.yml`
- 新 gate 验证：manifest 文件存在、YAML 可 parse、chain_id/node_ids/owner_feature_id 存在
- `verify:function-map-build-wiring.mjs` 增加检查：`verify:architecture-mainline-manifest` 必须被 CI 引用

### 新 gate 3：verify-architecture-mainline-binding-pending-gate.mjs（缺口 E）
- 解析 `mainline-call-map.yml`
- 统计所有 `binding_pending: true` 的 edges
- 统计所有 `status: anchored | partial` 的 edges
- 报告 "N binding pending edges, N anchored edges, N% anchored"
- 读取 `docs/architecture/mainline-binding-budget.yml`
- 强制失败条件：
  - 某条 chain 的 `binding pending` / `partial` 超预算
  - anchored 低于 floor
  - total edges 改变但未同步 budget
- 作用：允许当前已知 debt 留存，但禁止静默增长

### 新 gate 4：verify-function-map-required-tests-bidir.mjs（缺口 F）
- 读取 `docs/architecture/function-map.yml`
- 对每个 feature 读取 `required_tests` 列表（npm test 路径或 jest 路径）
- 对每个 test 路径，读取文件内容，验证文件内实际 import / describe / test / it 了对应 feature_id 的语义
- **简单匹配规则**：jest 文件中必须包含 feature_id 字符串（覆盖 describe / it / test 块），或 spec 文件名/路径包含 feature_id
- 若 required_test 声明存在，但文件中找不到 feature_id 关键词，fail

### 新 gate 5：verify-architecture-topology-doc-sync.mjs（缺口 G）
- 读取 `docs/design/pipeline-type-topology-and-module-boundaries.md`
- 提取所有 `<Module><Phase><NN><Node>` 节点名
- 对照 `mainline-call-map.yml`、`metadata-center-manifest.yml`、`wiki/*`
- 再对照 `docs/architecture/topology-sync-manifest.yml`
- 强制失败条件：
  - 新出现的未消费 topology 节点未登记
  - 已收口的旧 debt 还留在 manifest 中
  - declared / referenced 节点计数与 manifest 不一致

### 新 gate 6：verify-build-script-tiering.mjs（缺口 A wiring 逻辑）
- 读取 package.json
- 验证 `build:dev` / `build:dev:full` 引用了 `npm run build`（而非直接复制 build 内容）
- 验证 `build:dev:full` 引用了 `npm run build` + 包含 `verify:architecture-ci` 路径（作为可选 check，但 wiring gate 至少验证调用链正确）
- 注：缺口 A 本身是设计决策（是否强制 build:min 跑完整 CI），wiring 层面只补注释说明

## 文件清单

```
scripts/architecture/
  verify-architecture-mainline-node-id-consistency.mjs   [NEW]
  verify-architecture-mainline-manifest.mjs              [NEW]
  verify-architecture-mainline-binding-pending-gate.mjs [NEW]
  verify-function-map-required-tests-bidir.mjs           [NEW]
  verify-architecture-topology-naming.mjs                 [NEW]
  verify-build-script-tiering.mjs                        [NEW]

docs/architecture/mainline-manifests/                     [NEW dir]
  request.mainline.yml
  response.mainline.yml
  error.mainline.yml
  runtime.lifecycle.mainline.yml
  runtime.tmux_client_binding.mainline.yml
  stopless.session.mainline.yml
  metadata.center.mainline.yml

package.json
  + verify:architecture-mainline-node-id-consistency
  + verify:architecture-mainline-binding-pending-gate
  + verify:function-map-required-tests-bidir
  + verify:architecture-topology-naming
  + verify:build-script-tiering
  verify:architecture-ci += new gates above
  verify:function-map-build-wiring.mjs += wiring comments

docs/architecture/wiki/mainline-call-graph.md (render artifact, auto-regenerate)
```

## 风险与规避
- **风险**：新增 gate 会让 architecture-ci 更慢。**规避**：binding/topology 都只做文本级 budget 校验，仍保持轻量。
- **风险**：topology-naming gate 扫描全源码很慢。**规避**：只扫描 .ts 文件的 interface/type/class 声明，不扫描全部内容。
- **风险**：required-tests-bidir 的简单关键词匹配会误报。**规避**：只对 jest/spec 文件做此检查，且关键词匹配用全词匹配（\b）防止误命中。

## 测试计划
- 每个新 gate 自身必须 PASS（green）
- 故意制造一个小 drift（如改 wiki 节点名不改 call map），验证 gate 正确 FAIL
- `verify:function-map-build-wiring` 验证新 gate 正确接入 CI
- 全量回归：npm run verify:architecture-ci-longtail PASS

## 实施步骤（顺序）
1. 写 gate 1（wiki/node-id-consistency）
2. 写 gate 2（mainline-manifest）+ 触发 render
3. 写 gate 3（binding-pending，只报告）
4. 写 gate 4（required-tests-bidir）
5. 写 gate 5（topology-naming）
6. 写 gate 6（build-script-tiering）
7. 更新 package.json：新 gate 接入 CI + build wiring
8. 给 verify-function-map-build-wiring.mjs 补注释
9. 全量回归验证
10. commit
