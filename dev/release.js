#!/usr/bin/env node
/* Bump the version in every place at once and (optionally) commit + push.
   usage: node dev/release.js 1.12.0 "What changed" [--push] */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const [ver, notes, ...flags] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(ver || '')) { console.error('usage: node dev/release.js <x.y.z> "<notes>" [--push]'); process.exit(1); }
const root = path.resolve(__dirname, '..');
const idx = path.join(root, 'index.html'); const vj = path.join(root, 'version.json');
let html = fs.readFileSync(idx, 'utf8').replace(/window\.APP_VERSION = '[^']*'/, `window.APP_VERSION = '${ver}'`);
// the CSP allows the two inline scripts by hash; the version script changes each release, so recompute
const crypto = require('crypto');
const hashes = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => "'sha256-" + crypto.createHash('sha256').update(m[1]).digest('base64') + "'").join(' ');
// trimEnd matters: the old hashes are captured separately, so without it the gap before them grows by a space per release
html = html.replace(/(script-src [^;]*?)('sha256-[^;]*)?;/, (all, pre) => `${pre.replace(/\s+'sha256-.*$/, '').trimEnd()} ${hashes};`);
fs.writeFileSync(idx, html);
const v = JSON.parse(fs.readFileSync(vj, 'utf8')); v.version = ver; v.date = new Date().toISOString().slice(0, 10); if (notes) v.notes = notes;
fs.writeFileSync(vj, JSON.stringify(v, null, 2) + '\n');
console.log(`version ${ver} written to index.html and version.json`);
if (flags.includes('--push')) { cp.execSync(`git add -A && git commit -q -m "${ver}: ${(notes || 'release').replace(/"/g, "'")}" && git push -q origin main`, { cwd: root, stdio: 'inherit' }); console.log('committed and pushed'); }
