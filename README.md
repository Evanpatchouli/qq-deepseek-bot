# QQ DeepSeek Bot

基于腾讯 QQ 开放平台新版 Node.js SDK `@tencent-connect/qqbot-nodejs` + DeepSeek API 构建的 AI 机器人后台服务。

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
- QQ 单聊自定义菜单
- QQ 私聊 `/balance` 查询 DeepSeek API 余额
- `/reset` 清空当前用户临时会话上下文
- `/help` 查看帮助
- QQ 消息去重、自回声过滤
- `/healthz` 健康检查
- Docker / Docker Compose 部署
- SQLite 数据目录持久化

> `/reset` 只会清空临时聊天上下文，不会删除账本、笔记或小确幸等持久化数据。

---

## 1. 前置要求

- Node.js >= 20.6
- 推荐 Node.js 22 LTS
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
      - ./data:/app/data:Z
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

在 CentOS / RHEL 等启用 SELinux 的宿主机上，建议保留挂载后的 `:Z`：

```yaml
volumes:
  - ./data:/app/data:Z
```

Qgent 启动时优先使用 SQLite WAL。如果 WAL 设置或首次建表阶段出现 SQLite I/O 错误，程序会关闭当前连接、重新打开数据库并降级为 `MEMORY` journal；两种模式都无法写入时才会启动失败，并保留底层错误用于定位宿主机目录、权限、磁盘空间或文件系统问题。

CentOS 7 本身并不阻止 SQLite 工作，但其常见的 SELinux 和旧版 Docker 环境可能影响容器对 bind mount 的写入。遇到 `disk I/O error` 时可检查：

```bash
getenforce
ls -Zd ./data
docker inspect qq-deepseek-bot --format '{{json .Mounts}}'
df -h ./data
```

如果 SELinux 为 `Enforcing`，修改 `:Z` 或目录标签后必须重新创建容器：

```bash
docker compose down
docker compose up -d --build
```

仍然失败时，检查 SELinux 拒绝记录：

```bash
sudo ausearch -m avc -ts recent | tail -n 50
```

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

## 6. 联网搜索

Qgent 使用 DeepSeek Responses API，并可开启服务端 Web Search：

```env
DEEPSEEK_WEB_SEARCH=true
```

开启后，模型可以根据问题自动判断是否需要联网。

适合：

- 实时天气
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

如果 `QGENT_DEFAULT_LOCATION` 留空，模型在缺少地点时应优先询问，而不是自行猜测。

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
FROM node:22-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --omit=dev

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
4. QQ 主动消息存在额度和平台限制，本项目主要采用“收到用户消息后被动回复”。
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
│   └── setup-menu.js
├── src/
│   ├── balance.js
│   ├── index.js
│   ├── config.js
│   ├── qqbot.js
│   ├── deepseek.js
│   ├── memory.js
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

继续增强时推荐顺序：

1. 主动提醒 / 定时任务
2. 用户级 / 群级限流
3. Redis 保存临时上下文和限流状态
4. 更完善的账目分类和月度报表
5. 笔记标签、搜索和归档
6. 天气主动提醒与穿衣建议
7. QQ 群聊指令面板
8. C2C DeepSeek 流式输出
9. 管理后台和 Token / 用量统计
10. 图片理解
11. 语音消息
12. MCP / 更多外部工具接入

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
