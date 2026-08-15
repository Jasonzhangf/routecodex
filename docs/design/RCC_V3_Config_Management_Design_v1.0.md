# RCC V3 Config Management Design

> 收口 RCC V3 配置管理体系（CLI/WebUI/Runtime 同一入口），按
> [RCC_V4_Config_Management_Design_v1.0.md](./RCC_V4_Config_Management_Design_v1.0.md)
> 在 V3 运行时上落盘。V4 升级路径见原文档与
> [v4-cordis-plugin-framework-and-webui-plan.md](../goals/v4-cordis-plugin-framework-and-webui-plan.md)。

## Goal

CLI / WebUI / Runtime 三个面共享一个 Config Core，配置读写全部下沉到
`routecodex-v3-config-mgmt`；不改路由算法，不引入数据库，不新增持久化格式。

## 模块边界

```text
                ┌───────────────────────────────────────────┐
                │         rccv3 init / rccv3-admin / API     │
                │   CLI、axum admin server、WebUI 页面       │
                └───────────────────────────────────────────┘
                                │
                                ▼
    ┌───────────────────────────────────────────────────────────┐
    │  routecodex-v3-config-mgmt（Config Core，唯一 owner）     │
    │  - provider parser/generator (V2 file)                    │
    │  - route view  (Port → Pool → Tier → Member)              │
    │  - forwarder builder / upsert                             │
    │  - validation（与 runtime 一致的全链编译校验）             │
    │  - atomic write (tmp + rename)                            │
    │  - backup（命名 `*.bak-<UTC-compact>-<reason>`）         │
    │  - revision（state/config-revisions.json，单调 seq）      │
    └───────────────────────────────────────────────────────────┘
                                │
                                ▼
    ┌───────────────────────────────────────────────────────────┐
    │  routecodex-v3-config（authoring + V3ConfigStore）        │
    │  + V3ManagedLifecycle（routecodex restart）               │
    └───────────────────────────────────────────────────────────┘
```

CLI / WebUI / Runtime 都不允许自行解析配置：解析、生成、原子写、备份、
修订全部经 Config Core 编排；只允许 CLI / API 直接调用 Config Core 暴露
的函数。

## CLI 初始化（`rccv3 init`）

流程：

1. 检查已有配置：`~/.rcc/config.v3.toml` 存在 + `--force` 关闭时拒绝重复初始化。
2. 选择 provider：内置 6 个官方预设（openai / anthropic / deepseek / gemini /
   openrouter / lmstudio） + custom 子命令，或 `--provider <id>` 直接指定。
3. 输入必要字段：base URL、默认模型、api key 形态（直填 / env / token file）。
4. 生成 provider 文件：`~/.rcc/provider/<id>/config.v2.toml`，原子写入并
   自动备份（首次无 backup）。
5. 创建最简 default route pool：单 target、priority=1、key=key1，路由组
   与 server 同名（routecodex_v3_<port>）。
6. 提交配置：validate → backup → atomic replace → 写入
   `state/config-revisions.json`（seq=1, action=init）。

`--force` 重新写入 provider 与 config，但 `config-revisions.json` 始终
只追加；旧 entries 保留作为审计轨迹。

## WebUI 三页面

### Dashboard（`/`）

- Cards：runtime 状态、端口健康数、Provider 总数/启用数、累计请求数、
  日请求数、日志尾部请求数 / provider error 数、修订条目数。
- Port 列表：每行 server_id + 127.0.0.1:port + endpoints + healthy/down badge。
- Route actual traffic：从 server-v3-*.log 最近 32 MB 聚合
  `route_selected` 事件的目标分布，按计数渲染条形图。
- Revisions：最新 10 条修订记录（seq / ts / action / reason）。

### Routes（`/routes.html`）

分层折叠树：

```text
routing_group
└── Port <port>
    └── Pool <name>
        └── Tier <priority>
            └── Member <provider/model[/key]>  (weight=w if present)
```

CRUD 与 Drawer：

- 树节点 hover 显示 `+ Pool / + Tier / + Member` 按钮（新增）和 Edit /
  Delete 按钮（修改 / 删除）。
- Drawer 编辑：Pool、Tier、Member 三个独立表单，支持 tier priority、
  member provider/model/key/priority/weight 字段。
- 顶部按钮：`Validate`（不落盘，只跑 compile_v3_config_05_manifest）、
  `Save`（PUT /api/routes 提交，触发 Config Core commit）、`Reload`。
- 失败保持旧配置：服务端 validate 失败 → 返回 400 + error，原文件不动。

### Providers（`/providers.html`）

- Cards：Total / Healthy / Warning / Untested / 累计请求 / 日请求。
- Provider 列表表格：id / type / endpoint / status badge / latency / models
  count / action（Health test / Detail）。
- Provider Detail Drawer：Configuration（Name / Type / Endpoint / Models /
  Auth 形态 / Timeout），Health（最近一次测试结果 + Run health test），
  Reference（被哪些 route_groups/pools/tiers 引用，含 forwarder 引用），
  Models（每个 model 的 capability 列表）。

