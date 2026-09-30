/* Text extraction from documents, fully client-side. Libraries are loaded from cdnjs on first use:
   PDF -> pdf.js, DOCX/PPTX -> JSZip (+ XML parsing), XLSX/XLS/ODS/CSV -> SheetJS, DOC/PPT -> SheetJS's CFB reader. */
H.extract = (() => {
  /* Pinned by subresource integrity, like the libraries index.html loads up front: these parse the user's own
     documents with full page privileges, so a swapped file on the CDN must simply fail to run.
     Hashes are the ones cdnjs publishes for these exact versions — bump both together. */
  const CDN = {
    pdf: ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', () => window.pdfjsLib, 'sha512-q+4liFwdPC/bNdhUpZx6aXDx/h77yEQtn4I1slHydcbZK34nLaR3cAeYSJshoxIOq3mjEf7xJE8YWIUHMn+oCQ=='],
    /* A classic worker script cannot carry an `integrity` attribute, so this one was the only CDN file here with
       nothing checking it. It is fetched, hashed and run from a blob: URL instead — the same guarantee the other
       three get from SRI, by hand. Bump the hash with the version, exactly like the others. */
    pdfWorker: ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', null, 'sha512-BbrZ76UNZq5BhH7LL7pn9A4TKQpQeNCHOo65/akfelcIBbcVvYWOFQKPXIrykE3qZxYjmDX573oa4Ywsc7rpTw=='],
    jszip: ['https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', () => window.JSZip, 'sha512-XMVd28F1oH/O71fzwBnV7HucLxVwtxf26XV8P4wPk26EDxuGZ91N8bsOttmnomcCD3CS5ZMRL50H0GgOHvegtg=='],
    xlsx: ['https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', () => window.XLSX, 'sha512-r22gChDnGvBylk90+2e/ycr3RVrDi8DIOkIGNhJlKfuyQM4tIRAI062MaV8sfjQKYVGjOBaZBOA87z+IhZE9DA=='],
  };
  const lib = (name) => H.loadScript(...CDN[name]);

  const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|java|kt|go|rs|c|h|cpp|hpp|cs|php|sh|bash|zsh|ps1|bat|yaml|yml|toml|ini|cfg|conf|env|sql|graphql|proto|log|rtf|svg|tex|r|m|swift|scala|lua|pl|dart|vue|svelte|properties|gradle|dockerfile|makefile|gitignore|editorconfig)$/i;
  const kindOf = (name, type = '') => {
    const n = name.toLowerCase();
    if (/\.(heic|heif)$/.test(n) || /heic|heif/.test(type)) return 'heic';
    if (/\.(mp4|m4v|webm|mov|ogv|mkv|avi)$/.test(n) || type.startsWith('video/')) return 'video';
    if (/\.(mp3|wav|m4a|aac|ogg|oga|flac|webm|opus|wma)$/.test(n) || type.startsWith('audio/')) return 'audio';
    if (/\.pdf$/.test(n) || type === 'application/pdf') return 'pdf';
    if (/\.(docx|docm|dotx|dotm)$/.test(n)) return 'docx';
    if (/\.(pptx|pptm|potx|potm|ppsx|ppsm)$/.test(n)) return 'pptx';
    if (/\.(xlsx|xlsm|xlsb|xltx|xltm|xls|ods)$/.test(n)) return 'sheet';
    if (/\.(csv|tsv)$/.test(n)) return 'text';
    if (/\.(png|jpe?g|gif|webp|bmp)$/.test(n) || type.startsWith('image/')) return 'image';
    if (/\.(doc|dot)$/.test(n)) return 'doc';
    if (/\.(ppt|pps|pot)$/.test(n)) return 'ppt';
    if (/\.(zip|gz|tar|7z|rar|exe|dll|dmg|iso|woff2?|ttf|otf|bin|class|pyc|wasm|sqlite|db)$/.test(n)) return 'binary';
    if (TEXT_EXT.test(n) || type.startsWith('text/') || /json|xml|javascript/.test(type)) return 'text';
    return 'unknown';
  };

  const looksBinary = (buf) => { const b = new Uint8Array(buf.slice(0, 8000)); let bad = 0; for (const x of b) if (x === 0 || (x < 7) || (x > 13 && x < 32 && x !== 27)) bad++; return b.length > 0 && bad / b.length > 0.02; };
  const decodeText = (buf) => { let t = new TextDecoder('utf-8', { fatal: false }).decode(buf); if (t.includes('�')) { try { t = new TextDecoder('windows-1252').decode(buf); } catch { } } return t.replace(/^﻿/, ''); };
  const rtfText = (s) => s.replace(/\\par[d]?/g, '\n').replace(/\{\\\*[^}]*\}/g, '').replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '').trim();

  /* The worker, verified: fetch it, hash it, hand pdf.js a blob: URL for the bytes that matched. A mismatch (or a
     browser with no Web Crypto) is not fatal — pdf.js can parse on the main thread — so the answer is null and
     the caller falls back to disableWorker, which is slower and can block the tab on a large file, but still
     reads the user's document rather than refusing to. */
  let workerBlob = null;
  async function verifiedWorker() {
    if (workerBlob !== null) return workerBlob;
    const [url, , integrity] = CDN.pdfWorker;
    try {
      const bytes = await H.fetchVerified(url, integrity);
      workerBlob = URL.createObjectURL(new Blob([bytes], { type: 'application/javascript' }));
    } catch (e) { console.warn('pdf worker not verified, parsing on the main thread', e); workerBlob = ''; }
    return workerBlob;
  }
  /** pdf.js, loaded and pointed at its verified worker. Shared with the preview panel, which renders the pages
      this module reads the text out of — one copy of the library, one checksum to keep current. */
  async function pdfjs() {
    const lib_ = await lib('pdf');
    const src = await verifiedWorker();
    if (src) lib_.GlobalWorkerOptions.workerSrc = src;
    return { lib: lib_, worker: !!src };
  }
  async function pdf(buf, onStatus) {
    onStatus?.('Loading PDF reader…');
    const { lib: lib_, worker } = await pdfjs();
    const src = worker;
    const doc = await lib_.getDocument({ data: buf, disableWorker: !src }).promise;
    const parts = []; let empty = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      onStatus?.(`Reading PDF page ${i}/${doc.numPages}`);
      const page = await doc.getPage(i); const tc = await page.getTextContent();
      let line = '', lastY = null, text = '';
      for (const it of tc.items) { if (!('str' in it)) continue; const y = it.transform?.[5]; if (lastY !== null && Math.abs(y - lastY) > 2) { text += line.trimEnd() + '\n'; line = ''; } line += it.str + (it.hasEOL ? '\n' : ''); lastY = y; }
      text += line; text = text.replace(/[ \t]+\n/g, '\n').trim();
      if (!text) empty++;
      parts.push(`--- Page ${i} ---\n${text}`);
    }
    const note = [
      empty === doc.numPages ? 'The PDF contains no extractable text (scanned images?). OCR is not available in the browser; ask the user for a text version.' : empty ? `${empty} of ${doc.numPages} pages had no text layer.` : '',
      src ? '' : 'The PDF worker could not be verified against its checksum, so parsing ran on the main thread (slower).',
    ].filter(Boolean).join(' ');
    return { text: parts.join('\n\n'), pages: doc.numPages, note };
  }
  /* ===== Office documents =====
     Read as the model would need them, not just their visible run text: Word keeps headings, lists, tables, links,
     headers/footers, footnotes, comments and tracked changes; PowerPoint follows the presentation's own slide order
     and adds speaker notes, comments, tables, SmartArt and hidden slides; Excel keeps cell addresses, formulas,
     comments, links, merged and hidden ranges. Charts come out as their data, and embedded pictures are listed by
     their path inside the file so view_image can open one ("report.docx#word/media/image1.png").
     The pre-2007 binary .doc and .ppt formats are read from their compound-file streams. */
  const isZip = (u8) => u8[0] === 0x50 && u8[1] === 0x4B;
  const isCfb = (u8) => u8[0] === 0xD0 && u8[1] === 0xCF && u8[2] === 0x11 && u8[3] === 0xE0;
  const parseXml = (s) => { const d = new DOMParser().parseFromString(s, 'application/xml'); if (d.getElementsByTagName('parsererror').length) throw new Error('malformed XML'); return d; };
  /* Matched by local name: prefixes are only a convention, and Strict OOXML files use other namespaces. */
  const all = (el, name) => el ? Array.from(el.getElementsByTagNameNS('*', name)) : [];
  const first = (el, name) => el?.getElementsByTagNameNS('*', name)[0] || null;
  const child = (el, name) => el ? Array.from(el.children).find(c => c.localName === name) || null : null;
  const childs = (el, name) => el ? Array.from(el.children).filter(c => c.localName === name) : [];
  const isRelNs = (a) => /relationships/.test(a.namespaceURI || '');
  const at = (el, name) => { for (const a of el?.attributes || []) if (a.localName === name && !isRelNs(a)) return a.value; return null; };
  const rid = (el, name = 'id') => { for (const a of el?.attributes || []) if (a.localName === name && isRelNs(a)) return a.value; return null; };
  const joinPath = (dir, t) => { const out = []; for (const s of (t.startsWith('/') ? t.slice(1) : dir + t).split('/')) { if (s === '..') out.pop(); else if (s && s !== '.') out.push(s); } return out.join('/'); };
  const cellText = (s) => String(s).replace(/\|/g, '\\|').replace(/\s*\n\s*/g, '<br>').trim();
  function mdTable(rows) {
    rows = rows.filter(r => r.some(c => c));
    if (!rows.length) return '';
    const w = Math.max(...rows.map(r => r.length));
    const line = (r) => '| ' + Array.from({ length: w }, (_, i) => r[i] ?? '').join(' | ') + ' |';
    return [line(rows[0]), '|' + ' --- |'.repeat(w), ...rows.slice(1).map(line)].join('\n');
  }
  /* Paragraphs get a blank line between them, list items do not, so a list still reads as one list. */
  const joinBlocks = (bs) => { let out = '', prev = null; for (const b of bs) { if (!b) continue; const li = /^\s*(-|\d+\.) /.test(b); out += prev === null ? b : (li && prev ? '\n' : '\n\n') + b; prev = li; } return out; };

  async function openZip(buf) {
    const z = await (await lib('jszip')).loadAsync(buf);
    const cache = {};
    const xml = async (p) => {
      if (!p) return null;
      if (!(p in cache)) { const f = z.file(p); cache[p] = f ? f.async('string').then(parseXml).catch(() => null) : null; }
      return cache[p];
    };
    /* A part's relationships, targets resolved to paths inside the zip (external ones, i.e. links, kept as given). */
    const rels = async (part) => {
      const dir = part.includes('/') ? part.slice(0, part.lastIndexOf('/') + 1) : '';
      const m = {};
      for (const r of all(await xml(`${dir}_rels/${part.slice(dir.length)}.rels`), 'Relationship')) {
        const ext = r.getAttribute('TargetMode') === 'External', t = r.getAttribute('Target') || '';
        m[r.getAttribute('Id')] = { type: (r.getAttribute('Type') || '').split('/').pop(), target: ext ? t : joinPath(dir, t), external: ext };
      }
      return m;
    };
    const main = async () => Object.values(await rels('')).find(r => r.type === 'officeDocument')?.target || null;
    return { z, xml, rels, main };
  }
  async function docProps(zx) {
    const d = await zx.xml('docProps/core.xml'); if (!d) return '';
    const get = (n) => first(d, n)?.textContent.trim();
    const p = [['Title', get('title')], ['Subject', get('subject')], ['Author', get('creator')], ['Last modified by', get('lastModifiedBy')], ['Modified', get('modified')?.slice(0, 10)]].filter(([, v]) => v);
    return p.length ? `[${p.map(([k, v]) => `${k}: ${v}`).join(' · ')}]\n\n` : '';
  }
  /* A chart is its data: type, series names, source ranges, and the values cached in the file. */
  async function chartText(zx, path) {
    const d = await zx.xml(path); if (!d) return `[Chart ${path}: could not be read]`;
    const rich = (el) => all(el, 't').map(t => t.textContent).join('') || all(el, 'v').map(t => t.textContent).join(' ');
    const c = first(d, 'chart'), plot = child(c, 'plotArea');
    const title = rich(child(c, 'title')).trim();
    const pts = (el) => { if (!el) return []; const out = []; for (const p of all(first(el, 'lvl') || el, 'pt')) out[+at(p, 'idx')] = first(p, 'v')?.textContent ?? ''; return Array.from(out, v => v ?? ''); };
    const lines = [];
    for (const g of Array.from(plot?.children || []).filter(e => /Chart$/.test(e.localName))) {
      const type = g.localName.replace(/Chart$/, '').replace(/3D$/, ' 3D');
      for (const s of childs(g, 'ser')) {
        const name = rich(child(s, 'tx')).trim() || `Series ${+(at(child(s, 'idx'), 'val') || 0) + 1}`;
        const catEl = child(s, 'cat') || child(s, 'xVal'), valEl = child(s, 'val') || child(s, 'yVal');
        const cats = pts(catEl), vals = pts(valEl), ref = first(valEl, 'f')?.textContent;
        const data = Array.from({ length: Math.max(cats.length, vals.length) }, (_, i) => cats.length ? `${cats[i] ?? ''} = ${vals[i] ?? ''}` : vals[i] ?? '').join('; ');
        lines.push(`  ${type} series "${name}"${ref ? ` (${ref})` : ''}: ${data}`);
      }
    }
    if (!lines.length) for (const dt of all(d, 'data')) for (const dim of [...all(dt, 'strDim'), ...all(dt, 'numDim')]) {   // chartex: waterfall, treemap, histogram…
      const f = first(dim, 'f')?.textContent; lines.push(`  ${at(dim, 'type') || 'values'}${f ? ` (${f})` : ''}: ${pts(dim).join('; ')}`);
    }
    const axes = Array.from(plot?.children || []).filter(e => /Ax$/.test(e.localName)).map(a => rich(child(a, 'title')).trim()).filter(Boolean);
    return [`[Chart${title ? `: ${title}` : ''}${axes.length ? ` (axes: ${axes.join(', ')})` : ''}]`, ...lines].join('\n');
  }
  /* SmartArt: the text of its nodes, in document order. */
  async function diagramText(zx, path) {
    const d = await zx.xml(path); if (!d) return '';
    const nodes = all(d, 'pt').filter(p => !at(p, 'type') || at(p, 'type') === 'node').map(p => all(child(p, 't'), 't').map(t => t.textContent).join('').trim()).filter(Boolean);
    return nodes.length ? `[Diagram: ${nodes.join('; ')}]` : '';
  }
  /* Charts and diagrams live in their own parts; read them up front so the walk over a part can stay synchronous. */
  async function embedsOf(zx, root, rels) {
    const out = {};
    for (const el of all(root, 'chart')) { const r = rels[rid(el)]; if (r && !r.external && !(r.target in out)) out[r.target] = await chartText(zx, r.target); }
    for (const el of all(root, 'relIds')) { const r = rels[rid(el, 'dm')]; if (r && !r.external && !(r.target in out)) out[r.target] = await diagramText(zx, r.target); }
    return out;
  }
  const choice = (ac) => child(ac, 'Choice') || child(ac, 'Fallback');   // mc:AlternateContent holds the same content twice
  function imageLine(env, target, alt) {
    if (!env.images.includes(target)) env.images.push(target);
    return `[Image: ${target}${alt ? ` "${alt.replace(/\s+/g, ' ').trim()}"` : ''}]`;
  }
  /* Everything a drawing can carry that is not plain text: charts, SmartArt, pictures, OLE objects, text boxes. */
  function drawingText(el, env, textBoxes) {
    const out = [], seen = new Set();
    for (const ch of all(el, 'chart')) { const r = env.rels[rid(ch)]; if (r && env.embeds[r.target]) out.push(env.embeds[r.target]); }
    for (const dg of all(el, 'relIds')) { const r = env.rels[rid(dg, 'dm')]; if (r && env.embeds[r.target]) out.push(env.embeds[r.target]); }
    const alt = [...all(el, 'docPr'), ...all(el, 'cNvPr')].map(p => at(p, 'descr') || at(p, 'title')).find(Boolean);
    for (const b of [...all(el, 'blip'), ...all(el, 'imagedata')]) {
      const r = env.rels[rid(b, 'embed') || rid(b, 'id')];
      if (r && !r.external && !seen.has(r.target)) { seen.add(r.target); out.push(imageLine(env, r.target, alt)); }
    }
    for (const o of [...all(el, 'OLEObject'), ...all(el, 'oleObj')]) { const r = env.rels[rid(o)]; if (r) out.push(`[Embedded object${at(o, 'ProgID') || at(o, 'progId') ? ` (${at(o, 'ProgID') || at(o, 'progId')})` : ''}: ${r.target}]`); }
    if (textBoxes) for (const tb of all(el, 'txbxContent')) { if (tb.parentNode.closest?.('txbxContent')) continue; const t = textBoxes(tb); if (t) out.push(`[Text box: ${t}]`); }
    return out.join('\n');
  }

  /* ---- Word (.docx) ---- */
  function wInline(el, env) {
    let s = '';
    for (const c of el.children) {
      switch (c.localName) {
        case 't': case 'delText': s += c.textContent; break;
        case 'tab': case 'ptab': s += '\t'; break;
        case 'br': case 'cr': s += '\n'; break;
        case 'noBreakHyphen': s += '-'; break;
        case 'sym': { const ch = parseInt(at(c, 'char') || '', 16); if (ch) s += String.fromCharCode(ch >= 0xF000 ? ch - 0xF000 : ch); break; }
        case 'pPr': case 'rPr': case 'instrText': case 'delInstrText': case 'softHyphen': case 'footnoteRef': case 'endnoteRef': case 'annotationRef': break;
        case 'del': case 'moveFrom': { const t = wInline(c, env); if (t.trim()) s += `~~${t}~~`; break; }
        case 'hyperlink': {
          const t = wInline(c, env), r = env.rels[rid(c)];
          s += r?.external && t.trim() && !/^mailto:$/.test(r.target) ? `[${t}](${r.target})` : t; break;
        }
        case 'footnoteReference': s += `[^${at(c, 'id')}]`; break;
        case 'endnoteReference': s += `[^e${at(c, 'id')}]`; break;
        case 'commentReference': s += `[comment ${at(c, 'id')}]`; break;
        case 'drawing': case 'pict': case 'object': { const t = drawingText(c, env, (tb) => joinBlocks(wBlocks(tb, env)).replace(/\n+/g, ' / ')); if (t) s += `\n${t}\n`; break; }
        case 'AlternateContent': { const ch = choice(c); if (ch) s += wInline(ch, env); break; }
        default: s += wInline(c, env);   // runs, fields, insertions, smart tags, content controls, equations
      }
    }
    return s;
  }
  function wPara(p, env) {
    const pPr = child(p, 'pPr');
    let level = env.styles[at(child(pPr, 'pStyle'), 'val')]?.level || 0;
    const ol = at(child(pPr, 'outlineLvl'), 'val'); if (ol != null && +ol < 9) level = +ol + 1;
    const text = wInline(p, env).replace(/[ \t]+$/gm, '').replace(/^\n+|\n+$/g, '');
    if (!text.trim()) return '';
    if (level) return '#'.repeat(Math.min(level, 6)) + ' ' + text.trim();
    const numPr = child(pPr, 'numPr'), id = at(child(numPr, 'numId'), 'val');
    if (id && id !== '0') {
      const il = +(at(child(numPr, 'ilvl'), 'val') || 0), fmt = env.nums[id]?.[il] || 'bullet';
      const n = (env.counters[id] ||= []); n[il] = (n[il] || 0) + 1; n.length = il + 1;
      return '  '.repeat(il) + (fmt === 'bullet' || fmt === 'none' ? '-' : `${n[il]}.`) + ' ' + text;
    }
    return text;
  }
  const WRAP = new Set(['sdt', 'sdtContent', 'customXml', 'ins', 'moveTo']);
  const kidsVia = (el, name) => Array.from(el?.children || []).flatMap(c => c.localName === name ? [c] : WRAP.has(c.localName) ? kidsVia(c, name) : []);
  function wTable(tbl, env) {
    return mdTable(kidsVia(tbl, 'tr').map(tr => kidsVia(tr, 'tc').flatMap(tc => {
      const pr = child(tc, 'tcPr'), span = +(at(child(pr, 'gridSpan'), 'val') || 1), vm = child(pr, 'vMerge');
      const t = vm && at(vm, 'val') !== 'restart' ? '' : cellText(joinBlocks(wBlocks(tc, env)));   // a merged-down cell repeats nothing
      return [t, ...Array(span - 1).fill('')];
    })));
  }
  function wBlocks(el, env, out = []) {
    for (const c of el.children) {
      const n = c.localName;
      if (n === 'p') out.push(wPara(c, env));
      else if (n === 'tbl') out.push(wTable(c, env));
      else if (n === 'AlternateContent') { const ch = choice(c); if (ch) wBlocks(ch, env, out); }
      else if (!/Pr$/.test(n)) wBlocks(c, env, out);
    }
    return out;
  }
  async function docx(zx, main, onStatus) {
    onStatus?.('Reading Word document…');
    const doc = await zx.xml(main); if (!doc) throw new Error('not a valid .docx (the main document part is missing)');
    const rels = await zx.rels(main);
    const partsOf = (type) => [...new Set(Object.values(rels).filter(r => r.type === type && !r.external).map(r => r.target))].sort();
    const styles = {};
    for (const s of all(await zx.xml(partsOf('styles')[0]), 'style')) {
      const name = at(child(s, 'name'), 'val') || '', h = name.match(/^heading\s*(\d)$/i), ol = at(first(s, 'outlineLvl'), 'val');
      styles[at(s, 'styleId')] = { level: /^title$/i.test(name) ? 1 : h ? +h[1] : ol != null && +ol < 9 ? +ol + 1 : 0 };
    }
    const nd = await zx.xml(partsOf('numbering')[0]), abs = {}, nums = {};
    for (const a of all(nd, 'abstractNum')) abs[at(a, 'abstractNumId')] = Object.fromEntries(childs(a, 'lvl').map(l => [at(l, 'ilvl'), at(child(l, 'numFmt'), 'val') || 'decimal']));
    for (const n of childs(nd?.documentElement, 'num')) nums[at(n, 'numId')] = abs[at(child(n, 'abstractNumId'), 'val')] || {};
    const images = [], base = { styles, nums, counters: {}, images };
    /* Headers, footers, notes and comments are parts of their own, each with its own relationships. */
    const part = async (path) => { const d = await zx.xml(path); if (!d) return null; const r = await zx.rels(path); return { d, env: { ...base, rels: r, embeds: await embedsOf(zx, d, r) } }; };
    const body = joinBlocks(wBlocks(first(doc, 'body') || doc.documentElement, { ...base, rels, embeds: await embedsOf(zx, doc, rels) }));
    const section = async (types, title) => {
      const seen = new Set();
      for (const type of types) for (const p of partsOf(type)) { const x = await part(p); const t = x && joinBlocks(wBlocks(x.d.documentElement, x.env)).trim(); if (t) seen.add(t); }
      return seen.size ? `--- ${title} ---\n${[...seen].join('\n\n')}` : '';
    };
    const notes = async (type, tag, pre, title) => {
      const x = await part(partsOf(type)[0]); if (!x) return '';
      const items = childs(x.d.documentElement, tag).filter(f => !/separator|continuation/i.test(at(f, 'type') || ''))
        .map(f => `[^${pre}${at(f, 'id')}]: ${joinBlocks(wBlocks(f, x.env)).replace(/\n+/g, ' ').trim()}`);
      return items.length ? `--- ${title} ---\n${items.join('\n')}` : '';
    };
    const comments = async () => {
      const x = await part(partsOf('comments')[0]); if (!x) return '';
      const items = childs(x.d.documentElement, 'comment').map(c => `[comment ${at(c, 'id')}] ${at(c, 'author') || 'Unknown'}${at(c, 'date') ? ` (${at(c, 'date').slice(0, 10)})` : ''}: ${joinBlocks(wBlocks(c, x.env)).replace(/\n+/g, ' ').trim()}`);
      return items.length ? `--- Comments ---\n${items.join('\n')}` : '';
    };
    const text = [await docProps(zx) + (await section(['header'], 'Header')), body, await notes('footnotes', 'footnote', '', 'Footnotes'), await notes('endnotes', 'endnote', 'e', 'Endnotes'), await comments(), await section(['footer'], 'Footer')]
      .map(s => s.trim()).filter(Boolean).join('\n\n');
    const tracked = all(doc, 'del').length + all(doc, 'ins').length;
    return { text, images, note: tracked ? 'The document has tracked changes: deleted text is shown as ~~struck through~~, inserted text as normal text.' : '' };
  }

  /* ---- PowerPoint (.pptx) ---- */
  const upTo = (el, name) => { while (el && el.localName !== name) el = el.parentElement; return el; };
  const phType = (sp) => { if (!sp) return null; const ph = first(Array.from(sp.children).find(c => /^nv/.test(c.localName)), 'ph'); return ph ? at(ph, 'type') || 'obj' : null; };
  function aRuns(p, env) {
    let s = '';
    for (const c of p.children) {
      if (c.localName === 'r' || c.localName === 'fld') {
        const t = child(c, 't')?.textContent || '', r = env.rels[rid(first(child(c, 'rPr'), 'hlinkClick'))];
        s += r?.external && t.trim() ? `[${t}](${r.target})` : t;
      } else if (c.localName === 'br') s += '\n';
      else if (c.localName === 'AlternateContent') s += all(choice(c), 't').map(t => t.textContent).join('');   // equations
    }
    return s;
  }
  function pText(sp, env) {
    const body = child(sp, 'txBody'); if (!body) return drawingText(sp, env);
    const ph = phType(sp);
    if (ph === 'sldNum' || ph === 'dt') return '';
    const paras = childs(body, 'p').map(p => [p, aRuns(p, env)]).filter(([, t]) => t.trim());
    if (ph === 'title' || ph === 'ctrTitle') return paras.length ? '## ' + paras.map(([, t]) => t.trim()).join(' ') : '';
    return paras.map(([p, t]) => {
      const pPr = child(p, 'pPr'), lvl = +(at(pPr, 'lvl') || 0);
      const bullet = child(pPr, 'buNone') ? false : child(pPr, 'buChar') || child(pPr, 'buAutoNum') || child(pPr, 'buBlip') ? true : ph === 'body' || ph === 'obj';
      return '  '.repeat(lvl) + (bullet ? '- ' : '') + t;
    }).join('\n');
  }
  function pFrame(gf, env) {
    const tbl = first(gf, 'tbl');
    if (tbl) return mdTable(childs(tbl, 'tr').map(tr => childs(tr, 'tc').map(tc => at(tc, 'hMerge') === '1' || at(tc, 'vMerge') === '1' ? '' : cellText(childs(child(tc, 'txBody'), 'p').map(p => aRuns(p, env)).join('\n')))));
    return drawingText(gf, env);
  }
  /* Shapes in z-order, which is also roughly reading order; groups are opened. Shared with Excel's drawings. */
  function pShapes(tree, env) {
    const out = [];
    for (const c of tree?.children || []) {
      const n = c.localName;
      if (n === 'sp') out.push(pText(c, env));
      else if (n === 'grpSp') out.push(...pShapes(c, env));
      else if (n === 'graphicFrame') out.push(pFrame(c, env));
      else if (n === 'pic') out.push(drawingText(c, env));
      else if (n === 'AlternateContent') { const ch = choice(c); if (ch) out.push(...pShapes(ch, env)); }
    }
    return out.filter(Boolean);
  }
  async function pptx(zx, main, onStatus) {
    onStatus?.('Reading presentation…');
    const pres = await zx.xml(main), prels = pres ? await zx.rels(main) : {};   // without presentation.xml, fall back to the slide files
    /* The order in presentation.xml is the order of the deck; file names keep the order slides were created in. */
    let slides = all(pres, 'sldId').map(s => prels[rid(s)]?.target).filter(Boolean);
    const byName = !slides.length;
    if (byName) slides = Object.keys(zx.z.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => a.match(/(\d+)\.xml/)[1] - b.match(/(\d+)\.xml/)[1]);
    if (!slides.length) throw new Error('not a valid .pptx (no slides found)');
    const authors = {};
    for (const p of ['ppt/commentAuthors.xml', 'ppt/authors.xml']) { const d = await zx.xml(p); for (const a of [...all(d, 'cmAuthor'), ...all(d, 'author')]) authors[at(a, 'id')] = at(a, 'name'); }
    const images = [], parts = [];
    let hiddenCount = 0;
    for (let i = 0; i < slides.length; i++) {
      onStatus?.(`Reading slide ${i + 1}/${slides.length}`);
      const d = await zx.xml(slides[i]);
      if (!d) { parts.push(`--- Slide ${i + 1} ---\n[this slide could not be read]`); continue; }
      const rels = await zx.rels(slides[i]);
      const hidden = at(d.documentElement, 'show') === '0'; if (hidden) hiddenCount++;
      let text = pShapes(first(d, 'spTree'), { rels, embeds: await embedsOf(zx, d, rels), images }).join('\n\n');
      const notes = Object.values(rels).find(r => r.type === 'notesSlide') || (byName && { target: slides[i].replace(/slides\/slide(\d+)\.xml$/, 'notesSlides/notesSlide$1.xml') });
      if (notes) {
        const nd = await zx.xml(notes.target), nenv = { rels: await zx.rels(notes.target), embeds: {}, images };
        let t = all(nd, 'sp').filter(sp => phType(sp) === 'body').map(sp => pText(sp, nenv).replace(/^- /gm, '')).join('\n').trim();
        if (!t) t = all(nd, 'p').filter(p => p.namespaceURI?.includes('drawingml') && !/^(sldNum|dt|hdr|ftr|sldImg)$/.test(phType(upTo(p, 'sp')) || ''))
          .map(p => aRuns(p, nenv)).filter(s => s.trim()).join('\n').trim();   // notes without a body placeholder: any text on the page
        if (t) text += '\n\n[Speaker notes]\n' + t;
      }
      const cms = [];
      for (const r of Object.values(rels).filter(r => r.type === 'comments')) for (const cm of all(await zx.xml(r.target), 'cm')) {
        const t = (child(cm, 'text')?.textContent || all(cm, 't').map(t => t.textContent).join(' ')).replace(/\s+/g, ' ').trim();
        if (t) cms.push(`- ${authors[at(cm, 'authorId')] || 'Comment'}: ${t}`);
      }
      if (cms.length) text += '\n\n[Comments]\n' + cms.join('\n');
      parts.push(`--- Slide ${i + 1}${hidden ? ' (hidden)' : ''} ---\n${text.trim() || '[no text]'}`);
    }
    return { text: (await docProps(zx)) + parts.join('\n\n'), pages: slides.length, images, note: hiddenCount ? `${hiddenCount} hidden slide${hiddenCount > 1 ? 's are' : ' is'} included and marked (hidden).` : '' };
  }

  /* ---- Excel (.xlsx/.xlsm/.xlsb/.xls/.ods) ---- */
  const ranges = (ns) => { const out = []; for (const n of ns) { const l = out[out.length - 1]; if (l && n === l[1] + 1) l[1] = n; else out.push([n, n]); } return out; };
  /* Charts, pictures and text boxes drawn on each sheet (xlsx only; SheetJS reads the cells). */
  async function sheetDrawings(buf, XLSX, images) {
    const zx = await openZip(buf), main = (await zx.main()) || 'xl/workbook.xml', wrels = await zx.rels(main), out = {};
    for (const s of all(await zx.xml(main), 'sheet')) {
      const path = wrels[rid(s)]?.target; if (!path) continue;
      const lines = [];
      for (const dr of Object.values(await zx.rels(path)).filter(r => r.type === 'drawing' && !r.external)) {
        const d = await zx.xml(dr.target); if (!d) continue;
        const rels = await zx.rels(dr.target), env = { rels, embeds: await embedsOf(zx, d, rels), images };
        for (const anchor of d.documentElement.children) {
          const from = child(anchor, 'from'), where = from ? ` at ${XLSX.utils.encode_cell({ c: +child(from, 'col').textContent, r: +child(from, 'row').textContent })}` : '';
          const t = pShapes(anchor, env).join('\n'); if (t) lines.push(`[Drawing${where}]\n${t}`);
        }
      }
      if (lines.length) out[at(s, 'name')] = lines;
    }
    return out;
  }
  /* The formatted value, as the user sees it — plus the stored number when the format hides part of it (rounding). */
  function cellValue(cell) {
    if (cell.t === 'z') return '';
    const raw = cell.v instanceof Date ? cell.v.toISOString().replace(/T00:00:00(\.000)?Z$/, '').replace(/\.000Z$/, 'Z') : cell.v == null ? '' : String(cell.v);
    const w = cell.w ?? raw;
    if (cell.t === 'n' && typeof cell.v === 'number' && w !== raw) {
      let shown = Number(w.replace(/[,\s$€£¥%()]/g, '')); if (/%\s*$/.test(w)) shown /= 100; if (/^\(.*\)$/.test(w.trim())) shown = -shown;
      if (!(Math.abs(shown - cell.v) <= 1e-9 * Math.max(1, Math.abs(cell.v)))) return `${w} (${cell.v})`;
    }
    return w;
  }
  async function sheet(buf, onStatus) {
    onStatus?.('Reading spreadsheet…');
    const XLSX = await lib('xlsx');
    let wb;
    try { wb = XLSX.read(buf, { type: 'array', cellDates: true, cellFormula: true, cellStyles: true }); }
    catch (e) { if (/password|encrypt/i.test(e.message)) throw new Error('the workbook is password-protected; ask the user to save a copy without the password'); throw e; }
    const images = []; let drawings = {};
    if (isZip(new Uint8Array(buf, 0, 4))) try { drawings = await sheetDrawings(buf, XLSX, images); } catch (e) { console.warn('spreadsheet drawings not read', e); }
    const parts = [], U = XLSX.utils;
    const names = (wb.Workbook?.Names || []).filter(n => !n.Hidden && !/^_xlnm\._FilterDatabase/.test(n.Name));
    if (names.length) parts.push('--- Named ranges ---\n' + names.map(n => `${n.Name}${n.Sheet != null ? ` (sheet ${wb.SheetNames[n.Sheet]})` : ''} = ${n.Ref}`).join('\n'));
    wb.SheetNames.forEach((name, i) => {
      onStatus?.(`Reading sheet ${i + 1}/${wb.SheetNames.length}`);
      const ws = wb.Sheets[name] || {}, vis = wb.Workbook?.Sheets?.[i]?.Hidden;
      /* Walk the cells that exist, not the declared range: a sheet formatted down to row 1048576 is still small. */
      const rows = new Map(), cols = new Set(), formulas = [], comments = [], links = [];
      for (const a of Object.keys(ws)) {
        if (a[0] === '!') continue;
        const cell = ws[a], { r, c } = U.decode_cell(a), v = cellValue(cell);
        if (cell.f) formulas.push([r, c, `${a}: =${cell.f}${cell.F && cell.F !== a ? ` (array formula over ${cell.F})` : ''}`]);
        for (const cm of cell.c || []) if (cm.t?.trim()) comments.push([r, c, `${a}${cm.a ? ` (${cm.a})` : ''}: ${cm.t.replace(/\s+/g, ' ').trim()}`]);
        if (cell.l?.Target) links.push([r, c, `${a}: ${cell.l.Target}`]);
        if (v === '') continue;
        if (!rows.has(r)) rows.set(r, new Map());
        rows.get(r).set(c, cellText(v)); cols.add(c);
      }
      const colList = [...cols].sort((a, b) => a - b), rowList = [...rows.keys()].sort((a, b) => a - b), byPos = (x, y) => x[0] - y[0] || x[1] - y[1];
      const used = rows.size ? ` · ${U.encode_range({ s: { r: rowList[0], c: colList[0] }, e: { r: rowList.at(-1), c: colList.at(-1) } })}` : '';   // '!ref' is the declared size, often the whole grid
      const out = [`--- Sheet: ${name}${vis ? (vis === 2 ? ' (very hidden)' : ' (hidden)') : ''}${used} ---`];
      if (rows.size) out.push(mdTable([['', ...colList.map(U.encode_col)], ...rowList.map(r => [String(r + 1), ...colList.map(c => rows.get(r).get(c) ?? '')])]));
      else if (!drawings[name]) out.push('[empty sheet]');
      if (formulas.length) out.push('Formulas:\n' + formulas.sort(byPos).map(x => x[2]).join('\n'));
      if (comments.length) out.push('Comments:\n' + comments.sort(byPos).map(x => x[2]).join('\n'));
      if (links.length) out.push('Links:\n' + links.sort(byPos).map(x => x[2]).join('\n'));
      if (ws['!merges']?.length) out.push('Merged cells: ' + ws['!merges'].map(m => U.encode_range(m)).join(', '));
      const hr = ranges((ws['!rows'] || []).flatMap((x, i) => x?.hidden ? [i] : [])).map(([a, b]) => a === b ? `${a + 1}` : `${a + 1}-${b + 1}`);
      const hc = ranges((ws['!cols'] || []).flatMap((x, i) => x?.hidden ? [i] : [])).map(([a, b]) => a === b ? U.encode_col(a) : `${U.encode_col(a)}-${U.encode_col(b)}`);
      if (hr.length) out.push('Hidden rows: ' + hr.join(', '));
      if (hc.length) out.push('Hidden columns: ' + hc.join(', '));
      if (drawings[name]) out.push(...drawings[name]);
      parts.push(out.join('\n\n'));
    });
    return { text: parts.join('\n\n'), pages: wb.SheetNames.length, images, note: 'Cells are shown as displayed; a stored value the number format hides is added in parentheses. Rows and columns keep their spreadsheet numbers and letters; empty ones are left out.' };
  }

  /* ---- Word 97–2003 (.doc): the text lives in the WordDocument stream, laid out by the piece table ---- */
  const bytesOf = (e) => e?.content ? (e.content instanceof Uint8Array ? e.content : Uint8Array.from(e.content)) : null;
  const dview = (u8) => new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  function legacyDoc(cfb, XLSX, onStatus) {
    onStatus?.('Reading Word 97–2003 document…');
    const wd = bytesOf(XLSX.CFB.find(cfb, 'WordDocument')), dv = dview(wd);
    if (dv.getUint16(0, true) !== 0xA5EC) throw new Error('unrecognised Word file');
    if (dv.getUint16(2, true) < 0xC1) throw new Error('this is a Word 6/95 file, which is too old to read; ask the user to save it as .docx');
    const flags = dv.getUint16(0x0A, true);
    if (flags & 0x0100) throw new Error('the document is password-protected; ask the user to save a copy without the password');
    const table = bytesOf(XLSX.CFB.find(cfb, flags & 0x0200 ? '1Table' : '0Table')); if (!table) throw new Error('the table stream is missing');
    const tv = dview(table), fcClx = dv.getUint32(0x01A2, true), lcbClx = dv.getUint32(0x01A6, true);
    let p = fcClx;
    while (p < fcClx + lcbClx && table[p] === 0x01) p += 3 + tv.getUint16(p + 1, true);   // skip formatting (Prc) entries
    if (table[p] !== 0x02) throw new Error('the piece table could not be found');
    const n = (tv.getUint32(p + 1, true) - 4) / 12; p += 5;
    const u16 = new TextDecoder('utf-16le'), cp1252 = new TextDecoder('windows-1252');
    let all_ = '';
    for (let i = 0; i < n; i++) {
      const len = tv.getUint32(p + (i + 1) * 4, true) - tv.getUint32(p + i * 4, true), fc = tv.getUint32(p + (n + 1) * 4 + i * 8 + 2, true);
      if (fc & 0x40000000) { const o = (fc & 0x3FFFFFFF) / 2; all_ += cp1252.decode(wd.subarray(o, o + len)); }
      else all_ += u16.decode(wd.subarray(fc, fc + len * 2));
    }
    /* Fields keep their result and lose their instruction; cells end in \x07, a row in a second \x07. */
    const clean = (s) => {
      let out = ''; const st = [];
      for (const ch of s) { if (ch === '\x13') st.push(0); else if (ch === '\x14') { if (st.length) st[st.length - 1] = 1; } else if (ch === '\x15') st.pop(); else if (st.every(Boolean)) out += ch; }
      return out.replace(/\x07\x07/g, ' |\n').replace(/\x07/g, ' | ').replace(/[\r\x0B\x0C]/g, '\n').replace(/\x1E/g, '-').replace(/\x02/g, '[*]').replace(/[\x00-\x08\x0E-\x1F]/g, '')
        .replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    };
    const lw = (i) => dv.getInt32(0x40 + 4 * i, true);
    const sizes = [['', lw(3)], ['Footnotes', lw(4)], ['Headers and footers', lw(5)], ['', lw(6)], ['Comments', lw(7)], ['Endnotes', lw(8)], ['Text boxes', lw(9)], ['Header text boxes', lw(10)]];
    const out = []; let cp = 0;
    for (const [title, len] of sizes) { const t = len > 0 ? clean(all_.slice(cp, cp + len)) : ''; cp += Math.max(0, len); if (t) out.push(title ? `--- ${title} ---\n${t}` : t); }
    return { text: out.join('\n\n'), note: 'Read from the older Word 97–2003 format: text, tables and notes are kept, but headings and list numbering are not marked.' };
  }

  /* ---- PowerPoint 97–2003 (.ppt): records in the "PowerPoint Document" stream, found through the persist directory ---- */
  function legacyPpt(cfb, XLSX, onStatus) {
    onStatus?.('Reading PowerPoint 97–2003 presentation…');
    const doc = bytesOf(XLSX.CFB.find(cfb, 'PowerPoint Document')), dv = dview(doc);
    const u16 = new TextDecoder('utf-16le'), cp1252 = new TextDecoder('windows-1252');
    const rec = (o) => ({ ver: dv.getUint16(o, true) & 0xF, inst: dv.getUint16(o, true) >> 4, type: dv.getUint16(o + 2, true), len: dv.getUint32(o + 4, true), body: o + 8 });
    const kids = (r) => { const out = []; for (let o = r.body, end = Math.min(doc.length, r.body + r.len); o + 8 <= end;) { const k = rec(o); out.push(k); o = k.body + k.len; } return out; };
    const atomText = (r) => r.type === 0x0FA0 ? u16.decode(doc.subarray(r.body, r.body + r.len)) : r.type === 0x0FA8 ? cp1252.decode(doc.subarray(r.body, r.body + r.len)) : null;
    const texts = (r, out = []) => { for (const k of kids(r)) { if (k.ver === 0xF) texts(k, out); else { const t = atomText(k); if (t != null) out.push(t.replace(/\r|\x0B/g, '\n').trim()); } } return out.filter(Boolean); };
    try {
      const cu = bytesOf(XLSX.CFB.find(cfb, 'Current User'));
      const persist = {}, seen = new Set(); let e = dview(cu).getUint32(16, true), docRef = null;
      while (e && !seen.has(e) && e + 28 <= doc.length) {   // newest edit first; an older entry never overrides a newer one
        seen.add(e); const r = rec(e); if (r.type !== 0x0FF5) break;
        docRef ??= dv.getUint32(r.body + 16, true);
        const d = rec(dv.getUint32(r.body + 12, true));
        for (let q = d.body; q < d.body + d.len;) { const x = dv.getUint32(q, true), id = x & 0xFFFFF, cnt = x >>> 20; q += 4; for (let k = 0; k < cnt; k++, q += 4) if (!(id + k in persist)) persist[id + k] = dv.getUint32(q, true); }
        e = dv.getUint32(r.body + 8, true);
      }
      const docRec = rec(persist[docRef]); if (docRec.type !== 0x03E8) throw new Error('document record not found');
      const slides = [], notesById = {};
      for (const list of kids(docRec).filter(k => k.type === 0x0FF0)) {
        let cur = null, kind = null;
        for (const k of kids(list)) {
          if (k.type === 0x03F3) { cur = { ref: dv.getUint32(k.body, true), id: dv.getUint32(k.body + 12, true), outline: [] }; if (list.inst === 0) slides.push(cur); else if (list.inst === 2) notesById[cur.id] = cur.ref; }
          else if (k.type === 0x0F9F) kind = dv.getUint32(k.body, true);
          else if (cur && list.inst === 0) { const t = atomText(k); if (t?.trim()) cur.outline.push(kind === 0 || kind === 6 ? '## ' + t.trim().replace(/\s*[\r\x0B]\s*/g, ' ') : t.replace(/\r|\x0B/g, '\n').trim()); }
        }
      }
      if (!slides.length) throw new Error('no slide list');
      const parts = slides.map((s, i) => {
        const sr = persist[s.ref] != null ? rec(persist[s.ref]) : null, lines = [...s.outline];
        let notes = [];
        if (sr?.type === 0x03EE) {
          for (const t of texts(sr)) if (!lines.some(l => l.replace(/^## /, '') === t) && t !== '*') lines.push(t);
          const atom = kids(sr).find(k => k.type === 0x03EF), nid = atom ? dv.getUint32(atom.body + 16, true) : 0;
          if (nid && persist[notesById[nid]] != null) { const nr = rec(persist[notesById[nid]]); if (nr.type === 0x03F0) notes = texts(nr).filter(t => t !== '*'); }
        }
        return `--- Slide ${i + 1} ---\n${lines.join('\n') || '[no text]'}${notes.length ? '\n\n[Speaker notes]\n' + notes.join('\n') : ''}`;
      });
      return { text: parts.join('\n\n'), pages: slides.length, note: 'Read from the older PowerPoint 97–2003 format: slide text and speaker notes only; tables, charts and pictures are not.' };
    } catch (err) {
      console.warn('ppt structure not read, falling back to a flat scan', err);
      const t = texts({ body: 0, len: doc.length });
      if (!t.length) throw new Error('no text found in this presentation');
      return { text: t.join('\n'), note: 'The slide structure of this PowerPoint 97–2003 file could not be read, so this is all of its text in file order, without slide boundaries (it may repeat text from earlier saved versions).' };
    }
  }

  /* Decide by content, not name: a .doc may really be a .docx, and a password-protected .docx is not a zip at all. */
  async function office(buf, kind, onStatus) {
    const head = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
    if (isZip(head)) {
      /* The package's own pointer to its main part first; if that part is missing (damaged or hand-made files), whatever is there. */
      const zx = await openZip(buf), has = (p) => p && !!zx.z.file(p);
      const guesses = kind === 'pptx' || kind === 'ppt' ? ['ppt/presentation.xml', 'word/document.xml', 'xl/workbook.xml'] : kind === 'sheet' ? ['xl/workbook.xml', 'word/document.xml', 'ppt/presentation.xml'] : ['word/document.xml', 'ppt/presentation.xml', 'xl/workbook.xml'];
      let main = await zx.main(); if (!has(main)) main = guesses.find(has) || null;
      if (!main && Object.keys(zx.z.files).some(n => /^ppt\/slides\//.test(n))) main = 'ppt/presentation.xml';
      if (!main) main = guesses[0];
      if (/^ppt\//.test(main)) return pptx(zx, main, onStatus);
      if (/^word\//.test(main)) return docx(zx, main, onStatus);
      return sheet(buf, onStatus);   // xl/…, and OpenDocument spreadsheets
    }
    if (isCfb(head)) {
      const XLSX = await lib('xlsx'), cfb = XLSX.CFB.read(new Uint8Array(buf), { type: 'array' }), has = (n) => !!XLSX.CFB.find(cfb, n);
      if (has('EncryptionInfo') || has('EncryptedPackage')) throw new Error('the file is password-protected; ask the user to save a copy without the password');
      if (has('WordDocument')) return legacyDoc(cfb, XLSX, onStatus);
      if (has('PowerPoint Document')) { if (has('EncryptedSummary')) throw new Error('the presentation is password-protected; ask the user to save a copy without the password'); return legacyPpt(cfb, XLSX, onStatus); }
      return sheet(buf, onStatus);
    }
    if (kind === 'sheet') return sheet(buf, onStatus);   // .xlsb is a zip too, but SpreadsheetML 2003 and HTML "xls" are text
    throw new Error('this is not a Word, PowerPoint or Excel file (the contents do not match the extension)');
  }
  /** One embedded file (usually a picture) out of an Office document, as a File named after it. */
  async function embedded(file, inner) {
    if (!isZip(new Uint8Array(await file.slice(0, 4).arrayBuffer()))) throw new Error(`${file.name} is not an Office Open XML file, so it has no embedded parts to open`);
    const zx = await openZip(await file.arrayBuffer()), f = zx.z.file(inner.replace(/^\/+/, ''));
    if (!f) throw new Error(`${file.name} has no part "${inner}". Use the [Image: …] paths listed when the document is read.`);
    const ext = (inner.match(/\.(\w+)$/)?.[1] || '').toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' }[ext];
    if (!mime) throw new Error(`${inner} is a ${ext.toUpperCase() || 'binary'} file${/^(emf|wmf|tiff?|wdp)$/.test(ext) ? ', a picture format browsers cannot display' : ''}. Ask the user for a PNG or JPEG of it if it matters.`);
    return new File([await f.async('uint8array')], inner.split('/').pop(), { type: mime });
  }

  /* ---- images: decode + downscale to keep requests small (max side 1600px, JPEG unless small PNG) ---- */
  const MAX_SIDE = 1600, MAX_RAW = 350 * 1024;
  async function image(file, onStatus) {
    let bmp; try { bmp = await createImageBitmap(file); } catch { throw new Error('the browser could not decode this image format'); }
    const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
    if (scale === 1 && file.size <= MAX_RAW && /png|gif|webp|jpe?g/.test(file.type)) { bmp.close?.(); return { kind: 'image', content: await H.readFileAsDataURL(file), note: '' }; }
    onStatus?.('Resizing image…');
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const c = document.createElement('canvas'); c.width = w; c.height = h; c.getContext('2d').drawImage(bmp, 0, 0, w, h); bmp.close?.();
    const keepPng = file.type === 'image/png' && file.size < 2 * 1024 * 1024 && scale === 1;
    const url = c.toDataURL(keepPng ? 'image/png' : 'image/jpeg', 0.85);
    return { kind: 'image', content: url, note: scale < 1 ? `resized to ${w}×${h}` : '' };
  }
  /* ---- video: sample evenly spaced frames as images (+ optional transcript) ---- */
  async function videoFrames(file, onStatus, maxFrames = 6) {
    const url = URL.createObjectURL(file);
    try {
      const v = document.createElement('video'); v.muted = true; v.playsInline = true; v.preload = 'auto'; v.src = url;
      await new Promise((res, rej) => { v.onloadedmetadata = res; v.onerror = () => rej(new Error('the browser cannot decode this video format (try MP4/H.264 or WebM)')); });
      let dur = v.duration;
      if (!isFinite(dur)) { await new Promise((res) => { v.onseeked = res; v.currentTime = 1e7; }); dur = isFinite(v.duration) ? v.duration : (v.currentTime || 0); }  // WebM from MediaRecorder reports Infinity until seeked
      const n = dur > 2 ? Math.min(maxFrames, Math.max(3, Math.round(dur / 5))) : 1;
      const times = Array.from({ length: n }, (_, i) => dur > 0 ? (dur * (i + 0.5)) / n : 0);
      const scale = Math.min(1, 1024 / Math.max(v.videoWidth, v.videoHeight, 1));
      const c = document.createElement('canvas'); c.width = Math.round(v.videoWidth * scale); c.height = Math.round(v.videoHeight * scale); const ctx = c.getContext('2d');
      const frames = [];
      for (const t of times) {
        onStatus?.(`Extracting video frame ${frames.length + 1}/${n}`);
        await new Promise((res, rej) => { v.onseeked = res; v.onerror = () => rej(new Error('seek failed')); v.currentTime = Math.min(t, Math.max(0, dur - 0.1)); });
        ctx.drawImage(v, 0, 0, c.width, c.height);
        frames.push({ time: t, content: c.toDataURL('image/jpeg', 0.8) });
      }
      return { frames, duration: dur, width: v.videoWidth, height: v.videoHeight };
    } finally { URL.revokeObjectURL(url); }
  }
  async function transcript(file, onStatus) {
    const model = H.settings.get('transcriptionModel');
    if (!model) return { text: '', note: 'Audio not transcribed: no transcription model configured (Settings → Model → Transcription model, e.g. whisper-1 on your LiteLLM proxy).' };
    onStatus?.(`Transcribing with ${model}…`);
    try { const t = await H.llm.transcribe(file, model); return { text: t, note: '' }; }
    catch (e) { return { text: '', note: 'Transcription failed: ' + e.message }; }
  }
  const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  /** Extract from a File/Blob. Returns { kind: 'text'|'image'|'video'|'unsupported', content, note, pages, frames, transcript } */
  async function fromFile(file, { onStatus, maxChars = 300000 } = {}) {
    const kind = kindOf(file.name, file.type);
    if (kind === 'image') { try { return await image(file, onStatus); } catch (e) { return { kind: 'unsupported', content: '', note: `${file.name}: ${e.message}.` }; } }
    if (kind === 'heic') return { kind: 'unsupported', content: '', note: `${file.name}: HEIC/HEIF images cannot be decoded by the browser. Ask the user to export it as JPEG or PNG (on iPhone: Settings → Camera → Formats → Most Compatible).` };
    if (kind === 'video') {
      try {
        const v = await videoFrames(file, onStatus);
        const tr = file.size <= 25 * 1024 * 1024 ? await transcript(file, onStatus) : { text: '', note: 'Audio not transcribed: file larger than 25 MB.' };
        return { kind: 'video', content: '', frames: v.frames.map(f => ({ name: `${file.name} @ ${fmtT(f.time)}`, content: f.content })), transcript: tr.text, duration: v.duration, note: [`${v.frames.length} frames sampled from ${fmtT(v.duration)} of video (${v.width}×${v.height})`, tr.note].filter(Boolean).join('. ') };
      } catch (e) { return { kind: 'unsupported', content: '', note: `${file.name}: ${e.message}.` }; }
    }
    if (kind === 'audio') {
      if (file.size > 25 * 1024 * 1024) return { kind: 'unsupported', content: '', note: `${file.name}: audio larger than 25 MB cannot be transcribed.` };
      const tr = await transcript(file, onStatus);
      return tr.text ? { kind: 'text', content: tr.text, note: 'transcript' } : { kind: 'unsupported', content: '', note: `${file.name}: ${tr.note}` };
    }
    const buf = await file.arrayBuffer();
    try {
      let r;
      if (kind === 'pdf') r = await pdf(buf, onStatus);
      else if (OFFICE.includes(kind)) r = await office(buf, kind, onStatus);
      else if (kind === 'binary') return { kind: 'unsupported', content: '', note: `${file.name}: binary file (${file.type || 'unknown type'}, ${H.fmtBytes(file.size)}); no text to extract.` };
      else {
        if (looksBinary(buf)) return { kind: 'unsupported', content: '', note: `${file.name} appears to be binary (${file.type || 'unknown type'}, ${H.fmtBytes(file.size)}); no text to extract.` };
        let t = decodeText(buf); if (/\.rtf$/i.test(file.name)) t = rtfText(t);
        r = { text: t };
      }
      const truncated = r.text.length > maxChars;
      const images = r.images?.length ? `${r.images.length} embedded image${r.images.length > 1 ? 's are' : ' is'} listed as [Image: …].` : '';
      return { kind: 'text', content: truncated ? r.text.slice(0, maxChars) : r.text, pages: r.pages, images: r.images, note: [r.note, images, truncated ? `Text truncated to ${maxChars} characters (original ${r.text.length}).` : ''].filter(Boolean).join(' ') };
    } catch (e) { return { kind: 'unsupported', content: '', note: `${file.name}: could not extract text (${e.message}).` }; }
  }
  const OFFICE = ['docx', 'pptx', 'sheet', 'doc', 'ppt'];
  const isDocument = (name) => ['pdf', ...OFFICE].includes(kindOf(name));
  return { fromFile, kindOf, isDocument, pdfjs, embedded };
})();
