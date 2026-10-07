# S12 lifecycle operation lock crash recovery

Issue5bf796d；唯一owner fs_locks.rs::acquire_operation_lock 和lib.rs::OperationLock，只改本struct/Drop范围，不碰S11 start/spawn owner。引用lifecycle-design/result.md S12及project graph docs/architecture/dags/v3.operation_lock_recovery.graph.json。

create_new+Drop remove_file无法处理持锁进程SIGKILL。复用本crate现有status.lock的OS flock；fd持有所有权，File关闭即释放，锁文件保持同一inode不删除。LOCK_EX|LOCK_NB返回WouldBlock仍明确OperationLocked；其余I/O不吞。诊断文字不能决定锁拥有者，不增加PID日志解析、TTL或legacy V2路径。资源真源仍为已注册v3.lifecycle.operation_lock。

状态：打开锁文件→成功独占或明确冲突→操作完成/取消/进程退出释放fd→新caller可获得锁。崩溃终点由kernel释放，不依赖Rust Drop运行。成功、busy、I/O失败均单一结果出口。设计静态图不宣称SDK/runtime接线。

图修订2收敛到三个现有owner symbol：acquire_operation_lock完成打开及获得内核锁，V3ManagedLifecycle::start代表持锁公开操作，OperationLock::drop完成正常/取消释放；进程崩溃由kernel关闭fd达到相同资源终点，不声称SIGKILL会调用Rust Drop。删除原调查里未存在的exclusive/run/release/finalize概念helper，不为满足图新造函数。操作锁resource map绑定Drop及S11spawn owner（两者持有同一锁生命周期）；复用v3-life-02 caller边，不另造独立锁真源。

公开验收：新integration consumer通过公开V3ManagedLifecycle::start(real executable, timeout)保持操作占用；第二公开caller不得进入临界区。以独占helper明确PID SIGKILL持锁owner，下一公开start可以重新获得锁。用临时HOME/config/state/ports，真实OS process/file evidence；不mock acquire_operation_lock私有函数。先红再绿。命令：CARGO_NET_OFFLINE=true CARGO_BUILD_JOBS=2 node v3/scripts/run-v3-cargo-test.mjs -p routecodex-v3-lifecycle --test operation_lock_lifecycle -- --test-threads=1 --nocapture。另复用现有CLI正常生命周期regression。

升级边界：旧V3 CLI使用create_new，不能假设它和新flock并行互斥。当前修复不加第二种兼容锁真源；共享安装必须在明确维护窗口确认没有在执行的旧V3生命周期命令后切换canonical CLI。旧运行服务本身的运行状态不是持有operation lock的证据。父负责该交付边界；隔离作者黑盒只验证新实现caller及crash释放。跨版本并发支持不在本项承诺内，不能省略该升级限制。
