# Servertool 生命周期路由

## 覆盖范围

适用于 V3 普通 servertool、`web_search`、tool-call hooks、CLI projection
以及本地 continuation。V3 内置 Stopless、`stop_message_auto`、
`reasoningStop` 和 stop-response hook 已退休，不再是 V3 执行路径。

## 前置查询（必须）

servertool、tool-call hook 或 continuation 改动前，先查：

1. `docs/agent-routing/05-foundation-contract.md`
2. `docs/architecture/v3-resource-operation-map.yml`
3. `docs/architecture/v3-function-map.yml`
4. `docs/architecture/v3-mainline-call-map.yml`
5. `docs/architecture/v3-verification-map.yml`
6. 对应 mainline source 与 wiki review surface

先锁定唯一 owner、允许/禁止路径、调用边和 required gates；找不到唯一
绑定时先补 contract/map，不改实现。

## 当前 servertool 合同

1. 有输入的普通 servertool 通过
   `routecodex servertool run <toolName> --input-json <json>` 执行，结果经
   正常 `submit_tool_outputs` 回传。
2. 注册为 client-exec projection 的 servertool（包括兼容路径的
   `web_search`）在 Resp03 的 tool-call hook 投影为客户端可见的
   `exec_command`；原始 call id 必须保留。
3. `apply_patch` 保持原生/freeform 客户端工具链，不进入 servertool CLI
   projection。
4. servertool request hook 只处理请求侧工具输出配对、普通工具 schema 和
   `web_search` 本地工具面；response tool-call hook 只处理相邻的普通
   servertool/web-search response governance。
5. tool-call hook 与 stop hook 是不同语义边界；V3 当前只保留 tool-call
   hook。stop hook 不得通过旧 servertool、CLI、MetadataCenter 或
   `reenterPipeline` 旁路恢复。

## Followup 边界

1. continuation 只能基于 origin snapshot 重建；不得从污染 payload 猜测
   补偿。
2. servertool 执行后的 payload 必须仍经 Hub Resp Chat Process、Resp04
   continuation commit、client semantic projection 和 client frame；禁止
   servertool 专用响应出口、手工 Responses 包装或绕过正常响应口。
3. 请求与响应的 tool governance 必须停留在对应 Chat Process owner；不得由
   handler、SSE、outbound 或 provider transport 重复实现。
4. same-protocol Direct / provider-direct 不因 servertool followup 改道
   Relay；Direct 不进入 Hub response Chat Process。
5. direct passthrough 的 provider raw SSE 不进入 server response
   projection/restore/guard；只允许注册的 Direct hooks 处理。
6. continuation、routing、health、debug 和 client/provider payload 的控制
   状态必须物理分离；不得将内部 carrier 投入 client JSON/SSE。
7. 失败必须 fail-fast；禁止吞异常、猜测修复、无条件 fallback 或降级。

## 已退休功能禁区

- V3 内置 Stopless / `stop_message_auto` 全部 runtime、CLI、状态机、注入、
  拦截和对应 active docs/tests/scripts 已退休。
- `reasoningStop` 不得重新作为 V3 servertool 或客户端 no-op CLI 接入。
- 后续官方 Stop Hook、定时 hook、memory hook 属于独立 hooks daemon /
  codexapp 输入接口设计，不进入 V3 runtime；daemon 的 working 状态判断和
  `sendmessage` 唤醒由该独立部件拥有。
- clock / reminder、heartbeat / DELIVERY 等旧旁路不得恢复。

## 权威文档

- `docs/design/servertool-cli-projection-migration.md`
- `docs/design/servertool-rust-only-architecture.md`
- `docs/architecture/v3-function-map.yml`
- `docs/architecture/v3-mainline-call-map.yml`
- `docs/architecture/v3-verification-map.yml`
