"use strict";
const fs = require("node:fs");
const path = require("node:path");
const cp = require("node:child_process");
const root = path.resolve(__dirname, "..");
const { strategySources } = require("./ai-product-sources.cjs");
const strategyFiles = strategySources();
for (const name of [...strategyFiles, "src/ai-worker.js", "src/ai-client.js", "src/app.js", "src/updates.js", "tools/ai-product-sources.cjs", "tools/ai-benchmark.cjs", "tools/build.cjs", "tools/check.cjs", "tools/serve.cjs", "tools/verify-public.cjs"]) {
  const result = cp.spawnSync(process.execPath, ["--check", path.join(root, name)], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr || `语法检查失败：${name}`);
}
for (const name of [...strategyFiles, "index.html", "src/index.template.html", "src/styles.css", "src/app.js", "src/ai-worker.js", "src/ai-client.js", "src/updates.js", "src/releases.json", "package.json", "tools/ai-product-sources.cjs", "tools/ai-benchmark.cjs", "tools/build.cjs", "tools/check.cjs"]) {
  const bytes = fs.readFileSync(path.join(root, name));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (text.includes("\uFFFD")) throw new Error(`编码检查失败：${name}`);
}
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
if (/<script[^>]+src\s*=|<link[^>]+href\s*=\s*["']https?:|@import|url\(\s*["']?https?:/i.test(html)) throw new Error("成品包含外部资源依赖");
if (/\/\*__[A-Z_]+__\*\/|<!--__[A-Z_]+__-->/.test(html)) throw new Error("成品仍有未替换插槽");
console.log("JavaScript 语法、UTF-8 和单文件离线资源检查通过。");
