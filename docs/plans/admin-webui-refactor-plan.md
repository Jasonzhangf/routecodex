# Admin WebUI 重构方案（v3/admin-webui）

- 状态：已确认待实施
- 落盘日期：2026-09-12
- 执行方式：2026-09-13 08:00 定时启动实施
- 内容参考：New API / OneAPI 风格用量面板（统计卡 + 环图 + 筛选栏 + 用量表）
- 信息架构参考：claude-code-router `packages/ui`（React monorepo，仅借鉴信息架构，不采用其技术栈）
- 视觉表达：**Ambient CSS 物理光照系统**（https://ambientcss.vercel.app/）——光影是本次视觉的唯一来源

## 0. 背景与现状

当前 webui 是零构建纯静态页面，共约 3400 行，通过 `include_str!` 嵌入 `routecodex-v3-admin` 二进制：

| 文件 | 行数 | 内容 |
| --- | --- | --- |
| `v3/admin-webui/requests.html` | 1496 | 统计卡、手写柱状图、端口 Tab、多层筛选、entries/attempts/errors 三视图、CSV 导出 |
| `v3/admin-webui/styles.css` | 863 | "beUI" 中性 zinc 深色主题，颜色只保留错误红 |
| `v3/admin-webui/routes.html` | 366 | 路由编辑器 |
| `v3/admin-webui/providers.html` | 222 | Provider 管理 |
| `v3/admin-webui/index.html` | 213 | Dashboard |
| `v3/admin-webui/app.embedded.txt` | 149 | 共享工具（api/el/fmt/badge/reload/autorefresh） |

关键锚点：

- 嵌入：`v3/crates/routecodex-v3-admin/src/lib.rs:13-18`（`include_str!`）。
- 分发：`v3/crates/routecodex-v3-admin/src/api/mod.rs` `static_serve`，固定文件白名单，`Cache-Control: no-store`。
- API 面（owner 全部在 routecodex-v3-admin）：
  - `GET /api/overview`
  - `GET /api/observability/records`（facets / 分页 / 排序）
  - `GET /api/observability/cooldown-pool`
  - `GET /api/providers`、`GET /api/providers/:id`、`POST /api/providers/:id/health-test`
  - `GET/PUT /api/routes`、`POST /api/routes/validate`
  - `POST /api/reload`、`GET /api/revisions`
- 架构契约：`docs/architecture/v3-function-map.yml` 特性 `v3.admin_observability_aggregation`（owner_crate `routecodex-v3-admin`）的 owner_files/allowed_paths 包含 `v3/admin-webui/requests.html`、`v3/admin-webui/styles.css`；forbidden_paths 指向数据面资源，不可触碰。
- 兼容性测试：`v3/crates/routecodex-v3-server/tests/admin_webui_managed.rs` 断言 `GET /requests.html` 返回 200 + HTML，页面 URL 结构不可破坏。
- smoke：`v3/admin-webui/requests-filter-smoke.mjs`、`requests-usage-layout-smoke.mjs` 对 HTML 源码做正则断言，未接入 package.json gate。

痛点：每页复制 drawer/status-bar/refresh 逻辑；`requests.html` 单文件 1500 行内联 JS；缺少"统计卡 + 环图 + 筛选栏 + 明细表"的用量分析视图。

## 1. 技术决策：保持零构建 vanilla，不引入 React

结论：**保留 vanilla + 零构建，做"组件化 + 换脸"**。

- 把 `app.embedded.txt` 拆成 ES modules（`app/*.js`），`static_serve` 白名单显式扩展。自研代码无外部依赖，无需打包器。
- 环图手写 SVG（约 60 行），柱状图沿用现有手写实现抽进 `charts.js`。
- 保留 4 个 HTML 入口作为薄壳（引同一套 shell 模块），URL、书签、`admin_webui_managed` 测试全部不动。
- 拒绝项：CDN/npm runtime 依赖（破坏离线与嵌入契约）、Vite/React 构建链（发布路径多一个 node build 步骤，4 视图管理台收益不足）。
- 备选记录：若后续上实时日志流、虚拟模型管理等大功能，再评估迁 Vite + React，届时 `static_serve` 改为嵌入构建产物；本次不为其预支成本。

