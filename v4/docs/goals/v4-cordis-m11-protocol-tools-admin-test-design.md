# M11-T01 协议、工具与管理面测试设计

本设计与 `m11-protocol-tools-admin.contract.json`、`m11-protocol-tools-admin.manifest.json` 同步；它描述前置合同 gate，不冒充 M11 runtime 或在线验证。

## 生命周期与测试层

| 层 | 正向样本 | 反向样本 | 目的 |
| --- | --- | --- | --- |
| 合同 L0 | contract status/owner/三 lane/dependency/task gate 可解析 | 缺合同、错误 owner、缺 lane/dependency/gate | 防止目标态文档冒充合同真源 |
| 平面 L1 | normal payload 与 typed control side-channel 分离 | payload access/control optional、fallback/silent strip/payload reconstruction 被注入 | 控制面/数据面物理隔离，fail-fast |
| 任务 L2 | 每个 task 指向唯一 owner、依赖和既有 gate | 空 required_gates、未知 owner、跨 lane shortcut | 防止重复 owner 与未绑定实现 |
| 项目 L3 | 既有 Cordis host `node --test` glob 执行 contract positive+red | canonical test 命令缺失或仅跑普通 smoke | 确认 gate 进入既有 V4 test 入口 |

## 当前 run 的最小红测

在合同创建前运行 `node --test v4/tests/m11-protocol-tools-admin-contract.test.mjs`，预期 fail：canonical M11 contract 不存在，lane/dependency 断言无法通过。该文件随后迁移到既有 Cordis host test glob，以使绿化后的合同测试由 `v4/scripts/test.mjs` 和 `v4/scripts/verify-ci.mjs` 执行。

## 绿化与正反成对门禁

- `v4_m11_contract_positive`：读取 canonical contract，验证 status、owner、lane 顺序、依赖和每个 task 的 gate 绑定。
- `v4_m11_contract_red`：以内存 invalid fixture 注入 payload/control/fallback bypass，验证合同 validator 对每个违规逐项 fail-fast；它不修改仓库文件。
- `v4_parity_gate_plane_isolation`：复用现有 V4 控制/数据平面 gate。
- `v4_parity_gate_resource_binding`：复用既有 resource relation 与 gate registration gate；本任务不新增资源 owner。

## 已知缺口

本任务不实现 protocol codecs、tool state machine、Admin HTTP/UI、Cordis graph 接线、ExecutionEngine、M08 transport 或 Active artifact。后续实现 task 必须为自己的 source/API 变化补充模块级白盒、consumer、differential、安装/重启/在线样本证据，并重新运行 AGY review；任何实现变更都会使本合同 run 的证据失效。
