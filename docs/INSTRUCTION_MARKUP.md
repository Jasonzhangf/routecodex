# `<** ... **>` 指令语法说明

RouteCodex 支持在用户消息中写入“指令标记”，用于影响 Virtual Router / servertool 行为。

## 基本格式

- 指令块：`<** ... **>`
- 可以在一条 user 消息中写多个指令块
- `sm` 只允许从“最新一条 user 消息”生效（避免重放历史导致重复设置）

## 1) clear（清空路由状态）

清除本会话的 sticky/黑名单/allowlist 等状态：

```text
<**clear**>
```

## 2) sm（自动续轮）

目标 + 轮次：

```text
<**sm:"补齐交付证据",30**>
```

只有目标（持续执行直到目标达成）：

```text
<**sm:"补齐交付证据"**>
```

模式 + 轮次（无显式目标时默认目标为“继续执行”）：

```text
<**sm:on/30**>
```

仅轮次（等价于 `on + 轮次`）：

```text
<**sm:30**>
```

关闭（等价于清除 stopMessage）：

```text
<**sm:off**>
```

### 2.3 Marker 生命周期（Lifecycle）

- 只解析**最新一条 user 消息**中的 marker；旧消息 marker 不会重复生效。
- 同一条消息内若同时存在多个 `sm`，按“清理优先、最后一条有效”处理：
  - 存在 `sm:off` 时，最终以 clear 为准；
  - 无 clear 时，最后一个 `sm` 指令生效。
- 触发一次自动续轮就会累加 `stopMessageUsed`；达到 `stopMessageMaxRepeats` 后自动清除激活态。

### 2.4 错误管理（Error Handling）

- 非法语法（如 `sm:on/not-a-number`）会被**忽略且不改写状态**（fail-closed）。
- 无法解析的 `file://` 引用不会污染当前有效状态，主请求继续按正常路径执行。
- 注入失败时会清理当前 stopMessage 激活状态，避免在坏状态下无限循环。

### stopMessage 文件引用（file://）

支持从 `~/.rcc` 下读取相对路径文件内容作为 stopMessage：

```text
<**sm:<file://stopMessage/message1.md>**>
```

含义：读取 `~/.rcc/stopMessage/message1.md` 的内容，并把文件内容作为 stopMessage 文本（会按 mtime/size 做缓存）。

## 3) provider 路由指令

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
