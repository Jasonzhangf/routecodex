# V4 Cordis 并发治理测试设计

## 生命周期

验证 claim 原子性、独立 worktree/base HEAD、task 依赖、唯一 `codex/v4-cordis-refactor-main` target、checker merge receipt、主树复验、claim release 和 cleanup 顺序。测试只读治理 manifest、文档和 map，不安装、重启或调用 runtime。

## 正向

- canonical manifest 通过 schema、所有 task 独立 claim/非空依赖、唯一 merge target、post-merge verification、M05/D0/M08 blocker 非解决声明。
- package gate 从 V4 根目录可运行；JSON 解析和 `git diff --check` 通过。

## 反向 red-first

逐项删除 independent claim、依赖、post-merge verification、cleanup step，及将 manifest/task target 改为 `main`；每项必须失败。`--red-self-test` 在内存 fixture 上锁定这些反例。

## 边界审计

确认 diff 不包含 runtime、runtime-bin、ExecutionEngine、D0、M08、Active artifact、V3、父进度文件或全局运行时；确认 manifest 不把 blocker 写成 resolved，不新增第二套 graph，不引入 fallback。

## 已知缺口

本治理 gate 不替代 M05、D0、M08 自身的 runtime/build/install/live gate，也不解除 M00-T05 provider blocker；这些只在主线 task 的真实 evidence 中判定。
