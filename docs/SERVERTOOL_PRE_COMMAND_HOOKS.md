# ServerTool Pre-Command Hooks

## Goal

在 `tool_call` 下发到客户端执行前，做一层可注册的 `pre_command` 拦截（不消费工具调用、不替代执行），用于：

- 参数形状清理（例如 `exec_command` 参数规范化）
- 预执行审计（shell side-effect 记录）
- 与 Claude Code `PreToolUse` 类似的“执行前 hook”能力

## Config file

默认读取：`~/.routecodex/hooks/pre-command-hooks.json`

可覆盖：

- `ROUTECODEX_PRE_COMMAND_HOOKS_FILE`
- `RCC_PRE_COMMAND_HOOKS_FILE`
- `LLMSWITCH_PRE_COMMAND_HOOKS_FILE`

示例：

```json
{
  "enabled": true,
  "hooks": [
    {
      "id": "normalize-npm-cmd",
      "tool": "exec_command",
      "priority": 10,
      "cmdRegex": "^npm\\s+",
      "jq": ".cmd = (\"set -euo pipefail; \" + .cmd)"
    },
    {
      "id": "audit-pre-command",
      "tool": ["exec_command", "shell"],
      "priority": 20,
      "shell": "cat >> ~/.routecodex/logs/pre-command-audit.jsonl"
    }
  ]
}
```

## `jq` 注册（shell 操作）

可直接用 `jq` 向 hooks 文件追加注册项：

```bash
HOOK_FILE="${ROUTECODEX_PRE_COMMAND_HOOKS_FILE:-$HOME/.routecodex/hooks/pre-command-hooks.json}"
mkdir -p "$(dirname "$HOOK_FILE")"
[ -f "$HOOK_FILE" ] || printf '{"enabled":true,"hooks":[]}' > "$HOOK_FILE"

jq '.hooks += [
  {
    "id": "block-applypatch-via-exec",
    "tool": "exec_command",
    "priority": 5,
    "cmdRegex": "apply_patch",
    "jq": ".cmd = \"echo \"\"Warning: use apply_patch tool\"\"; \" + .cmd"
  }
]' "$HOOK_FILE" > "$HOOK_FILE.tmp" && mv "$HOOK_FILE.tmp" "$HOOK_FILE"
```

## Runtime behavior

- 按 `priority` 升序执行，`priority` 相同按注册顺序。
- `jq` action：把当前 arguments JSON 作为输入，输出 JSON 对象作为新的 tool arguments。
- `shell` action：以 hook event JSON 作为 stdin 执行 shell 命令（可用于审计/旁路记录）。
- 失败策略：hook 报错记为 trace（`error`），但不阻断原工具调用下发。
- trace：通过 servertool hook trace 通道记录 `match/miss/error`。

