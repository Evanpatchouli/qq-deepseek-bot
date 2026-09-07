import { createServer } from "node:http";

export function startHealthServer({ host, port, getStatus }) {
  const server = createServer((req, res) => {
    if (req.url !== "/healthz") {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ ok: false, error: "not_found" }));
      return;
    }

    const status = getStatus();
    res.writeHead(status.ready ? 200 : 503, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    res.end(JSON.stringify(status));
  });

  server.listen(port, host, () => {
    console.log(`[health] http://${host}:${port}/healthz`);
  });

  return server;
}
