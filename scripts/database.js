import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { createDatabaseSnapshot, verifyDatabaseSnapshot } from "../src/storage.js";

const help = `SQLite 维护命令（不需要 QQ / DeepSeek 凭证）
  npm run db:backup -- --source <当前数据库> [--output <新备份文件>]
  npm run db:restore -- --source <备份文件> --output <新数据库文件>
  npm run db:verify -- --source <待校验数据库>

backup 可在服务运行时使用，包含已提交的 WAL 数据。
restore 只恢复到新路径；切换生产数据库前必须先停止服务。
源路径必须显式指定；backup 默认保存到源目录的 backups/qgent-YYYYMMDDHHmmss.db。
时间使用 Asia/Shanghai；同秒重名时追加 -1、-2。restore 必须显式指定新路径。
不会自动读取 .env 或覆盖数据库、WAL、SHM 文件。`;

function automaticBackupPath(source) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date());
  const fields = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const timestamp = ["year", "month", "day", "hour", "minute", "second"].map((field) => fields[field]).join("");
  const directory = path.join(path.dirname(path.resolve(source)), "backups");
  for (let index = 0; ; index++) {
    const filename = path.join(directory, `qgent-${timestamp}${index ? `-${index}` : ""}.db`);
    const occupied = ["", "-wal", "-shm", "-journal"].some((suffix) => {
      try { fs.lstatSync(filename + suffix); return true; } catch (error) {
        if (error.code === "ENOENT") return false;
        throw error;
      }
    });
    if (!occupied) return filename;
  }
}

try {
  const { values, positionals } = parseArgs({
    options: { source: { type: "string" }, output: { type: "string" }, help: { type: "boolean", short: "h" } },
    allowPositionals: true,
  });
  if (values.help) {
    console.log(help);
  } else {
    const [command] = positionals;
    if (positionals.length !== 1 || !["backup", "restore", "verify"].includes(command) ||
        !values.source || (command === "verify" && values.output !== undefined) ||
        (command === "restore" && !values.output)) {
      throw new Error(help);
    }
    const result = command === "verify"
      ? verifyDatabaseSnapshot(values.source)
      : createDatabaseSnapshot({ sourcePath: values.source, destinationPath: values.output ?? automaticBackupPath(values.source) });
    console.log(`[database] ${command} success=true ${JSON.stringify(result)}`);
  }
} catch (error) {
  console.error(`[database] failed: ${error.message}`);
  process.exitCode = 1;
}
