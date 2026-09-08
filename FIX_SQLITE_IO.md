# SQLite `disk I/O error` 修复

本修复针对 Docker/CentOS 环境中 SQLite 在 `/app/data` 写 journal/WAL 时出现的：

```text
Error: disk I/O error
errcode: 778
```

## 修改

1. `docker-compose.yml` 的数据挂载改为：

```yaml
- ./data:/app/data:Z
```

2. SQLite 初始化不再强制要求 WAL 成功：
   - 优先 `WAL`
   - WAL 不可用时自动降级为 `MEMORY` journal
   - 保留 `foreign_keys=ON` 与 5 秒 busy timeout

3. `.gitignore` 增加 `data/`，避免运行时数据库误提交。

## 部署

直接重新创建容器，让新的 SELinux 挂载标签生效：

```bash
docker compose down
docker compose up -d --build
docker compose logs -f qq-deepseek-bot
```

无需删除 `data/qgent.db`，也不要删除现有持久化数据。
