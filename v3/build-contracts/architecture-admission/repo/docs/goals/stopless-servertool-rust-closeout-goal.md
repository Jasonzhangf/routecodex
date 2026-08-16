# /goal prompt: stopless goal state bridge / servertool Rust closeout

主目标：
- 闭环 stopless goal state 桥接故障，并把 servertool 真源收回 Rust；同时清理 persisted 503 / reprobe 旧语义残留。

参考文档：
- 项目 AGENTS.md
- docs/design/servertool-stopmessage-lifecycle.md
- docs/design/servertool-followup-rebuild-from-origin.md
- docs/design/pipeline-type-topology-and-module-boundaries.md
- docs/agent-routing/30-servertool-lifecycle-routing.md

执行规范（缩略版）：
- 先读真源与现有证据，写 note.md。
- 先做红测，后改代码；禁止 fallback / 降级 / 双路径补偿。
- 优先定位唯一真源修改点；若 servertool/stopless 仍经 TS bridge 走，必须先证明为何不能直接收回 Rust，再最小化收口。
- 同步清理 persisted 503 / reprobe 的测试名、注释、死代码和运行时语义残留。
- 每次修改后必须跑定向测试；能在线验证必须在线验证；能重放样本必须在线重放样本验证。

验证要求：
- 至少包含：
  - bridge / stopless focused red-green tests
  - Rust focused tests
  - 在线 smoke / 真实样本重放
- 必须同时做正向与反向测试，锁住“该发生”和“不该发生”。

完成标准：
- stopless goal state 路径在唯一真源上闭环，不再静默失效。
- servertool 语义不再依赖错误 TS 导出名或重复实现。
- persisted 503 / reprobe 旧语义从代码、测试、注释中清理完毕。
- 已验证结果、剩余风险、下一步写回 note.md / MEMORY.md。
