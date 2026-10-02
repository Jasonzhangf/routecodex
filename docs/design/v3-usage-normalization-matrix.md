# V3 Usage 归一化矩阵（完整版 v4）

> v1 经独立设计 review FAIL（F1–F10），v2 经二轮 review FAIL（BLOCKER-1/2/3 + MINOR-1..4），
> v3 经实现后独立架构 review PASS（3 minor + 7 advisory，无 P0/P1）。本版按 review 结论校准：
> 修 MINOR-1（timeseries 桶级二次分类改为逐行累加）、统一三个 projection 的空 usage 策略、
> 更正文档锚点与两处不实声明，并显式声明 MINOR-2（Relay 同协议 Anthropic 的 creation 丢失）
> 与未进黑盒矩阵的格。命名使用实际 shipped symbol，DAG 与真实 Value 级数据流一致。

## 1. 触发证据（provenance）

live 样本目录 `~/.rcc/codex-samples/<endpoint>/ports/<port>/<requestId>/`，candidate 基线 `f3c2ed601`。
口径：逐 requestId 枚举样本目录中带客户端 `response.json` 的请求（证据而非代码事实）。

| 样本（provider） | 客户端实际收到的 usage |
|---|---|
| `openai-responses` / `goai…`(anthropic) | `{"cache_creation_input_tokens":0,"cache_read_input_tokens":217088,"input_tokens":3748,"output_tokens":707,"total_tokens":4455}` |
| 同上（`goaichat-ai`） | `input_tokens=4410, cache_read=229376, output=1438, total=5848` |
| 同上（`goaichat-ai`） | `input_tokens=2944, cache_read=216064, output=1037, total=3981` |

形状普查合计 **42** 例：`responses` provider 9 例、`openai_chat` provider 5 例为正确 OpenAI 形状；
`anthropic` provider 3 例为泄漏形状；chat 端点 20 例正确（#289 已修）；余 5 例为采集缺口
（`rawSse` 长度 0，request-record 有完整 usage）。重放以 `response.json` 的
`materializedResponse.usage` 与 `rawSse` 的 `response.completed` 为准。

可执行复现（已从 RED 转绿）：`v3/crates/routecodex-v3-server/tests/multi_listener_server.rs`
`responses_client_anthropic_cache_usage_projects_openai_details_shape`。

## 2. 真实数据流（Value 级，DAG 必须与之一致）

```text
provider wire usage (serde_json::Value)
  └─ canonical_usage_cache_for_value(&Value) -> V3CanonicalUsageCache
       └─ split_v3_canonical_usage_cache(input, cached_subcount, read, creation)   ← 唯一分类真源
            ├─ project_v3_chat_usage_from_canonical(&Value)      -> OpenAI Chat wire usage
            ├─ project_v3_responses_usage_from_canonical(&Value) -> Responses wire usage
            └─ project_v3_anthropic_usage_from_canonical(&Value) -> Anthropic Messages wire usage
```

shipped symbol（唯一真源 `hub_v1/usage_normalization.rs`）：`V3CanonicalUsageCache`、
`split_v3_canonical_usage_cache`、`read_v3_canonical_usage_cache_fields`、
`canonical_usage_cache_for_value`、`has_v3_canonical_usage_tokens`，以及三个 projection。

**空 usage 策略（统一，避免伪造）**：三个 projection 共用 `has_v3_canonical_usage_tokens` 判定；
usage 对象不含任何可识别计数字段（空对象、只有 `service_tier` 等非计数字段、或只有
`total_tokens` 而无 input/output 拆分）时，投影返回 `None`，由调用方决定是否保留原始 usage，
**不得**伪造 `input_tokens:0 / output_tokens:0 / total_tokens:0`。`total_tokens` 不再单独构成
"可投影"依据，因为投影会从 input+output 重算 total，接受 total-only 等于丢弃 provider 的 total。

**DAG 建模口径（BLOCKER-3）**：三个 projection 的入参都是 usage `Value`，分类在节点内部调用
`canonical_usage_cache_for_value` 完成；运行期**不存在**一个中间 `canonical-usage` Value。
因此每个投影图是**单节点图**（usage-Value → client-wire-usage），不虚构 `m01 → m02` 的 Value 边；
分类真源作为节点内部逻辑与共享符号存在，不另立第二张图。
命中率消费方是独立单节点图，owner 为 `row_canonical_usage_cache`。

