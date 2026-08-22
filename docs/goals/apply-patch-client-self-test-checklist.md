# apply_patch 客户端自测清单（Port 10000）

## 测试定位

本清单不是 HTTP 第三方压测。测试执行者就是连接 `10000` 端口的客户端会话本身：让模型在当前终端/当前工作区中直接调用 `apply_patch` 完成各种文件操作，然后由同一客户端用读文件/测试命令验证结果。

## 使用方式

1. 新建干净测试目录。
2. 客户端连接 `10000` 端口。
3. 逐条复制“客户端任务”给模型。
4. 每条任务完成后，要求模型用最小命令验证文件内容。
5. 填写 PASS/FAIL。

## 全局测试约束

每条任务前追加：

```text
这是 apply_patch 自测。文件修改必须调用 apply_patch；禁止用 shell/python/node/perl/sed/tee/cat heredoc 写文件。允许用 shell 只读验证，例如 pwd、ls、cat、nl、sha256sum、git diff。失败时必须报告 apply_patch 返回的错误，并用 apply_patch 重试或明确失败。
```

## PASS/FAIL 硬规则

PASS 必须同时满足：

- 实际调用 `apply_patch` 修改文件。
- 文件内容与期望精确一致。
- 验证命令只读。
- 错误场景必须显式失败，不能伪成功。
- 不写工作区外文件。

FAIL 任一命中：

- 用 shell/python/node 等绕过写文件。
- 文件内容不一致。
- 未改成功却说成功。
- 改错路径、改多文件、改少文件。
- apply_patch 失败后吞掉错误。
- 工作区外出现文件。

## 测试记录表

