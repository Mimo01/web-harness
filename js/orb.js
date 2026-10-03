/* Thought orbs: the app's working indicator. A few dozen dots on a small canvas, arranged on a sphere, on rings or
   on a band, and turned in 3D: a dot near the viewer is large and dark, one behind is small and faint, so the
   picture reads as depth without any shading. Each kind of work has its own motion:

     think    a sphere that breathes while a wave of ink climbs over it      (waiting for the first words)
     search   a globe with a scan line sweeping across it                    (reading, listing, fetching)
     solve    latitude bands that click round in quarter turns, alternately   (running code, computing)
     compose  a band of strands undulating round the middle                  (writing, editing, creating)
     connect  nodes on a sphere, wired to their near neighbours               (sub-agents)
     work     particles on three tilted orbits                               (anything else)

   H.loader(kind, px) returns the canvas. Every orb shares one animation-frame loop, which skips orbs that are
   hidden and forgets ones that have left the page. Ink is the theme's --fg, re-read when the theme changes. */
(() => {
  const TAU = Math.PI * 2, GOLD = Math.PI * (3 - Math.sqrt(5));
  /* n points spread evenly over the unit sphere (a Fibonacci lattice) */
  const sphere = (n) => Array.from({ length: n }, (_, i) => { const y = 1 - 2 * (i + .5) / n, r = Math.sqrt(1 - y * y), a = i * GOLD; return [r * Math.cos(a), y, r * Math.sin(a)]; });
  /* turn about the vertical axis, then tilt toward the viewer; z comes out positive toward the viewer */
  const turn = (x, y, z, yaw, tilt) => {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), x1 = x * cy + z * sy, z1 = -x * sy + z * cy;
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    return [x1, y * ct - z1 * st, y * st + z1 * ct];
  };
  const ease = (f) => f * f * (3 - 2 * f);
  const cache = new Map();
  const lattice = (n) => { if (!cache.has(n)) cache.set(n, sphere(n)); return cache.get(n); };

  /* each kind: (t seconds, big?) → { dots: [[x, y, z, ink 0..1, size ×]], lines: [[x1, y1, z1, x2, y2, z2, ink]] } */
  const KINDS = {
    think(t, big, huge) {
      /* a breathing sphere: a wave of ink climbs it, a few dots catch the light and let go, and at the larger size a
         sparse ring circles the other way, which is what gives it depth */
      const k = 1 + .07 * Math.sin(t * 2.1);
      const dots = lattice(huge ? 240 : big ? 96 : 34).map(([x, y, z], i) => {
        const p = turn(x * k, y * k, z * k, t * .55, .38);
        const glint = Math.max(0, Math.sin(t * 1.7 + i * 2.39) * Math.sin(t * .9 + i * 1.13)) ** 6;
        return [...p, .22 + .78 * (.5 + .5 * Math.sin(y * 3.2 - t * 3)) + (huge ? .25 : .5) * glint, 1 + (huge ? .2 : .6) * glint];   // a backdrop's glints stay small
      });
      if (big) for (let j = 0, n = huge ? 64 : 28; j < n; j++) { const a = j / n * TAU - t * .8; dots.push([...turn(1.32 * Math.cos(a), .04 * Math.sin(a * 3 + t), 1.32 * Math.sin(a), 0, .38), .55, .7]); }
      return { dots };
    },
    search(t, big, huge) {
      const scan = Math.sin(t * 1.5) * .95;
      return { dots: lattice(huge ? 280 : big ? 120 : 38).map(([x, y, z]) => { const p = turn(x, y, z, t * .7, .3); const hit = Math.exp(-((p[0] - scan) ** 2) / .025); return [...p, (big ? .22 : .32) + .7 * hit, 1 + .35 * hit]; }) };
    },
    solve(t, big, huge) {
      const bands = big ? 7 : 4;
      return {
        dots: lattice(huge ? 280 : big ? 120 : 36).map(([x, y, z]) => {
          const b = Math.min(bands - 1, Math.floor((y + 1) / 2 * bands));
          const ph = t * .75 + b * .37, a = (Math.floor(ph) + ease(ph % 1)) * TAU / 4 * (b % 2 ? 1 : -1);
          return [...turn(x * Math.cos(a) + z * Math.sin(a), y, -x * Math.sin(a) + z * Math.cos(a), .6, .42), .45 + .55 * (b % 2), 1];
        }),
      };
    },
    compose(t, big, huge) {
      const lanes = huge ? 7 : big ? 5 : 2, segs = huge ? 84 : big ? 46 : 14, dots = [];
      for (let l = 0; l < lanes; l++) for (let j = 0; j < segs; j++) {
        const a = j / segs * TAU, y = .3 * Math.sin(a * 2 + t * 1.9 + l * .7) + (l - (lanes - 1) / 2) * (big ? .13 : .3);
        const r = Math.sqrt(Math.max(0, 1 - y * y));
        dots.push([...turn(r * Math.cos(a), y, r * Math.sin(a), t * .5, .55), .45 + .55 * (l === (lanes - 1) / 2 ? 1 : .6), 1]);
      }
      return { dots };
    },
    connect(t, big, huge) {
      const pts = lattice(huge ? 40 : big ? 26 : 12).map(([x, y, z], i) => {
        const w = .22 * Math.sin(t * .9 + i * 1.7); const v = [x + w * z, y + w * x, z - w * y]; const n = Math.hypot(...v);
        return turn(v[0] / n, v[1] / n, v[2] / n, t * .35, .32);
      });
      const lines = [], thr = big ? .78 : 1.05;
      for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
        const d = Math.hypot(pts[i][0] - pts[j][0], pts[i][1] - pts[j][1], pts[i][2] - pts[j][2]);
        if (d < thr) lines.push([...pts[i], ...pts[j], 1 - d / thr]);
      }
      return { dots: pts.map((p, i) => [...p, .7 + .3 * Math.sin(t * 2.4 + i * 2.1), 1.25]), lines };
    },
    work(t, big, huge) {
      const per = huge ? 16 : big ? 10 : 4, dots = [];
      for (let o = 0; o < 3; o++) for (let j = 0; j < per; j++) for (let tail = 0; tail < (big ? 4 : 3); tail++) {
        const a = j / per * TAU + t * (1.5 + o * .35) - tail * .16;
        const [x, y, z] = [Math.cos(a), 0, Math.sin(a)];
        const tilt = 1.05 + o * .25, spin = o * TAU / 3;   // three planes, each laid back and turned a third round
        const y1 = -z * Math.sin(tilt), z1 = z * Math.cos(tilt);
        const p = [x * Math.cos(spin) - y1 * Math.sin(spin), x * Math.sin(spin) + y1 * Math.cos(spin), z1];
        dots.push([...turn(p[0], p[1], p[2], t * .3, .2), 1 - tail * .25, 1 - tail * .2]);
      }
      return { dots };
    },
  };

  /* ink from the theme, re-read only when the theme can have changed */
  let ink = '0,0,0';
  const readInk = () => {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--fg').trim();
    const m = /^#?([0-9a-f]{6})$/i.exec(v);
    ink = m ? [0, 2, 4].map(i => parseInt(m[1].slice(i, i + 2), 16)).join(',') : '128,128,128';
  };
  new MutationObserver(readInk).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', readInk);
  const calm = matchMedia('(prefers-reduced-motion: reduce)');

  /* one kind's frame, at a given opacity and scale (both below 1 while it blends into the next kind) */
  function drawKind(o, kind, t, alpha, scale) {
    const { ctx, px } = o, big = px >= 32, huge = px >= 240;   // a backdrop-sized orb draws more, finer dots
    /* dots grow more slowly than the orb: a big orb gets more room between its dots, not fatter dots */
    const c = px / 2, R = px * .36 * scale * (1 + .06 * o.energy), dotR = (huge ? .75 + px * .005 : big ? .45 + px * .013 : px * .062) * (1 + .18 * o.energy);
    const lift = .82 + .18 * o.energy;   // energy brightens the whole orb a little
    const { dots, lines = [] } = KINDS[kind](t, big, huge);
    ctx.lineWidth = Math.max(.6, px / 60);
    for (const [x1, y1, z1, x2, y2, z2, k] of lines) {
      ctx.strokeStyle = `rgba(${ink},${(alpha * k * (.15 + .35 * ((z1 + z2) / 4 + .5))).toFixed(3)})`;
      ctx.beginPath(); ctx.moveTo(c + x1 * R, c - y1 * R); ctx.lineTo(c + x2 * R, c - y2 * R); ctx.stroke();
    }
    dots.sort((a, b) => a[2] - b[2]);   // back to front, so the near dots cover the far ones
    for (const [x, y, z, k, sz] of dots) {
      const depth = Math.min(1, Math.max(0, (z + 1) / 2));   // 0 at the back, 1 at the front
      ctx.fillStyle = `rgba(${ink},${(alpha * Math.min(1, k * lift * (.1 + .9 * depth))).toFixed(3)})`;
      ctx.beginPath(); ctx.arc(c + x * R, c - y * R, Math.max(.35, dotR * sz * (.45 + .55 * depth)), 0, TAU); ctx.fill();
    }
  }
  function paint(o) {
    const dpr = Math.min(2, devicePixelRatio || 1), w = Math.round(o.px * dpr);
    if (o.c.width !== w) o.c.width = o.c.height = w;
    o.ctx.setTransform(dpr, 0, 0, dpr, 0, 0); o.ctx.clearRect(0, 0, o.px, o.px);
    if (o.prev && o.mix < 1) {   // the old kind folds inward as the new one opens out of it
      const m = ease(o.mix);
      drawKind(o, o.prev, o.t, 1 - m, 1 - .25 * m);
      drawKind(o, o.kind, o.t, m, .75 + .25 * m);
    } else drawKind(o, o.kind, o.t, 1, 1);
  }

  const orbs = new Set(); let raf = 0, inkRead = false, last = 0;
  function tick(now) {
    if (!inkRead) { readInk(); inkRead = true; }
    const dt = Math.min(.1, last ? (now - last) / 1000 : 0); last = now;
    for (const o of orbs) {
      if (!o.c.isConnected) { if (++o.miss > 60) orbs.delete(o); continue; }   // not placed yet, or gone for good
      o.miss = 0;
      /* energy: a surge from pulse() that drains away, never below the floor the caller set; it quickens the clock */
      o.energy = Math.max(o.floor, o.energy * Math.exp(-dt * 2.4));
      o.t += dt * o.rate * (calm.matches ? .35 : 1) * (1 + 1.4 * o.energy);
      if (o.prev) { o.mix += dt / o.blend; if (o.mix >= 1) o.prev = null; }
      if (o.c.offsetParent !== null) paint(o);   // null: display:none somewhere above it
    }
    if (orbs.size) raf = requestAnimationFrame(tick); else { raf = 0; last = 0; }
  }
  /* H.loader(kind, px) → a canvas, which also carries:
       setKind(kind)   blend into another kind of work
       pulse(amount)   a surge of energy (e.g. per streamed chunk); it drains away by itself
       floor(level)    the energy it never drops below (a running tool keeps it ticking over)
       rate(x)         its pace: 1 is a working orb, below 1 an idle, ambient one
       blend(seconds)  how long a change of kind takes (half a second by default) */
  H.loader = (kind = 'work', px = 20) => {
    const c = H.el('canvas', { class: 'orb', role: 'img', 'aria-label': 'Working', style: `width:${px}px;height:${px}px` });
    const o = { c, ctx: c.getContext('2d'), kind: KINDS[kind] ? kind : 'work', prev: null, mix: 1, px, miss: 0, t: performance.now() / 1000, energy: 0, floor: 0, rate: 1, blend: .5 };
    c.setKind = (k) => { if (!KINDS[k] || k === o.kind) return; o.prev = o.kind; o.kind = k; o.mix = 0; };
    c.pulse = (amount = .25) => { o.energy = Math.min(1, o.energy + amount); };
    c.floor = (level = 0) => { o.floor = Math.max(0, Math.min(1, level)); };
    c.rate = (x = 1) => { o.rate = Math.max(.05, x); };
    c.blend = (s = .5) => { o.blend = Math.max(.1, s); };
    orbs.add(o);
    if (!raf) raf = requestAnimationFrame(tick);
    return c;
  };
})();
