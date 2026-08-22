# 端口与监听地址（输入端口）说明

## 配置文件

推荐在 `~/.rcc/config.json` 里配置：

```jsonc
{
  "httpserver": {
    "host": "127.0.0.1",
    "port": 5555
  }
}
```

## CLI 行为差异（rcc vs routecodex）

### `rcc`（release CLI）

- **严格按配置文件端口启动**（`httpserver.port`）
- 若端口缺失/非法：`rcc start` 直接失败
 - 也可用 `rcc start --port <port>` 覆盖

### `routecodex`（dev worktree）

- 默认端口固定为 `5555`
- 可用环境变量覆盖：
  - `ROUTECODEX_PORT` 或 `RCC_PORT`
- 也可用 `routecodex start --port <port>` 覆盖

## 常用排查

```bash
rcc status
curl http://127.0.0.1:5555/ready
```

## 离线单模型模式（常用）

当你需要把所有主路由收敛到本地模型（例如 LM Studio）时，建议使用单独配置文件（例如 `config.offline.json`）并在独立端口启动：

```bash
routecodex start --port 5520 --config "/Volumes/extension/.rcc/config.offline.json"
```

说明：
- `--port` 优先级高于配置文件端口。
- 若端口已被非托管进程占用，会直接失败（fail-fast），不会静默抢占。
