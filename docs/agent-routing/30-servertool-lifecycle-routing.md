# 工具生命周期与 RCC servertool 退役路由

## 覆盖范围

适用于普通客户端工具、Provider hosted search、tool-call hooks 与通用多轮处理。
当前 `routecodex-v3-no-rcc-servertool` 在设计上移除 RCC 专用 servertool、CLI
descriptor projection、本地搜索和搜索专用 followup。旧源码不是恢复旧设计的依据；
实现与运行状态仍以当前候选和验收为准。

## 前置查询（必须）

沿 [运行时路由](10-runtime-ssot-routing.md) 查询受影响的普通工具、
tool-call hook、refill 或 continuation feature，复用本任务已有 owner、调用边和
required gates。这里只补工具专属边界，不重复执行入口查询。

## 当前工具合同

1. 保留普通工具、ToolThinking、custom、原生/freeform `apply_patch`、namespace、
   完整工具身份、参数、结果及历史配对。不再把工具改写为 RCC servertool CLI descriptor。
2. Provider 执行的 hosted search 与 citations 仍是业务能力。RCC 不增加本地搜索兜底；
   `metadata_center_local_search` 和 `servertool_search_backend` 按当前需求在配置编译期显式拒绝。
3. 请求/响应工具治理分别留在对应 Chat Process；Direct 改写只在注册 Direct hooks。
4. 通用多轮执行沿当前 Chat Process 有界 refill 契约；disposition 为
   `client_commit`/`refill_requested`，来源为 `client`/`dry_run`/`refill`。
   保留延期提交、原 Error 链、取消与清理；不复活搜索专用 Center、sidecar 或 `servertool_followup`。
5. tool-call hook 与 stop hook 是不同语义边界；V3 当前只保留 tool-call
   hook。stop hook 不得通过旧 servertool、CLI、MetadataCenter 或
   `reenterPipeline` 旁路恢复。

## Followup 边界

1. 工具结果与后续请求按真实原始请求及 typed 关联处理，不从污染 payload 猜测
   控制状态，不合成缺失 call/result。
2. Relay 结果沿正常 Chat Process、client semantic projection 和 client frame 交付；
   禁止工具专用响应出口、手工 Responses 包装或绕过正常响应口。
3. 请求与响应的 tool governance 必须停留在对应 Chat Process owner；不得由
   handler、SSE、outbound 或 provider transport 重复实现。
4. same-protocol Direct / provider-direct 不因工具 followup 改道
   Relay；Direct 不进入 Hub response Chat Process。
5. Direct 的 payload 改写只允许注册的 Direct hooks 处理；它仍经过 Runtime
   的完整尝试缓冲和客户端传输边界，不得把 raw provider SSE 直通作为旁路。
6. continuation、routing、health、debug 和 client/provider payload 的控制
   状态必须物理分离；不得将内部 carrier 投入 client JSON/SSE。
7. 真实失败进入原 typed Error 链并局部隔离；Provider 错误不得返回客户端。
   模型非法参数仍为业务内容，不增加本地准入拒绝。禁止吞错、猜测修复和无条件 fallback。

## 已退休功能禁区

- RCC 专用 `servertool-core`、CLI servertool/descriptor、ExecuteWebSearch、
  web_search_hop/sidecar/hook_request、direct_web_search 与搜索专用跨轮状态均退役。
- V3 内置 Stopless / `stop_message_auto` 全部 runtime、CLI、状态机、注入、
  拦截和对应 active docs/tests/scripts 已退休。
- `reasoningStop` 不得重新作为 V3 servertool 或客户端 no-op CLI 接入。
- 后续官方 Stop Hook、定时 hook、memory hook 属于独立 hooks daemon /
  codexapp 输入接口设计，不进入 V3 runtime；daemon 的 working 状态判断和
  `sendmessage` 唤醒由该独立部件拥有。
- clock / reminder、heartbeat / DELIVERY 等旧旁路不得恢复。

## 当前依据

- 主线整合设计：`docs/goals/66301e2-servertool-refill-integrated-plan.md`。
  当前 checkout 缺该文件时，只读 `git show origin/main:docs/goals/66301e2-servertool-refill-integrated-plan.md`；不因此恢复旧 R2 或新建重复实施任务。
- 当前有效需求 `routecodex-v3-no-rcc-servertool` 与 `routecodex-v3-chat-process-bounded-refill`；
  候选内旧 requirements 不能覆盖用户新授权。
- `docs/architecture/v3-function-map.yml`
- `docs/architecture/v3-mainline-call-map.yml`
- `docs/architecture/v3-verification-map.yml`
