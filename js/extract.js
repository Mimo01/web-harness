/* Text extraction from documents, fully client-side. Libraries are loaded from cdnjs on first use:
   PDF -> pdf.js, DOCX/PPTX -> JSZip (+ XML parsing), XLSX/XLS/ODS/CSV -> SheetJS. */
H.extract = (() => {
  const CDN = {
    pdf: ['https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', () => window.pdfjsLib],
    pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
    jszip: ['https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js', () => window.JSZip],
    xlsx: ['https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', () => window.XLSX],
  };
  const loading = {};
  function lib(name) {
    const [url, get] = CDN[name];
    if (get()) return Promise.resolve(get());
    return loading[name] ||= new Promise((res, rej) => { const s = document.createElement('script'); s.src = url; s.onload = () => res(get()); s.onerror = () => { delete loading[name]; rej(new Error('Could not load ' + url + ' (offline or CDN blocked)')); }; document.head.append(s); });
  }

  const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|java|kt|go|rs|c|h|cpp|hpp|cs|php|sh|bash|zsh|ps1|bat|yaml|yml|toml|ini|cfg|conf|env|sql|graphql|proto|log|rtf|svg|tex|r|m|swift|scala|lua|pl|dart|vue|svelte|properties|gradle|dockerfile|makefile|gitignore|editorconfig)$/i;
  const kindOf = (name, type = '') => {
    const n = name.toLowerCase();
    if (/\.pdf$/.test(n) || type === 'application/pdf') return 'pdf';
    if (/\.docx$/.test(n)) return 'docx';
    if (/\.pptx$/.test(n)) return 'pptx';
    if (/\.(xlsx|xlsm|xls|ods)$/.test(n)) return 'sheet';
    if (/\.(csv|tsv)$/.test(n)) return 'text';
    if (/\.(png|jpe?g|gif|webp|bmp)$/.test(n) || type.startsWith('image/')) return 'image';
    if (/\.(doc|ppt)$/.test(n)) return 'legacy';
    if (/\.(zip|gz|tar|7z|rar|exe|dll|dmg|iso|mp[34]|mov|avi|mkv|wav|flac|woff2?|ttf|otf|bin|class|pyc|wasm|sqlite|db)$/.test(n)) return 'binary';
    if (TEXT_EXT.test(n) || type.startsWith('text/') || /json|xml|javascript/.test(type)) return 'text';
    return 'unknown';
  };

  const looksBinary = (buf) => { const b = new Uint8Array(buf.slice(0, 8000)); let bad = 0; for (const x of b) if (x === 0 || (x < 7) || (x > 13 && x < 32 && x !== 27)) bad++; return b.length > 0 && bad / b.length > 0.02; };
  const decodeText = (buf) => { let t = new TextDecoder('utf-8', { fatal: false }).decode(buf); if (t.includes('�')) { try { t = new TextDecoder('windows-1252').decode(buf); } catch { } } return t.replace(/^﻿/, ''); };
  const xmlText = (s) => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n));
  const rtfText = (s) => s.replace(/\\par[d]?/g, '\n').replace(/\{\\\*[^}]*\}/g, '').replace(/\\'([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\[a-z]+-?\d* ?/gi, '').replace(/[{}]/g, '').trim();

  async function pdf(buf, onStatus) {
    onStatus?.('Loading PDF reader…');
    const lib_ = await lib('pdf'); lib_.GlobalWorkerOptions.workerSrc = CDN.pdfWorker;
    const doc = await lib_.getDocument({ data: buf }).promise;
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
    const note = empty === doc.numPages ? 'The PDF contains no extractable text (scanned images?). OCR is not available in the browser; ask the user for a text version.' : empty ? `${empty} of ${doc.numPages} pages had no text layer.` : '';
    return { text: parts.join('\n\n'), pages: doc.numPages, note };
  }
  async function docx(buf, onStatus) {
    onStatus?.('Reading Word document…');
    const JSZip = await lib('jszip'); const z = await JSZip.loadAsync(buf);
    const f = z.file('word/document.xml'); if (!f) throw new Error('Not a valid .docx (word/document.xml missing)');
    let x = await f.async('string');
    x = x.replace(/<\/w:p>\s*<\/w:tc>/g, '</w:tc>').replace(/<w:tab\/>/g, '\t').replace(/<w:br[^>]*\/>/g, '\n').replace(/<\/w:p>/g, '\n').replace(/<\/w:tc>/g, ' | ').replace(/<\/w:tr>/g, '\n');
    let text = xmlText(x).replace(/\n{3,}/g, '\n\n').trim();
    const comments = z.file('word/comments.xml'); if (comments) { const c = xmlText((await comments.async('string')).replace(/<\/w:p>/g, '\n')).trim(); if (c) text += '\n\n--- Comments ---\n' + c; }
    return { text };
  }
  async function pptx(buf, onStatus) {
    onStatus?.('Reading presentation…');
    const JSZip = await lib('jszip'); const z = await JSZip.loadAsync(buf);
    const slides = Object.keys(z.files).filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => +a.match(/(\d+)/)[1] - +b.match(/(\d+)/)[1]);
    if (!slides.length) throw new Error('Not a valid .pptx (no slides found)');
    const parts = [];
    for (const n of slides) {
      const num = n.match(/(\d+)/)[1];
      let x = await z.file(n).async('string');
      x = x.replace(/<\/a:p>/g, '\n').replace(/<a:tab\/>/g, '\t').replace(/<\/a:tc>/g, ' | ');
      let text = xmlText(x).replace(/\n{3,}/g, '\n\n').trim();
      const notes = z.file(`ppt/notesSlides/notesSlide${num}.xml`); if (notes) { const t = xmlText((await notes.async('string')).replace(/<\/a:p>/g, '\n')).trim(); if (t) text += '\n[Speaker notes] ' + t; }
      parts.push(`--- Slide ${num} ---\n${text}`);
    }
    return { text: parts.join('\n\n'), pages: slides.length };
  }
  async function sheet(buf, onStatus) {
    onStatus?.('Reading spreadsheet…');
    const XLSX = await lib('xlsx'); const wb = XLSX.read(buf, { type: 'array', cellDates: true });
    const parts = [];
    for (const name of wb.SheetNames) { const ws = wb.Sheets[name]; const csv = XLSX.utils.sheet_to_csv(ws, { blankrows: false }); parts.push(`--- Sheet: ${name} ---\n${csv.trim()}`); }
    return { text: parts.join('\n\n'), pages: wb.SheetNames.length };
  }

  /** Extract from a File/Blob. Returns { kind: 'text'|'image'|'unsupported', content, note, pages } */
  async function fromFile(file, { onStatus, maxChars = 300000 } = {}) {
    const kind = kindOf(file.name, file.type);
    if (kind === 'image') return { kind: 'image', content: await H.readFileAsDataURL(file) };
    const buf = await file.arrayBuffer();
    try {
      let r;
      if (kind === 'pdf') r = await pdf(buf, onStatus);
      else if (kind === 'docx') r = await docx(buf, onStatus);
      else if (kind === 'pptx') r = await pptx(buf, onStatus);
      else if (kind === 'sheet') r = await sheet(buf, onStatus);
      else if (kind === 'legacy') return { kind: 'unsupported', content: '', note: `${file.name}: legacy binary Office format (.doc/.ppt) is not supported. Ask the user to save it as .docx/.pptx or PDF.` };
      else if (kind === 'binary') return { kind: 'unsupported', content: '', note: `${file.name}: binary file (${file.type || 'unknown type'}, ${H.fmtBytes(file.size)}); no text to extract.` };
      else {
        if (looksBinary(buf)) return { kind: 'unsupported', content: '', note: `${file.name} appears to be binary (${file.type || 'unknown type'}, ${H.fmtBytes(file.size)}); no text to extract.` };
        let t = decodeText(buf); if (/\.rtf$/i.test(file.name)) t = rtfText(t);
        r = { text: t };
      }
      const truncated = r.text.length > maxChars;
      return { kind: 'text', content: truncated ? r.text.slice(0, maxChars) : r.text, pages: r.pages, note: [r.note, truncated ? `Text truncated to ${maxChars} characters (original ${r.text.length}).` : ''].filter(Boolean).join(' ') };
    } catch (e) { return { kind: 'unsupported', content: '', note: `${file.name}: could not extract text (${e.message}).` }; }
  }
  const isDocument = (name) => ['pdf', 'docx', 'pptx', 'sheet'].includes(kindOf(name));
  return { fromFile, kindOf, isDocument, lib };
})();
