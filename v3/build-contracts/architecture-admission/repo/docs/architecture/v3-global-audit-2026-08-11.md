# V3 全局审计报告(2026-08-11)

> 审计基线:HEAD `7f95177a6`(0.90.4268)· 范围:`v3/crates/*`、`docs/`、`AGENTS.md`、`sharedmodule/llmswitch-core/rust-core`
> 方法:verify:v3-architecture-ci 自动 gate + 6 维并行审计(架构合规/错误处理/安全/文档一致性/工程质量/流水线边界)

## 结论总览

| 维度 | 结论 | 关键发现数 |
|---|---|---|
| 架构合规(P0 护栏) | 总体合规,模型名特判是主要问题区 | 5(P0/P1 边界 1 + P1×4) |
| 错误处理链 | 主链合规,两条独立 relay 路径超时缺失 | 高×2、中×2、低×2 |
| 安全 | 无 Critical/High,4 个 Medium(脱敏/权限) | 中×4、低×5 |
| 文档一致性 | 前次 6 处漂移全存在 + 新增 5 处 | 11 |
| 工程质量 | file-size gate 红 + 6 个过时测试 | 高×2、中×4、低若干 |
| 流水线边界 | 节点职责干净,无实质越界 | 中×2、低×4 |

---

## 一、架构违规(需 Jason 裁决归属)

### P0/P1 边界:DeepSeek 模型名特判写进 Hub Pipeline transport builder
- `hub_v1/provider_compat_shared.rs:123-186`:`build_v3_openai_chat_transport_request_from_v3_provider_08` 按 `canonical_model_id.contains("deepseek")`(`is_v3_deepseek_reasoning_target` :180-184)对 openai_chat wire body 回填 `reasoning_content` 空串(`apply_v3_opencode_deepseek_reasoning_passthrough` :153-178)
- **生产路径**:被 `build_v3_provider_transport_request_for_protocol`(:110)→ `hooks.rs:374`、`openai_chat_relay_runtime.rs:1166`、`responses_relay_runtime.rs:1939`、`web_search_hop.rs:246` 调用
- 按 AGENTS.md 第 12 条(Hub Pipeline 禁止 provider-specific 分支/shape 修补)字面判 **P0**;若归入 ProviderReqOutbound07TransportRequest(provider outbound codec)边界可辩护降 **P1**

### P1:gpt 模型名特判(3 处)
- `provider_compat_shared.rs:188-198`:`is_v3_gpt_canonical_model`(gpt- 前缀)+ `is_v3_retain_response_cipher`(仅 gpt 且单 provider 保留密文)在 relay 主链 VR 决策处计算(`relay_runtime_core.rs:350-357`),消费于 `resp_chat_process_03_governed.rs:377-378`(Resp03 密文剥离判定)——**gpt 特判写入 Hub 决策**
- `request_outbound_builtin_tool_projection.rs:33`:`is_gpt_model = model_id.starts_with("gpt")` → openai_chat wire build(:39-68)按 gpt 特判 web_search 工具投影
- `anthropic_codec.rs:480-485`:`model.trim().starts_with("claude-")` 决定是否注入 Claude Code 系统提示(调用点 :404)

### P1:direct 进入 servertool response orchestration(feature-gated)
- `kernel/direct_stopless.rs:205-273`:direct passthrough 进入 Hub Resp03 servertool/stop orchestration
- 已登记 feature `v3.direct_stopless_metadata_center`(docs/goals 计划,function-map 登记),gate `responses_direct_stopless_center` 默认关闭(`common.rs:14-22`),wiki 状态 pending review
- 按 AGENTS.md 第 13 条字面是违规;因 feature-gated + 已登记计划,需 Jason 确认是否豁免

### P2(边界观察)
- `anthropic_codec.rs:1012-1014`:请求侧 Responses `metadata` 原样克隆进 client response body(协议回显,同一闭环,非内部 metadata)
- `config/types.rs:492,509,1022`:`provider_request_cleanup.historical_fields` 遗留配置无 runtime 消费(配置残面,应删除)

---

## 二、错误处理缺失与漏洞

