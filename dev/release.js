#!/usr/bin/env node
/* Bump the version in every place at once and (optionally) commit + push.
   usage: node dev/release.js 1.12.0 "What changed" [--push] */
const fs = require('fs'), path = require('path'), cp = require('child_process');
const [ver, notes, ...flags] = process.argv.slice(2);
if (!/^\d+\.\d+\.\d+$/.test(ver || '')) { console.error('usage: node dev/release.js <x.y.z> "<notes>" [--push]'); process.exit(1); }
const root = path.resolve(__dirname, '..');
const idx = path.join(root, 'index.html'); const vj = path.join(root, 'version.json');
fs.writeFileSync(idx, fs.readFileSync(idx, 'utf8').replace(/window\.APP_VERSION = '[^']*'/, `window.APP_VERSION = '${ver}'`));
const v = JSON.parse(fs.readFileSync(vj, 'utf8')); v.version = ver; v.date = new Date().toISOString().slice(0, 10); if (notes) v.notes = notes;
fs.writeFileSync(vj, JSON.stringify(v, null, 2) + '\n');
console.log(`version ${ver} written to index.html and version.json`);
if (flags.includes('--push')) { cp.execSync(`git add -A && git commit -q -m "${ver}: ${(notes || 'release').replace(/"/g, "'")}" && git push -q origin main`, { cwd: root, stdio: 'inherit' }); console.log('committed and pushed'); }
