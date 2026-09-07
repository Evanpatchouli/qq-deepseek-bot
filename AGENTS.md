# AGENTS.md

本文件用于指导 Codex、Claude Code、Cursor Agent、OpenAI Coding Agent 及其他自动化开发 Agent 在本仓库中工作。

项目名称：**Qgent / QQ DeepSeek Bot**

Qgent 是一个运行在 QQ 中的个人生活 AI 助手。项目目标是：**保持轻量、可靠、易部署，并逐步增强生活助手能力，而不是把它扩张成复杂的企业级平台。**

---

## 1. 项目目标

Qgent 主要服务个人日常生活场景，包括但不限于：

- QQ 私聊 AI 助手
- QQ 群聊 @机器人问答
- 天气查询与穿衣建议
- 穿搭建议
- 联网调查与资料整理
- 记账与账目汇总
- 笔记
- 生活小确幸记录
- 待办与提醒（规划中）
- 后续可扩展图片理解、语音、更多工具

核心原则：

> **Qgent 可以皮，但不能不靠谱。**

技术目标：

- 部署简单
- 单机运行稳定
- 尽量少依赖额外基础设施
- 对个人服务器资源友好
- 能够长期维护
- 功能逐步增加，但避免过度工程化

---

## 2. 当前技术栈

### Runtime

- Node.js 22 LTS
- ESM

### QQ

官方 SDK：

```text
@tencent-connect/qqbot-nodejs
```

主要使用：

- WebSocket Gateway
- QQ C2C 私聊
- QQ 群聊
- Guild
- DM
- QQ OpenAPI
- 自定义菜单

默认不使用公网 Webhook。

### AI

DeepSeek API：

```text
https://api.deepseek.com
```

默认模型：

```text
deepseek-v4-flash
```

可切换：

```text
deepseek-v4-pro
```

当前使用：

- DeepSeek Responses API
- Web Search
- Function Calling / Tools

### 数据

使用 Node.js 22 自带：

```text
node:sqlite
```

SQLite 默认路径：

```text
/app/data/qgent.db
```

Docker 中通过：

```yaml
volumes:
  - ./data:/app/data
```

持久化。

不要无充分理由引入 PostgreSQL、MongoDB、MySQL 等额外数据库。

---

## 3. 当前目录结构

仓库应大致保持：

```text
qq-deepseek-bot/
├── data/
│   └── qgent.db
├── scripts/
│   └── setup-menu.js
├── src/
│   ├── index.js
│   ├── config.js
│   ├── qqbot.js
│   ├── deepseek.js
│   ├── memory.js
│   ├── health.js
│   ├── storage.js
│   └── tools.js
├── .env.example
├── .gitignore
├── Dockerfile
├── docker-compose.yml
├── package.json
├── setup-menu.sh
├── README.md
└── AGENTS.md
```

如无明确理由，不要大规模重构目录。

---

## 4. 文件职责

### `src/index.js`

应用入口。

职责：

- 初始化配置
- 初始化 SQLite
- 初始化 DeepSeek
- 初始化 QQ Bot
- 注册工具
- 启动健康检查
- 优雅退出

不要在这里堆积业务逻辑。

---

### `src/config.js`

所有环境变量解析入口。

要求：

- 环境变量统一在这里读取
- 提供合理默认值
- 数字、布尔值需要显式转换
- 必填配置缺失时尽早失败
- 不要在其他模块散落 `process.env.xxx`

---

### `src/qqbot.js`

QQ 消息接入层。

职责：

- C2C
- 群聊
- Guild
- DM
- @机器人规则
- 消息去重
- 防自回声
- 命令 `/reset`
- 命令 `/help`
- 调用 AI
- 回复 QQ

不要把 SQLite SQL、DeepSeek 请求细节直接写进本文件。

---

### `src/deepseek.js`

AI 调用层。

职责：

- DeepSeek Responses API
- SYSTEM_PROMPT
- 上下文组装
- Web Search
- Function Calling
- Tool loop
- 超时
- 异常处理
- 输出解析

重要要求：

- Web Search 和本地 Tools 可以共存
- Tool Calling 必须限制最大轮数
- 禁止无限工具循环
- 模型返回异常时必须安全失败
- 不要伪造联网结果或工具执行结果

---

### `src/memory.js`

临时聊天上下文。

当前实现：

- 内存存储
- 用户 / 会话隔离
- 最大历史轮数
- TTL

`/reset` 只清空这里的数据。

