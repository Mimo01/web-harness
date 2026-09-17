/* Markdown -> PDF, fully client-side.
   The harness could already read PDFs (js/extract.js); this is the other direction. pdf-lib draws the pages and
   fontkit lets it embed — and subset — real fonts, which is the whole reason for choosing it over jsPDF: the
   standard PDF fonts cover cp1252 only, so "č ť ľ ô" and anything Cyrillic would come out as garbage, and a font
   embedded whole adds ~700 KB to every file. Subsetting keeps a two-page memo at a few tens of kilobytes.
   Text is drawn as text, never rasterised: it stays selectable, searchable and sharp at any zoom.
   Typography follows the app's own paper & ink system — Instrument Sans, one accent colour on links, hairlines. */
H.pdf = (() => {
  /* Pinned by checksum like every other lazily loaded library here. Bump the hash with the version. */
  const CDN = {
    pdflib: ['https://cdnjs.cloudflare.com/ajax/libs/pdf-lib/1.17.1/pdf-lib.min.js', () => window.PDFLib, 'sha512-z8IYLHO8bTgFqj+yrPyIJnzBDf7DDhWwiEsk4sY+Oe6J2M+WQequeGS7qioI5vT6rXgVRb4K1UVQC5ER7MKzKQ=='],
    fontkit: ['https://cdn.jsdelivr.net/npm/@pdf-lib/fontkit@1.1.1/dist/fontkit.umd.min.js', () => window.fontkit, 'sha512-nN5LMjOUxjpCutlx3vCE453XaDaDYhjwM+0uYxHMo7wVW9SLhLi6kspqdcuWGrLYHkENUwtkiNeSlVflBQAQGQ=='],
  };
  /* Two families. Instrument Sans is the app's own face and covers Latin and Latin Extended-A, which is everything
     Western and Central European — Slovak included. A document that needs more (Cyrillic, Greek) switches to
     DejaVu Sans, which covers them; it is three times the download, so it is fetched only when a document
     actually contains those characters. Code is always JetBrains Mono, which covers both. */
  const ES = 'https://cdn.jsdelivr.net/npm/@expo-google-fonts';
  const FONTS = {
    sans: {
      label: 'Instrument Sans',
      regular: [`${ES}/instrument-sans@0.4.2/400Regular/InstrumentSans_400Regular.ttf`, 'sha512-nvf6bvyGDwGSNiPf3oDGueWsBIZzUUmhsamjoOJiFFy/bNaz6n3CqleO+4rKwf1sld35N7ZRIpbrbmCFANfXFg=='],
      bold: [`${ES}/instrument-sans@0.4.2/600SemiBold/InstrumentSans_600SemiBold.ttf`, 'sha512-ezRfy8Efdoi8xDNjUF3R9B4FWCu3lGvXoyolrUVfAg4gUkSByYpBYewjce0c8lpSpALkWYIzFRWHkbc78D05zg=='],
      italic: [`${ES}/instrument-sans@0.4.2/400Regular_Italic/InstrumentSans_400Regular_Italic.ttf`, 'sha512-K8M7q1mTc8CYWdwtKHj6wC3F/yk5+qR/1LurdVOhPkN6E6fTu4RPk8elSUfHJk5v5LKJMGNJFawkmkHB4PFoVg=='],
      boldItalic: [`${ES}/instrument-sans@0.4.2/600SemiBold_Italic/InstrumentSans_600SemiBold_Italic.ttf`, 'sha512-aF401Lw0iY8y7OAWylTyL5JFK/7HnxTe8200F6aa5BHD3bI4viWWm1cZUt8nXSoP6EEA+choUj5cTXi8vClg7A=='],
    },
    wide: {
      label: 'DejaVu Sans',
      regular: ['https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37/ttf/DejaVuSans.ttf', 'sha512-usnGLAa+cAzoBnuLXtMmMymshLO9mOja7/5G0ToAxv8zj7VwX0R1Kb84l8ouJuwQofMp7PML8C8Uc8yNfpkYGA=='],
      bold: ['https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37/ttf/DejaVuSans-Bold.ttf', 'sha512-fzIYW1APP8zNSo4SLbybMrtRgi2WY3hF0cg2hYxj9SLexVh0PysYtUXiDErF/jplTPxRYdCnpYLKWlhDd4GcOw=='],
      italic: ['https://cdn.jsdelivr.net/npm/dejavu-fonts-ttf@2.37/ttf/DejaVuSans-Oblique.ttf', 'sha512-Z1A+z4w7wJNw0klVALoNlElGbSIgaE4H0w8b47zNZygEbB74a/sx+IId3sSJeQ21wtenug3xZUso5K6gLuYRMg=='],
    },
    mono: {
      label: 'JetBrains Mono',
      regular: [`${ES}/jetbrains-mono@0.2.3/JetBrainsMono_400Regular.ttf`, 'sha512-dkAadugnezyIeJZWuaiIA/w83Aq1EJD7j2nS5Umxn1M729nzx9mMCh/iuobHDhVhkidjx2CnRAZysZr5VG7nbg=='],
    },
  };
  const bytesCache = new Map();   // url -> Uint8Array, so a second PDF in the same session downloads nothing
  const fontBytes = (spec) => {
    const [url, integrity] = spec;
    if (!bytesCache.has(url)) bytesCache.set(url, H.fetchVerified(url, integrity).catch(e => { bytesCache.delete(url); throw e; }));
    return bytesCache.get(url);
  };

  /* ---------- geometry ---------- */
  const MM = 72 / 25.4;
  const PAGES = { a4: [595.28, 841.89], letter: [612, 792], legal: [612, 1008], a5: [419.53, 595.28], a3: [841.89, 1190.55] };
  const pageSize = (name = 'a4', orientation = 'portrait') => {
    const [w, h] = PAGES[String(name).toLowerCase().replace(/[\s_-]/g, '')] || PAGES.a4;
    return /landscape/i.test(orientation) ? [h, w] : [w, h];
  };

  /* ---------- the look: the app's tokens, translated to ink on paper ---------- */
  const hex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255]; };
  const C = {
    ink: '#111110', body: '#1c1c1a', soft: '#3b3b38', muted: '#6e6e6a',
    rule: '#dedeD8', hair: '#e8e8e3', tint: '#f4f4f1', accent: '#0f7a72',
  };
  /* Type scale. Restraint on purpose: size and weight do the work, nothing is coloured that need not be. */
  const SCALE = {
    h1: { size: 1.8, style: 'bold', before: 16, after: 8, color: C.ink },
    h2: { size: 1.45, style: 'bold', before: 15, after: 6, color: C.ink },
    h3: { size: 1.18, style: 'bold', before: 12, after: 4, color: C.ink },
    h4: { size: 1.04, style: 'bold', before: 10, after: 3, color: C.ink },
    h5: { size: 1.0, style: 'bold', before: 9, after: 2, color: C.soft },
    h6: { size: 0.95, style: 'bold', before: 9, after: 2, color: C.muted },
  };
  const LEADING = 1.5, CODE_LEADING = 1.42;

  /* ---------- markdown -> tokens ---------- */
  /* marked is already loaded by index.html for the chat, so the document is parsed by the same parser that
     rendered its preview in the conversation: what the user saw is what they get. */
  function lex(md) {
    if (!window.marked?.lexer) throw new Error('The markdown parser (marked) is not loaded, so no PDF can be built.');
    return window.marked.lexer(String(md ?? '').replace(/\r\n?/g, '\n'));
  }
  /* Flatten marked's inline tokens into drawable runs. Everything a run needs to be measured and drawn is on it:
     no tree walking happens again during layout. */
  function runsOf(tokens, base = {}) {
    const out = [];
    const walk = (list, style) => {
      for (const t of list || []) {
        switch (t.type) {
          case 'strong': walk(t.tokens, { ...style, bold: true }); break;
          case 'em': walk(t.tokens, { ...style, italic: true }); break;
          case 'del': walk(t.tokens, { ...style, strike: true }); break;
          case 'link': walk(t.tokens, { ...style, link: t.href }); break;
          case 'codespan': out.push({ text: t.text, ...style, mono: true }); break;
          case 'br': out.push({ text: '\n', ...style }); break;
          case 'image': out.push({ text: t.text || t.href, ...style, italic: true }); break;   // an image inside a line of text: its alt stands in
          case 'html': { const s = String(t.text || '').replace(/<[^>]*>/g, ''); if (s) out.push({ text: s, ...style }); break; }
          default: if (t.tokens?.length) walk(t.tokens, style); else if (t.text != null) out.push({ text: t.text, ...style });
        }
      }
    };
    walk(tokens, base);
    return out.filter(r => r.text !== '');
  }

  /* ---------- character references ----------
     marked hands on the text with its character references intact — that is the HTML renderer's job to pass to the
     browser — and it escapes the contents of code spans itself, so `<div>` arrives as "&lt;div&gt;". Drawing that
     into a PDF would print "What&#39;s inside" verbatim, so it is decoded here, by the browser's own table.
     A detached <textarea> is the tool for it: its content is parsed as raw text, so every reference is resolved
     while anything shaped like a tag stays the literal characters it is. (Only its own end tag would escape that,
     and it cannot arrive unescaped — but it is neutralised anyway rather than relied upon.) */
  const decoder = document.createElement('textarea');
  const decodeEntities = (s) => {
    const t = String(s ?? '');
    if (!t.includes('&')) return t;
    decoder.innerHTML = t.replace(/<\/textarea/gi, '&lt;/textarea');
    return decoder.value;
  };

  /* ---------- characters the chosen font cannot draw ----------
     pdf-lib throws halfway through a page when it meets a glyph the font lacks, which would lose the whole
     document. The text is checked up front instead: unsupported code points are replaced and reported, so a stray
     emoji costs a warning line rather than the file. */
  const NON_LATIN = /[^\u0020-\u024F\u1E00-\u1EFF\u2000-\u206F\u20A0-\u20BF\u2122\u2190-\u21FF\u2212\n]/;
  function familyFor(text) { return NON_LATIN.test(text) ? 'wide' : 'sans'; }
  function coverageFilter(fontkit, bytes) {
    let font = null;
    try { font = fontkit.create(bytes); } catch { return null; }   // introspection is a nicety; without it nothing is replaced
    if (typeof font?.hasGlyphForCodePoint !== 'function') return null;
    const seen = new Map();
    return (cp) => { if (!seen.has(cp)) { let ok = false; try { ok = font.hasGlyphForCodePoint(cp); } catch { ok = true; } seen.set(cp, ok); } return seen.get(cp); };
  }

  /* ---------- the renderer ---------- */
  async function fromMarkdown(md, opts = {}) {
    const {
      title = '', subtitle = '', author = '', date = '', subject = '', keywords = '',
      headerText = '', pageNumbers = true, coverPage = false, fontSize = 10.5,
      onStatus, resolveImage,
    } = opts;

    const source = String(md ?? '');
    onStatus?.('Loading the PDF engine…');
    const PDFLib = await H.loadScript(...CDN.pdflib);
    const fontkit = await H.loadScript(...CDN.fontkit);
    const { PDFDocument, PDFName, PDFString, rgb } = PDFLib;
    const col = (h) => rgb(...hex(h));

    /* on the decoded text: "&#1055;" is Cyrillic once it is drawn, and the font has to be chosen for what lands
       on the page, not for what the markdown spells it with */
    const family = familyFor(decodeEntities(source + title + subtitle + author + headerText));
    onStatus?.(`Loading ${FONTS[family].label}…`);
    const set = FONTS[family];
    const [reg, bold, italic, boldItalic, mono] = await Promise.all([
      fontBytes(set.regular), fontBytes(set.bold), fontBytes(set.italic),
      fontBytes(set.boldItalic || set.bold), fontBytes(FONTS.mono.regular),
    ]);

    onStatus?.('Laying out the document…');
    const doc = await PDFDocument.create();
    doc.registerFontkit(fontkit);
    const F = {
      regular: await doc.embedFont(reg, { subset: true }), bold: await doc.embedFont(bold, { subset: true }),
      italic: await doc.embedFont(italic, { subset: true }), boldItalic: await doc.embedFont(boldItalic, { subset: true }),
      /* Ligatures off for code, and only for code. JetBrains Mono joins "&&", "!=", "</" into single glyphs, and a
         subsetted ligature glyph gets the wrong ToUnicode entry: the page looks right, but copying the listing out
         of the PDF — or searching it — yields "<&" for "&&" and, worse, "<=" where the code says "!=". A listing
         nobody can copy correctly is not a listing. The text faces keep theirs: they extract cleanly, and fi/fl
         are worth having. */
      mono: await doc.embedFont(mono, { subset: true, features: { liga: false, clig: false, calt: false, dlig: false } }),
    };
    const warnings = [];
    const supports = coverageFilter(fontkit, reg);
    const dropped = new Set();
    /* Everything drawn goes through here: NFC so composed accents measure like the glyphs they are, tabs as
       spaces (a PDF has no tab stops), and anything the font cannot draw swapped for a visible placeholder. */
    const clean = (s) => {
      let t = decodeEntities(s).normalize('NFC').replace(/\t/g, '    ').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
      if (!supports) return t;
      return t.replace(/[\s\S]/gu, (ch) => {
        const cp = ch.codePointAt(0);
        if (ch === '\n' || supports(cp)) return ch;
        dropped.add(ch);
        return '·';
      });
    };
    const fontFor = (r) => (r.mono ? F.mono : r.bold && r.italic ? F.boldItalic : r.bold ? F.bold : r.italic ? F.italic : F.regular);
    const sizeOf = (r, size) => (r.mono ? size * 0.92 : size);
    const widthOf = (r, size) => { try { return fontFor(r).widthOfTextAtSize(r.text, sizeOf(r, size)); } catch { return r.text.length * size * 0.5; } };

    const [PW, PH] = pageSize(opts.pageSize, opts.orientation);
    const margin = Math.max(8 * MM, (Number(opts.margin) || 20) * MM);
    const left = margin, right = PW - margin;
    const top = PH - margin;
    const footRoom = pageNumbers ? 16 : 0;
    const bottom = margin + footRoom;

    const pages = [];
    const links = [];                 // { page, rect, href } — applied once everything has been drawn
    let page = null, y = 0;
    const newPage = () => { page = doc.addPage([PW, PH]); pages.push(page); y = top; return page; };
    const space = (h) => { if (y - h < bottom) newPage(); };
    const gap = (h) => { if (y < top) y -= h; };   // no leading gap at the top of a page

    const line = (x1, y1, x2, color, thickness = 0.6) => page.drawLine({ start: { x: x1, y: y1 }, end: { x: x2, y: y1 }, thickness, color: col(color) });
    const text = (s, x, yy, { font = F.regular, size = fontSize, color = C.body } = {}) => page.drawText(s, { x, y: yy, size, font, color: col(color) });

    /* ---- inline layout: runs -> wrapped lines of positioned pieces ---- */
    function wrap(runs, width, size) {
      const lines = []; let cur = [], w = 0;
      const push = () => { while (cur.length && /^\s+$/.test(cur[cur.length - 1].text)) cur.pop(); lines.push({ parts: cur, width: cur.reduce((a, p) => a + p.width, 0) }); cur = []; w = 0; };
      for (const run of runs) {
        /* `pre` runs (a line of a code block) are kept whole so their indentation survives — the wrapper drops
           whitespace at the start of a line, which is right for prose and wrong for code. Anything too wide for
           the column still gets broken below, which is the soft wrap a listing wants. */
        /* every whitespace run is a break opportunity except U+00A0, which a document says "&nbsp;" to ask for
           precisely the opposite: it stays inside the word it binds */
        const pieces = run.pre ? [clean(run.text)].filter(p => p !== '') : clean(run.text).split(/([^\S\u00A0]+|\n)/).filter(p => p !== '');
        for (const piece of pieces) {
          if (piece === '\n') { push(); continue; }
          const part = { ...run, text: piece };
          let pw = widthOf(part, size);
          if (/^\s+$/.test(piece)) { if (!cur.length) continue; cur.push({ ...part, width: pw }); w += pw; continue; }
          /* a single token wider than the column (a URL, a hash) is broken by character rather than allowed to
             run off the page */
          if (pw > width) {
            let buf = '';
            for (const ch of piece) {
              const test = { ...part, text: buf + ch }; const tw = widthOf(test, size);
              if (w + tw > width && (buf || cur.length)) { if (buf) { cur.push({ ...part, text: buf, width: widthOf({ ...part, text: buf }, size) }); } push(); buf = ch; }
              else buf += ch;
            }
            if (buf) { const bw = widthOf({ ...part, text: buf }, size); cur.push({ ...part, text: buf, width: bw }); w += bw; }
            continue;
          }
          if (w + pw > width && cur.length) push();
          cur.push({ ...part, width: pw }); w += pw;
        }
      }
      push();
      return lines.filter((l, i, a) => l.parts.length || i === a.length - 1 || i === 0);
    }
    /* Draw one wrapped line. Links get the accent colour, an underline and a real /Link annotation so they are
       clickable in a reader, not just blue. */
    function drawLine(l, x, size, color) {
      let cx = x;
      for (const p of l.parts) {
        if (/^\s+$/.test(p.text)) { cx += p.width; continue; }
        const s = sizeOf(p, size);
        const c = p.link ? C.accent : p.mono ? C.ink : color;
        text(p.text, cx, y, { font: fontFor(p), size: s, color: c });
        if (p.link) { line(cx, y - s * 0.16, cx + p.width, C.accent, 0.4); links.push({ page, rect: [cx, y - s * 0.2, cx + p.width, y + s * 0.85], href: p.link }); }
        if (p.strike) line(cx, y + s * 0.26, cx + p.width, color, 0.5);
        cx += p.width;
      }
    }
    /** Lay a paragraph out and draw it, breaking across pages where it has to. */
    function paragraph(runs, { x = left, width = right - left, size = fontSize, color = C.body, leading = LEADING, keepWith = 0 } = {}) {
      const lines = wrap(runs, width, size);
      const lh = size * leading;
      for (let i = 0; i < lines.length; i++) {
        const need = lh + (i === 0 ? keepWith : 0);
        if (y - need < bottom) newPage();
        y -= lh * 0.82;
        drawLine(lines[i], x, size, color);
        y -= lh * 0.18;
      }
      return lines.length;
    }

    /* ---- blocks ---- */
    async function renderBlocks(tokens, x, width) {
      for (const t of tokens || []) await renderBlock(t, x, width);
    }
    async function renderBlock(t, x = left, width = right - left) {
      switch (t.type) {
        case 'space': return;
        case 'heading': {
          const s = SCALE['h' + Math.min(6, t.depth)] || SCALE.h4;
          gap(s.before);
          /* a heading alone at the foot of a page is a bad page: it moves down with the line it introduces */
          paragraph(runsOf(t.tokens, { bold: s.style === 'bold' }), { x, width, size: fontSize * s.size, color: s.color, leading: 1.25, keepWith: fontSize * LEADING });
          y -= s.after;
          return;
        }
        case 'paragraph': {
          const imgs = (t.tokens || []).filter(k => k.type === 'image');
          const rest = (t.tokens || []).filter(k => k.type !== 'image' && !(k.type === 'text' && !k.text.trim()));
          if (imgs.length && !rest.length) { for (const im of imgs) await image(im, x, width); return; }
          gap(2);
          paragraph(runsOf(t.tokens), { x, width });
          y -= fontSize * 0.75;
          return;
        }
        case 'text': paragraph(runsOf(t.tokens || [{ type: 'text', text: t.text }]), { x, width }); return;
        case 'hr': space(12); y -= 6; line(x, y, x + width, C.rule, 0.7); y -= 10; return;
        case 'code': return codeBlock(t, x, width);
        case 'blockquote': {
          gap(6);
          const startY = y, startPage = pages.indexOf(page);
          await renderBlocks(t.tokens, x + 14, width - 14);
          /* the rule is drawn after the text so it can follow it across a page break */
          const endPage = pages.indexOf(page);
          for (let i = startPage; i <= endPage; i++) {
            const p = pages[i];
            const a = i === startPage ? startY : top, b = i === endPage ? y + 2 : bottom;
            if (a > b) p.drawLine({ start: { x: x + 2, y: a }, end: { x: x + 2, y: b }, thickness: 2, color: col(C.rule) });
          }
          y -= 4;
          return;
        }
        case 'list': return listBlock(t, x, width);
        case 'table': return tableBlock(t, x, width);
        case 'html': {
          if (/<!--\s*(pagebreak|page-break|newpage)\s*-->/i.test(t.raw || '')) { newPage(); return; }
          const stripped = String(t.raw || '').replace(/<[^>]*>/g, '').trim();
          if (stripped) paragraph([{ text: stripped }], { x, width, color: C.soft });
          return;
        }
        default:
          if (t.tokens?.length) return renderBlocks(t.tokens, x, width);
          if (t.text) paragraph([{ text: t.text }], { x, width });
      }
    }

    function codeBlock(t, x, width) {
      const size = fontSize * 0.88, lh = size * CODE_LEADING, pad = 8;
      const runs = clean(t.text ?? '').split('\n').map(l => ({ text: l, mono: true, pre: true }));
      /* every source line is wrapped on its own, so a blank line stays blank and nothing is reflowed into it */
      const lines = [];
      for (const r of runs) for (const l of wrap([r], width - pad * 2, size)) lines.push(l);
      gap(8);
      let i = 0;
      while (i < lines.length) {
        if (y - (lh + pad * 2) < bottom) newPage();
        const room = Math.max(1, Math.floor((y - bottom - pad * 2) / lh));
        const chunk = lines.slice(i, i + room);
        const h = chunk.length * lh + pad * 2;
        page.drawRectangle({ x, y: y - h, width, height: h, color: col(C.tint), borderColor: col(C.hair), borderWidth: 0.5 });
        y -= pad;
        for (const l of chunk) { y -= lh * 0.8; drawLine(l, x + pad, size, C.ink); y -= lh * 0.2; }
        y -= pad;
        i += chunk.length;
      }
      y -= 9;
    }

    async function listBlock(t, x, width) {
      gap(4);
      const indent = 16;
      let n = Number(t.start || 1);
      for (const item of t.items || []) {
        const marker = t.ordered ? `${n++}.` : '';
        const markerWidth = t.ordered ? Math.max(indent, F.regular.widthOfTextAtSize(marker, fontSize) + 6) : indent;
        const before = y, beforePage = page;
        /* The item's own blocks are laid out first, and the marker is drawn afterwards at the position the first
           line turned out to take — the only way to place it correctly when that line lands on a fresh page. */
        if (item.task) {
          // a real box rather than a glyph: no font has to have it, and it prints crisply
          const inner = item.tokens || [];
          const boxAt = { p: pages.indexOf(page), y: y - fontSize * LEADING * 0.82 };
          await renderBlocks(inner, x + markerWidth, width - markerWidth);
          const p = pages[boxAt.p], by = boxAt.y;
          p.drawRectangle({ x: x + 2, y: by + 0.5, width: fontSize * 0.72, height: fontSize * 0.72, borderColor: col(C.muted), borderWidth: 0.7, color: item.checked ? col(C.ink) : undefined });
          if (item.checked) {
            const s = fontSize * 0.72;
            p.drawLine({ start: { x: x + 2 + s * 0.22, y: by + 0.5 + s * 0.5 }, end: { x: x + 2 + s * 0.44, y: by + 0.5 + s * 0.26 }, thickness: 1.1, color: col('#ffffff') });
            p.drawLine({ start: { x: x + 2 + s * 0.44, y: by + 0.5 + s * 0.26 }, end: { x: x + 2 + s * 0.8, y: by + 0.5 + s * 0.74 }, thickness: 1.1, color: col('#ffffff') });
          }
        } else {
          const markerY = y - fontSize * LEADING * 0.82, markerPage = page;
          await renderBlocks(item.tokens, x + markerWidth, width - markerWidth);
          /* the bullet is drawn, not typed: no font has to carry U+2022, and a circle of our own size sits
             better against the text than whatever the face happens to provide */
          if (t.ordered) markerPage.drawText(marker, { x, y: markerY, size: fontSize, font: F.regular, color: col(C.soft) });
          else markerPage.drawCircle({ x: x + 5, y: markerY + fontSize * 0.28, size: fontSize * 0.115, color: col(C.soft) });
        }
        if (page === beforePage && y === before) y -= fontSize * LEADING;   // an empty item still occupies a line
        if (!t.loose) y += fontSize * 0.45;                                  // tight lists breathe less
        y -= 1;
      }
      y -= fontSize * 0.5;
    }

    function tableBlock(t, x, width) {
      const size = fontSize * 0.92, lh = size * 1.38, padX = 6, padY = 5;
      const header = (t.header || []).map(c => runsOf(c.tokens, { bold: true }));
      const rows = (t.rows || []).map(r => r.map(c => runsOf(c.tokens)));
      const cols = header.length || (rows[0] || []).length;
      if (!cols) return;
      const align = t.align || [];
      /* Columns are sized from what is in them: the natural (unwrapped) width, capped so one long cell cannot
         squeeze the others below what their longest word needs. */
      const natural = [], minimum = [];
      for (let c = 0; c < cols; c++) {
        let nat = 0, min = 0;
        for (const cells of [header, ...rows]) {
          const runs = cells[c] || [];
          const full = runs.reduce((a, r) => a + widthOf({ ...r, text: clean(r.text) }, size), 0);
          nat = Math.max(nat, full);
          for (const r of runs) for (const w of clean(r.text).split(/\s+/)) min = Math.max(min, widthOf({ ...r, text: w }, size));
        }
        natural.push(nat + padX * 2); minimum.push(min + padX * 2);
      }
      const total = natural.reduce((a, b) => a + b, 0);
      let widths = natural.slice();
      if (total > width) {
        const minTotal = minimum.reduce((a, b) => a + b, 0);
        const slack = Math.max(0, width - minTotal), extra = Math.max(1, total - minTotal);
        widths = natural.map((w, i) => minimum[i] + (slack * (w - minimum[i])) / extra);
        const over = widths.reduce((a, b) => a + b, 0) - width;
        if (over > 0) widths = widths.map(w => w - (over * w) / (width + over));   // still too wide: shave proportionally
      } else {
        const rest = width - total;
        widths = widths.map(w => w + (rest * w) / total);   // fill the column, keeping proportions
      }

      const rowLines = (cells) => cells.map((runs, c) => wrap(runs || [], widths[c] - padX * 2, size));
      const drawRow = (cells, { head = false } = {}) => {
        const lines = rowLines(cells);
        const h = Math.max(1, ...lines.map(l => l.length)) * lh + padY * 2;
        if (y - h < bottom) { newPage(); if (!head) drawRow(header, { head: true }); }
        if (head) page.drawRectangle({ x, y: y - h, width, height: h, color: col(C.tint) });
        let cx = x;
        for (let c = 0; c < cols; c++) {
          const saved = y;
          y -= padY;
          for (const l of lines[c] || []) {
            const room = widths[c] - padX * 2;
            const off = align[c] === 'right' ? room - l.width : align[c] === 'center' ? (room - l.width) / 2 : 0;
            y -= lh * 0.8; drawLine(l, cx + padX + Math.max(0, off), size, head ? C.ink : C.body); y -= lh * 0.2;
          }
          y = saved;
          cx += widths[c];
        }
        y -= h;
        line(x, y, x + width, head ? C.rule : C.hair, head ? 0.7 : 0.4);
      };
      gap(8);
      space(lh * 3);
      line(x, y, x + width, C.rule, 0.7);
      if (header.length) drawRow(header, { head: true });
      for (const r of rows) drawRow(r);
      y -= 10;
    }

    async function image(tok, x, width) {
      const src = String(tok.href || '');
      let bytes = null;
      try {
        if (/^data:image\/(png|jpe?g);base64,/i.test(src)) {
          const b64 = src.slice(src.indexOf(',') + 1), bin = atob(b64);
          bytes = Uint8Array.from(bin, ch => ch.charCodeAt(0));
        } else if (/^https?:/i.test(src)) {
          warnings.push(`Image "${src}" was not embedded: building a document never fetches from the network. Save the image into the workspace and reference it by path.`);
        } else if (resolveImage) {
          bytes = await resolveImage(src);
        }
      } catch (e) { warnings.push(`Image "${src}" could not be read: ${e.message}`); }
      if (!bytes) {
        if (!/^https?:/i.test(src) && resolveImage) warnings.push(`Image "${src}" could not be embedded (PNG and JPEG only).`);
        if (tok.text) paragraph([{ text: tok.text, italic: true }], { x, width, color: C.muted });
        return;
      }
      let img;
      try { img = bytes[0] === 0x89 ? await doc.embedPng(bytes) : await doc.embedJpg(bytes); }
      catch (e) { warnings.push(`Image "${src}" is not a PNG or JPEG the renderer can embed (${e.message}).`); return; }
      const scale = Math.min(1, width / img.width);
      const w = img.width * scale, h = img.height * scale;
      if (y - h < bottom) { if (h <= top - bottom) newPage(); }
      const fit = Math.min(1, (top - bottom) / h);
      page.drawImage(img, { x, y: y - h * fit, width: w * fit, height: h * fit });
      y -= h * fit + 6;
      if (tok.text) { paragraph([{ text: tok.text, italic: true }], { x, width, size: fontSize * 0.85, color: C.muted }); y -= 4; }
    }

    /* ---- the document itself ---- */
    newPage();
    const hasTitle = !!(title || subtitle);
    const meta = [author, date].filter(Boolean).join(' · ');
    if (hasTitle && coverPage) {
      y = PH * 0.62;
      paragraph([{ text: title, bold: true }], { size: fontSize * 2.9, leading: 1.2, color: C.ink });
      if (subtitle) { y -= 6; paragraph([{ text: subtitle }], { size: fontSize * 1.35, color: C.muted, leading: 1.3 }); }
      /* measured up from the bottom of the type area, not down from the top: on a short page (landscape, A5)
         a fixed offset put the byline below the last line the page had room for, and it started page two */
      y = bottom + 56;
      line(left, y, left + 54, C.rule, 0.8);
      y -= 16;
      if (meta) paragraph([{ text: meta }], { size: fontSize * 0.92, color: C.muted });
      newPage();
    } else if (hasTitle) {
      paragraph([{ text: title, bold: true }], { size: fontSize * 2.1, leading: 1.2, color: C.ink });
      if (subtitle) { y -= 2; paragraph([{ text: subtitle }], { size: fontSize * 1.15, color: C.muted, leading: 1.35 }); }
      if (meta) { y -= 3; paragraph([{ text: meta }], { size: fontSize * 0.85, color: C.muted }); }
      y -= 8; line(left, y, right, C.rule, 0.7); y -= 14;
    }
    await renderBlocks(lex(source));

    /* ---- running header and page numbers: a second pass, because "of N" is only known now ---- */
    const coverPages = hasTitle && coverPage ? 1 : 0;
    const runningHead = clean(headerText || (hasTitle && !coverPage ? '' : title));
    const total = pages.length;
    pages.forEach((p, i) => {
      if (i < coverPages) return;
      if (runningHead && i > coverPages) {
        const s = fontSize * 0.78;
        p.drawText(runningHead, { x: left, y: PH - margin + 14, size: s, font: F.regular, color: col(C.muted) });
        p.drawLine({ start: { x: left, y: PH - margin + 9 }, end: { x: right, y: PH - margin + 9 }, thickness: 0.4, color: col(C.hair) });
      }
      if (pageNumbers) {
        const label = `${i + 1 - coverPages} / ${total - coverPages}`;
        const s = fontSize * 0.78, w = F.regular.widthOfTextAtSize(label, s);
        p.drawText(label, { x: right - w, y: margin - 16, size: s, font: F.regular, color: col(C.muted) });
      }
    });
    /* links last: a /Link annotation is attached to the page, not drawn into it */
    for (const l of links) {
      const href = H.safeHref(l.href);
      if (!href) continue;
      const ref = doc.context.register(doc.context.obj({
        Type: 'Annot', Subtype: 'Link', Rect: l.rect, Border: [0, 0, 0],
        A: { Type: 'Action', S: 'URI', URI: PDFString.of(href) },
      }));
      const existing = l.page.node.Annots();
      if (existing) existing.push(ref); else l.page.node.set(PDFName.of('Annots'), doc.context.obj([ref]));
    }

    if (title) doc.setTitle(clean(title));
    if (author) doc.setAuthor(clean(author));
    if (subject || subtitle) doc.setSubject(clean(subject || subtitle));
    if (keywords) doc.setKeywords(String(keywords).split(/\s*,\s*/).filter(Boolean).map(clean));
    doc.setProducer('LLM Harness ' + (H.ABOUT?.version || ''));
    doc.setCreator('LLM Harness');
    doc.setCreationDate(new Date());

    if (dropped.size) warnings.push(`${dropped.size} character(s) the document font cannot draw were replaced with "·": ${[...dropped].slice(0, 12).join(' ')}. ${family === 'wide' ? 'Emoji and CJK are not covered by any embedded font.' : ''}`.trim());
    onStatus?.('Writing the PDF…');
    const bytes = await doc.save();
    return { bytes, pages: pages.length, font: FONTS[family].label, warnings };
  }

  const blob = (bytes) => new Blob([bytes], { type: 'application/pdf' });

  /* ---------- showing a PDF ----------
     The pages are drawn into canvases by pdf.js — the same copy that reads attachments — rather than handed to the
     browser's own viewer in a frame: a blob: URL would put a document on the harness's own origin, which is the one
     thing the preview has always refused to do. Pages render as they come into view, so a 200-page document opens
     as fast as a one-page one, and each canvas is drawn at the device's pixel ratio so the type stays sharp. */
  async function view(bytes, host, { onStatus, maxScale = 2 } = {}) {
    const { lib, worker } = await H.extract.pdfjs();
    onStatus?.('Rendering…');
    const doc = await lib.getDocument({ data: bytes.slice(), disableWorker: !worker }).promise;
    host.innerHTML = '';
    const dpr = Math.min(maxScale, window.devicePixelRatio || 1);
    const width = () => Math.max(240, host.clientWidth - 24);
    const seen = new WeakMap(), tasks = new Set();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); draw(e.target); }
    }, { root: host, rootMargin: '400px' });
    /* Nothing in here may throw into the observer callback, which has no caller to catch it. Replacing one document
       with the next tears this one down mid-render, and pdf.js reports that by rejecting with
       RenderingCancelledException — the expected end of a cancelled page, not a failure to report. */
    async function draw(slot) {
      if (seen.get(slot)) return;
      seen.set(slot, true);
      try {
        const page = await doc.getPage(Number(slot.dataset.page));
        const scale = width() / page.getViewport({ scale: 1 }).width;
        const vp = page.getViewport({ scale: scale * dpr });
        const c = H.el('canvas', { class: 'pdf-page' });
        c.width = Math.round(vp.width); c.height = Math.round(vp.height);
        c.style.width = '100%';
        slot.replaceWith(c);
        const task = page.render({ canvasContext: c.getContext('2d'), viewport: vp });
        tasks.add(task);
        try { await task.promise; } finally { tasks.delete(task); }
      } catch (e) {
        if (e?.name === 'RenderingCancelledException') return;
        console.warn('PDF page ' + slot.dataset.page + ' could not be rendered', e);
      }
    }
    for (let i = 1; i <= doc.numPages; i++) {
      const p = await doc.getPage(i), vp = p.getViewport({ scale: 1 });
      /* a placeholder of the right shape first: the scrollbar is honest before a single page has been drawn */
      const slot = H.el('div', { class: 'pdf-slot', 'data-page': i, style: `aspect-ratio:${vp.width}/${vp.height}` });
      host.append(slot);
      io.observe(slot);
    }
    /* stop drawing first, then let the document go: a page still rendering would otherwise keep the worker busy
       painting a canvas nobody will see */
    return { pages: doc.numPages, destroy: () => { io.disconnect(); for (const t of tasks) { try { t.cancel(); } catch { } } tasks.clear(); doc.destroy?.(); } };
  }

  return { fromMarkdown, blob, view, pageSizes: () => Object.keys(PAGES) };
})();