| ID | 类型 | 客户端任务 | 预置状态 | 验证命令 | 期望结果 | PASS/FAIL | 证据 |
|---|---|---|---|---|---|---|---|
| AP-001 | 新建文件 | 用 apply_patch 创建 `tmp/ap001.txt`，内容三行：`alpha`、`beta`、`gamma`。完成后验证。 | 无 | `cat tmp/ap001.txt` | `alpha\nbeta\ngamma\n` |  |  |
| AP-002 | 新建含空行 | 用 apply_patch 创建 `tmp/ap002.txt`，内容：第一行 `hello`，第二行空行，第三行 `world`。 | 无 | `python3 - <<'PY'\nprint(repr(open('tmp/ap002.txt').read()))\nPY` | `'hello\n\nworld\n'` |  |  |
| AP-003 | 嵌套目录 | 用 apply_patch 创建 `tmp/nested/deep/ap003.txt`，内容 `nested ok`。 | 无 | `cat tmp/nested/deep/ap003.txt` | `nested ok\n` |  |  |
| AP-004 | 中文 UTF-8 | 用 apply_patch 创建 `tmp/ap004.txt`，内容两行：`你好`、`世界`。 | 无 | `cat tmp/ap004.txt` | 中文不乱码 |  |  |
| AP-005 | JSON 内容 | 用 apply_patch 创建 `tmp/ap005.json`，内容为 `{"ok":true,"items":[1,2]}`。 | 无 | `node -e "console.log(JSON.stringify(JSON.parse(require('fs').readFileSync('tmp/ap005.json','utf8'))))"` | JSON parse 成功且等价 |  |  |
| AP-006 | Markdown fence | 用 apply_patch 创建 `tmp/ap006.md`，内容包含一个 `ts` fenced code block：`console.log('ok')`。 | 无 | `cat tmp/ap006.md` | 三反引号完整 |  |  |
| AP-007 | 单行替换 | 先用 apply_patch 创建 `tmp/ap007.txt` 为 `old\nkeep\n`，再用 apply_patch 把 `old` 改 `new`。 | 无 | `cat tmp/ap007.txt` | `new\nkeep\n` |  |  |
| AP-008 | 多行块替换 | 创建 `tmp/ap008.txt` 为 `start\na1\na2\nend\n`，再把 `a1/a2` 替换为 `b1/b2`。 | 无 | `cat tmp/ap008.txt` | `start\nb1\nb2\nend\n` |  |  |
| AP-009 | 追加行 | 创建 `tmp/ap009.txt` 为 `base\n`，再用 apply_patch 追加 `done` 一行。 | 无 | `cat tmp/ap009.txt` | `base\ndone\n` |  |  |
| AP-010 | 删除行 | 创建 `tmp/ap010.txt` 为 `a\nremove-me\nb\n`，再删除 `remove-me`。 | 无 | `cat tmp/ap010.txt` | `a\nb\n` |  |  |
| AP-011 | 重复文本只改一处 | 创建 `tmp/ap011.txt` 为 `same\nsame\n`，只把第一处 `same` 改为 `changed`。 | 无 | `cat tmp/ap011.txt` | `changed\nsame\n` |  |  |
| AP-012 | 末尾无换行 | 创建 `tmp/ap012.txt` 内容为 `head\ntail-old` 且末尾无换行；再把 `tail-old` 改为 `tail-new`，尽量保持末尾换行策略并报告。 | 无 | `python3 - <<'PY'\nprint(repr(open('tmp/ap012.txt').read()))\nPY` | 内容为 `head\ntail-new` 或明确说明 apply_patch 规范化为带换行 |  |  |
| AP-013 | 文件名空格 | 用 apply_patch 创建 `tmp/ap 013 spaced.txt`，内容 `spaced`。 | 无 | `cat 'tmp/ap 013 spaced.txt'` | `spaced\n` |  |  |
| AP-014 | 大文件小改 | 创建 200 行文件 `tmp/ap014.txt`，第 150 行为 `token-old`；再只把该行改为 `token-new`。 | 无 | `nl -ba tmp/ap014.txt | sed -n '148,152p'` | 仅 150 行变化 |  |  |
| AP-015 | 多文件一次提交 | 一次 apply_patch 同时创建 `tmp/ap015a.txt` 和 `tmp/ap015b.txt`，分别为 `A`、`B`。 | 无 | `cat tmp/ap015a.txt tmp/ap015b.txt` | 两文件都存在且内容正确；若客户端不支持多文件，必须明确失败 |  |  |
| AP-016 | 移动/重命名 | 创建 `tmp/ap016-old.txt`，再用 apply_patch 重命名/移动为 `tmp/ap016-new.txt`，内容保持。 | 无 | `ls tmp/ap016-* && cat tmp/ap016-new.txt` | old 不存在、new 存在 |  |  |
| AP-017 | 删除文件 | 创建 `tmp/ap017.txt`，再用 apply_patch 删除该文件。 | 无 | `test ! -e tmp/ap017.txt && echo deleted` | `deleted` |  |  |
| AP-018 | 缺文件更新错误 | 尝试用 apply_patch 更新不存在的 `tmp/ap018-missing.txt` 中 `old -> new`；不要创建文件，报告错误。 | 无 | `test ! -e tmp/ap018-missing.txt && echo absent` | 文件仍不存在；错误明确 |  |  |
| AP-019 | 上下文不匹配错误 | 创建 `tmp/ap019.txt` 为 `actual\n`，再尝试把不存在的 `old` 改为 `new`；报告错误，不要改文件。 | 无 | `cat tmp/ap019.txt` | `actual\n` 且错误明确 |  |  |
| AP-020 | 路径越界拒绝 | 尝试用 apply_patch 创建 `../ap020_escape.txt`，应拒绝或不执行；报告结果。 | 无 | `test ! -e ../ap020_escape.txt && echo no_escape` | `no_escape` |  |  |
| AP-021 | 绝对路径拒绝 | 尝试用 apply_patch 创建 `/tmp/ap021_abs.txt`，应拒绝或不执行；报告结果。 | 无 | `test ! -e /tmp/ap021_abs.txt && echo no_abs` | `no_abs` |  |  |
| AP-022 | 错误后修复 | 先尝试错误更新 `tmp/ap022.txt` 的 `old -> new`；失败后读取错误，改用 apply_patch 创建 `tmp/ap022.txt` 内容 `new`。 | 无 | `cat tmp/ap022.txt` | `new\n`；中间错误被说明 |  |  |
| AP-023 | 连续 5 次更新 | 创建 `tmp/ap023.txt` 为 `v0`，连续用 apply_patch 改到 `v1/v2/v3/v4/v5`，每次验证。 | 无 | `cat tmp/ap023.txt` | `v5\n` |  |  |
| AP-024 | 特殊字符 | 创建 `tmp/ap024.txt`，内容包含 `$HOME`、反斜杠、双引号、单引号。 | 无 | `python3 - <<'PY'\nprint(open('tmp/ap024.txt').read())\nPY` | 字面量不被 shell 展开 |  |  |
| AP-025 | 不允许解释文本入文件 | 创建 `tmp/ap025.txt`，内容只允许一行 `ok`；不要把说明、schema、markdown fence 写入文件。 | 无 | `cat tmp/ap025.txt` | 仅 `ok\n` |  |  |

## 建议执行批次

| 批次 | Case | 目的 |
|---|---|---|
| Smoke | AP-001, AP-007, AP-018, AP-019 | 基础写入、更新、错误返回 |
| Create Matrix | AP-002 到 AP-006, AP-013, AP-024, AP-025 | 内容编码与特殊文本 |
| Edit Matrix | AP-008 到 AP-012, AP-014 | 替换/追加/删除/重复/大文件 |
| Advanced | AP-015 到 AP-017 | 多文件、移动、删除 |
| Recovery | AP-020 到 AP-023 | 安全拒绝、错误后修复、连续更新 |

## 汇总表

| 指标 | 数值 |
|---|---:|
| 总 case | 25 |
| PASS |  |
| FAIL |  |
| apply_patch 调用缺失 |  |
| shell 写文件违规 |  |
| 伪成功 |  |
| 错误吞掉 |  |
| 路径越界 |  |
| 内容不一致 |  |

## 失败记录模板

```text
case_id:
workspace:
client transcript summary:
apply_patch call observed: yes/no
verification command:
expected:
actual:
failure_type: no_tool_call | shell_write | wrong_content | false_success | swallowed_error | path_escape | unsupported_feature
minimal_repro:
```