### 高:两条独立 relay 路径无 transport 响应头超时 / SSE 守卫
- **responses relay**:`responses_relay_runtime.rs:1984` `transport.send(...).await` **裸 await 无 15s 响应头超时**;SSE 收集(:2409-2418)无首帧 30s 守卫、无流空闲 30s 守卫
- **anthropic relay**:`anthropic_relay_runtime.rs:757` 同样裸 await;SSE 收集(:808-831)同样缺守卫
- **后果**:provider 响应头挂起时,responses/anthropic relay 无限挂起直至 transport 层自身超时(默认 300s,config types.rs:503-505)或不超时,客户端无限等待——**正是用户当前遇到的 cc-sol 挂起 → 客户端无限重试的深层缺口**
- 对比:骨架 `relay_runtime_core.rs`(gemini/openai 共用)有完整超时链(15s 响应头 :448-461、首帧 30s :36-66、流空闲 30s :668-698、空响应 :676-681)

### 中:direct SSE 首帧后无流空闲超时
- `shared.rs:238` `observed_sse_client_stream` 只透传流,无 idle 守卫;`v3_direct_core.rs:685`
- SSE 流中途挂起不触发 provider 失败链,直接卡在客户端(server 层 `http_sse_keepalive_ms` 只发 keepalive,不识别 provider 挂起)

### 中:terminal ProviderFailure 保留上游 status(v2 契约未迁移)
- `error lib.rs:787-792`:terminal ProviderFailure `external.status ≥ 400 → 原样保留`(400/401/403/429/5xx 均如此)
- 旧契约(goal 文档):401/403 投影 **generic 502**、禁止暴露 auth 文案;special_400 直接 client-visible
- V3 当前 401/403 直接暴露上游 status——需确认 v3 口径(保留 or 迁移 v2 契约)

### 低
- `health.rs:216-218`:`health.enabled=false` 可完全关闭 cooldown/连续失败计数(default 池配置层强制非空但健康层可绕过)
- `relay_runtime_core.rs:432-445`:`Superseded`/`ReleasedBySuccess` 分支不递增预算,极端争用下可能长延迟(非无限)

### 已确认无违规
- 绕过 `decide_provider` 的 ProviderFailure 投影、手拼 Error06、缺失决策 fallback、无限重试同一 provider、relay 侧越界 502 投影——**均不存在**
- 400 同 provider 不重试(relay :884 + direct :222-223 双查 `source_kind != InvalidRequest && status != 400`)、3 次失败→15 分钟拉黑、default 池硬约束——**全部一致实现**

---

## 三、安全漏洞

### 中(4)
1. **redaction 键名缺口**:`routecodex-v3-debug/src/lib.rs:99-110` 敏感键碎片缺 `x-api-key`/`api-key`(连字符)——`"x-api-key"` 不包含任何碎片 → 明文进 debug 日志/raw capture/samples(transport.rs:292-304 已显式 redact authorization + x-api-key,但通用列表漏了)
2. **error.json 未脱敏落盘**:`endpoint_handlers.rs:857-873` request.json 经 `redact_payload_for_side_channel`,但 error.json 直接 `json!` 构造,observability.message 含原始 provider 错误消息
3. **provider 原始错误消息未脱敏**:terminal 投影的 `external_error.message` 原样回客户端 + 落盘(provider 错误体是不可信外部输入,可能含内部 URL/调试信息/token 片段)
4. **样本/日志文件权限默认 644**:`sample_store.rs:57-59` `fs::create_dir_all`+`fs::File::create` 无显式权限(umask 022 下同机其他用户可读;对比 lifecycle socket/状态文件显式 0o600/0o700)

### 低(5)
- 64MB body 并发内存面、`/v1/models` 端点暴露、WS 消息大小依赖库默认、health 信息暴露、unsafe 3 处均安全(仅关注)

---

## 四、文档一致性漂移(前次 6 处全存在 + 新增 5 处)

### 前次 6 处(仍存在)
1. AGENTS.md/设计文档通用节点图旧编号 vs 代码 V3 编号(AGENTS.md:72-105、:160-161;pipeline-topology 文档 144-164)
2. 错误链 owner 指向已删除 TS 文件(AGENTS.md:118/121/216 引用 `src/providers/**`)
3. special_400 语义矛盾(文档"直接 client-visible" vs 实现"切走 reselect")
4. Medium 3s delay 常量已加未用(`provider_action_gate.rs:13` `V3_PROVIDER_ACTION_MEDIUM_DELAY_MS` 死分支)
5. 30s idle/15s transport/空响应 x3→502 未入文档
6. continuation 图片占位与 3.2.1"唯一调用点+已记录边界"矛盾