## 2. 目标形态

### 2.1 布局（CCR 式外壳 + 参考图式内容区）

```
┌────────┬──────────────────────────────────────────┐
│ ◧ RCC  │  Dashboard                    [Refresh][Reload] │
│        │  ┌─────┐┌─────┐┌─────┐┌─────┐┌─────┐     │
│ Monitor│  │今日请求││今日tokens││错误││均时││RPM│     │
│  Usage │  └─────┘└─────┘└─────┘└─────┘└─────┘     │
│ Setup  │  ┌──────────┐ ┌────────────────┐         │
│ Routes │  │ ◔ 环图    │ │ ▂▄▆█ 柱状图     │         │
│ Provs  │  └──────────┘ └────────────────┘         │
│        │  [筛选栏: 时间|模型|Provider|端口|路由]      │
│        │  ┌────────────────────────────┐          │
│        │  │ 用量/明细表                  │          │
│        │  └────────────────────────────┘          │
└────────┴──────────────────────────────────────────┘
```

- 导航分组：Monitor（Dashboard、Requests/Usage、Cooldown）、Setup（Routes、Providers），与现有四页一一对应，不新增页面。
- 保留 Refresh / Reload 顶栏动作、status-bar、auto-refresh、详情 drawer。

### 2.2 视觉表达：Ambient CSS 物理光照系统（styles.css 重写）

**决策**：全部光影表达遵循 Ambient CSS。不是"深色主题 + 手工阴影"，而是**声明一个光源，所有阴影、高光、表面渐变、材质明暗由该光源推导**。

Ambient CSS 的机制（源码 `https://ambientcss.vercel.app/assets/index-YaHZitHb.css`，62KB，纯 CSS 无运行时依赖）：

- 光源：`--amb-light-x` / `--amb-light-y`（方向，取值 -1..1）、`--amb-key-light-intensity`（主光）、`--amb-fill-light-intensity`（补光）、`--amb-light-hue` / `--amb-light-saturation`（色温）、`--amb-light-distance`。
- 材质：`--amb-albedo`（材质基色，默认 `color(srgb-linear .82 .82 .82)`）、`--amb-mat-specular`、`--amb-mat-roughness`、`--amb-mat-opacity`、`--amb-shade`、`--amb-grain-amount`。
- 几何：`--amb-chamfer` / `--amb-fillet` 与 `--amb-thickness`（`amb-thickness-0/1/2`）。
- 高程：`--amb-elevation` 0–3（`amb-elevation-0..3`）。
- 派生量（由以上推导，不手写）：`--amb-lit`（被照亮的表面色）、`--amb-lume`（自发光/强调）、`--amb-label`（文字色）、`--amb-exposure`、`--amb-curve-delta`。

组件类（按用途选，不逐一罗列）：布局 `.ambient`；表面 `.amb-surface` + `.amb-surface-convex` / `.amb-surface-concave` / `.amb-groove`；材质 `.amb-mat-matte` / `.amb-mat-shiny` / `.amb-mat-brushed` / `.amb-mat-glass` / `.amb-mat-blasted`；高度 `.amb-elevation-N`；光源方向 `.amb-light-tl/tr/bl/br/top/bottom/left/right`；控件 `.amb-button`（+`-cap`/`-round`/`-square`）、`.amb-switch`、`.amb-slider`、`.amb-select`、`.amb-led`、`.amb-led-off`、`.amb-glow`；发射色 `.amb-emit-amber/blue/cyan/green/red/white`；字体 `.amb-heading-1/2/3`。

**照明场景声明**（放在 `:root`，全站唯一光源，Agent 不得逐组件覆盖方向或强度）：

