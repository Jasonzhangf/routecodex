# 端口与监听地址（输入端口）说明

## 配置文件

推荐在 `~/.routecodex/config.json` 里配置：

```jsonc
{
  "httpserver": {
    "host": "127.0.0.1",
    "port": 5555
  }
}
```

## CLI 行为差异（rcc vs routecodex）

### `rcc`（release 包）

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
