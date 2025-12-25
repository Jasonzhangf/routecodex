# Token Refresh Daemon 方案

## 概述

后台守护进程，监控 `~/.routecodex/auth/` 目录下的 Token 文件，自动管理 Token 刷新和重新认证。

## 核心职责

1. **监控 Token 文件** - 监控 `~/.routecodex/auth/*.json` 变化
2. **检测过期** - 读取 `expires_at` 判断是否即将过期/已过期
3. **自动刷新** - OAuth Token 提前30分钟自动刷新
4. **触发认证** - 失效时打开外部浏览器让用户重新认证

## 目录结构

```
~/.routecodex/auth/
├── iflow-oauth.json           # 账号: work@example.com
├── iflow-personal.json        # 账号: my@gmail.com
├── qwen-oauth.json            # 账号: dev@company.com
├── gemini-oauth.json
└── antigravity-oauth.json
```

## Token 文件格式

```json
{
  "access_token": "ya29.xxx",
  "refresh_token": "1//0xxx",
  "expires_at": 1735209600000,
  "email": "user@example.com"
}
```

## 用户识别方案

### 展示优先级

```
alias > email > name > account_id > 文件名
```

### 展示效果

| 文件名 | 显示名称 |
|--------|----------|
| iflow.json | 工作账号 (work@company.com) |
| iflow-personal.json | 个人账号 (my@gmail.com) |
| qwen.json | dev@company.com |

## 认证流程

### 1. 失效检测与通知

```
Token 即将过期(30min前) ──→ 后台自动刷新 ──→ 成功/失败通知
Token 已过期/刷新失败 ──→ 系统通知 ──→ 用户点击
```

### 2. 外部浏览器认证

```
用户点击通知 ──→ 打开外部浏览器 + 本地回调服务器
                                        │
                                        ▼
                    ┌───────────────────────────────────┐
                    │  认证页面显示:                     │
                    │  - 目标文件: iflow-work.json       │
                    │  - 账号: work@company.com          │
                    │  - [🔐 使用 Google 账号登录]        │
                    └───────────────────────────────────┘
                                        │
                                        ▼
                    用户在浏览器中登录 Google
                                        │
                                        ▼
                    OAuth 重定向到 localhost:38421
                                        │
                                        ▼
                    Daemon 接收 code ──→ 交换 Token ──→ 更新文件
                                        │
                                        ▼
                    显示成功页面/通知用户
```

### 3. 多账号处理

```
检测到多个账号 ──→ 认证页面显示账号列表 ──→ 用户选择 ──→ 浏览器中切换
```

## 用户界面

### 系统通知

```
🌙 Routecodex Token Notification

⚠️ Token 失效 - 需要重新认证

📄 iflow-work.json
👤 work@company.com

[打开浏览器认证]  [查看详情]  [取消]
```

### 认证页面

```
┌─────────────────────────────────────────────────────────┐
│  🌙 Routecodex Token 认证                                │
├─────────────────────────────────────────────────────────┤
│  📄 目标文件: iflow-work.json                            │
│  👤 账号: work@company.com                               │
│  📊 状态: Refresh Token 已过期                           │
│                                                         │
│  ────────────────────────────────────────────────────  │
│                                                         │
│  [ 🔐 使用 Google 账号登录 ]                             │
│                                                         │
│  💡 提示: 认证完成后 Token 文件将自动更新                  │
└─────────────────────────────────────────────────────────┘
```

### 成功页面

```
┌─────────────────────────────────────────────────────────┐
│  ✅ 认证成功                                               │
├─────────────────────────────────────────────────────────┤
│  🎉 Token 已更新!                                        │
│  📄 iflow-work.json                                     │
│  👤 work@company.com                                    │
│  此窗口可以关闭，Daemon 已恢复监控                         │
│  [返回终端]                                              │
└─────────────────────────────────────────────────────────┘
```

### Tray 菜单

```
🌙
 ├─ 📊 状态
 │   ├─ iflow.json ✅ 有效
 │   ├─ iflow-work.json ❌ 失效 [重新认证]
 │   └─ qwen.json ⚠️ 25分钟后过期
 ├─ 🔄 刷新全部
 └─ ❌ 退出
```