**入参来源修正（review ADVISORY）**：`project_v3_chat_usage_from_canonical` 与
`project_v3_responses_usage_from_canonical` 的入参是 provider-wire / 上游 canonical usage `Value`；
但 Anthropic **client** 格的入参是 Responses 投影后的 usage（
`anthropic_relay_runtime.rs:1206` → `anthropic_relay_runtime_codec.rs:81-86`），
即跨了一次 Responses canonical 中间态。该 hop 的后果见 §4「已知缺口（relay 同协议 Anthropic）」。

`extract_v3_runtime_usage_summary`（`responses_relay_runtime.rs:597`）返回 `V3RuntimeUsageSummary`，
只服务 observability，**不参与**任何 client 投影，也不作为分类真源。

## 3. Canonical 契约（三种输入语义）

| 输入语义 | 判定 | canonical 字段语义 | effective_input |
|---|---|---|---|
| OpenAI / Responses | 存在 `input_tokens_details.cached_tokens`（或 `prompt_tokens_details`） | `input_tokens` **已含**缓存 | `input_tokens` |
| Anthropic / MiniMax / glm | 存在 `cache_read_input_tokens` **或** `cache_creation_input_tokens` | `input_tokens` 只记未命中增量；read/creation 独立 | `input + read + creation` |
| Gemini | `promptTokenCount` / `cachedContentTokenCount` | `promptTokenCount` **已含** `cachedContentTokenCount`（OpenAI-like） | `promptTokenCount` |

- `cached_tokens`（命中子计数）= OpenAI 子计数，否则 `cache_read_input_tokens`。
- `cache_creation_input_tokens` 单独保留（诊断用），只在 Anthropic 语义下参与分母。
- **creation-only 边界（F5）**：只有 `cache_creation_input_tokens`、没有 `cache_read_input_tokens`
  的 payload 必须判为 Anthropic 语义（`effective = input + creation`），不得回退成 OpenAI 语义丢弃 creation。
- 判定优先级固定为：子计数 → read/creation → 无缓存字段。

## 4. 完整矩阵：canonical -> client wire（唯一 owner）

| client 协议 | 唯一 owner（shipped） | 现状 | 目标 wire 形状 |
|---|---|---|---|
| OpenAiChat | `project_v3_chat_usage_from_canonical` | ✅ 已有（#289），已收敛到共享分类 | `prompt_tokens`=effective；`completion_tokens`；`total_tokens`=prompt+completion；`prompt_tokens_details.cached_tokens`；`completion_tokens_details.reasoning_tokens` |
| Responses | `project_v3_responses_usage_from_canonical` | ✅ 本次新增 | `input_tokens`=effective；`output_tokens`；`total_tokens`=input+output；`input_tokens_details.cached_tokens`；`output_tokens_details.reasoning_tokens`；**禁止** `cache_read_input_tokens` / `cache_creation_input_tokens` |
| Anthropic | `project_v3_anthropic_usage_from_canonical` | ✅ 本次新增 | `input_tokens`=effective−cached−creation（未命中增量）；`output_tokens`；`cache_read_input_tokens`；`cache_creation_input_tokens`；**禁止** `total_tokens` / `input_tokens_details` |
| Gemini | 无（same-protocol 直通） | ✅ 已有 | `usageMetadata` 原样直通；不存在 canonical→Gemini 投影格 |

三个 projection 都接受原始 usage `Value`，内部调用 `canonical_usage_cache_for_value`
（= `read_v3_canonical_usage_cache_fields` + `split_v3_canonical_usage_cache`）；
投影层只做字段名映射，不重复推导 `effective_input` / `cached`。

**Gemini client 行（F3）**：Gemini 是 config-reachable client entry（entry_protocols 声明在
`routecodex-v3-config` 的 `types.rs:52` / `defaults.rs:12`，`endpoint_handlers.rs:749`、黑盒
`gemini_relay_controlled.rs:178` 断言客户端收到 `usageMetadata.totalTokenCount`）。
`gemini_relay_runtime.rs:246` 固定
`EXPECTED_PROVIDER_TYPE = Some("Gemini")`（比较见 `relay_runtime_shared.rs:133-147`），
因此 Gemini client 只有 **same-protocol 直通**格，无独立投影 owner，已由该黑盒覆盖。