```css
:root {
  /* 位置：左上主光，符合阅读方向；深色控制台用高主光比 + 低色温饱和 */
  --amb-light-x: -1;
  --amb-light-y: -1;
  --amb-key-light-intensity: 0.42;   /* 主光偏低 = 暗环境控制台 */
  --amb-fill-light-intensity: 0.30;  /* 补光防止纯黑死区 */
  --amb-light-hue: 234;              /* 冷灰蓝环境光 */
  --amb-light-saturation: 15%;
  --amb-albedo: color(srgb-linear .16 .18 .22);  /* 深色机身材质 */
  --amb-lume-hue: 172;               /* 强调光 = teal，唯一强调色 */
}
```

- `--amb-lume-hue: 172` 是替代原方案的 `--accent: #14b8a6`：强调色不再是写死的 hex，而是**光源的发光色相**，`.amb-glow` / `.amb-led` / 按钮发光由它统一推导。
- Ambient CSS 无 `prefers-color-scheme`、无 `.dark` 类，是**单主题光源系统**。本次只做深色控制台一个场景，不引入亮色变体；亮色留作 backlog（需重新声明一套光源，不是加个 class）。

**映射规则（现有语义 → Ambient）**：

| 语义 | 实现 |
| --- | --- |
| 页面底 | `.ambient.amb-surface` + `--amb-albedo` 深色 |
| 卡片/面板 | `.amb-surface` + `.amb-elevation-1`；凹陷容器（表格槽、代码块）`.amb-surface-concave` |
| 顶栏/侧栏 | `.amb-elevation-0`，靠 `.amb-groove` 分隔，不用边框线 |
| 主按钮 | `.amb-button .amb-button-cap .ambx-press-md`；危险动作加 `.amb-emit-red` |
| 状态 LED | `.amb-led` + `--amb-led-color`：成功绿 / 警告琥珀 / 错误红；停用态 `.amb-led-off` |
| 错误高亮 | `.amb-emit-red` 发光 + `--amb-label` 文字，保持旧的"错误只用红"语义 |
| 图表柱 | `.amb-surface-convex` 受光面 |
| 文字层级 | `.amb-heading-1/2/3` + `--amb-label`；表格数字继续 `font-variant-numeric: tabular-nums` |

**硬约束**：

- 禁止手写 `box-shadow` 表达深度；深度一律由 `--amb-elevation` 产生。内联阴影只允许来自 Ambient 自身的 `.amb-groove` / `.amb-surface-concave`。
- 禁止手写渐变色值表达体积；由 `.amb-surface-convex/concave` 按光源角度生成。
- 禁止新增第二套强调色；强调一律经 `--amb-lume-hue`。语义状态色（成功/警告/错误）通过 `.amb-emit-*` 与 `--amb-led-color` 表达。
- 光影不承担信息层级之外的装饰：不做鼠标跟随光斑、不做装饰性 glow 动画（`.amb-glow` 只用于真实状态反馈）。
- 必须保留 `prefers-reduced-motion: reduce` 降级；Ambient 的按压/过渡动效在 `amb-shade`/`thickness` 变化上轻量，但状态切换仍需该守卫。

**集成方式**：Ambient CSS 以 vendor 方式落盘为 `v3/admin-webui/vendor/ambient.css`（62KB，纯 CSS），不引 CDN（保持离线与嵌入契约）；`include_str!` 白名单加入该文件并随 UI 资产一同分发。理由：手工复刻光照公式会立刻漂移，且 Ambient 已按 Blender 光线追踪校准。

**验收的可执行检查**：

1. `grep -c "box-shadow" styles.css` 结果中，除 Ambient 自身定义与继承处外，项目自写样式为 0。
2. 切换 `--amb-light-x/y` 到四个角，所有面板明暗朝向应随之变化（这是"光影真的由光源推导"的可观察证据）。
3. 把 `--amb-albedo` 改为任一色值，全部表面材质应整体重着色，而强调色保持 teal。
4. 抽查 3 个关键表面（卡片、主按钮、表格槽）截图，记录：光源方向一致性、无手写阴影残留、文字对比度 ≥ WCAG AA。

