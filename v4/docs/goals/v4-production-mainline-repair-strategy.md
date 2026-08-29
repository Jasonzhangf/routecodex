# V4 Production Mainline Repair Strategy

状态：`red-first / pre-implementation`
目标分支：`v4-cordis`

## 目标

将 `/v1/responses` 与 `/v1/chat/completions` 的 JSON/SSE 四条生产入口收敛到唯一链路：

```text
Server inbound -> ReqInbound -> ReqChatProcess -> ReqOutbound
-> Provider wire/transport -> RespInbound -> RespChatProcess -> RespOutbound
-> Server frame
```

`runtime-bin` 只保留 bootstrap、listener、typed dispatch、生命周期和错误入口；不得直接拥有协议转换、路由选择、provider wire、transport、continuation、tool governance 或 client projection。

## 先决审计

1. 读取 `resource-map.json`、`function-map.json`、`mainline-call-map.json`、`verification-map.json` 与 module registry。
2. 明确唯一 owner：request chain/output 在 `routecodex-v4-runtime` + standard plugin；provider wire/transport 在 provider owner；response projection 在 response plugin；runtime-bin 仅 wiring。
3. 在 function map/mainline map 增加真实生产边：request report/data output -> provider wire input；provider raw response -> response chain -> client frame。
4. 将当前 runtime-bin 直调列为 `red` 违规，不得标成 pending 或已接线。

## 必须先建立的红测

红测必须在任何产品代码修改前失败：

- `runtime-bin` 直接调用 `project_chat_request_to_responses`、`build_protocol_wire`、业务 `select_product_target*` 时失败。
- request `ExecutionReport` 被丢弃或 `provider_wire` 未作为 transport input 时失败。
- 原始 HTTP body 旁路进入 provider transport 时失败。
- 四入口任一路未经过 request/response NodeContainer 时失败。
- response/client projection 在 runtime-bin 直接完成时失败。
- function-map/mainline-map 声称已绑定但真实 caller/callee 不存在时失败。
- 控制信号进入 normal payload、payload 反向重建 control 时失败。

最小红测命令由 verification map 登记，至少覆盖 `verify-v4-responses-request`、runtime-bin source graph、四入口 black-box wiring 和 payload/control isolation。

## 实施步骤

### 阶段 0：合同与映射

- 更新 resource/function/mainline/verification maps。
- 更新生产主线合同与任务清单。
- 运行全部红测，确认当前源码确实为红。
- 阶段退出条件：红测覆盖上述每条违规，map 中 owner/边唯一且可解析。

### 阶段 1：Request 主线

- 让 request plugin chain 产出 typed request semantic/wire carrier。
- runtime-bin 只提交原始入口和 typed routing facts，消费 request report。
- 删除 runtime-bin request protocol/wire/router helper 直连。
- Responses 与 Chat relay 共用 request chain；协议差异只在登记的 input/output plugin。
- 正向：真实 body 经过 chain 后仍语义等价、wire model 正确。
- 反向：旁路 helper、丢弃 output、control/payload 混用必须 fail-fast。

### 阶段 2：Response 主线

- 保持 provider raw response 只进入 RespInbound。
- RespChatProcess 唯一执行治理、tool harvest、continuation save。
- RespOutbound 唯一生成 client semantic/frame。
- 删除 runtime-bin response helper 中重复的语义投影；SSE 只负责 framing/transport。

### 阶段 3：四入口与插件化

- Direct/Relay 的模型映射、字段改写分别注册为 input/output plugin。
- 控制信号统一 event/typed side-channel；业务 payload 使用共享 bytes/borrowed view，禁止复制控制字段。
- 四入口 JSON/SSE 使用同一 request/response chain contract。

### 阶段 4：验证与交付

```text
red -> targeted tests -> map/gate self-test -> cargo locked
-> V4 release build -> global install -> rccv4 restart
-> all health -> Responses/Chat JSON+SSE replay
-> codex -p rcm -> AGY PASS -> commit/push/tag
```

禁止 fallback、silent strip、payload cleanup、handler/SSE 补偿、手工替代链路。

## 并行任务

| 任务 | owner | 可并行 | 依赖 | 交付 |
|---|---|---:|---|---|
| T01 合同/maps/red gate | map/gate worker | 是 | 无 | red evidence + map commit |
| T02 Request chain 接生产 | runtime/request worker | 否 | T01 | request report consumed |
| T03 Response chain 清理 | runtime/response worker | 是 | T01 | response output unique |
| T04 Direct model hook plugin | plugin worker | 是 | T01 | direct input/output plugin |
| T05 Relay model hook plugin | plugin worker | 是 | T01 | relay input/output plugin |
| T06 四入口 live/replay | integration owner | 否 | T02/T03/T04/T05 | install/restart/live evidence |

每个任务独立 worktree、独立 claim、独立 commit；只能合入 `v4-cordis`，不得合入 V3 或全局 `main`。