不要让 `/reset` 删除 SQLite 持久化数据。

---

### `src/storage.js`

SQLite 数据访问层。

职责：

- 初始化数据库
- 建表
- SQL
- 数据 CRUD

要求：

- 所有 SQL 尽量集中在这里
- 必须使用参数化查询
- 禁止把模型生成文本直接拼进 SQL
- 数据库结构变更要考虑已有数据库兼容

---

### `src/tools.js`

Qgent 本地工具定义与执行层。

当前工具方向：

- 记账
- 查询账目
- 汇总账目
- 添加笔记
- 查询笔记
- 添加小确幸
- 查询小确幸

未来：

- Reminder
- Todo
- Weather structured API
- Calendar
- 更多生活工具

要求：

- Tool schema 必须明确
- 参数必须校验
- 工具执行成功后模型才能声称“已保存”
- 每个工具执行应输出明确日志
- 用户数据必须隔离

---

### `src/health.js`

健康检查。

默认：

```text
GET /healthz
```

不要让健康检查依赖 DeepSeek API 或 QQ API 的实时成功，否则容易造成不必要的容器重启。

---

### `scripts/setup-menu.js`

QQ 自定义菜单初始化 / 更新脚本。

通过：

```bash
npm run menu:setup
```

执行。

Docker 中也可：

```bash
./setup-menu.sh
```

修改菜单结构时必须遵守 QQ 官方接口约束。

---

## 5. Qgent 人格原则

Qgent 的人格由 `SYSTEM_PROMPT` 控制。

核心定位：

- 生动
- 活泼
- 俏皮
- 可爱
- 略带一点小傲娇
- 不刻意卖萌
- 不油腻
- 不客服腔

但以下场景必须切换为认真模式：

- 金钱
- 健康
- 安全
- 时间
- 风险
- 重要安排
- 可能造成损失的建议

重要原则：

```text
小事可以可爱。
正事必须明确。
不知道就说不知道。
查不到就说查不到。
工具没执行成功，不能说已经保存。
```

不要通过代码硬编码大量人格句子。

人格应主要保留在 SYSTEM_PROMPT 中。

---

## 6. 环境变量

典型配置：

```env
# QQ
QQBOT_APP_ID=
QQBOT_APP_SECRET=

# DeepSeek
DEEPSEEK_API_KEY=
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_WEB_SEARCH=true

# AI
SYSTEM_PROMPT=
MAX_HISTORY_TURNS=8
HISTORY_TTL_MINUTES=120
AI_TIMEOUT_MS=45000

# Qgent
QGENT_DEFAULT_LOCATION=
QGENT_TIMEZONE=Asia/Shanghai
QGENT_DB_PATH=/app/data/qgent.db
QGENT_MAX_TOOL_ROUNDS=5

# QQ
GROUP_REQUIRE_MENTION=true

# Health
HEALTH_HOST=0.0.0.0
HEALTH_PORT=3000
```

新增配置时：

1. 修改 `src/config.js`
2. 修改 `.env.example`
3. 修改 `README.md`
4. 必要时修改 Docker 配置

绝不提交真实：

- AppSecret
- API Key
- Token
- Cookie
- 用户隐私数据

---

## 7. 数据隔离

这是高优先级要求。

所有持久化数据必须至少按 QQ 用户 ID 隔离。

例如：

```text
user_id
```

不得出现：

- A 用户查询到 B 用户账本
- 群成员能看到其他成员笔记
- 全局 SQL 查询未加用户条件

任何新增查询功能都必须检查用户隔离。

---

## 8. 记账规则

记账属于重要数据。

新增或修改记账功能时必须保证：

- 金额使用明确数值类型
- 区分收入 / 支出
- 日期明确
- 分类可选
- 备注可选
- 查询必须按用户隔离
- 汇总必须由代码 / SQL 计算
- 不让模型自行心算替代数据库统计

推荐保存原始金额单位：

```text
人民币元
```

如果未来需要更严格金额精度，可切换为：

```text
整数分
```

但迁移前必须兼容已有数据。

---

## 9. 笔记与小确幸

笔记和小确幸是长期个人数据。

原则：

- 不擅自扩写用户事实
- 不编造用户未提供的细节
- 保存成功后才能回复“记下了”
- 查询结果必须来源于数据库
- 支持关键词搜索时使用参数化 SQL

---

## 10. DeepSeek Web Search

当用户询问时效性内容时，应允许模型联网：

- 天气
- 新闻
- 价格
- 店铺
- 产品
- 交通
- 最新技术信息
- 当前事件

