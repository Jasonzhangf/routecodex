# DeepSeek Web 批量登录获取 Token

## 目标
用 camo 独立 profile 为 13 个 DeepSeek Web 账号依次登录，提取 access_token，保存到 `/Volumes/extension/.rcc/auth/`，更新 provider 配置引用，固化为 skill。

## 账号清单

| alias | 邮箱/手机 | 密码 | token 文件 |
|-------|----------|------|-----------|
| account-1 | 18675515367 | 已有旧token，需重登 | deepseek-account-1.json |
| account-2 | 17336680278 | 同上 | deepseek-account-2.json |
| account-3 | 13528857502 | 同上 | deepseek-account-3-13823250570.json |
| biggs | tizocsnelling+biggs@gmail.com | 12345678 | deepseek-biggs.json |
| hulsey | hominidpad+hulsey@gmail.com | 12345678 | deepseek-hulsey.json |
| sargent | kajaahahaggjahagafa+sargent@gmail.com | 12345678 | deepseek-sargent.json |
| leggett | dmdngsndnfsnbt+leggett@gmail.com | 12345678 | deepseek-leggett.json |
| hendrick | slinavelhagepto6g+hendrick@gmail.com | 12345678 | deepseek-hendrick.json |
| clary | arrogatejgngrh+clary@gmail.com | 12345678 | deepseek-clary.json |
| spence | tizocsnelling+spence@gmail.com | 12345678 | deepseek-spence.json |
| grover | hominidpad+grover@gmail.com | 12345678 | deepseek-grover.json |
| berg | ssbvcsjawhgakavf+berg@gmail.com | 12345678 | deepseek-berg.json |
| chalmers | rackauskashet291+chalmers@gmail.com | 12345678 | deepseek-chalmers.json |

## 登录流程
1. 打开 `https://chat.deepseek.com/sign_in`
2. 邮箱输入框 `input[type=text]`，密码输入框 `input[type=password]`
3. 登录按钮 `button.ds-basic-button--primary`
4. 登录成功 → URL 跳转 → `localStorage.userToken` 有值

## 技术要点
- React 受控组件：必须用 `Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set` + `dispatchEvent(input/change)`
- 每步验证：设完邮箱读 `input.value` 确认；设完密码点登录；等 5-15s 查 URL 变化 + userToken；超时 30s 报错
- camo profile 命名 `deepseek-<alias>`，每账号独立，用前删除重建
- 失败跳到下一个，记日志，不阻塞

## Token 文件格式
```json
{
  "access_token": "<token>",
  "token": "<同access_token>",
  "account_alias": "<alias>",
  "mobile": "<邮箱或手机号>",
  "created_at": "2026-05-09T...",
  "updated_at": "2026-05-09T..."
}
```
Token 提取优先级：`localStorage.userToken` → cookies `userToken`

## Provider 配置更新
文件：`/Volumes/extension/.rcc/provider/deepseek-web/config.v2.json`
在 `provider.auth.entries` 数组追加：
```json
{ "alias": "<alias>", "type": "deepseek-account", "tokenFile": "~/.rcc/auth/deepseek-<alias>.json" }
```
规则：alias 存在则覆盖 tokenFile，不存在则追加；其余字段不动。

## 要做
- 独立 camo profile，删旧建新
- 每步输入后验证（邮箱读 value，密码确认有内容，登录后等跳转）
- 登录成功立刻提取 token 并写文件
- 失败记日志继续下一个
- 完成后固化 `~/.codex/skills/deepseek-web-login/` skill

## 不做
- 不 fallback / 旧 token 冒充
- 不批处理跨账号
- 不改 provider 配置 auth 段之外任何字段
- 不杀进程

## 验证
- 13 个 `deepseek-*.json` 文件，`access_token` 非空
- provider config `auth.entries` 长度 = 13
- 随机一个 token 调 DeepSeek API 验证有效

## 产物
| 产物 | 路径 |
|------|------|
| 批量脚本 | `~/.codex/skills/deepseek-web-login/scripts/batch-login-deepseek.mjs` |
| Skill | `~/.codex/skills/deepseek-web-login/SKILL.md` |
| Token 文件 | `/Volumes/extension/.rcc/auth/deepseek-*.json` (13) |
| 更新后配置 | `/Volumes/extension/.rcc/provider/deepseek-web/config.v2.json` |
| 执行日志 | `/Volumes/extension/.rcc/auth/login.log` |