- 文案统一为英文（现有主体是英文，"导出 CSV/已选 N 行"等中文按钮一并改英文）。

### 2.3 Usage 页（重构重心，requests.html）

- 顶部统计卡：今日请求数、今日 tokens（input+output）、今日错误、平均时长、RPM 峰值（今日每分钟最大请求数，由 timeseries 计算）。
- 环图：模型调用分布（top 8 + Other，带图例与计数）。
- 筛选栏：现有左侧 filter rail 改为参考图式横向筛选栏，能力全保留：时间范围（today/week/month）、模型、Provider、端口、端点、路由、协议、模式、状态 Tab、排序。
- 视图 Tab 新增"Summary（汇总）"：按 model / provider / route / port 分组的用量汇总表，列：请求数、input tokens、output tokens、cached tokens、缓存命中率、错误数。先客户端聚合 records；若性能不足再加 `GET /api/observability/usage?aggregate=...`（增量接口，owner 仍是 admin crate，不碰 forbidden paths）。
- 全保留：Entries / Attempts / Errors 三视图、状态码分组行、exclude chips、分页、CSV/TSV 导出、selection bar、列宽拖拽。

### 2.4 目标文件结构

```
v3/admin-webui/
  index.html / routes.html / providers.html / requests.html   # 薄壳入口，URL 不变
  styles.css                    # 布局 + 项目样式；光影全部走 Ambient
  vendor/ambient.css            # Ambient CSS vendor（62KB，光照系统，禁止改公式）
  app/
    core.js                     # api()/el()/fmt/badge/status/autorefresh（自 app.embedded.txt 迁移）
    shell.js                    # sidebar + 顶栏渲染、导航分组
    charts.js                   # SVG 柱状图 + 环图
    drawer.js                   # 详情抽屉
    views/
      dashboard.js
      usage.js                  # requests 主视图（含 Summary 汇总）
      providers.js
      routes.js
```

- `static_serve` 白名单逐文件显式加入 `app/*.js` 与 `app/views/*.js`，维持固定白名单契约（不做目录遍历）。
- `app.embedded.txt` 及 `/app.js`、`/app.embedded.txt` 旧路由：迁移完成后在 Phase 5 检查无引用再删除。

## 3. 实施阶段与 gate

每阶段结束必须跑该阶段 gate，不过不许进下一阶段。预估 5–6 个工作日。

### Phase 0 — 契约对齐（0.5d）

- 更新 `docs/architecture/v3-function-map.yml`：`v3.admin_observability_aggregation`（及所有引用 admin-webui 路径的特性，先 grep 确认）的 owner_files/allowed_paths 纳入 `v3/admin-webui/app/*.js` 与 `vendor/ambient.css`。
- 同步检查 `docs/architecture/v3-verification-map.yml` 是否需要补锚点。
- Gate：`npm run verify:v3-resource-map`、`npm run verify:v3-module-boundaries`。

### Phase 1 — 光影系统 + 外壳（1d）

- 抓取 Ambient CSS 生产产物落盘为 `vendor/ambient.css`（源：https://ambientcss.vercel.app/assets/index-YaHZitHb.css，62KB；完整性校验：文件 ≥ 60KB 且含 `--amb-elevation` 与 `.amb-surface-convex` 定义），并在 `:root` 声明全站光源场景（见 2.2），扩 `static_serve` 白名单与 `lib.rs` 的 `include_str!` 常量。
- 重写 styles.css：用 Ambient 表面/高程/材质类替换现有手写背景、边框、阴影；拆 ES modules（core/shell/charts/drawer）；实现 sidebar 外壳。
- 执行 2.2 的 4 项可执行验收检查（自写 box-shadow 归零、四角光源响应、albedo 重着色、关键表面截图）。
- Gate：`CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-admin`、`cargo test -p routecodex-v3-server --test admin_webui_managed`。

