# 66301e2：Servertool 移除与有界续杯整合 DAG

状态：整合设计，未修改或注册活动 graph.json，未实施运行接线。原 [bounded-refill DAG](66301e2-bounded-refill-dag.md) 保留不改；续杯语义按该原设计和本次用户指令执行。详细合同见 [整合方案](66301e2-servertool-refill-integrated-plan.md)。

## 1. 改造前：专用 servertool 接线

这是一次成功 Provider 业务响应所在的当前主线责任视图，不包括 Error 对象源。图上的 servertool FollowupRequired 是现有标记，不代表通用有界续杯执行器已运行。

```mermaid
%%{init: {"theme":"base","themeVariables":{"clusterBkg":"#F8FAFC","clusterBorder":"#CBD5E1","lineColor":"#475569"}}}%%
flowchart TD
  S([客户端请求]):::boundary --> M{执行模式}:::decision
  M -->|Direct| D[注册 Direct 请求治理]:::action
  M -->|Relay| Q[Inbound 与 Req04 普通工具及 servertool 治理]:::action
  Q --> O[标准 Outbound 与 Provider Compat]:::action
  D --> P[Provider 正常传输与完整 attempt 缓冲]:::action
  O --> P
  P --> R{响应 owner}:::decision
  R -->|Direct| RD[Direct 响应治理及搜索控制]:::action
  R -->|Relay| RR[Resp03 普通工具及 servertool 混合治理]:::action
  RD --> K{是否命中专用行为}:::decision
  RR --> K
  K -->|CLI projection| C[改写为 exec_command descriptor]:::action
  K -->|本地搜索| H[(搜索 Center 与 sidecar 状态)]:::data
  H --> X[执行搜索与结果回填]:::action
  K -->|普通响应| V[正常 continuation 与客户端投影]:::action
  C --> V
  X --> V
  V --> E([客户端业务响应]):::success
  classDef boundary fill:#E9EEF5,stroke:#64748B,color:#0F172A,stroke-width:1.5px
  classDef action fill:#E8F1FF,stroke:#2563EB,color:#0F172A,stroke-width:1.5px
  classDef decision fill:#FFF4CC,stroke:#D97706,color:#0F172A,stroke-width:1.5px
  classDef data fill:#F1EAFE,stroke:#7C3AED,color:#0F172A,stroke-width:1.5px
  classDef success fill:#E8F7EE,stroke:#16A34A,color:#0F172A,stroke-width:1.5px
  classDef failure fill:#FDECEC,stroke:#DC2626,color:#0F172A,stroke-width:1.5px
  linkStyle default stroke:#475569
```

此外，当前静态目标合同还有 servertool_sidecar_plan、servertool_followup和空candidate/reentry表述。它们必须与实际搜索专用接线一并清理，不能由本图推断通用refill已存在。

## 2. 改造后：一次执行产生统一处置

本图是一次完整执行的责任视图。成功候选与延期续杯在单一 typed outcome 处汇合。Runtime下一动作见图4，不在此图连回请求入口。Error与取消有独立对象源，见图3和图5。

```mermaid
%%{init: {"theme":"base","themeVariables":{"clusterBkg":"#F8FAFC","clusterBorder":"#CBD5E1","lineColor":"#475569"}}}%%
flowchart TD
  S([当前 execution 的标准请求]):::boundary --> M{Direct 或 Relay}:::decision
  M -->|Direct| D[注册 Direct 请求治理]:::action
  M -->|Relay| Q[Req04 普通工具与历史治理及 Outbound]:::action
  D --> P[正常 Provider 传输与完整缓冲]:::action
  Q --> P
  P --> R{对应响应 owner}:::decision
  R -->|Direct| DD[注册 Direct 响应治理]:::action
  R -->|Relay| RR[Response Inbound 与 Chat Process 治理]:::action
  DD --> F[形成完整治理与源 summary 事实]:::action
  RR --> F
  F --> C[复用同一 Chat Process 续杯判断]:::action
  C --> A[(按序保留本轮业务内容)]:::data
  A --> K{typed 决策}:::decision
  K -->|最终交付| V[标准 continuation 与累积内容投影]:::action
  V --> B[暂存真实客户端候选与真实终态]:::action
  K -->|续杯| W[正常 staging 输出 DeferredRefill]:::action
  W --> N[不提交中间完成事件]:::action
  B --> E([唯一输出：execution outcome]):::boundary
  N --> E
  classDef boundary fill:#E9EEF5,stroke:#64748B,color:#0F172A,stroke-width:1.5px
  classDef action fill:#E8F1FF,stroke:#2563EB,color:#0F172A,stroke-width:1.5px
  classDef decision fill:#FFF4CC,stroke:#D97706,color:#0F172A,stroke-width:1.5px
  classDef data fill:#F1EAFE,stroke:#7C3AED,color:#0F172A,stroke-width:1.5px
  classDef success fill:#E8F7EE,stroke:#16A34A,color:#0F172A,stroke-width:1.5px
  classDef failure fill:#FDECEC,stroke:#DC2626,color:#0F172A,stroke-width:1.5px
  linkStyle default stroke:#475569
```