不要让 Qgent 使用模型训练记忆冒充实时数据。

如果 Web Search 失败：

- 明确告知当前无法确认最新信息
- 可以提供非实时通用建议
- 不要编造搜索结果

---

## 11. 天气能力

当前阶段可主要通过 Web Search 查询天气。

未来如实现主动天气提醒，应优先接入结构化 Weather API。

原因：

主动提醒需要程序能够稳定比较：

- 温度
- 体感温度
- 降雨概率
- 风力
- 温差
- 极端天气

不要用自然语言搜索结果做复杂自动化判断。

---

## 12. Reminder / 主动提醒（下一阶段）

提醒是下一阶段高优先级能力。

建议实现：

```text
reminders
```

SQLite 表。

字段至少考虑：

```text
id
user_id
content
trigger_at
timezone
status
created_at
```

第一阶段只做：

- 一次性提醒

之后再扩展：

- 每日
- 每周
- 每月
- 条件提醒

提醒发送必须遵守 QQ 官方主动消息能力和额度限制。

不要假设机器人可以无限主动推送。

---

## 13. Docker 原则

生产部署主要使用 Docker Compose。

要求：

- 容器必须可重启
- SQLite 必须挂载宿主机目录
- `.env` 不打进镜像
- 不使用 root 特权能力，除非必要
- 健康检查端口默认只映射本机

推荐：

```yaml
ports:
  - "127.0.0.1:3000:3000"
```

SQLite：

```yaml
volumes:
  - ./data:/app/data
```

Dockerfile 中需要：

```dockerfile
COPY src ./src
COPY scripts ./scripts
```

否则 `menu:setup` 无法在容器运行。

---

## 14. 依赖原则

Qgent 是小型个人项目。

新增依赖前先问：

> Node.js 标准库能不能解决？

优先顺序：

1. Node.js 标准库
2. 当前已有依赖
3. 小型稳定依赖
4. 最后才考虑大型框架

避免仅为一个简单功能引入：

- NestJS
- Prisma
- TypeORM
- Redis
- RabbitMQ
- Kafka
- 微服务
- Kubernetes

除非项目规模发生明显变化或用户明确要求。

---

## 15. 不要过度工程化

禁止 Agent 自发把项目改造成：

- DDD
- Clean Architecture 多十几层
- 微服务
- Event Bus
- CQRS
- Kubernetes
- 服务发现
- 分布式事务
- 多数据库

这是个人机器人。

优先：

```text
简单
清楚
稳定
可维护
```

而不是：

```text
架构炫技
```

---

## 16. Coding Style

保持现有 JavaScript / ESM 风格。

推荐：

```js
import ...
export ...
```

尽量避免：

```js
require(...)
module.exports
```

原则：

- 函数短小
- 命名明确
- 少嵌套
- 少魔法值
- 错误要带上下文
- 日志要可定位
- 不滥用 class
- 不写无意义 abstraction

异步代码使用：

```js
async / await
```

优先于 Promise 链。

---

## 17. 日志规范

推荐日志格式：

```text
[module] message
```

例如：

```text
[qq] connected
[deepseek] web_search=true calls=1
[tool] user=xxxx name=qgent_add_ledger success=true
[storage] initialized
[health] http://0.0.0.0:3000/healthz
```

禁止日志输出：

- AppSecret
- DeepSeek API Key
- Access Token
- 完整用户隐私内容
- 大量 SYSTEM_PROMPT

---

## 18. 错误处理

Agent 修改代码时必须考虑：

- DeepSeek timeout
- DeepSeek 429
- DeepSeek 5xx
- QQ API 400
- QQ API 401
- QQ WebSocket 断线
- SQLite lock
- Tool 参数异常
- 用户发送空文本
- 用户发送超长文本
- 模型输出为空
- Web Search 失败

用户侧错误信息要自然，不要把 stack trace 发到 QQ。

服务端日志可以保留 stack trace。

---

## 19. 安全规则

绝对禁止：

- `eval`
- 执行用户输入 shell
- 模型生成 SQL 直接执行
- 模型生成 JavaScript 直接执行
- 把 API Key 发给模型
- 把 AppSecret 发给模型
- Tool 参数未经验证直接执行
- 任意文件读写工具直接暴露给用户

所有 Tool 都必须做最小权限设计。

---

## 20. 修改前检查

Agent 开始任务前：

