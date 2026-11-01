# 共享采样目录的并发启动回归

本修复对应缺陷 `4da2a38`。已有图为 `docs/architecture/dags/v3.codex_sample_persistence.graph.json`。保持其单源单汇拓扑；只补齐最后一个节点内部的文件系统互斥。唯一 owner 是 Debug 的 `V3CodexSampleStore`。不改 Provider、请求语义、客户端通信或服务生命周期。

## 已确认的故障与能力

任务独占阶段笔记：`$HOME/.rcc/evidence/dsh-session-disconnect-20261003/notes.md`。证据同目录下的 `h2-retention-probe-500.log`、`h2-retention-probe-500.json`、`h2-retention-probe-0.log`、`h2-retention-probe-0.json` 及 `h2-retention-startup-probe.mjs`。路径中的 HOME 从当前运行环境读取；采样实验的 HOME 是证据 receipt 中的私有目录，不是生产 HOME。

同一源版本 `c7144a4b9e08da5c35c68d0d06c7ea3c0f867afd` 的原 H2 public CLI 黑盒，在私有 HOME 中放入 500 个旧样本时两次发生启动 ENOENT；空采样目录对照 7/7 通过。所有 CLI 的 lifecycle state/config 都独立，只有 HOME 采样目录共享。原基线 main 的 Linux CI 也出现相同启动故障。证据由任务笔记指向 `h2-retention-probe-500.log` 和 `h2-retention-probe-0.log`。

启动调用链在绑定监听器前执行 `enforce_listener_retention`。它和保存样本都会扫描、读取 metadata、删除旧目录。现有锁是单个 store 内的 Mutex，无法协调另一 store 或另一进程。因此一个进程删除另一个进程正读取的目录时，ENOENT 经 aggregate 初始化传成 managed lifecycle IO 错误。

真实 consumer 是官方 CLI 的 `server start --foreground` 与 HTTP `/health` 和 `/v1/responses`。定向 cargo runner、精确源版本构建、公共接口、独占临时 HOME、失败日志、正式 CI、官方安装/重启、review、PR 集成与本任务资源清理能力已确认。所有实验进程由 fixture 持有，运行中服务不受影响。

## 节点与资源约束

```mermaid
flowchart LR
  A[接纳保存任务] --> B[排空已接纳任务]
  B --> C[取得共享采样目录互斥并原样保存和执行保留策略]
  C --> D[返回保存结果或显式文件错误并释放互斥]
```

节点 C 仍读取/写入 `v3.debug.codex_sample_filesystem`。启动保留策略调用同一个互斥 owner。使用固定在样本根目录内的锁文件及标准库 `File::lock`；取得锁后才检查、创建、读取、写入或清理样本目录。持锁 File 的 RAII 负责全部返回路径解锁。锁文件不属于 request 目录，不进入 100 条保留计数，也不写入业务 payload。不能用忽略 NotFound、重试、延时或串行测试代替资源协调。移除被文件锁替代的 store-local persistence Mutex，避免两套互斥 owner。真实权限/锁/写入错误保持显式错误结果和既有 failure ledger。

## 黑盒验收与终点

新增稳定用例 `shared_sample_retention_parallel_cli_startup_blackbox`。以私有共享 HOME 的 500 个旧样本启动多个独立 CLI，配置和 lifecycle state 均独立。每个进程必须健康；公共 Responses 请求必须获得外部 TCP provider 的真实响应；样本必须原样保存；全局保留数必须不超过 100。正常退出或任何失败都回收本用例持有的子进程及临时目录。不能通过改变原 H2 并发级别、mock 内部 store 或削弱错误断言通过。

失败用例使用不可写或无效锁文件，通过公开 Debug consumer/harness 验证真实文件错误不被吞掉。原 Debug failure ledger/barrier/关闭排空测试保持通过。运行原并行 H2 500 样本实验并对比修复前 RED、修复后 GREEN；运行 Debug owner、CLI 新黑盒及现有 H2 测试，再完成所需架构 gates 和精确候选 CI。

设计 review 只接受 owner、锁生命周期、文件系统语义及验收边界；实现后独立架构 review 仍须另行完成。合并、main 构建、官方安装/重启、运行身份、真实入口及资源回收证据齐备前，本缺陷保持 OPEN。
