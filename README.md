# QQ DeepSeek Bot

基于腾讯 QQ 开放平台新版 Node.js SDK `@tencent-connect/qqbot-nodejs` + DeepSeek API 构建的 AI 机器人后台服务。

QQ Bot Node.js SDK（`@tencent-connect/qqbot-nodejs`）及其文档仅提供接入参考；具体功能、接口约束、权限和额度以 [QQ 开放平台官方文档](https://bot.q.qq.com/wiki/)为准。SDK 提供某个方法不代表平台当前开放对应能力。

机器人默认名称为 **Qgent**，定位为一个运行在 QQ 中的个人生活 AI 助手：可以聊天、联网调查、查询天气、辅助穿搭，并通过本地 SQLite 持久化记录笔记、账目和生活小确幸。

## 功能

- WebSocket 长连接，无需公网 Webhook 地址
- QQ C2C 私聊、群聊文本消息
- 频道（Guild）和频道私信（DM）文本回复
- 群聊默认仅在 `@机器人` 时回复
- DeepSeek 多轮上下文（内存缓存）
- DeepSeek Responses API
- DeepSeek Web Search 联网搜索
- Function Calling / 本地生活工具
- SQLite 持久化：
  - 记账
  - 查询账目与汇总
  - 笔记
  - 查询笔记
  - 生活小确幸
  - 查询小确幸
  - 按类型和编号查看、更正记录，预览并确认后撤销一条记录
  - 一次性提醒的创建、查询和取消，到期发回原 QQ 私聊或群聊
  - 长期偏好管理、按日期回顾账目和生活记录
  - 用户在本人私聊开启、查看和取消的条件天气提醒
- QQ 单聊自定义菜单
- QQ 私聊 `/balance` 查询 DeepSeek API 余额
- `/reset` 清空当前用户临时会话上下文
- `/help` 查看帮助
- `/status` 查询最近成功的记录操作和编号
- QQ 消息去重、自回声过滤
- `/healthz` 健康检查
- Docker / Docker Compose 部署
- SQLite 数据目录持久化

> `/reset` 清空临时聊天上下文。长期偏好、天气订阅、账本、笔记、小确幸和已安排的提醒保存在 SQLite 中。

---

## 1. 前置要求

- Node.js >= 22.13（支持无需额外启动参数的 `node:sqlite`）
- Docker 宿主机：Debian 13，使用 Docker Compose 插件
- 已在 QQ 开放平台创建机器人并取得 AppID / AppSecret
- 已创建 DeepSeek API Key
- Docker 部署时推荐使用 Docker Compose

当前持久化功能使用 Node.js 22 自带的 `node:sqlite`，无需额外安装 `better-sqlite3` 等原生数据库依赖。

---

## 2. 配置

复制环境变量模板：

```bash
cp .env.example .env
```

编辑 `.env`：

```env
# QQ 开放平台机器人凭证
QQBOT_APP_ID=你的AppID
QQBOT_APP_SECRET=你的AppSecret

# DeepSeek
DEEPSEEK_API_KEY=你的DeepSeek_API_Key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash

# 联网搜索
DEEPSEEK_WEB_SEARCH=true

# DeepSeek 余额查询（建议保持官方地址）
DEEPSEEK_BALANCE_BASE_URL=https://api.deepseek.com
DEEPSEEK_BALANCE_TIMEOUT_MS=10000

# AI 行为
SYSTEM_PROMPT=你的 Qgent System Prompt
MAX_HISTORY_TURNS=8
HISTORY_TTL_MINUTES=120
AI_TIMEOUT_MS=45000

# Qgent
QGENT_DEFAULT_LOCATION=
QGENT_TIMEZONE=Asia/Shanghai
QGENT_DB_PATH=/app/data/qgent.db
QGENT_MAX_TOOL_ROUNDS=5

# 可选：允许查询余额的 QQ C2C OpenID，多个 OpenID 用英文逗号分隔
QGENT_BALANCE_ALLOWED_OPENIDS=

# 群聊仅在 @机器人 时回复
GROUP_REQUIRE_MENTION=true

# 健康检查
HEALTH_HOST=0.0.0.0
HEALTH_PORT=3000
```

不要把 `.env` 提交进 Git。

建议 `.gitignore` 至少包含：

```gitignore
.env
data/
node_modules/
```

---

## 3. 本地运行

安装依赖：

```bash
npm install
```

启动：

```bash
npm start
```

开发模式：

```bash
npm run dev
```

运行单元测试：

```bash
npm test
```

启动成功后应看到类似：

```text
[health] http://0.0.0.0:3000/healthz
[qq] connected
```

然后可以：

- 私聊机器人：直接发送消息
- 群聊机器人：默认需要 `@机器人` 后提问
- `/reset`：清空当前临时会话上下文
- `/help`：查看帮助
- `/balance`：私聊查询 DeepSeek API 余额

---

## 4. Docker Compose

先准备环境变量：

```bash
cp .env.example .env
# 编辑 .env
```

确保 `docker-compose.yml` 给 SQLite 数据目录配置持久化挂载：

```yaml
services:
  qq-deepseek-bot:
    build: .
    container_name: qq-deepseek-bot
    restart: unless-stopped
    env_file:
      - .env
    ports:
      - "127.0.0.1:3000:3000"
    volumes:
      - ./data:/app/data
```

创建数据目录：

```bash
mkdir -p data
```

构建并启动：

```bash
docker compose up -d --build
```

查看日志：

```bash
docker compose logs -f qq-deepseek-bot
```

查看容器状态：

```bash
docker compose ps
```

检查健康状态：

```bash
curl http://127.0.0.1:3000/healthz
```

SQLite 数据默认位于：

```text
容器内：/app/data/qgent.db
宿主机：./data/qgent.db
```

因此重新创建容器不会丢失账本、笔记和小确幸数据。

容器使用 Debian Bookworm slim 系列的 Node.js 22 镜像，通过 `npm ci --omit=dev` 按锁文件安装依赖。

SQLite 固定使用 WAL journal，不再在 I/O 错误时降级为 MEMORY journal。初始化失败会停止启动并保留底层错误；请检查数据目录权限、磁盘空间和文件系统状态。已有数据库会在打开时切换到 WAL，无需删除数据库或手动迁移。

部署更新时执行 `docker compose up -d --build`，再通过 `docker compose ps`、容器日志和上述健康检查确认运行状态。

---

## 5. DeepSeek 模型

默认模型：

```env
DEEPSEEK_MODEL=deepseek-v4-flash
```

需要更强模型时：

```env
DEEPSEEK_MODEL=deepseek-v4-pro
```

无需修改业务代码。

---

## 6. 天气接口与联网搜索

天气优先通过本地工具 `qgent_get_weather` 调用 [UAPI 天气接口](https://uapis.cn/docs/api-reference/get-misc-weather)，不依赖 DeepSeek 是否触发 Web Search。

在 `.env` 配置：

```env
UAPI_API_KEY=你的UAPI_API_Key
UAPI_WEATHER_TIMEOUT_MS=10000
UAPI_WEATHER_EXTENDED=false
QGENT_DEFAULT_LOCATION=乌鲁木齐
```

Key 通过 `Authorization: Bearer` 请求头只发送给 UAPI，不进入模型上下文。未配置 Key 时机器人仍可启动，天气工具会明确返回配置缺失。超时默认 10 秒，覆盖请求与响应读取。

默认查询当前天气、温度、湿度、风向风力和数据更新时间。账户支持高级参数时，可设 `UAPI_WEATHER_EXTENDED=true`，同时请求体感等扩展字段、未来预报及生活指数；权限不足或额度耗尽会明确报错，不自动切换访客请求。未返回的字段不会补造，实况不能替代全天预报。

本次指定地点优先，其次参考当前对话中明确的目的地。省略城市时，工具依次读取本人的城市偏好、`QGENT_DEFAULT_LOCATION`，仍缺地点时会询问。建议会区分实况和对应日期的预报，参考可用的体感、温差、降水量及生活指数，并注明接口返回地点、更新时间和 UAPI 来源。

更新代码和 `.env` 后执行 `docker compose up -d --build` 重新创建容器。可在 QQ 中先 `/reset`，再问“今天乌鲁木齐天气怎么样？怎么穿？”，日志应出现 `name=qgent_get_weather success=true`。即使 `DEEPSEEK_WEB_SEARCH=false`，此天气工具也能工作。

### 联网搜索

Qgent 使用 DeepSeek Responses API，并可开启服务端 Web Search：

```env
DEEPSEEK_WEB_SEARCH=true
```

开启后，模型可以根据问题自动判断是否需要联网。

适合：

- 天气补充资料（实况优先使用上述 UAPI 工具）
- 新闻
- 产品与价格调查
- 店铺、地点、营业信息
- 时效性资料
- 事实调查
- 最新技术动态

例如：

```text
今天乌鲁木齐天气怎么样？晚上出门穿什么？
```

```text
帮我查一下 DeepSeek 最近有什么新消息
```

如果配置：

```env
QGENT_DEFAULT_LOCATION=乌鲁木齐
```

那么用户只问：

```text
今天天气怎么样？
```

Qgent 可以默认使用该地点查询。

也可以发送 `/prefs 城市 乌鲁木齐` 设置自己的默认城市。

---

## 7. 对话记忆

默认每个用户 / 会话最多保留 8 轮，2 小时无消息自动过期：

```env
MAX_HISTORY_TURNS=8
HISTORY_TTL_MINUTES=120
```

当前临时聊天上下文放在进程内存中。

特点：

- 实现简单
- 单实例个人机器人足够使用
- 重启后临时上下文会丢失
- `/reset` 只清空临时上下文

如果后续做多实例、分布式部署，或要求重启后保留聊天上下文，可以改用 Redis。

### 长期偏好

直接发送下面的 QQ 消息即可设置、查看、更正或删除偏好。写入取自本人发送的命令，也支持“记住我的城市是杭州”“把我的城市改为西安”“忘记我的城市”等明确句式。旅行、举例、临时穿衣要求只用于当前对话。

```text
/prefs 城市 杭州
/prefs 时区 Asia/Shanghai
/prefs 穿衣 怕冷，通勤喜欢穿外套
/prefs
/prefs 城市 西安
/prefs 删除 穿衣
```

每个 QQ 用户可保存 12 项。生活偏好按自定名称单独维护。时区使用 IANA 名称，决定相对日期、未指定日期的记账与小确幸、回顾和新提醒的默认时区。已登记的提醒及天气订阅沿用登记时的设置。模型可用只读工具 `qgent_get_preferences` 获取当前用户的相关偏好。在群内请求展示偏好或回顾时，回复对该群可见。

删除后，后续偏好查询会立即反映结果。原对话、已缓存的 QQ 回答及历史备份可能仍保有此前的内容。

---

## 8. 持久化生活工具

Qgent 当前支持本地 SQLite 持久化生活数据。

### 记账

可以直接自然表达：

```text
午饭牛肉面 28 元，帮我记餐饮
```

```text
今天打车 36.5 元
```

也可以查询：

```text
这个月餐饮花了多少？
```

```text
最近 10 笔支出给我看看
```

### 笔记

```text
记个笔记：周五晚上记得买猫砂
```

查询：

```text
我之前是不是记过猫砂相关的东西？
```

### 小确幸

```text
记录一下今天的小确幸：下班路上看到特别漂亮的晚霞
```

查询：

```text
给我看看最近的小确幸
```

所有持久化数据都会按 QQ 用户进行隔离。

### 按需生活回顾

可以说“回顾我上周的生活”“只总结本月账目”或“看看 11 月 1 日到 7 日的小确幸”。`qgent_life_review` 按本人时区读取指定日期范围，默认本周，周一为一周的开始。账目与小确幸按发生日期计算，笔记按本地创建日期计算。

账目收入、支出、结余及分类来自整段时间的整数分汇总。笔记、小确幸各返回该时段的实际总数和最近 5 条摘录，每类最多 10 条，每条最多 240 个字符，附日期与稳定编号。想读全文可以继续说“查看笔记 #3”。更正或撤销记录后，新回顾会反映当前数据。

### 私聊天气订阅

在本人 QQ 私聊中发送以下命令。开启需要现有的 `UAPI_API_KEY`。订阅命令固定检查时间、城市和当时的个人时区。省略城市时使用个人城市或部署默认地点。重新发送开启命令可以更新设置。

```text
/weather on 08:00 杭州
/weather
/weather off
```

每天在所选当地时间检查一次。以下任一条件成立时，通过原有 QQ 提醒队列向本人推送。

- 实况或当天预报降水量大于 0 毫米。
- 体感温度不高于 5℃ 或不低于 32℃。缺少体感时使用实测气温。
- 当天预报最低温不高于 5℃、最高温不低于 32℃，或昼夜温差达到 10℃。

基本天气接口使用可用的实况，预报需账户支持并启用 `UAPI_WEATHER_EXTENDED`。[UAPI 天气字段](https://uapis.cn/docs/api-reference/get-misc-weather)

返回地点不匹配、更新时间超过 6 小时、天气查询失败或可用数值未达阈值时会跳过，可用 `/weather` 查看检查结果、下一次检查时间和最近入队提醒的发送状态。无 UTC 偏移的更新时间按订阅时区核对，宜使用城市当地时区。重启仅补查当日迟到不足一小时的任务，夏令时跳过或重复的钟点跳过当天。改订或重新开启后仍受当地每日一次、相邻检查至少 20 小时的限制。

取消或改订会丢弃旧设置正在查询的天气，并取消尚在队列中等待发送的旧提醒。已经开始发送的消息可能仍会到达。天气提醒与一次性提醒共享 QQ 主动消息频控、额度、重试和回执处理。[QQ 消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)

更新部署运行 `docker compose up -d --build`。启动时自动增建 `user_preferences`、`weather_subscriptions` 和索引，沿用现有环境变量和依赖。可通过 `npm test` 验证，或在本人私聊设置一项偏好，执行 `/reset` 后用 `/prefs` 查看，再查询本周回顾。

### 更正或撤销记录

保存后会得到「账目 #12」「笔记 #3」或「小确幸 #5」这样的编号。每种记录独立编号，旧记录沿用原编号。下面的消息可以直接发给 Qgent。

```text
查看账目 #12
把账目 #12 的金额改为 18 元
给笔记 #3 加一句带上发票
把小确幸 #5 的日期改为 2026-11-17
撤销账目 #12
```

刚记完一笔，也可以说「刚才那笔不是 28，是 18」。Qgent 用原会话上一轮工具实际返回的记录定位。遇到多条候选时会请你选一条，回复「账目 #12」即可继续。更正只更新指定字段，追加笔记保留原文。账目仍以整数分入库，后续汇总会使用更正后的金额。

删除时先显示类型、编号和内容摘要。确认目标后，在原会话复制并发送预览中的「确认删除」和八位确认码。每次确认只对本人的这一条记录有效，时限为 10 分钟。预览后若记录内容已变，需要重新预览。完成另一轮 AI 对话、执行 `/reset` 或重启服务后也需重新预览。删除完成后，查询和统计立即反映结果。`/status`、已有备份、执行凭据和缓存回复可能保留历史操作信息。

按编号读取使用 `qgent_get_record`，修改使用 `qgent_update_ledger`、`qgent_update_note`、`qgent_update_moment`。模型通过 `qgent_prepare_record_deletion` 发起预览，QQ 收到用户的确认消息后才执行删除。更正和最终删除都与执行凭据在同一 SQLite 事务中提交，原 QQ 消息重投可以复用结果。

更新可执行 `docker compose up -d --build`，沿用原有依赖、环境变量和数据库结构。验证时可用一笔测试支出跑通保存、改金额、查汇总、预览删除和确认，再发送 `/status` 核对编号。

### 一次性提醒

在私聊里可以说“明天下午三点提醒我取快递”。在群里可以 @机器人说“明天下午三点在这个群提醒我带发票”。提醒发到创建它的会话，**群内提醒对群成员可见**。用户可以在原会话说“查看我的提醒”“提醒 #3 发出了吗”或“取消提醒 #3”。只有创建者可以查询和取消自己的提醒，取消需在开始发送前完成。

对应工具为 `qgent_create_reminder`、`qgent_list_reminders` 和 `qgent_cancel_reminder`。记录包含编号、事项、触发时间、时区和状态。相对时间以本条 QQ 消息的发送时间为基准，时区优先取本次指定值，其次取个人时区，最后取 `QGENT_TIMEZONE`。时间含糊时会先询问，夏令时回拨的重复时刻需要明确偏移。

用户已在真机 QQ 上验证，当前机器人账号可以创建一次性提醒，并在到期时主动发送提醒。

QQ 单聊和群聊分别按机器人、接收关系和每日额度限流，同一用户或群的上限为每分钟 20 条、每天 1000 条。接收方关闭主动消息、权限不足或用尽额度都会影响发送。[QQ 消息收发概述](https://bot.q.qq.com/wiki/develop/api-v2/server-inter/message/overview.html)

| 查询到的状态 | 含义 |
| --- | --- |
| `pending` / `sending` | 已登记等待发送 / 正在发送 |
| `sent` | QQ 已返回消息 ID，用户是否已读需在客户端核对 |
| `cancelled` / `expired` | 已取消 / 已超过补发期限 |
| `failed` | QQ 明确拒绝，查询结果中附有原因 |
| `unknown` | 发送中断或缺少有效回执，可在原会话核对 |

调度器每隔 5 秒最多处理一条到期提醒。重启后补发迟到 15 分钟以内的待发送提醒。单个接收对象近 24 小时累计 1000 次尝试后等待额度恢复。QQ 返回限流时至少等 60 秒，最多重试一次。遇到超时、服务端异常或发出后进程退出，结果无法确认时停止重发，避免重复打扰。

启动时自动创建 `reminders` 表和索引，沿用现有数据库、环境变量和依赖。更新可执行 `docker compose up -d --build`。验证自己的部署时，可在允许主动发送的测试私聊或群里设置两条短时提醒，取消其中一条，再按编号查询并核对 QQ 中实际出现的消息。

### 消息与工具可靠性（P0）

同一用户在同一会话中的消息按到达顺序处理，`/reset` 也在队列中执行；其他会话可以独立处理。群聊先判断是否 @ 机器人，再移除 @ 标记，避免误丢只含文本 @ 的消息。

当前采用固定的轻量保护：最多同时处理 4 个会话、全局最多 64 条在途及排队消息、每会话最多 8 条；每用户每分钟最多 20 条、每群每分钟最多 60 条。超出限制时提示稍后再试，单条输入上限 8000 字符。排队仅在内存中，重启不恢复尚未执行的消息。

`AI_TIMEOUT_MS`（默认 45000 毫秒）现在是整段 AI 处理预算，包含 SDK 重试、多轮请求和外部工具等待，不含消息排队及 QQ 发送。预算耗尽后取消在途网络请求，不再执行后续工具。SQLite 同步操作无法在执行中强行打断；锁等待结束后再次检查预算。轮数耗尽、不完整响应、空回答及显式联网失败会按失败处理，不发送中间的成功声明。

写工具会在同一个 SQLite 事务中保存业务记录和执行凭据。相同用户、原消息标识、工具及相同参数的重试复用原结果；工具调用 ID 改变不会重复写入。一次消息中确实要记两条完全相同的记录时，工具用不同的 `record_key` 区分。不同消息 ID 被视为新请求，参数不同也视为不同操作，不对自然语言相似内容做猜测合并。手动重新发送相同文字前，应先查询记录，避免把新请求再次保存。

最终回答会在发送 QQ 前缓存到 SQLite，原消息重投时复用回答。缓存保留约 7 天，在后续保存回答时清理；写入执行凭据长期保留。若重启或最终回答失败，原消息已有写入凭据时只反馈已保存的编号，不重新执行剩余写入。多笔操作不是整批事务：可能只有部分成功，失败后请核对再补记。

QQ 中发送 `/status` 可直接查看当前用户最近 10 次成功写入的操作和编号，包括修改和删除。提醒、长期偏好和天气订阅的操作凭据仅在原会话展示。工具提交后最终回答或 QQ 发送失败，会尽可能反馈实际完成的操作。QQ 恢复后也可主动查询 `/status`。历史版本写入但没有执行凭据的记录可通过查询工具查看。

新增 `tool_receipts` 和 `message_results` 表在启动时自动创建，兼容已有数据库，无需删除或手动迁移。缓存回答与工具执行凭据也是持久化用户数据，`/reset` 仅清空模型使用的临时对话上下文，不删除这些数据。

验证：`npm test`；部署更新：`docker compose up -d --build`。本轮没有新增依赖或环境变量。SQLite 一致性备份与恢复操作见下节。

### SQLite 一致性备份与恢复

提供 `db:backup`、`db:verify`、`db:restore` 三个维护命令，使用 Node.js 自带的 SQLite，无需新增依赖、环境变量或数据库迁移。维护脚本不读取 `.env`，也不需要 QQ / DeepSeek 凭证；源路径必须显式指定，备份输出路径可自动生成，恢复输出路径必须显式指定。自定义了 `QGENT_DB_PATH` 时，请把下面的源路径改为实际数据库路径。

备份使用 SQLite `VACUUM INTO` 生成一致性快照，包含快照时已提交但仍在 WAL 中的数据，不包含未提交事务。服务可保持运行；不要直接复制运行中的 `qgent.db` 单文件。生成过程中需要足够的临时磁盘空间，可能短暂影响数据库读写，锁冲突或 I/O 错误时命令失败，请排查后重试。

输出先写入目标目录内的私有临时目录，通过完整性、外键和 Qgent 核心表校验，再发布为独立 `.db` 文件；不需要附带 `-wal` / `-shm` 文件。文件权限为 `0600`，目标文件系统需支持硬链接（常规 Linux 本地文件系统支持）。已有目标、符号链接或同名 SQLite 辅助文件一律拒绝覆盖。备份包含全部用户数据、执行凭据和回复缓存，请保存在私有目录，并定期复制到服务器以外的安全位置；同一磁盘上的副本不能防止磁盘故障。暂不自动安排备份或清理历史副本。

推荐在宿主机直接运行一键脚本：

```bash
./backup-db.sh
```

脚本从项目目录启动临时 Docker Compose 容器，不要求机器人正在运行，也不会重启机器人。默认备份 `/app/data/qgent.db`，文件保存到宿主机 `./data/backups/qgent-20261105143532.db` 这样的路径。时间固定使用北京时间（Asia/Shanghai），格式为 `YYYYMMDDHHmmss`；同一秒重复备份时自动追加 `-1`、`-2`，已有文件仍受防覆盖保护。多个独立备份进程恰好争用同一文件名时，其中一个可能安全失败，重新运行即可。

首次使用或更新脚本后先执行 `docker compose build qq-deepseek-bot`。自定义数据库路径时，例如配置为 `/app/data/custom.db`，运行 `./backup-db.sh /app/data/custom.db`；路径是容器内路径，需位于持久化挂载目录中。

本地也可以自动生成文件名：

```bash
npm run db:backup -- --source ./data/qgent.db
```

默认保存到源数据库同目录下的 `backups/`，执行完成会输出实际文件路径；也可以通过 `--output` 手动指定新文件名，再校验：

```bash
npm run db:backup -- --source ./data/qgent.db --output ./data/backups/qgent-20261105143532.db
npm run db:verify -- --source ./data/backups/qgent-20261105143532.db
```

Docker 中先更新镜像以获得脚本，再在线备份。容器 `/app/data/backups` 对应宿主机 `./data/backups`：

```bash
docker compose up -d --build
docker compose exec -T qq-deepseek-bot npm run db:backup -- --source /app/data/qgent.db --output /app/data/backups/qgent-20261105143532.db
docker compose exec -T qq-deepseek-bot npm run db:verify -- --source /app/data/backups/qgent-20261105143532.db
```

先在独立目录演练恢复，不修改正在运行的生产库：

```bash
docker compose run --rm --no-deps -T qq-deepseek-bot npm run db:restore -- --source /app/data/backups/qgent-20261105143532.db --output /app/data/restore-check-20261105/qgent.db
docker compose run --rm --no-deps -T qq-deepseek-bot npm run db:verify -- --source /app/data/restore-check-20261105/qgent.db
```

需要真正恢复生产时，执行以下顺序；恢复后只包含备份时的数据，备份之后的记录和幂等凭据不会随之恢复：

1. 执行 `docker compose stop qq-deepseek-bot`，确保其他使用相同数据库的进程也已停止。内存队列不会保留，尽量等待当前对话完成再停止。
2. 用上述 `db:restore` 命令恢复到一个全新的目录，例如 `/app/data/recovery-20261105/qgent.db`，再执行 `db:verify`。不要覆盖当前数据库或混用旧 WAL / SHM；原库及其辅助文件保持原样以便回退。
3. 将 `.env` 中 `QGENT_DB_PATH` 修改为该新路径，执行 `docker compose up -d` 重新创建容器；单独 `restart` 不会加载新的环境变量。
4. 用 `docker compose ps`、`curl --fail http://127.0.0.1:3000/healthz` 检查启动，并在 QQ 查询已知的账目、笔记和小确幸。需要回退时先停服务，再把 `QGENT_DB_PATH` 改回原路径，重新执行 `docker compose up -d`。

从旧快照恢复也会回退偏好、订阅和提醒状态。备份后已取消的订阅可能恢复生效。快照中待发送的提醒可能在补发期限内再次触发。

本地恢复同样先停止机器人，再执行 `npm run db:restore -- --source <备份路径> --output <全新数据库路径>`，修改 `.env` 中的 `QGENT_DB_PATH` 后重新启动。上述备份与恢复是管理员命令，不向模型暴露文件操作工具。

自动化测试 `npm test` 覆盖运行中 WAL 备份、未提交事务排除、恢复后读写及用户隔离、执行凭据保留、旧库兼容、损坏 / 错误数据库拒绝、已有文件防覆盖及无凭证 CLI 使用。

## 9. DeepSeek 余额查询

Qgent 可以在 QQ C2C 私聊中直接调用 DeepSeek 官方余额接口查询账户余额，不经过聊天模型，也不会消耗聊天 token：

```text
/balance
```

QQ 单聊自定义菜单中的“更多 → 余额查询”也会发送同一命令。群聊、频道和频道私信不会返回余额数据。

余额接口默认使用 `https://api.deepseek.com`，可通过以下配置调整超时时间和接口地址：

```env
DEEPSEEK_BALANCE_BASE_URL=https://api.deepseek.com
DEEPSEEK_BALANCE_TIMEOUT_MS=10000
```

余额属于账户敏感信息，建议配置 C2C OpenID 白名单：

```env
QGENT_BALANCE_ALLOWED_OPENIDS=你的QQ_C2C_OpenID
```

多个 OpenID 使用英文逗号分隔。留空时，为方便个人部署，任何能私聊机器人的用户都可以执行 `/balance`；启动时会输出安全提示。OpenID 可以从机器人日志中的以下字段找到：

```text
[message] kind=c2c sender=xxxxxxxx
```

如果查询失败，Qgent 会返回简短错误提示，不会把 API Key 或服务端堆栈发送给用户。

---

## 10. Qgent System Prompt

QQ 消息按纯文本展示。程序会在每次 DeepSeek 请求的统一指令中追加纯文本回复规则，即使自定义了 `SYSTEM_PROMPT` 也生效：不使用 Markdown 标题、加粗、斜体、引用、代码围栏、行内代码、表格或链接语法；用自然段、换行和中文序号组织内容，链接直接提供完整网址，代码按纯文本展示。更新后执行 `docker compose up -d --build` 生效，无需新增环境变量或数据库迁移。

推荐给 Qgent 设置稳定的人格：

- 生动活泼
- 俏皮可爱
- 略带一点小傲娇
- 日常聊天轻松自然
- 重要事情认真明确
- 涉及金钱、安全、健康、时间和风险时绝不含糊
- 不知道就明确说不知道
- 时效性信息优先联网查询
- 没有真正调用持久化工具成功前，不应声称“已经记录”

核心原则：

> **Qgent 可以皮，但不能不靠谱。**

由于 `.env` 使用单行变量，建议把完整 System Prompt 压缩成单行后再填写：

```env
SYSTEM_PROMPT=你叫 Qgent，是一个生活在 QQ 里的个人 AI 小助手……
```

---

## 11. QQ 自定义菜单

项目支持通过 QQ OpenAPI 配置机器人单聊自定义菜单。

菜单配置脚本：

```text
scripts/setup-menu.js
```

`package.json` 中应包含：

```json
{
  "scripts": {
    "menu:setup": "node scripts/setup-menu.js"
  }
}
```

执行：

```bash
npm run menu:setup
```

Docker 环境下可以使用仓库根目录的：

```bash
./setup-menu.sh
```

脚本会进入正在运行的 `qq-deepseek-bot` 容器并执行：

```bash
npm run menu:setup
```

如果脚本没有执行权限：

```bash
chmod +x setup-menu.sh
```

推荐菜单：

```text
聊聊

生活
├─ 天气
├─ 穿搭
├─ 记账
├─ 笔记
└─ 小确幸

更多
├─ 余额查询
├─ 调查
├─ 清空对话
└─ 帮助
```

自定义菜单主要用于 QQ 单聊窗口。

群聊中的类似功能应使用 QQ 指令面板，而不是单聊自定义菜单。

---

## 12. Docker 镜像注意事项

如果需要在容器内运行菜单配置脚本，Dockerfile 必须把 `scripts` 目录复制进去：

```dockerfile
FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY src ./src
COPY scripts ./scripts

ENV NODE_ENV=production
EXPOSE 3000

CMD ["node", "src/index.js"]
```

否则容器中运行：

```bash
npm run menu:setup
```

会出现：

```text
Cannot find module '/app/scripts/setup-menu.js'
```

---

## 13. QQ 开放平台注意事项

1. 确保机器人已开通实际使用场景对应的消息能力和事件权限。
2. `AppSecret` 和 `DeepSeek API Key` 只放服务器环境变量，不要放前端。
3. `markdownSupport` 当前建议保持为 `false`，避免未开通 QQ Markdown 权限时发送失败。
4. 普通聊天使用被动回复。到期提醒通过单聊或群聊的主动文本接口发送，目标 OpenID 来自创建提醒时的 QQ 事件。[发送单聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_users_user_openid_messages.post.html) · [发送群聊消息](https://bot.q.qq.com/wiki/develop/api-v2/autogen/api/v2_groups_group_openid_messages.post.html)
5. C2C 流式消息属于 QQ 私聊专属能力；当前为了让群聊、频道和私聊共用稳定链路，统一采用非流式 AI 回复。
6. QQ 自定义菜单用于单聊场景；群聊应使用指令面板。
7. 配置菜单成功后，QQ 客户端可能需要重新进入会话或重启后才显示最新菜单。

---

## 14. 项目结构

当前主要目录：

```text
qq-deepseek-bot/
├── data/
│   └── qgent.db
├── scripts/
│   ├── setup-menu.js
│   └── database.js
├── src/
│   ├── balance.js
│   ├── index.js
│   ├── config.js
│   ├── qqbot.js
│   ├── deepseek.js
│   ├── memory.js
│   ├── records.js
│   ├── preferences.js
│   ├── dates.js
│   ├── weather.js
│   ├── weather-subscriptions.js
│   ├── reminders.js
│   ├── health.js
│   ├── storage.js
│   └── tools.js
├── test/
│   └── balance.test.js
├── .env.example
├── .gitignore
├── Dockerfile
├── docker-compose.yml
├── package.json
├── setup-menu.sh
├── backup-db.sh
└── README.md
```

`data/qgent.db` 属于运行时数据，不建议提交 Git。

---

## 15. 日志

常见日志：

### QQ 已连接

```text
[qq] connected
```

### 联网搜索

```text
[deepseek] web_search=true calls=1 ...
```

### 未联网

```text
[deepseek] web_search=false calls=0 ...
```

### 本地工具调用

```text
[tool] user=xxxx name=qgent_add_ledger success=true
```

### 余额查询

```text
[balance] sender=xxxx success=true
```

### 健康检查

```text
[health] http://0.0.0.0:3000/healthz
```

---

## 16. 生产化建议

个人单机部署可以直接使用当前版本。

各阶段的实现和验收进度见 [ROADMAP.md](ROADMAP.md)。

1. P0：消息排队、原消息写入幂等、整段 AI 超时与失败保存状态反馈已实现；SQLite 一致性备份、校验与恢复脚本已实现；QQ 消息顺序和故障恢复仍待完整实机验收。
2. P1 一次性提醒已上线，支持创建、查询、取消和重启恢复。[使用说明与实测结果](#一次性提醒)
3. P1 记录修改与撤销已实现，支持按编号更正、删除预览和本人确认。[使用说明](#更正或撤销记录)
4. P2 已实现长期偏好、按需生活回顾和本人私聊订阅的天气提醒。[偏好用法](#长期偏好) · [生活回顾](#按需生活回顾) · [天气订阅](#私聊天气订阅)
5. P3 / P4：根据实际需求评估流式回复、群聊指令面板、图片、语音及轻量管理功能。

继续保持单进程、SQLite 和少依赖，当前不预先引入 Redis、任务队列或额外数据库。

---

## 17. 安全建议

- 不要提交 `.env`
- 不要提交真实 API Key
- 定期备份 `data/qgent.db`
- 生产环境限制健康检查端口只监听本机
- 对外部工具调用增加参数校验
- 涉及记账、删除、提醒等写操作时保留明确日志
- 不要让模型直接拼接 SQL
- 对用户输入和 QQ 消息做好长度限制与异常处理

---

## License

请根据仓库实际授权方式补充 License。
