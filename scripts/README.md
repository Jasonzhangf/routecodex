# RouteCodex 构建和安装脚本

本目录包含用于自动构建和安装 RouteCodex 的脚本。

## 唯一安装脚本

### install-user-global.sh（推荐）

```bash
# 一键构建并全局安装（使用 npm 默认全局路径，不修改前缀）
npm run install:global
```

脚本流程：
- 构建 sharedmodule/llmswitch-core 与根包
- npm pack 生成 tgz
- 卸载全局旧版 routecodex
- npm install -g 安装新版本

> 说明：其余安装脚本已移除，请统一使用上述命令。
