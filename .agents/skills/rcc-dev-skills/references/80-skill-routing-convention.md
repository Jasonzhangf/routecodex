# 80 Skill Routing Convention

## 目标
让 `rcc-dev-skills` 保持短入口，细节全部下沉到小文件。

## 主文件规则
- `SKILL.md` ≤ 200 行
- `description` 单行 ≤ 50 字
- 只保留：
  - 触发信号
  - 路由表
  - 少量硬护栏
  - 最小闭环指针

## reference 文件规则
- 每个文件 ≤ 200 行
- 一个主题一个文件
- 统一结构：
  - 何时用
  - 真源 / 权威路径
  - 操作步骤
  - 反模式 / 边界
  - 验证
  - 相关 references

## 新增 reference 流程
1. 先判断是不是新主题
2. 若是新主题，新增 `references/<nn>-<topic>.md`
3. 同步在 `SKILL.md` 路由表登记
4. 控制单文件大小；超 200 行继续拆
5. 若只是已有主题的新稳定流程，不新建文件，直接回写现有 reference；不要把同主题流程散落到 note 或聊天

## lesson 文件规则
- lesson 用 card，不用流水账
- 每张卡只保留：
  - 触发
  - 真源
  - 动作
  - 反模式
  - 验证

## 什么不要塞回主 SKILL
- 大段历史时间线
- 长测试清单
- 完整配置 schema
- 多主题混合说明

## 当前建议分层
- 00-30：总览 / flow / index
- 40：owner / map / gate
- 50：`~/.rcc` / provider config
- 60：note / memory / skill
- 70：gate discovery
- 80：skill 自身写法
- 91-92：lessons archive

## 验证
- `wc -l .agents/skills/rcc-dev-skills/SKILL.md`
- `wc -l .agents/skills/rcc-dev-skills/references/*.md`
- `rg -n 'references/' .agents/skills/rcc-dev-skills/SKILL.md`

## 反模式 / 边界
- ❌ 主 SKILL 越写越长
- ❌ 同一主题跨多个文件重复复制
- ❌ 历史 lessons 混进主路由
- ✅ 主文件只回答“去哪读”，不回答全部细节