共享判断属于Chat Process；Direct hook只提供标准事实和调用入口，不拥有另一份策略。图中的框是责任分组，不是新增大骨架节点或已编译Operator声明。固定response节点仍按次序运行。延期是typed处置，不是正常空成功帧。

## 3. 共享决策：按用户指定三条件与上限

该图输入是当前完整治理结果及当前请求typed控制。错误/取消由其现有owner处置；共享策略不改变真实终态、不判断provider健康。

```mermaid
%%{init: {"theme":"base","themeVariables":{"lineColor":"#475569"}}}%%
flowchart TD
  S([完整治理结果及请求 typed 控制]):::boundary --> C{已取消或断开}:::decision
  C -->|是| X[Runtime 取消 不再发起执行]:::failure
  C -->|否| E{存在本执行真实错误}:::decision
  E -->|是| ER[保留原错 交既有 Error 链]:::failure
  E -->|否| T{存在真实完整工具调用}:::decision
  T -->|是| TOOL[交付真实工具与保留内容]:::success
  T -->|否| H{源显式 summary 非空}:::decision
  H -->|是| DONE[交付真实业务结果]:::success
  H -->|否| B{used 小于内部配置上限}:::decision
  B -->|否 含上限0| LIMIT[交付已有结果 额度耗尽不是错误]:::success
  B -->|是| NEXT[RequestRefill]:::action
  X --> O([唯一输出：typed 处置]):::boundary
  ER --> O
  TOOL --> O
  DONE --> O
  LIMIT --> O
  NEXT --> O
  classDef boundary fill:#E9EEF5,stroke:#64748B,color:#0F172A,stroke-width:1.5px
  classDef action fill:#E8F1FF,stroke:#2563EB,color:#0F172A,stroke-width:1.5px
  classDef decision fill:#FFF4CC,stroke:#D97706,color:#0F172A,stroke-width:1.5px
  classDef data fill:#F1EAFE,stroke:#7C3AED,color:#0F172A,stroke-width:1.5px
  classDef success fill:#E8F7EE,stroke:#16A34A,color:#0F172A,stroke-width:1.5px
  classDef failure fill:#FDECEC,stroke:#DC2626,color:#0F172A,stroke-width:1.5px
  linkStyle default stroke:#475569
```

不添加stop-only、长度、关键词、task/goal完成度或旧echo特殊终态例外。真正的治理后不可交付结果在原边界产生typed错误，不能借无summary进入续杯。空白/缺失summary不止链；RCC合成summary不是源summary。源字段必须先绑定provenance。

## 4. Runtime 单次动作与资源终点

本图每次只执行一个动作，下一次治理由Runtime外层状态机触发新的图调用。没有静态回边。attempt清理与request finalizer分开。

