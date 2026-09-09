# SQLite `disk I/O error` 修复

本修复针对 Docker/CentOS 环境中 SQLite 在 `/app/data` 写 journal/WAL 或初始化表结构时出现的：

```text
Error: disk I/O error
errcode: 778
```

## 根因范围

`SQLITE_IOERR_WRITE`（常见错误码为 778）表示 SQLite 的写入动作失败。CentOS 7 不是 SQLite 的禁用条件，但以下宿主机问题都可能触发它：

- SELinux 未允许容器访问 bind mount；
- `data` 目录或已有数据库文件不可写；
- 磁盘空间或 inode 用尽；
- bind mount 位于不支持 SQLite 锁/journal 语义的远程或特殊文件系统。

`:Z` 只处理 SELinux 标签，不会修复其他几类问题。

## 修改

1. `docker-compose.yml` 的数据挂载改为：

```yaml
- ./data:/app/data:Z
```

2. SQLite 初始化改为两阶段重试：
   - 优先以 `WAL` 打开数据库并完成建表；
   - WAL 设置或初始化写入发生 I/O 错误时，关闭连接并重新打开；
   - 第二次使用 `MEMORY` journal 完成初始化；
   - 保留 `foreign_keys=ON` 与 5 秒 busy timeout；
   - 如果数据库本身不可写，返回包含数据库路径和底层错误的启动异常，不再误以为切换 journal 就能解决。

3. `.gitignore` 增加 `data/`，避免运行时数据库误提交。

## CentOS 7 检查

```bash
getenforce
ls -Zd ./data
docker inspect qq-deepseek-bot --format '{{json .Mounts}}'
df -h ./data
sudo ausearch -m avc -ts recent | tail -n 50
```

如果 `getenforce` 返回 `Enforcing`，保留 Compose 中的 `:Z`，并在修改挂载标签后重新创建容器。

## 部署

直接重新创建容器，让新的 SELinux 挂载标签生效：

```bash
docker compose down
docker compose up -d --build
docker compose logs -f qq-deepseek-bot
```

无需删除 `data/qgent.db`，也不要删除现有持久化数据。