**已知缺口（MINOR-1，显式声明，不在本次范围）**：`provider_wire_protocol_for_provider_type`
把 `gemini → Gemini`（`provider_compat_shared.rs:20-38`），且 `openai_chat_relay_runtime.rs:1297`
的 `EXPECTED_PROVIDER_TYPE = None`，所以 Gemini **provider** 理论上可服务 Chat/Responses/Anthropic
client，第 3 行语义对 provider 侧 Gemini 形状是 load-bearing 的。但所有 projection 调用点读
`object.get("usage")`，只有 observability 提取器读 `usageMetadata`（`responses_relay_runtime.rs:601`），
上游没有 `usageMetadata`→`usage` 的映射。因此 **gemini provider → 非 gemini client 目前不产出
client usage**。当前 active config 无 Gemini provider，该格不可达；本变更不接线，仅在此声明为缺口，
避免把未接线的能力写成已覆盖。

**已知缺口（review MINOR-2，显式声明，不在本次范围）**：Anthropic provider → Anthropic client 若被
配置强制走 **Relay**（同协议默认是 Direct 直通，`v3/crates/routecodex-v3-runtime/src/nodes.rs:734`
只在 direct 不可用或
`responses_process=chat` 时选 Relay），中间会经过 Responses canonical，而 Responses wire 无法表达
"缓存写入"，`project_v3_responses_usage_from_canonical` 把 creation 折进 effective input 后不再输出它。
于是 `project_v3_anthropic_usage_from_canonical` 的 creation 分支在该 hop 上不可达：
`{input_tokens:1000, cache_creation_input_tokens:200}` 回程为
`{input_tokens:1200, cache_read_input_tokens:0}`——creation 丢失、未命中 input 被高估 200
（effective 总量不变）。本次黑盒 fixture 的 `cache_creation = 0`，因此该格未被黑盒覆盖。
该缺口不改变本次修好的 anthropic→responses/chat 与 Direct 直通路径；列此声明以免把
"Anthropic 目标形状含 creation" 写成在 Relay 同协议 hop 上已覆盖。

**其它 client-facing usage writer 的角色声明（F4）**：
- `materialize_v3_responses_terminal_usage`（`responses_relay_runtime.rs:858`）：仅补缺失
  `input_tokens`/`output_tokens`/`total_tokens` 的填充器，不重算缓存语义。
- `materialize_v3_runtime_input_usage_estimate_from_request`（`responses_relay_runtime.rs:664`，
  调用点 `responses_relay_runtime_inner.rs:857,1216`）：provider 语义缺 usage 时写入**估算**
  input/total，随后仍必须经过对应 projection；它是填充器，不是第二分类真源。
- Direct 模式同协议直通（`kernel/direct_runtime_helpers_stream.rs:587`）：provider 与 client 同协议时
  不重投影，属声明性直通。

## 5. 收敛与删除清单（消融）

| 待删/收敛对象 | 位置 | 收敛到 |
|---|---|---|
| `anthropic_usage_as_responses_usage` | `anthropic_codec/responses_to_anthropic.rs`（已删） | `project_v3_responses_usage_from_canonical` |
| `normalize_v3_hub_responses_usage_from_openai_chat_usage` | `responses_openai_chat_conversion.rs`（已删） | 同上 |
| Anthropic client 直通 writer | `anthropic_relay_runtime_codec.rs:80-82` | `project_v3_anthropic_usage_from_canonical` |
| Anthropic client 重建 writer | `anthropic_relay_runtime_codec.rs:194-201` | 同上 |
| chat projection 自带分类 | `openai_chat_codec.rs`（改为 re-export） | `split_v3_canonical_usage_cache` |
| console 第三份命中率规则 | `routecodex-v3-server/src/console/impl_display.rs:46-72` | `split_v3_canonical_usage_cache` |
| timeseries 桶级二次分类 | `routecodex-v3-admin/src/api/timeseries.rs`（改为逐行累加 canonical） | `split_v3_canonical_usage_cache` |
| timeseries 旧 read/cached 回退 | `routecodex-v3-admin/src/api/timeseries.rs`（`row_cache_read` 已删） | 同上 |
| observability 命中率规则 | `routecodex-v3-admin/src/api/observability.rs:689-707` | `row_canonical_usage_cache` → 同上 |

