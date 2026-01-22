# `<** ... **>` 指令语法说明

RouteCodex 支持在用户消息中写入“指令标记”，用于影响 Virtual Router / servertool 行为。

## 基本格式

- 指令块：`<** ... **>`
- 可以在一条 user 消息中写多个指令块
- `stopMessage` / `clock:clear` 只允许从“最新一条 user 消息”生效（避免重放历史导致重复设置）

## 1) clear（清空路由状态）

清除本会话的 sticky/黑名单/allowlist 等状态：

```text
<**clear**>
```

## 2) stopMessage（停止提示消息）

设置 stopMessage（默认最多触发 1 次）：

```text
<**stopMessage:继续**>
```

设置 stopMessage + 次数：

```text
<**stopMessage:"继续",3**>
```

清除 stopMessage：

```text
<**stopMessage:clear**>
```

### stopMessage 文件引用（file://）

支持从 `~/.routecodex` 下读取相对路径文件内容作为 stopMessage：

```text
<**stopMessage:<file://stopMessage/message1.md>**>
```

含义：读取 `~/.routecodex/stopMessage/message1.md` 的内容，并把文件内容作为 stopMessage 文本（会按 mtime/size 做缓存）。

## 3) clock（定时任务）

清除当前 session 的所有定时任务：

```text
<**clock:clear**>
```

> clock servertool 的详细行为与持久化说明见 `docs/SERVERTOOL_CLOCK_DESIGN.md`。

## 4) provider 路由指令

### 允许列表（whitelist）

只允许命中指定 provider（逗号分隔）：

```text
<**!glm,tab**>
```

`<**glm**>` 等价于 `<**!glm**>`（只写 providerId 时按 allowlist 处理）。

### disable / enable（临时下线/上线）

```text
<**#tab**>      # disable
<**@tab**>      # enable
```

### force（强制命中 provider.model）

```text
<**tab.gpt-5.2**>
```

### prefer（优先命中 provider.model；不可用则回退到正常路由）

```text
<**!tab.gpt-5.2**>
```