`Avg latency / Success rate / 错误数` 等待 V3 runtime 暴露运行时统计；
当前 Dashboard / Providers 显示 `—`（not collected runtime metric），由
后续 V4 inspector/Runtime 升级补齐。

## Dynamic Reload

```text
Save (UI / API)
  └─► Validate (authoring → manifest, 含 provider 目录解析与引用校验)
        └─► 失败：返回 typed error，原文件不动
        └─► 成功：
              ├─► 备份当前 config.v3.toml（首次无）
              ├─► Atomic replace（tmp + rename）
              └─► 追加 revision（seq 单调，target=runtime, result=committed）
Reload (POST /api/reload)
  └─► Validate again
        └─► spawn_blocking("routecodex restart")
              ├─► 成功：append revision(action="reload", result="restarted")
              └─► 失败：返回 500 + stderr tail，runtime 不动，文件已是
                  上一次成功 Save 的版本（valid + committed）。
```

设计要点：

- Reload 失败绝不回滚——上一次 Save 已通过 validate，是当前正确配置。
- 在途请求由 V3 runtime 聚合 restart 协议（exec 重启同一 listener PID 集合）
  完成，新请求使用新配置；旧 in-flight 旧配置直到 drained。
- 配置版本可追踪：`state/config-revisions.json` 保留 seq/ts/action/target/
  reason/backup/source_sha256/result 字段。

## Config Core API

```rust
pub fn route_groups_from_authoring(authoring: &AuthoringParsed) -> Vec<RouteGroupView>;
pub fn apply_route_group_view_to_authoring(authoring: &mut AuthoringParsed, group: &RouteGroupView);
pub fn list_provider_ids(config_dir: &Path) -> Result<Vec<String>, String>;
pub fn read_provider_file(config_dir: &Path, provider_id: &str) -> Result<ProviderFileEntry, String>;
pub fn write_provider_file(config_dir: &Path, provider_id: &str, config: &V2ProviderConfigFile) -> Result<PathBuf, String>;
pub fn upsert_forwarder(authoring: &mut AuthoringParsed, name: &str, forwarder: V3ForwarderAuthoringConfig);
pub fn new_forwarder_with_target(model, provider, provider_model, key, priority, weight) -> V3ForwarderAuthoringConfig;
pub struct ConfigMgmtStore { /* config path + revision store */ }
impl ConfigMgmtStore {
    pub fn read_authoring(&self) -> Result<V3Config02AuthoringParsed, V3ConfigMgmtError>;
    pub fn validate(&self, authoring: &V3Config02AuthoringParsed) -> Result<V3Config05ManifestPublished, V3ConfigMgmtError>;
    pub fn commit_with_backup(&self, authoring, action, reason) -> Result<CommitOutcome, V3ConfigMgmtError>;
}
```

## 验证矩阵

| 层级 | 测试 | 文件 |
| --- | --- | --- |
| L3 Config Core | 7 测试：route view roundtrip / provider 文件写读 / atomic + backup + revision / forwarder build | `v3/crates/routecodex-v3-config-mgmt/tests/l3_config_mgmt.rs` |
| L4 Admin API | 6 测试：overview / routes get / validate / providers list / revisions+static / health test | `v3/crates/routecodex-v3-admin/tests/l4_admin_api.rs` |
| L4 CLI init | `rccv3 init --provider deepseek --api-key sk-test --port 7777` 端到端生成 provider + config + revision | 集成 smoke |
| L4 WebUI | Playwright headless：Dashboard / Routes / Providers 页面渲染、validate 提交、Provider Detail Drawer、Console 无错误 | `/tmp/rcc-webui-*.png` |

`cargo test --workspace --no-fail-fast` 1382 测试全绿。

## 治理注册

- `docs/architecture/repository-filesystem-module-registry.yml`：新增
  `v3.config_management` 模块声明 owned_paths / allowed_paths / forbidden_paths /
  allowed_edges / forbidden_resources。
- `docs/architecture/v3-verification-map.yml`：新增 `feature_id: v3.config_management`
  验证条目（status: implementation_active_pending_release_rollover）。
- 验证门禁：`cargo test -p routecodex-v3-config-mgmt`、
  `cargo test -p routecodex-v3-admin`、
  `cargo test --workspace --no-fail-fast`。

## 已知边界与后续

- 不实现 Runtime 流量 / 错误率 / 延迟的运行时聚合（Dashboard 与 Provider
  详情显示 `not collected runtime metric`）——这是 V4 inspector / V3
  runtime observability 的范围，本次不做。
- `rccv3-admin` 不内置 auth/authorization——设计文档要求 UI 在可控网络内
  访问；生产部署需前置 reverse proxy auth（待 follow-up）。
- V4 迁移路径：Config Core 暴露的 `route_groups_from_authoring` /
  `apply_route_group_view_to_authoring` 等函数是纯 Rust 数据变换，可在
  V4 nodegraph / WebUI 阶段直接复用；不需要重新建模。