```mermaid
%%{init: {"theme":"base","themeVariables":{"lineColor":"#475569"}}}%%
flowchart TD
  S([当前 typed 处置]):::boundary --> D{动作}:::decision
  D -->|Deliver| F[提交完整累积业务候选及真实终态]:::action
  F --> FIN[释放 attempt 与请求级资源]:::action
  D -->|取消| CANCEL[取消当前执行与未启动续杯]:::failure
  CANCEL --> FIN
  D -->|真实错误| ERROR[交图5的既有 Error owner]:::action
  D -->|RequestRefill| KEEP[(保留业务序列 原始 inverse 与配对历史)]:::data
  KEEP --> BUILD[请求 Chat Process 构造标准续请求]:::action
  BUILD -->|构造完成| CHECK{真正发起前状态}:::decision
  BUILD -->|真实构造失败| ERROR
  CHECK -->|已取消| CANCEL
  CHECK -->|额度已耗尽| F
  CHECK -->|可发起| COUNT[used 加1 创建新的 execution 身份]:::action
  COUNT --> CLEAN[清理已消费 attempt 保留请求级控制]:::action
  CLEAN --> MAIN[通过正常 Request 主线执行]:::action
  MAIN --> RESULT[完整结果交外层下一次治理调用]:::action
  FIN --> O([唯一输出：本动作回执]):::boundary
  ERROR --> O
  RESULT --> O
  classDef boundary fill:#E9EEF5,stroke:#64748B,color:#0F172A,stroke-width:1.5px
  classDef action fill:#E8F1FF,stroke:#2563EB,color:#0F172A,stroke-width:1.5px
  classDef decision fill:#FFF4CC,stroke:#D97706,color:#0F172A,stroke-width:1.5px
  classDef data fill:#F1EAFE,stroke:#7C3AED,color:#0F172A,stroke-width:1.5px
  classDef success fill:#E8F7EE,stroke:#16A34A,color:#0F172A,stroke-width:1.5px
  classDef failure fill:#FDECEC,stroke:#DC2626,color:#0F172A,stroke-width:1.5px
  linkStyle default stroke:#475569
```

同一请求owner串行管理used，正常情况下策略判断后到发起前不会被另一个动作消耗；发起边仍按typed状态区分取消与正常额度耗尽。构造失败走真实错误，尚未发起不扣次数。Error恢复只增attempt身份，不增加refill计数。新客户端请求独立used=0。

## 5. Error 恢复与两种耗尽

错误对象独立进入原Error图。Error恢复不是续杯；失败恢复不再次占用续杯额度。已有前轮文本也不能变成失败后的假正常完成。

```mermaid
%%{init: {"theme":"base","themeVariables":{"lineColor":"#475569"}}}%%
flowchart TD
  S([当前 attempt 的真实 typed 错误]):::boundary --> KEEP[保留原原因 上游状态及本地来源]:::action
  KEEP --> POLICY[原 Error01 至 Error06 决定恢复]:::action
  POLICY --> D{有合法恢复动作}:::decision
  D -->|是| CLEAN[释放失败 attempt 保留 used 历史及业务累积]:::action
  CLEAN --> RETRY[正常候选恢复 当前 execution 不变]:::action
  RETRY --> REC[成功结果重新进入完整治理]:::action
  D -->|否| ABORT[仅终止本请求传输 不发错误或假成功]:::failure
  ABORT --> FIN[释放 attempt 与请求级资源]:::action
  REC --> O([唯一输出：typed 错误处理回执]):::boundary
  FIN --> O
  classDef boundary fill:#E9EEF5,stroke:#64748B,color:#0F172A,stroke-width:1.5px
  classDef action fill:#E8F1FF,stroke:#2563EB,color:#0F172A,stroke-width:1.5px
  classDef decision fill:#FFF4CC,stroke:#D97706,color:#0F172A,stroke-width:1.5px
  classDef data fill:#F1EAFE,stroke:#7C3AED,color:#0F172A,stroke-width:1.5px
  classDef success fill:#E8F7EE,stroke:#16A34A,color:#0F172A,stroke-width:1.5px
  classDef failure fill:#FDECEC,stroke:#DC2626,color:#0F172A,stroke-width:1.5px
  linkStyle default stroke:#475569
```

续杯额度耗尽在图3交付真实结果；本图候选耗尽中止请求。二者不混为一类，不把真实错误改成新续杯或新502原因。provider健康与冷却仍由原typed身份策略负责。

## 6. 配置源与请求隔离

这是配置到运行控制的辅助资源流，不是第四个业务对象源。唯一输入是config crate的内部配置，唯一输出是可供本请求策略使用的独立typed控制。

