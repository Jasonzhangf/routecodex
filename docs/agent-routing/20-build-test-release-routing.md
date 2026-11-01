# 构建、测试与发布路由

适用于 V3 本地构建、回归、安装与发布。先沿 `10-runtime-ssot-routing.md` 定位受影响 owner 和必要验证；已有效的定位与结果直接复用。

## 开发与测试

当前构建入口为 `npm --prefix v3 run build`，实现位于 `v3/scripts/build.mjs`。它运行独立构建边界检查、Rust workspace build 和 CLI 产物复制。不要先构建已退役的 `sharedmodule/llmswitch-core`。

按 `docs/architecture/v3-verification-map.yml` 选择受影响用例。运行时修复须有真实公开入口或实际 consumer 的成功、失败及副作用断言。真实失败样本存在时，复测同入口样本并保留 control。工具和 gate 变更验证对应 CLI/hook 行为；纯文档做针对性检查。

不因每次编辑或记录笔记重复运行全部 gate。完整且重大的 milestone 在作者验收后、提交或集成前做一次整体 review。提交、CI、main 合并、推送和清理沿 `05-foundation-contract.md`。

## 安装与运行边界

安装命令及其副作用以实际 `scripts/install-global.sh`、`scripts/install-release.sh` 和 `v3/package.json` 为准。`install:release` 当前包含安装及运行时重启/健康检查，不是普通开发检查。不要为治理、文档或 gate 消融调用安装脚本。

正式命令为 `rccv3`；`rcc` 和 `routecodex` 是兼容入口。当前 authoring 配置入口为 `~/.rcc/config.toml`，运行状态使用 `rccv3 status -c ~/.rcc/config.toml` 查询。安装和运行结果分别报告，不能从构建通过推断线上已生效。

4444/7777 承载实时流量。正式 `rccv3 restart`（含兼容入口 `rcc restart`）前须说明预计中断，无需另行人类授权。每次加载新构建只执行一次正式 restart；失败后先查原因，不盲目重复。stop/start（含所有参数及兼容入口）仍须先说明中断并取得人类明确批准，不得用它们或自行接管代替 restart。健康检查不能替代受影响请求重放。

## 对外发布

仅在实际准备对外发布时执行发布所需检查。开发期间不建立 SHA/checksum、候选身份、冻结快照或内容等价包装门禁。不提交构建产物；已发布历史记录不因本次消融重写。
