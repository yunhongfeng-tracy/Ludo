"use strict";
// 仅用于开发预览，游戏成品可以直接双击打开，不依赖此服务。
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const htmlPath = path.resolve(__dirname, "..", "index.html");
const server = http.createServer((req, res) => {
  if (req.url.split("?")[0] !== "/" && req.url.split("?")[0] !== "/index.html") {
    res.writeHead(404); res.end(); return;
  }
  try {
    const html = fs.readFileSync(htmlPath);
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    res.end(html);
  } catch { res.writeHead(500); res.end("Build index.html first."); }
});
server.listen(Number(process.env.LUDO_PREVIEW_PORT || 0), "127.0.0.1", () => {
  console.log(`Ludo preview: http://127.0.0.1:${server.address().port}`);
});
