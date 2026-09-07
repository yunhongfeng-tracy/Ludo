"use strict";
// 校验公网单文件成品与本地摘要一致，记录部署后的只读验收结果。
const fs = require("node:fs");
const path = require("node:path");
const https = require("node:https");
const crypto = require("node:crypto");
const root = path.resolve(__dirname, "..");
const output = path.resolve(root, process.argv[2] || "output/deploy/public-check.json");
const digest = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const expected = digest(fs.readFileSync(path.join(root, "index.html")));
const request = https.get("https://ludo.tracyyun.cn/", { headers: { "Cache-Control": "no-cache" } }, response => {
  const chunks = [];
  response.on("data", chunk => chunks.push(chunk));
  response.on("error", fail);
  response.on("end", () => {
    try {
      const body = Buffer.concat(chunks);
      const hash = digest(body);
      const html = new TextDecoder("utf-8", { fatal: true }).decode(body);
      if (response.statusCode !== 200 || hash !== expected) throw new Error("公网成品与本地版本不一致");
      const report = { checkedAt: new Date().toISOString(), url: "https://ludo.tracyyun.cn/", status: response.statusCode,
        bytes: body.length, sha256: hash, matchesLocal: true, updatesPage: html.includes('id="updates-page"'),
        version: JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version };
      fs.mkdirSync(path.dirname(output), { recursive: true });
      fs.writeFileSync(output, JSON.stringify(report, null, 2), "utf8");
      console.log(JSON.stringify(report, null, 2));
    } catch (error) { fail(error); }
  });
});
request.setTimeout(20000, () => request.destroy(new Error("公网校验超时")));
request.on("error", fail);
function fail(error) { console.error(error.message); process.exitCode = 1; }