**未收敛（合法不同契约，非重复分类）**：`extract_v3_console_usage_summary`
（`console/impl_display.rs:126-182`）**未**改为调用共享规则——它是**字段提取/别名表**，
不是第二份分类规则；只有其下游的命中率计算（`impl_display.rs:46-72`）收敛到共享 split。
v2 文档曾把该提取器写成"已收敛到 `split_v3_canonical_usage_cache`"，属不准确，此处更正。
它自身不含 `promptTokenCount`/`candidatesTokenCount`/`cachedContentTokenCount`/`totalTokenCount`
别名，这是提取面缺口，不是分类分歧。

**形状差异（MINOR-3）**：admin/console 的行数据是**扁平**的（`V3ObsUsageSummary`
`webui_observability.rs:531-543`、`TimeseriesRow.usage`），Value 级 reader
`read_v3_canonical_usage_cache_fields` 只读嵌套 `*_details.cached_tokens` + 顶层
`cache_read/creation` + `cachedContentTokenCount`，**不读扁平 `cached_tokens`**。因此扁平消费方
直接调用 `split_v3_canonical_usage_cache(input, cached, read, creation)`（`observability.rs:689-707`
`row_canonical_usage_cache`、`console/impl_display.rs:49-57`、`timeseries.rs` 逐行累加点），
而不是 `canonical_usage_cache_for_value`。这是同一分类规则的两种入参形状，不是第二规则。

**桶级聚合（review MINOR-1，已修）**：`timeseries` 不能对**桶的求和字段**再跑一次分类——
同一桶内可以混有 OpenAI 语义行（子计数）和 Anthropic 语义行（增量），任一 OpenAI 行都会让
`(bucket.cached_tokens > 0)` 成立，从而把 Anthropic 行的 read/creation 从分子和分母一起丢掉。
现在改为**逐行**用共享 split 求出 canonical 命中/有效输入并累加到桶内私有累加器
（`canonical_cached_tokens` / `canonical_effective_input_tokens`，`#[serde(skip)]` 不改变 API 形状），
桶命中率只由累加器计算；原始字段仍作展示求和。混桶单测：
`timeseries_mixed_semantics_bucket_accumulates_canonical_per_row`（OpenAI 250/1000 + Anthropic 600/1500
→ 850/2500 = 34.0%）。

`routecodex-v3-admin` 已依赖 `routecodex-v3-runtime`，共享规则不需要新依赖。

**仍未收敛的第四/五份副本（显式声明，本次范围外）**：admin webui 前端 JS 仍自带命中率算式
`v3/admin-webui/app/views/usage.js:167-170`（`hitRateText` 用 `read/input`）与 `:328`
（`mergeStats` 用 `cache_read_input_tokens/input_tokens`）。它们消费 admin API 的行数据，对
Anthropic 行同样会低估分母；但属 webui 展示面，需 `verify:webui-smoke` 门禁，本变更不触碰。
这是同一语义的已知剩余重复实现，列为后续收敛项。

**Admin 数据来源（review ADVISORY，已更正）**：observability 的行来源**不是**统一读
`finalized_provider_value`——`relay_runtime_core.rs:1140` 读的是 `client_response`；
`responses_relay_runtime_inner.rs:935,1308` 才读 `finalized_provider_value`。因此 `/v1/responses`
入口的行是 Responses 语义，而 `/v1/messages` 入口
（`anthropic_relay_runtime.rs:1052,1282` → `extract_v3_anthropic_relay_usage_summary`）落库的行
**即使在本变更后仍是 Anthropic 形状**。所以共享分类规则对新行同样是 load-bearing 的，
不只是对历史行 / Direct 行的兼容；这也是混桶场景真实存在的原因。
`responses_relay_runtime_inner.rs:935,1308` 之后仍必须经过对应 projection。

## 6. 回归面（必须同步更新的具体断言）