### 新增(本次发现)
7. `V3ChatDirect11Policy`(`nodes.rs:62`)——**第三个 11 号**——mainline/verification map 零登记(god-file 拆分后引入)
8. `V3Resp15ClientPayload`(`nodes.rs:135`)与 `V3DirectResp15ClientPayloadReady`(error lib.rs:27)——两个 15 号
9. `v3-routecodex-runtime-resource-contract.md:20-40` skeleton 缺 `V3Execution11ProtocolDecision`(mainline-call-map 已登记)——文档间不一致
10. `pipeline-type-topology-and-module-boundaries.md` 内部新旧编号并存(101-121 V3 vs 144-164 旧)
11. `v3.stage_protocol_shape_contract.yml:96-106` mainline_step_ids 5 个 vs stages 实际 6 行——数量不一致

---

## 五、工程质量

### 高(2)
1. **file-size gate 失败**:`v3/crates/routecodex-v3-server/src/console/impl_bulk.rs` = **2198 行** > 1500,不在 ratchet_whitelist(`verify:v3-file-size` 红,verify:v3-architecture-ci 停在 5/36)
2. **6 个过时测试必红**(期望旧行为但实现已改):
   - 2× reasoning.content 相关(实现已改透传 `build_v3_responses_reasoning_...` :3841-3861)

### 中(4)
- 请求归一化 `expect`(`req_inbound_02_normalized.rs:21`)、健康检查 panic(server lib.rs:394-398)、出站表 panic(:896)、console 投影 panic(:1228/1252)——设计上 fail-fast,建议改可传播 Err

### 低
- `V3_PROVIDER_ACTION_MEDIUM_DELAY_MS` 死分支;模型名前缀与 UA 启发式硬编码(不可配置);首帧 30s 常量跨模块重复定义(DRY);`provider_failure_output` 4× expect(错误链收敛 invariant,可接受)

---

## 六、流水线边界

### 中(2)
1. **图片清洗第 5 调用点 + "不覆盖"声明矛盾**:`relay_request.rs:473-493` restore 后清洗 vs 文档 3.2.1:184-190"恢复的已保存上下文若含历史图片不覆盖"——已矛盾(save 时已全量清理,恢复时不会再含 base64),需修文档登记
2. **direct 链编号重载**(04×2/11×3/14×2/15×2)与 stage_shapes step_id 数量不一致——无法从编号推导拓扑相邻关系,增加误用风险

### 低(4)
- relay→direct 递归重入 + continuation locator 二次提取(`responses_direct_server_outcome.rs:217-241` + `nodes.rs:150-166`)
- relay/direct 两套 stopless center 在 handoff 时不互传
- `kernel.rs:436-494` 与 `kernel/direct_protocol_plan.rs` 重复 Router05→Target09 代码
- mainline-call-map `v3-rd-*` 全部绑定 dry-run,真实 kernel 路径 direct 链未单独登记

### 已确认无越界
- resp_outbound 保存 continuation、provider runtime 做 Hub 工具治理、req_inbound 恢复上下文、handler/SSE payload 补偿、控制面/数据面混入、routing 状态 session 泄漏——**均不存在**

---

## 修复优先级建议

| 优先级 | 项 | 性质 |
|---|---|---|
| **P0(先修)** | responses/anthropic relay transport 15s + SSE 首帧 30s + 流空闲 30s 守卫(对齐骨架 relay_runtime_core) | 错误处理缺失——用户当前挂起/无限重试的深层缺口 |
| **P0(先修)** | file-size gate 红(impl_bulk.rs 2198 行拆分或收敛) | 架构 gate 红 |
| **P1** | 6 个过时测试改透传断言 | 测试必红 |
| **P1** | DeepSeek/gpt/claude 模型名特判归属裁决(迁移 ProviderReqOutbound/Provider runtime 或 Jason 豁免) | 架构边界 |
| **P1** | redaction 补 x-api-key/api-key;error.json + external_error.message 脱敏 | 安全 |
| **P1** | 文档漂移 11 处同步(节点编号/错误链 owner/新行为/调用点登记) | 一致性 |
| **P2** | sample/log 权限 0o600;panic→Err 收敛;MEDIUM_DELAY 死分支清理;配置残面删除;direct SSE 流空闲 | 加固 |