1. 阅读 `README.md`
2. 阅读 `AGENTS.md`
3. 阅读相关 `src/*.js`
4. 阅读 `.env.example`
5. 如涉及 Docker，阅读：
   - `Dockerfile`
   - `docker-compose.yml`
6. 如涉及菜单，阅读：
   - `scripts/setup-menu.js`
   - `setup-menu.sh`

不要只凭任务描述猜当前代码状态。

---

## 21. 修改后最低验证要求

每次修改 JavaScript 后至少运行：

```bash
node --check src/xxx.js
```

涉及多个文件：

```bash
find src scripts -name "*.js" -print0 | xargs -0 -n1 node --check
```

如修改依赖：

```bash
npm install
```

如可运行测试：

```bash
npm test
```

如果没有测试脚本，不要假装测试已经通过。

---

## 22. Docker 修改验证

涉及 Docker 时至少验证：

```bash
docker compose config
```

如果环境允许：

```bash
docker compose build
docker compose up -d
docker compose ps
```

然后：

```bash
curl http://127.0.0.1:3000/healthz
```

必要时：

```bash
docker compose logs --tail=200 qq-deepseek-bot
```

---

## 23. SQLite 修改验证

涉及数据库时必须验证：

- 初次启动可以建库
- 已有数据库重复启动不会报错
- CRUD 正常
- 用户隔离正常
- 参数化查询正常
- `/reset` 不影响持久化数据

如新增 schema，优先使用兼容性迁移，不要要求用户手动删除 `qgent.db`。

除非明确说明是开发阶段破坏性迁移。

---

## 24. QQ 修改验证

修改消息逻辑时检查：

### C2C

- 普通文本可以回复
- `/reset`
- `/help`

### Group

- `GROUP_REQUIRE_MENTION=true` 时不 @ 不回复
- @机器人时回复
- 不回复自己的消息

### Guild / DM

- 不影响现有回复能力

### Menu

修改菜单后：

```bash
npm run menu:setup
```

Docker：

```bash
./setup-menu.sh
```

---

## 25. Tool Calling 修改验证

新增 Tool 时必须验证：

1. Schema 合法
2. 参数校验
3. 工具执行成功
4. 工具执行失败
5. AI 能读取工具结果
6. 工具最大循环次数有效
7. 不会无限 Tool Call
8. 不会越权访问其他用户数据

---

## 26. 向用户交付时

Agent 完成任务后，应说明：

- 修改了什么
- 为什么这么改
- 哪些文件变化
- 如何部署
- 如何验证
- 是否需要新增环境变量
- 是否需要数据库迁移
- 哪些测试实际跑过
- 哪些测试因为环境原因没有跑

不要声称没有实际执行过的测试“已经通过”。

---

## 27. Git 原则

建议每个任务保持单一职责。

提交信息示例：

```text
feat: add reminder tool
fix: persist sqlite data in docker
feat: add qq menu setup script
fix: handle deepseek timeout
docs: update qgent setup guide
```

不要把大量无关格式化和功能修改混在一个 commit。

---

## 28. README 同步规则

以下变化必须同步 README：

- 新环境变量
- 新命令
- 新脚本
- 新 Tool
- 新数据库能力
- Docker 改动
- QQ 接入方式变化
- DeepSeek API 变化

AGENTS.md 如果架构规则发生变化也应同步更新。

---

## 29. 当前优先级路线

如果用户没有指定具体功能，后续默认推荐顺序：

### P0

稳定现有功能：

- QQ 消息
- DeepSeek
- Web Search
- SQLite
- 记账
- 笔记
- 小确幸
- Docker

### P1

主动提醒：

- 一次性 Reminder
- SQLite Reminder 表
- 定时扫描
- QQ 主动推送

### P2

生活助手增强：

- 天气结构化 API
- 主动天气提醒
- 穿衣建议
- 待办

### P3

体验增强：

- C2C 流式回复
- 群聊指令面板
- 图片理解
- 语音

### P4

管理功能：

- 简单管理页
- Token / API 用量
- 日志统计
- 数据导出 / 备份

除非用户明确要求，不要跳过 P0/P1 直接建设复杂管理后台。

---

## 30. 最终设计哲学

Qgent 不是企业 SaaS。

它是一个：

```text
小
轻
好用
可靠
有一点可爱
```

的个人 QQ 生活助手。

Agent 做任何架构决策时，都应优先问：

> 这个改动真的能让 Qgent 更好用吗？

如果答案只是：

> “架构看起来更专业。”

那通常不值得做。
