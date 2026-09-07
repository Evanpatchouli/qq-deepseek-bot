# QQ DeepSeek Bot

基于腾讯 QQ 开放平台新版 Node.js SDK `@tencent-connect/qqbot-nodejs` + DeepSeek API 的 AI 机器人后台服务。

## 功能

- WebSocket 长连接，无需公网 webhook 地址
- QQ C2C 私聊、群聊文本消息
- 频道（Guild）和频道私信（DM）文本回复
- 群聊默认仅在 @机器人 时回复
- DeepSeek 多轮上下文（内存缓存）
- `/reset` 清空当前用户会话
- `/help` 查看帮助
- QQ 消息去重、自回声过滤
- `/healthz` 健康检查
- Docker / Docker Compose 部署

## 1. 前置要求

- Node.js >= 20.6（推荐 Node.js 22 LTS）
- 已在 QQ 开放平台创建机器人并取得 AppID / AppSecret
- 已创建 DeepSeek API Key

## 2. 配置

```bash
cp .env.example .env
```

编辑 `.env`：

```env
QQBOT_APP_ID=你的AppID
QQBOT_APP_SECRET=你的AppSecret
DEEPSEEK_API_KEY=你的DeepSeek_API_Key
DEEPSEEK_MODEL=deepseek-v4-flash
```

不要把 `.env` 提交进 Git。

## 3. 本地运行

```bash
npm install
npm start
```

开发模式：

```bash
npm run dev
```

启动成功后应看到：

```text
[health] http://0.0.0.0:3000/healthz
[qq] connected
```

然后：

- 私聊机器人：直接发消息
- 群聊机器人：默认需要 `@机器人` 后提问
- `/reset`：清空当前会话上下文
- `/help`：帮助

## 4. Docker Compose

```bash
cp .env.example .env
# 编辑 .env

docker compose up -d --build
docker compose logs -f
```

检查健康状态：

```bash
curl http://127.0.0.1:3000/healthz
```

## 5. DeepSeek 模型

默认：

```env
DEEPSEEK_MODEL=deepseek-v4-flash
```

需要更强模型时改成：

```env
DEEPSEEK_MODEL=deepseek-v4-pro
```

无需修改代码。

## 6. 对话记忆

默认每个用户/会话最多保留 8 轮，2 小时无消息自动过期：

```env
MAX_HISTORY_TURNS=8
HISTORY_TTL_MINUTES=120
```

当前实现把上下文放在进程内存里。单实例个人机器人足够简单；如果后续做多实例或要求重启后保留上下文，再换 Redis 即可。

## 7. QQ 开放平台需要注意

1. 确保机器人已开通你实际使用场景对应的消息能力/事件权限。
2. `AppSecret` 和 `DeepSeek API Key` 只放服务器环境变量，不要放前端。
3. `markdownSupport` 当前固定为 `false`，避免未开 Markdown 权限时发送失败。
4. QQ 主动消息有额度限制，本项目主要采用“收到用户消息后被动回复”。
5. C2C 流式消息是 QQ 私聊专属能力；本初版为了让群聊/频道/私聊共用同一条稳定链路，统一采用非流式 DeepSeek 回复。

## 8. 生产化建议

个人单机部署可以直接用当前版本。如果要继续增强，推荐顺序：

1. Redis 保存对话上下文和限流状态
2. 用户级/群级限流
3. DeepSeek 流式输出（仅 C2C）
4. 管理后台与用量统计
5. Function Calling / MCP 工具调用
6. 图片理解、语音消息
