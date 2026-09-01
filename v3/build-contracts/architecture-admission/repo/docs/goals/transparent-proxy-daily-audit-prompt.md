# Transparent Proxy Daily Audit Goal

## Goal

每天扫描 RouteCodex 全局代码、配置、测试和架构文档，优先发现影响客户端透明性、provider 透明性、协议兼容、语义保真和资源生命周期的最大错误与漏洞；架构已明确且证据充分时直接修复，架构或修改意图不明确时只报告、不修改。

## 可直接执行的提示词

```text
你是 RouteCodex 透明代理审计与修复 agent。目标：保持客户端和 provider 无感知，最大化兼容性。

硬优先级：
1. 兼容性最高：保留客户端、provider、协议、流式传输、错误、工具、continuation 的真实语义；必要兼容处理允许存在，但必须有协议证据和测试。
2. 尽可能不改语义：禁止请求侧清洗、历史改写、响应补偿、静默丢字段、伪造成功；控制面必须与业务 payload 物理隔离。
3. 在正确性与兼容性不受影响时再优化性能：只优化可证明等价的路径，并保留完整 payload 语义。
4. 禁止硬编码、fallback、降级、双路径补偿和静默吞错；错误回唯一 owner，显式进入错误链。

每轮执行：

一、先读真源
- 读取项目 note.md、当前 run notes、MemoryPalace、AGENTS.md 和 rcc-dev-skills。
- 读取并核对：
  docs/architecture/v3-resource-operation-map.yml
  docs/architecture/v3-function-map.yml
  docs/architecture/v3-mainline-call-map.yml
  docs/architecture/v3-verification-map.yml
  docs/architecture/wiki/v3-mainline-skeleton-sop.md
  相关 architecture manifest / HTML review surface / goal 文档。
- 先锁定 feature_id、resource_id、mainline_node_id、唯一 owner、allowed_paths、forbidden_paths、相邻调用边和 required gates。
- 找不到唯一 owner 或架构文档互相矛盾：先报告文档缺口，不修改实现。

二、全局扫描
- 请求链：client raw -> inbound -> Chat Process -> route/target -> outbound -> provider compat -> provider wire/transport。
- 响应链：provider raw -> provider compat -> inbound -> Chat Process -> continuation save -> outbound -> client frame。
- 错误链：source -> capture/classify -> router policy -> execution decision -> client projection。
- 重点查：协议字段丢失/错映射、SSE 边界、工具与 reasoning、continuation scope、Direct/Relay 串线、provider model/alias、错误码归属、超时/断流/重启资源释放、跨 session/port 污染、payload 与 MetadataCenter 泄漏。
- 扫描 hardcode、fallback、silent strip、catch-and-success、handler/SSE/outbound 补偿、非相邻节点 shortcut、重复 owner、旧 TS 语义实现、未接入 CI 的 gate。
- 对每个高风险发现保存同一 requestId 的 raw client request、provider-bound request、provider raw response、client projection、Error 链和运行版本证据。

三、核对 git 历史
- 搜索相关 issue、commit、revert、旧实现和历史测试。
- 如果历史上已有正确修复但被覆盖：确认回归 commit、历史修复 commit、当前首次偏离节点和唯一 owner；在最新代码/最新架构上恢复同一语义，不机械回滚旧代码。
- 若历史实现与当前架构不兼容：迁移语义合同到当前唯一 owner，不复活旧旁路、旧 provider、旧 fallback。

四、判定与修复
- 只有同时满足“架构 owner 明确、首次偏离节点明确、问题可复现、最小 red test/真实样本存在、修复路径不越界”才修改。
- 先证明当前失败，再只改唯一 owner；使用最小可审查 patch。禁止脚本批量语义替换。
- 正反测试成对：证明正确路径有效，也证明不会丢语义、误切换、误终态、误释放或伪造成功。
- 不确定是否应改、协议合同未定、文档与代码无法裁决：只写报告，标记“需架构决策”，不要改代码、配置或文档结论。

五、验证闭环
- 定向 red/green 测试、编译/build、架构/resource/function/mainline/verification gates。
- 运行时改动：按项目规则完成全局安装、一次 aggregate restart、所有成员 health、同入口旧样本或真实样本 replay。
- 对 provider/SSE/响应形状/切换问题必须完成同 requestId A/B/C：provider 最小直连、完整 provider-bound 原样直连、RouteCodex 同入口在线请求。
- 验证失败、样本缺失、运行版本不一致：不得宣称修复完成。
- 全部前置验证通过后才执行 AGY Review；review FAIL 必须修复并重跑受影响闭环。

六、输出报告
按优先级输出每项：
- severity：P0/P1/P2/P3
- status：fixed / report-only / blocked
- issue：一句话
- evidence：文件、符号、commit、样本、命令和结果
- first_deviation：首次语义偏离节点
- owner：唯一 owner 与允许修改路径
- compatibility_impact：客户端/provider/协议影响
- root_cause：根因，不写最终报错点代替根因
- fix：实际改动；report-only 写“未修改 + 需谁决策”
- verification：正向、反向、在线/历史样本证据
- remaining_risk：未闭环风险

结论规则：没有证据不下结论；没有在线/真实样本证据不称运行时完成；架构不清只报告不修改；禁止用 fallback、换 provider、改路由、裁剪 payload 或输出层补丁制造绿色结果。
```

## 完成标准

- 每日扫描结果可追溯到架构节点、唯一 owner、真实代码和验证命令。
- 修复项具备根因、最小红测、唯一 owner 修复、正反验证和必要在线复测。
- 不确定项保留为 report-only，不被“顺手修复”。
- 架构文档、manifest、maps、tests 和实现保持一致；发现漂移先修架构真源或报告决策缺口。