```mermaid
%%{init: {"theme":"base","themeVariables":{"lineColor":"#475569"}}}%%
flowchart TD
  S([config crate 的 internal.toml]):::boundary --> P[internal.rs 解析 chat_process.refill]:::action
  P --> C[(只读 max_consecutive_refills 默认1)]:::data
  C --> LOAD[重建并正式加载 binary]:::action
  LOAD --> NEW[每个新客户端请求创建独立 used 等于0]:::action
  NEW --> R[(本请求 typed 控制与原始身份引用)]:::data
  R --> O([供共享 Chat Process 策略读取]):::boundary
  classDef boundary fill:#E9EEF5,stroke:#64748B,color:#0F172A,stroke-width:1.5px
  classDef action fill:#E8F1FF,stroke:#2563EB,color:#0F172A,stroke-width:1.5px
  classDef decision fill:#FFF4CC,stroke:#D97706,color:#0F172A,stroke-width:1.5px
  classDef data fill:#F1EAFE,stroke:#7C3AED,color:#0F172A,stroke-width:1.5px
  classDef success fill:#E8F7EE,stroke:#16A34A,color:#0F172A,stroke-width:1.5px
  classDef failure fill:#FDECEC,stroke:#DC2626,color:#0F172A,stroke-width:1.5px
  linkStyle default stroke:#475569
```

无用户config、server override、环境变量、运行时动态API或payload marker。配置值不存used；相同policy不意味着不同端口/会话共享运行次数。

## 7. 删除与补边总表

| 删除 | 保留/补齐 |
|---|---|
| 专用搜索 Center、sidecar、ExecuteWebSearch、CLI descriptor、vision_auto包装 | 标准原生搜索、普通本地工具、多模态、原有工具身份/历史 |
| servertool_sidecar_plan 与 servertool_followup语义 | 独立refill decision、request construction、execution origin和Runtime动作 |
| echo伪工具、auto_continue/listener开关方案 | internal.toml单一上限、源summary、请求隔离used |
| 把empty candidate视为成功或让续杯绕过主线 | DeferredRefill typed staging、完整内容序列、最后标准投影与commit |
| 搜索专用资源清理 | attempt清理、request finalizer、取消和Error恢复各自scope |

六图都是单次有限对象流/责任视图；不表示已注册或已编译的DAGPipe图。运行时重复调用不同图属于生命周期调度，不能画静态回边。图1/2用于前后对照，图3/4定义新能力，图5保留原错误边界，图6定义唯一配置源。

## 8. 查看图与本轮检查

正文Mermaid是设计正文的一部分；以下图源和SVG由正文派生，后续修改正文后重新导出，不独立维护第二份语义。

| 图 | SVG | Mermaid 源 |
|---|---|---|
| 改造前 | [01-before.svg](66301e2-servertool-refill-diagrams/01-before.svg) | [01-before.mmd](66301e2-servertool-refill-diagrams/01-before.mmd) |
| 改造后 | [02-after.svg](66301e2-servertool-refill-diagrams/02-after.svg) | [02-after.mmd](66301e2-servertool-refill-diagrams/02-after.mmd) |
| 续杯决策 | [03-refill-decision.svg](66301e2-servertool-refill-diagrams/03-refill-decision.svg) | [03-refill-decision.mmd](66301e2-servertool-refill-diagrams/03-refill-decision.mmd) |
| Runtime动作 | [04-runtime-action.svg](66301e2-servertool-refill-diagrams/04-runtime-action.svg) | [04-runtime-action.mmd](66301e2-servertool-refill-diagrams/04-runtime-action.mmd) |
| Error与清理 | [05-error-cleanup.svg](66301e2-servertool-refill-diagrams/05-error-cleanup.svg) | [05-error-cleanup.mmd](66301e2-servertool-refill-diagrams/05-error-cleanup.mmd) |
| 配置与隔离 | [06-config-isolation.svg](66301e2-servertool-refill-diagrams/06-config-isolation.svg) | [06-config-isolation.mmd](66301e2-servertool-refill-diagrams/06-config-isolation.mmd) |

本轮检查：六张图均经Mermaid CLI成功渲染；前图、后图和续杯决策另导出PNG并查看，文字和箭头可读。只读拓扑检查确认六个展示视图均无环、各有唯一入口和出口；mmd源与正文一致。文档本地链接、代码围栏、相关npm脚本名和公开测试target所属crate已核对。

这些检查不等于项目DAGPipe gate、Operator编译或产品运行验收。活动graph.json、internal.toml、requirements及产品源码均未修改，原三份bounded-refill设计保留。
