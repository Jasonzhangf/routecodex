# V4 Direct / Relay / SSE 架构整改计划

状态：`hooks_green_runtime_migration_pending`

目标：把当前合并的 request/response lane 拆成 Direct 与 Relay 独立执行链；把 Direct 两端中继落实为独立 NodeContainer 节点；把 SSE 落实为独立 transport plugin；所有 payload 修改只由 registered Direct/Relay hook 或相邻 protocol codec 完成。

## 固定边界

```text
HTTP admission
  -> typed execution lane + entry/provider/client protocol information
  -> immutable epoch lease
  -> NodeContainer entrypoint

Direct request:
  ClientRaw -> DirectRelayRequestNode -> DirectRequestHookQueue
            -> SameProtocolProviderWire -> provider transport

Direct response:
  ProviderRaw -> provider event codec -> DirectRelayResponseNode
              -> DirectResponseHookQueue -> ClientSemantic

Relay request:
  ClientRaw -> EntryCodec -> HubNormalized -> ReqChatProcess
            -> RelayProviderHook -> ProviderCodec -> ProviderWire

Relay response:
  ProviderRaw -> ProviderCodec -> HubNormalized -> RespChatProcess
              -> RelayClientHook -> ClientCodec -> ClientSemantic

SSE:
  ProviderBytes -> SseIngressPlugin -> ordered opaque transport frames
  finalized opaque client frames -> SseEgressPlugin -> ClientBytes
```

`V4DirectReq02RelayContainer` 与 `V4DirectResp02RelayContainer` 是同一 Direct relay container feature 的方向化 entrypoint，作为 client/provider Direct 连接之间唯一独立 NodeContainer 节点；它们不能复用 Relay Chat Process 节点，也不能绕过 NodeContainer/EpochLease。SSE ingress/egress 是独立 plugin identity，effect 固定为 `transport`，不得解析协议事件、判断业务 terminal truth 或声明 normal payload write。

## 首批红测

1. 当前 skeleton 仍只有 combined request/response chain，Direct/Relay 未分离：红。
2. SSE node/plugin 声明 `semantic` effect 或 normal payload write：红。
3. runtime/runtime-bin/server/provider transport 内存在 model rewrite、Chat/Responses 投影或 provider/client payload normalize：红。
4. Direct request/response plan 挂载 Relay hook，或 Relay plan 挂载 Direct hook：红。
5. Direct entry protocol 与 provider protocol 不一致仍继续执行：红。
6. hook 从 payload 读取 `protocol`、execution lane、provider identity 或 control markers：红。
7. client protocol 从 provider protocol 推断，或 provider protocol 从 client payload 推断：红。
8. Direct relay 未作为 Cordis compiled graph 中的独立 NodeContainer 节点：红。
9. SSE plugin 判断 terminal/tool/continuation/retry/route 或修改 model/fields：红。
10. runtime-local continuation classify/restore/commit/store/materialize 复活：红。

## 实施任务与并发关系

| task | 内容 | 依赖 | 可并行 |
|---|---|---|---|
| DR-SSE-01 | canonical topology、resource/function/mainline/verification maps、node graph/skeleton contract、red gates | 无 | 否，先完成 |
| DR-SSE-02 | 独立 SSE transport plugin：frame/order/buffer/backpressure/timeout/keepalive/closeout；零 payload mutation | DR-SSE-01 | 与 03/04/05 并行 |
| DR-SSE-03 | DirectRelay request/response NodeContainer entrypoints + typed Direct lane/protocol information | DR-SSE-01 | 与 02/04/05 并行 |
| DR-SSE-04 | Direct request/response hook plugins；same-protocol fail-fast；model/field rewrite 迁入 hook | DR-SSE-01 | 与 02/03/05 并行 |
| DR-SSE-05 | Relay request/response adjacent codecs/hooks；client/provider protocol 完全解耦 | DR-SSE-01 | 与 02/03/04 并行 |
| DR-SSE-06 | runtime/runtime-bin/server/provider 删除 payload mutation、combined lane、SSE semantic helpers 与 local continuation | 02+03+04+05 | 否 |
| DR-SSE-07 | Cordis compiled epoch、ActiveEpochStore、runtime-bin 单实例生产接线 | 06 | 否 |
| DR-SSE-08 | JSON/SSE Direct+Relay differential、global install、`rccv4 restart`、5520 live、AGY、tag | 07 | 否 |

每个实现 task 独立 claim/worktree/commit，只能合入 `v4-cordis`。完成 task 后由 master 精确合并、在 `v4-cordis` 复验并同步下一 task base；不得合入仓库 `main`。

## 验收

- Direct Chat/Responses JSON 与 SSE：入口协议和 provider 协议一致；Direct relay node 与 Direct hooks 真实进入 leased epoch trace。
- Relay Chat/Responses JSON 与 SSE：client entry codec、Hub Chat Process、provider codec、client codec 均为相邻节点；client/provider protocol 可不同且互不推断。
- SSE plugin 的 payload 输入输出字节语义等价，除 framing 外零业务字段变化。
- raw client request、provider-bound request、raw provider response、client projection 使用同一 requestId 留证；Direct/Relay 各覆盖 JSON/SSE 正反样本。
- local/relay continuation 物理不存在；仅 Direct provider-owned Responses continuation 保留。
- 全量 architecture gates、workspace locked build、AppSDK admission、全局安装、managed restart、5520 health/live、AGY PASS。
