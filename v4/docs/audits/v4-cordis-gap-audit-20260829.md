# V4 Cordis 当前差距审计（2026-08-29）

基线：`v4-cordis` @ `9934f9a76`。本报告只描述当前分支源码与门禁实测，不把旧审计快照当作现状。

## 结论

V4 已具备可用的 Responses/Chat JSON/SSE canary，但尚未达到 Cordis 生产主链闭环。当前第一阻断不是协议样本，而是执行 owner、并发 listener、epoch 生命周期和准入记录仍未收敛。

## 已复核的红点

1. `npm run build` 与 `node scripts/architecture/verify-v4-feature-layer-batches.mjs --build-guard` 失败。真实原因是 D/E 候选记录仍锁定旧 source/gate 输入，且 integration wiring 观察值与 manifest 不一致；不能通过放宽 gate、伪造 hash 或复制 Active 产物解决。
2. `runtime-bin/src/main.rs` 仍调用 `V4HttpServer::run_until`，listener 按连接同步执行；长 SSE 或慢 provider 会阻塞同端口后续请求。
3. 请求初始选择已改为显式 `x-rccv4-route-group-id`，单组配置才允许无 header；重试/错误分支仍有 `route_groups.first()`，需继续迁移到同一 helper。
4. 生产入口仍持有 `Arc<Mutex<SkeletonRuntime>>`；NodeContainer/Cordis bridge 的输出没有被证明为每个相邻节点的唯一输入，存在第二执行语义。
5. `assert_no_control_leak` 原先只借用 data/control view，不检查 wire 内容；已在 `c522367ba` 修为解析 provider/client wire 并对控制字段 fail-fast。仍需在四入口在线 replay 中验证该边界。
6. NodeContainer 的 `PlanBindings::verify` 仍要求 graph/manifest/loaded-plan 三值相等；生产侧若继续复制同一 hash，版本绑定会退化为自比较，无法证明真实 manifest、Cordis graph 和 artifact set。
7. `ActiveExecutionEpoch`/lease 已有实现，但当前 `runtime-bin` 请求入口没有形成“admit → lease → terminal release”的可追踪主线；重启 drain 也未与请求/SSE lease 绑定。

## 当前优先级

| 优先级 | 修复项 | 依赖 | 验收 |
|---|---|---|---|
| P0 | feature-layer candidate/integration 真源重建 | AppSDK record owner | build-guard + admission PASS |
| P0 | Async listener + cancellation | server/runtime-bin owner | 并发 JSON、长 SSE、慢客户端正反测 |
| P0 | 请求/SSE epoch lease | execution-engine owner | in-flight、retire、drain、release 正反测 |
| P0 | NodeContainer 相邻输出接线 | runtime integration owner | 每条入口完整链路与 shortcut red gate |
| P1 | 独立 graph/manifest/plugin artifact identity | binding owner | 三方 hash 不同且可验证，错配 fail-fast |
| P1 | wire 控制泄漏 fail-fast | control boundary owner | 注入控制字段失败，正常 payload 保持等价 |
| P1 | route-group/weight/capability/error-action 真消费 | router owner | 配置差分 replay 与错误链验证 |

## 不可宣称完成的项

- V3 parity/live replacement
- Cordis production ownership
- 全 NodeContainer 主链
- managed restart 后的新版 binary 在线证据（当前 install 被 admission 拦截）
- AGY review（必须等 build/install/restart/真实 replay 全部通过）

## 固定推进顺序

```text
重建 candidate/integration records
→ build-guard/admission
→ Async listener + epoch lease
→ NodeContainer 相邻主链
→ global install
→ managed restart
→ 四入口 JSON/SSE + codex replay
→ AGY PASS
→ 精确 commit/push/tag
```

禁止 fallback、silent strip、payload cleanup、手工 Active 复制、V3 合并或全局 `main` 合入。
