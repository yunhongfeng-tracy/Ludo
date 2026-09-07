'use strict';

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const SOURCE_ROOT = path.join(ROOT, 'src');

// 按产品入口实际的静态依赖拓扑打包，主页面与 Worker 共用同一顺序。
function strategySources() {
  const seen = new Set();
  const visiting = new Set();
  const result = [];
  function visit(file) {
    const resolved = require.resolve(file);
    const relative = path.relative(SOURCE_ROOT, resolved);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('AI dependency is outside src: ' + resolved);
    if (seen.has(resolved)) return;
    if (visiting.has(resolved)) throw new Error('Circular AI dependency: ' + resolved);
    visiting.add(resolved);
    const source = fs.readFileSync(resolved, 'utf8');
    const requires = source.matchAll(/\brequire\(\s*(['"])(\.[^'"]+)\1\s*\)/g);
    for (const match of requires) visit(path.resolve(path.dirname(resolved), match[2]));
    visiting.delete(resolved);
    seen.add(resolved);
    result.push(path.relative(ROOT, resolved).split(path.sep).join('/'));
  }
  visit(path.join(SOURCE_ROOT, 'ai-policy.js'));
  return result;
}

module.exports = { strategySources };
