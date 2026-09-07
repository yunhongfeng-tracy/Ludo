"use strict";
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const read = name => fs.readFileSync(path.join(root, name), "utf8");
const { strategySources } = require("./ai-product-sources.cjs");
function build(outputFile = path.join(root, "index.html")) {
const releaseSource = read("src/releases.json");
if (releaseSource.includes("\uFFFD")) throw new Error("更新记录存在编码替换字符");
const history = JSON.parse(releaseSource);
const version = JSON.parse(read("package.json")).version;
if (history.currentVersion !== version || history.releases[0]?.version !== version) throw new Error("当前版本与更新记录不一致");
const escapeHtml = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const ids = new Set();
const releasesHtml = history.releases.map((release, index) => {
  if (!/^[a-z0-9-]+$/.test(release.id) || ids.has(release.id)) throw new Error("更新记录 ID 无效或重复");
  ids.add(release.id);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(release.date) || new Date(release.date).toISOString().slice(0, 10) !== release.date) throw new Error("更新记录日期无效");
  if (index && release.date > history.releases[index - 1].date) throw new Error("更新记录必须按日期倒序排列");
  if (![release.version, release.title, release.summary].every(value => typeof value === "string" && value.trim())) throw new Error("更新记录缺少文案");
  if (!Array.isArray(release.changes) || !release.changes.length) throw new Error("更新记录缺少变更内容");
  const changes = release.changes.map(change => {
    if (!["新增", "优化", "修复"].includes(change.kind) || !Array.isArray(change.items) || !change.items.length || !change.items.every(item => typeof item === "string" && item.trim())) throw new Error("更新记录变更内容无效");
    const style = change.kind === "修复" ? " fix" : change.kind === "优化" ? " improve" : "";
    return `<div class="release-change"><span class="change-kind${style}">${escapeHtml(change.kind)}</span><ul>${change.items.map(item => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`;
  }).join("");
  const [year, month, day] = release.date.split("-");
  return `<article class="release-entry${index === 0 ? " latest" : ""}" aria-labelledby="release-${release.id}"><div class="release-meta"><span class="release-version">v${escapeHtml(release.version)}</span><time datetime="${release.date}">${year}年${month}月${day}日</time>${index === 0 ? '<span class="release-latest-label">最新</span>' : ""}</div><div class="release-content"><h2 id="release-${release.id}">${escapeHtml(release.title)}</h2><p class="release-summary">${escapeHtml(release.summary)}</p>${changes}${release.note ? `<p class="release-note">${escapeHtml(release.note)}</p>` : ""}</div></article>`;
}).join("\n");
let html = read("src/index.template.html");
html = html.replaceAll("<!--__VERSION__-->", escapeHtml(version)).replace("<!--__RELEASES__-->", () => releasesHtml);
const strategyFiles = strategySources();
const parts = { STYLES: "src/styles.css", ENGINE: "src/engine.js", AI: strategyFiles.filter(file => file !== "src/engine.js"), AI_CLIENT: "src/ai-client.js", UPDATES: "src/updates.js", APP: "src/app.js",
  WORKER_SOURCE: [...strategyFiles, "src/ai-worker.js"] };
for (const [key, file] of Object.entries(parts)) {
  const text = Array.isArray(file) ? file.map(read).join("\n") : read(file);
  if (text.includes("\uFFFD")) throw new Error(`${file} 存在编码替换字符`);
  if (key !== "STYLES" && /<\/script/i.test(text)) throw new Error(`${file} 包含不安全的内嵌脚本结束标记`);
  const marker = `/*__${key}__*/`;
  if (!html.includes(marker)) throw new Error(`缺少构建插槽 ${key}`);
  html = html.replace(marker, () => text);
}
if (/\/\*__[A-Z_]+__\*\/|<!--__[A-Z_]+__-->/.test(html)) throw new Error("存在未替换的构建插槽");
fs.writeFileSync(outputFile, html, { encoding: "utf8" });
return { outputFile, bytes: Buffer.byteLength(html), strategyFiles };
}
module.exports = { build };
if (require.main === module) {
  const result = build();
  console.log(`已生成 index.html，${result.bytes} 字节，资源全部内嵌。`);
}