| 文件:行 | 现断言 | 处理 |
|---|---|---|
| `multi_listener_server.rs`（本变更新增 3 条黑盒） | RED：Responses client 收到 anthropic 形状 | 变绿（3 格） |
| `responses_relay_runtime_extra_tests.rs:1053-1056` | `input_tokens==7`、`total_tokens==10`、`cache_read_input_tokens==5` | 改为 `input_tokens==12`、`total_tokens==15`、`input_tokens_details.cached_tokens==5`，且无私有字段 |
| `responses_relay_runtime_tests_extra.rs:758-767` | 旧 OpenAI 形状转换调用点 | 按新 owner 语义复核（未变） |
| `anthropic_relay_runtime_integration.rs:539-541` | Anthropic client `usage.total_tokens == 21` | 输入 `{input_tokens:13,output_tokens:8,total_tokens:21}` **无缓存字段**，新输出为 `{input_tokens:13,output_tokens:8}`：无 `total_tokens`、无 `input_tokens_details`，也**不产生** `cache_read_input_tokens` |
| `timeseries.rs:478`（断言在 `:516`） | 期望 `Some(70.0)`（input=1000/read=700/creation=200） | 期望 `Some(36.8)`（700/1900） |
| `timeseries.rs` 新增混桶单测 | — | `timeseries_mixed_semantics_bucket_accumulates_canonical_per_row`（850/2500） |
| `observability.rs:1327-1377` | 命中率单测 | 按共享规则复核 |
| `usage_normalization.rs` 新增单测 | — | `projections_skip_usage_without_recognizable_tokens`、`responses_projection_skips_total_only_usage_instead_of_zeroing_it` |
| console 测试 `routecodex-v3-server/src/tests/mod.rs:1312-1332` | 分母 101826 | 改为 101833（59842+41984+7，含 creation）；`:3152` 同批复核 |

## 7. 黑盒测试矩阵（每格一条，走真实入口）

| provider wire | client | harness | 入口 | 状态 |
|---|---|---|---|---|
| anthropic | Responses | `multi_listener_server.rs` manifest `:369` + terminal upstream `:1185` | `POST /v1/responses` | ✅ 本次新增 |
| anthropic | Anthropic | 同上 manifest，覆盖 `server.endpoints`（模式见 `:1566`）+ `:1200` `/v1/messages` upstream | `POST /v1/messages`（SSE） | ✅ 本次新增 |
| anthropic | Chat | 同上 manifest + terminal upstream | `POST /v1/chat/completions` | ✅ 本次新增 |
| responses | Responses | `multi_listener_server.rs:369/1185` | `POST /v1/responses` | ✅ 既有 |
| openai_chat | Responses | `multi_listener_server.rs:369` + terminal upstream（OpenAI-Chat 形状 body） | `POST /v1/responses` | ✅ 既有 |
| openai_chat | Chat | `openai_chat_relay_controlled.rs:324/33` | `POST /v1/chat/completions` | ✅ 既有 |
| gemini | Gemini | `gemini_relay_controlled.rs:178`（同协议直通） | `POST /v1beta/models/:model:generateContent` | ✅ 既有 |
| gemini provider | 非 gemini client | — | — | ❌ 缺口（见 §4，不可达，不接线） |

**只由单测覆盖（未进黑盒矩阵，review ADVISORY）**：provider→Anthropic client 的另两格
（`responses` provider → Anthropic client、`openai_chat` provider → Anthropic client）目前只在
`anthropic_relay_runtime_integration.rs:532-547` 的单测层覆盖。它们的 usage 形状由本次新增的
`project_v3_anthropic_usage_from_canonical` 决定，属受影响面；本次未为其新增黑盒格，
按缺口列出而不写成已覆盖。

**未被黑盒覆盖的边界**：`anthropic` provider → `anthropic` client 且
`cache_creation > 0` 的 Relay 同协议格（§4 MINOR-2）——黑盒 fixture 固定 `cache_creation = 0`。

> v2 曾把 "anthropic | Chat" 归到 `openai_chat_relay_controlled.rs:324/33`；该 manifest 硬编码
> `type = "openai_chat"`、上游 `:33 controlled_openai_chat_upstream` 返回 OpenAI-Chat body，
> 无法承载 Anthropic provider。本版改用同一 Anthropic-provider manifest + terminal upstream。

每格断言：① 只出现本协议字段；② `effective_input` 含缓存；③ `cached` 子计数正确；
④ `total` = 投影后 input+output；⑤ 缺缓存字段的 provider 不得伪造 0 子计数；
⑥ usage 对象无可识别计数字段时不产出伪造 usage（§2 空 usage 策略）。

## 8. 非目标

- 不新增 client 协议；不改 provider 请求侧 `include_usage` / `stream_options` 语义。
- 不接线 gemini provider → 非 gemini client 的 `usageMetadata`→`usage` 映射（§4 缺口，当前不可达）。
- 不为 Gemini 增加 cross-protocol provider 支持（现为固定 provider type）。
- 不从样本、日志或 snapshot 反推控制状态。
