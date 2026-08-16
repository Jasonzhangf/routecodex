# Runtime Session Dir SSOT Plan

## Objective

收口 `ROUTECODEX_SESSION_DIR` 的语义，明确它只是 runtime workdir root，不再被当成语义 session id；把 `tmuxSessionId / sessionId / conversationId` 的职责边界、读写 owner、目录职责和 metadata 传递关系理清，并补齐可审查文档与最小 gate。

## Scope

In scope:
- 梳理 `ROUTECODEX_SESSION_DIR` 当前承载的状态类型与 owner
- 明确 `tmux session`、request `sessionId`、`conversationId`、server runtime lifecycle 的边界
- 把混用点写进 architecture wiki / runtime lifecycle 文档
- 收敛 stopless / CLI / routing state 的 sessionDir 取值与传递规则

Out of scope:
- 不做大规模目录迁移
- 不改无关 provider / routing 逻辑
- 不引入 fallback/dual-path

## Design Principles

- 只信 metadata carrier，不靠目录名猜语义
- 目录是运行时工作根，不是身份真源
- 每类状态必须有明确 owner/path
- 只有 protocol-independent continuation 必须保存/文件化；request-local stopless 等短生命周期状态不得借 continuation 名义落盘
- 先文档化，再做最小代码收口

## Target Docs

- `docs/architecture/wiki/metadata-boundary-map.md`
- `docs/architecture/wiki/runtime-lifecycle-call-graph.md`
- `docs/architecture/wiki/coverage-matrix.md`
- `docs/architecture/README.md`
- `docs/design/server-runtime-lifecycle-ssot.md`

## Implementation Notes

- 收敛 `sessionDir` 语义说明到 metadata boundary 和 runtime lifecycle 两页
- 如果代码继续需要 `sessionDir`，只允许显式 metadata carrier 传递
- 删除生产路径里多余的 env / 顶层字段兜底逻辑
- 保持现有文件名和 key namespace，不做隐式兼容层

## Risks

- 现有测试可能仍假设 `sessionDir` 可从 env 或顶层字段兜底
- `ROUTECODEX_SESSION_DIR` 在运行时仍可能被其他子系统复用，文档必须明确这不是 session id

## Verification Plan

- 定向 Jest：stopless / servertool CLI projection / session dir 相关测试
- 文档同步：wiki render + html sync
- 代码检查：`git diff --check`
- 如代码改动涉及 runtime 路径，再补 live/runtime probe

## Steps

1. 盘点 `ROUTECODEX_SESSION_DIR` 的所有读写 owner 和目录内容
2. 更新 architecture wiki，明确它是 runtime workdir root
3. 收口 stopless / CLI 的 sessionDir 传递规则为 metadata-only
4. 调整依赖旧兜底的测试
5. 跑定向验证并确认无格式/同步漂移

## Definition of Done

- 文档明确：`ROUTECODEX_SESSION_DIR` 不是语义 session id
- 代码明确：sessionDir 不再靠 env/顶层字段猜测
- 测试明确：旧兜底假设被替换为 metadata-only contract
- 可验证：wiki/html/gate 全部同步