## 命令行接口

```bash
# 独立启动
routecodex token-daemon start

# 随主进程启动
routecodex start --daemon

# 查看状态
routecodex token-daemon status

# 手动触发刷新
routecodex token-daemon refresh iflow-oauth

# 查看即将过期的 token
routecodex token-daemon list --expiring

# 停止
routecodex token-daemon stop
```

## status 输出示例

```
🌙 Token Refresh Daemon 运行中
PID: 12345
📁 监控目录: ~/.routecodex/auth/

| 文件名              | 显示名称               | 状态   | 过期时间       | 剩余   |
|---------------------|------------------------|--------|----------------|--------|
| iflow.json          | 工作账号 (work@co.com) | ✅ 有效 | 2025-12-26 15:30 | 38分钟 |
| iflow-work.json     | 个人账号 (my@gmail.com) | ❌ 失效 | -              | -      |
| qwen.json           | dev@company.com        | ⚠️ 即将过期 | 2025-12-26 14:45 | 3分钟  |
```

## 技术架构

```
┌─────────────────────────────────────────────────────────┐
│  Token Refresh Daemon                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │ File Monitor│  │ Token Manager│ │ Auth Trigger│     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
│         │                │                │              │
│         └────────────────┼────────────────┘              │
│                          ▼                               │
│               ┌─────────────────────┐                    │
│               │ Event Bus / IPC     │                    │
│               └─────────────────────┘                    │
└─────────────────────────────────────────────────────────┘
         │                    │
         ▼                    ▼
┌──────────────────┐  ┌─────────────────────────────────┐
│ 配置文件Watcher   │  │ 认证页面 (外部浏览器)             │
│ ~/.routecodex/auth│  │ + 本地回调服务器 (localhost)     │
└──────────────────┘  └─────────────────────────────────┘
```

## 关键配置

```json
{
  "tokenDaemon": {
    "enabled": true,
    "refreshAheadMinutes": 30,
    "checkIntervalSeconds": 60,
    "notification": {
      "showPopup": true,
      "sound": true
    },
    "autoRefresh": {
      "enabled": true,
      "retryOnFailure": true,
      "maxRetries": 3
    }
  }
}
```

## 技术决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 监控目录 | `~/.routecodex/auth/` | 现有结构，保持兼容 |
| 进程间通信 | Unix Domain Socket | 本机通信，安全 |
| 配置文件监听 | chokidar | 跨平台，事件驱动 |
| 浏览器 | 外部浏览器 | Google 禁止自动化登录 |
| Cookie 管理 | 浏览器管理 | Daemon 不干涉 |
| OAuth 回调 | 本地 HTTP 服务器 | 接收 code 并交换 token |
| 提前刷新时间 | 30分钟 | 可配置 |

## 风险与应对

| 风险 | 应对措施 |
|------|----------|
| 刷新死循环 | 指数退避 + 最大重试次数 |
| Token 文件被误删 | 监控文件存在性，缺失时报警 |
| OAuth 循环认证 | 用户干预前最多重试3次 |
| 性能影响 | 增量扫描 + 内存缓存 |
| 回调端口冲突 | 端口池管理，自动回退 |

## 后续扩展

1. **Web UI 管理界面**: `routecodex token-daemon ui`
2. **Token 健康度评分**: 基于使用频率 + 过期时间
3. **批量操作**: 一键刷新所有 Token
4. **导出/导入**: 迁移认证配置到新机器
5. **审计日志**: 记录所有 Token 访问和刷新

## 待确认问题

1. [x] 监控目录: `~/.routecodex/auth/`
2. [x] 提前刷新时间: 30分钟
3. [x] 认证方式: 外部浏览器
4. [x] 回调方式: 本地 HTTP 服务器
5. [x] alias: 支持显式账号名称（类似 iflow 实现方式），用于多账号识别
6. [x] 手动刷新: 支持 `routecodex token-daemon refresh <file>`