### Phase 2 — Dashboard（1d）

- 统计卡行、环图（路由/模型分布）、ports/revisions 面板换新壳，卡片点击 detail drawer 保留。
- Gate：同 Phase 1 + 手动截图对比。

### Phase 3 — Usage 页（2d，最大块）

- 横向筛选栏、统计卡 + 环图 + 柱图、Summary 汇总表、三视图迁移；重写两个 smoke 为新结构断言并接入 package.json（新增 `verify:webui-smoke`，不与现有脚本重名）。
- Gate：Phase 1 gate + `node v3/admin-webui/requests-filter-smoke.mjs`、`node v3/admin-webui/requests-usage-layout-smoke.mjs`（或新入口）。

### Phase 4 — Providers / Routes（1d）

- 只换视觉与外壳，编辑器逻辑不动。
- Gate：`CARGO_NET_OFFLINE=true cargo test --manifest-path v3/Cargo.toml -p routecodex-v3-admin`。

### Phase 5 — 收尾验证（0.5d）

- 删除 `app.embedded.txt` 旧路由（确认无引用）；全量 gate：上述全部 + `git diff --check`。
- 按 `docs/agent-routing/20-build-test-release-routing.md` 执行 build/install/restart/health/同入口 replay。
- 按 AGENTS.md Evidence Boundary 分级出证据：source / test / build / install / restart / health / replay 分开报告，禁止用前一级推断后一级。

## 4. 非目标（本次不做）

- 不引入 React / Vite / 任何 npm 运行时依赖或 CDN 资源；Ambient CSS 以 vendor 文件落盘，不走 CDN。
- 不新增页面、不改既有 API 语义（新增接口只做增量）。
- 不做实时日志流、i18n 扩展、图表库替换。
- 不做亮色主题（Ambient 是单主题光源系统，亮色需另声明一套光源，记 backlog）。
- 不修改 Ambient CSS 的光照公式；如需调光只改 `:root` 场景变量。

## 5. 风险与对策

1. **Map 漂移**：新增前端文件未进 function-map 会被 `verify:v3-resource-map` 挡下 —— Phase 0 先行。
2. **源码正则 smoke 脆弱**：Phase 3 同步重写并接入 gate。
3. **URL 兼容**：`/requests.html` 等路径被 server 测试断言 —— 薄壳入口方案规避。
4. **范围蔓延**：环图/筛选/汇总表之外的需求记 backlog，本次不做。
5. **现代 CSS 特性兼容**：Ambient 依赖 `color()` / `color-mix()` / `hsl(from …)` / `@property` / `sign()` / `pow()`，需要新版 Chrome/Safari/Firefox。管理台受众是开发者本机，接受此约束；Phase 5 必须在目标浏览器实际渲染抽样截图并记录浏览器版本证据。SVG 环图/柱图为独立实现，不受此风险影响。

## 6. 变更记录

- 2026-09-12 23:50 落盘（untracked）。
- 2026-09-13 00:53 被并行 dirty-recovery 会话清理误删。
- 2026-09-13 00:5x 从原文恢复，并 commit 到非保护分支 `codex/root-dirty-recovery-0908` 防止再次被清；8:00 定时任务未受影响（从未触发，runCount=0）。
- 2026-09-13 01:0x 视觉表达改为 Ambient CSS 物理光照系统（用户指定 ambientcss.vercel.app），重写 2.2 与 Phase 1，新增 `vendor/ambient.css` 与现代 CSS 兼容性风险。
- 2026-09-13 08:0x 08:00 定时任务触发：从 origin/main (8a1d90ca2) 新建 worktree `codex/webui-ambient-refactor-0913` 执行；最终合并到 main 由用户提交。
