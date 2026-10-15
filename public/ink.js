// Handwriting pad for manual minutes (iPad + Apple Pencil, also mouse; finger optional).
// Ink is vector data: pages of strokes in a 1000-unit-wide page space, delta-encoded integers.
(() => {
  'use strict';
  const PAGE_W = 1000, PAGE_H = 1414;
  const COLORS = [['#1b1b1b', 'Negro'], ['#1f4fd1', 'Azul'], ['#c62828', 'Rojo']];
  const WIDTHS = [[2, 'Fino'], [3.5, 'Medio'], [6, 'Grueso']];
  const MAX_PAGES = 20, MAX_CHARS = 1_400_000, ERASE_RADIUS = 14;
  const SETTINGS = 'dsta-ink-settings';
  const loadSettings = () => { try { return { color: 0, width: 1, finger: false, ...JSON.parse(localStorage.getItem(SETTINGS) || '{}') }; } catch { return { color: 0, width: 1, finger: false }; } };
  const saveSettings = s => { try { localStorage.setItem(SETTINGS, JSON.stringify(s)); } catch { /* per-device convenience only */ } };

  // Stroke: {c, w, pts:[x,y,p, ...]} in page units (0.1 precision); p = pressure 0..1.
  // Stored delta-encoded integers: coordinates × q (10) and pressure × pq (100). Early drafts had q=1, pq=9.
  const Q = 10, PQ = 100;
  function decode(text) {
    if (!text) return [{ strokes: [] }];
    const data = JSON.parse(text), q = data.q || 1, pq = data.pq || 9;
    const pages = (data.pages || []).map(page => ({ strokes: page.map(([c, w, d]) => {
      const pts = []; let x = 0, y = 0;
      for (let i = 0; i < d.length; i += 3) { x += d[i]; y += d[i + 1]; pts.push(x / q, y / q, d[i + 2] / pq); }
      return { c, w, pts };
    }) }));
    return pages.length ? pages : [{ strokes: [] }];
  }
  function encode(pages) {
    if (pages.every(p => !p.strokes.length)) return '';
    return JSON.stringify({ v: 1, w: PAGE_W, h: PAGE_H, q: Q, pq: PQ, pages: pages.map(page => page.strokes.map(s => {
      const d = []; let x = 0, y = 0;
      for (let i = 0; i < s.pts.length; i += 3) {
        const X = Math.round(s.pts[i] * Q), Y = Math.round(s.pts[i + 1] * Q);
        d.push(X - x, Y - y, Math.max(1, Math.min(PQ, Math.round(s.pts[i + 2] * PQ)))); x = X; y = Y;
      }
      return [s.c, s.w, d];
    })) });
  }
  const widthOf = (base, scale, p) => base * scale * (0.45 + 0.9 * p);
  // Smooth rendering: quadratic curves through the midpoints of consecutive samples, one piece per
  // sample so the width follows the pencil's pressure. `from` limits the work while drawing live.
  function drawStroke(ctx, s, scale, from = 0, tail = true) {
    const color = COLORS[s.c]?.[0] || COLORS[0][0], base = WIDTHS[s.w]?.[0] || WIDTHS[1][0];
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const p = s.pts, n = p.length / 3, X = i => p[i * 3] * scale, Y = i => p[i * 3 + 1] * scale, P = i => p[i * 3 + 2];
    if (n === 1) { ctx.beginPath(); ctx.arc(X(0), Y(0), widthOf(base, scale, P(0)) / 2, 0, Math.PI * 2); ctx.fill(); return; }
    const mid = (a, b) => [(X(a) + X(b)) / 2, (Y(a) + Y(b)) / 2];
    for (let i = Math.max(1, from); i < n; i++) {
      const start = i === 1 ? [X(0), Y(0)] : mid(i - 2, i - 1);
      const end = i === n - 1 && tail ? [X(i), Y(i)] : mid(i - 1, i);
      ctx.lineWidth = widthOf(base, scale, (P(i - 1) + P(i)) / 2);
      ctx.beginPath(); ctx.moveTo(start[0], start[1]);
      if (i === 1) ctx.lineTo(end[0], end[1]); else ctx.quadraticCurveTo(X(i - 1), Y(i - 1), end[0], end[1]);
      ctx.stroke();
    }
  }
  const nearStroke = (s, x, y) => {
    for (let i = 0; i < s.pts.length; i += 3) if (Math.hypot(s.pts[i] - x, s.pts[i + 1] - y) <= ERASE_RADIUS) return true;
    return false;
  };

  // compact: a read-only view that crops each page below its last stroke (Minutas detail, copilot).
  function create({ ink = '', readOnly = false, compact = false, onChange = () => {} } = {}) {
    let pages = decode(ink), locked = readOnly, tool = 'pen', penSeen = false;
    const settings = loadSettings(), undo = [], redo = [];
    const el = document.createElement('div'); el.className = 'ink';
    el.innerHTML = `<div class="ink-bar" role="toolbar" aria-label="Herramientas de escritura">
        <div class="ink-group"><button type="button" data-tool="pen" aria-label="Lápiz">✏️</button><button type="button" data-tool="eraser" aria-label="Borrador">🧽</button></div>
        <div class="ink-group" data-colors></div><div class="ink-group" data-widths></div>
        <div class="ink-group"><button type="button" data-undo aria-label="Deshacer">↶</button><button type="button" data-redo aria-label="Rehacer">↷</button></div>
        <div class="ink-group"><button type="button" data-add>+ Hoja</button></div>
        <button type="button" class="ink-finger" data-finger aria-label="Escribir también con el dedo">☝️ Dedo</button>
      </div><div class="ink-pages"></div>`;
    const bar = el.querySelector('.ink-bar'), box = el.querySelector('.ink-pages');
    COLORS.forEach(([color, label], i) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'ink-swatch' });
      b.style.setProperty('--ink', color); b.setAttribute('aria-label', label); b.dataset.color = i;
      el.querySelector('[data-colors]').append(b);
    });
    WIDTHS.forEach(([w, label], i) => {
      const b = Object.assign(document.createElement('button'), { type: 'button', className: 'ink-width' });
      b.innerHTML = `<i style="width:${4 + w * 2}px;height:${4 + w * 2}px"></i>`; b.setAttribute('aria-label', label); b.dataset.width = i;
      el.querySelector('[data-widths]').append(b);
    });

    const snapshot = () => pages.map(p => p.strokes.slice());
    const restore = snap => { pages = snap.map(strokes => ({ strokes })); renderPages(); };
    const commit = before => { undo.push(before); if (undo.length > 100) undo.shift(); redo.length = 0; changed(); };
    let cached = null;
    const changed = () => { cached = null; refreshBar(); onChange(); };
    const serialize = () => (cached ??= encode(pages));

    function refreshBar() {
      bar.querySelectorAll('[data-tool]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
      bar.querySelectorAll('[data-color]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.color) === settings.color)));
      bar.querySelectorAll('[data-width]').forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.width) === settings.width)));
      bar.querySelector('[data-finger]').setAttribute('aria-pressed', String(settings.finger));
      bar.querySelectorAll('button,input').forEach(b => { b.disabled = locked; });
      if (!locked) {
        bar.querySelector('[data-undo]').disabled = !undo.length;
        bar.querySelector('[data-redo]').disabled = !redo.length;
        bar.querySelector('[data-add]').disabled = pages.length >= MAX_PAGES;
      }
      el.classList.toggle('ink-locked', locked); el.classList.toggle('ink-finger-on', settings.finger);
    }
    bar.addEventListener('click', e => {
      const b = e.target.closest('button'); if (!b || locked) return;
      if (b.dataset.tool) tool = b.dataset.tool;
      else if (b.dataset.color) { settings.color = Number(b.dataset.color); tool = 'pen'; saveSettings(settings); }
      else if (b.dataset.width) { settings.width = Number(b.dataset.width); tool = 'pen'; saveSettings(settings); }
      else if ('finger' in b.dataset) { settings.finger = !settings.finger; saveSettings(settings); }
      else if ('undo' in b.dataset && undo.length) { redo.push(snapshot()); restore(undo.pop()); changed(); return; }
      else if ('redo' in b.dataset && redo.length) { undo.push(snapshot()); restore(redo.pop()); changed(); return; }
      else if ('add' in b.dataset && pages.length < MAX_PAGES) {
        const before = snapshot(); pages.push({ strokes: [] }); renderPages(); commit(before);
        box.lastElementChild?.scrollIntoView({ behavior: 'smooth', block: 'start' }); return;
      }
      refreshBar();
    });

    const views = [];
    function renderPages() {
      box.replaceChildren(); views.length = 0;
      pages.forEach((page, index) => {
        const wrap = document.createElement('div'); wrap.className = 'ink-page';
        const head = document.createElement('div'); head.className = 'ink-page-head';
        head.innerHTML = `<span>Hoja ${index + 1}</span>`;
        const clear = Object.assign(document.createElement('button'), { type: 'button', textContent: page.strokes.length || pages.length === 1 ? 'Limpiar' : 'Quitar hoja' });
        clear.disabled = locked;
        clear.onclick = () => {
          const before = snapshot();
          if (!page.strokes.length && pages.length > 1) pages.splice(index, 1); else page.strokes = [];
          renderPages(); commit(before);
        };
        head.append(clear);
        const canvas = document.createElement('canvas'); canvas.setAttribute('aria-label', `Hoja ${index + 1} para escribir a mano`);
        wrap.append(head, canvas); box.append(wrap);
        let height = PAGE_H;
        if (compact) {
          let bottom = 0;
          for (const s of page.strokes) for (let i = 1; i < s.pts.length; i += 3) bottom = Math.max(bottom, s.pts[i]);
          height = Math.min(PAGE_H, Math.max(160, bottom + 60));
          canvas.style.aspectRatio = `${PAGE_W}/${height}`;
        }
        const view = { page, canvas, ctx: canvas.getContext('2d'), scale: 1, height };
        views.push(view); bindCanvas(view, index); paint(view);
      });
      refreshBar();
    }
    function paint(view) {
      const { canvas, ctx } = view, ratio = window.devicePixelRatio || 1, width = canvas.clientWidth || 600;
      canvas.width = Math.round(width * ratio); canvas.height = Math.round(width * (view.height || PAGE_H) / PAGE_W * ratio);
      view.scale = canvas.width / PAGE_W;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const s of view.page.strokes) drawStroke(ctx, s, view.scale);
    }
    const resize = new ResizeObserver(() => views.forEach(paint)); resize.observe(box);

    function bindCanvas(view, index) {
      const { canvas } = view; let current = null, before = null, pointer = null, erased = false;
      const point = e => {
        const r = canvas.getBoundingClientRect();
        const x = Math.round((e.clientX - r.left) / r.width * PAGE_W * Q) / Q, y = Math.round((e.clientY - r.top) / r.height * PAGE_H * Q) / Q;
        const p = e.pressure > 0 && e.pointerType === 'pen' ? Math.min(1, e.pressure) : 0.5;
        return [Math.max(0, Math.min(PAGE_W, x)), Math.max(0, Math.min(PAGE_H, y)), p];
      };
      // Palm and finger: with a pencil (or the finger option off) only pencil/mouse write; fingers scroll.
      const accepts = e => !locked && (e.pointerType === 'pen' || e.pointerType === 'mouse' || (e.pointerType === 'touch' && settings.finger && !penSeen));
      const eraseAt = ([x, y]) => {
        const keep = view.page.strokes.filter(s => !nearStroke(s, x, y));
        if (keep.length !== view.page.strokes.length) { view.page.strokes = keep; erased = true; paint(view); }
      };
      canvas.addEventListener('pointerdown', e => {
        if (e.pointerType === 'pen') penSeen = true;
        if (!accepts(e) || pointer !== null) return;
        if (e.button > 0 && e.pointerType === 'mouse') return;
        if (serialize().length > MAX_CHARS) { window.DstaToast?.show('Esta minuta alcanzó el máximo de escritura. Transcríbela o crea otra minuta.', false); return; }
        e.preventDefault(); try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or lost pointer */ } pointer = e.pointerId; before = snapshot(); erased = false;
        // Pencil eraser end or barrel button also erases.
        if (tool === 'eraser' || e.button === 5 || e.buttons === 32) { current = 'erase'; eraseAt(point(e)); return; }
        current = { c: settings.color, w: settings.width, pts: point(e) };
        drawStroke(view.ctx, current, view.scale);
      });
      canvas.addEventListener('pointermove', e => {
        if (e.pointerId !== pointer || !current) return;
        e.preventDefault();
        const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
        for (const ev of events.length ? events : [e]) {
          const pt = point(ev);
          if (current === 'erase') { eraseAt(pt); continue; }
          const n = current.pts.length;
          if (Math.hypot(pt[0] - current.pts[n - 3], pt[1] - current.pts[n - 2]) < 0.6) continue;
          pt[2] = current.pts[n - 1] * 0.6 + pt[2] * 0.4;  // the pencil's pressure is noisy: low-pass it
          current.pts.push(...pt);
          // Live: the curve piece ending at the previous sample is final once the next one exists.
          const k = current.pts.length / 3;
          if (k >= 3) drawStroke(view.ctx, { ...current, pts: current.pts.slice((k - 3) * 3) }, view.scale, 2, false);
        }
      });
      const end = e => {
        if (e.pointerId !== pointer) return;
        pointer = null;
        if (current === 'erase') { if (erased) commit(before); }
        else if (current) { view.page.strokes.push(current); paint(view); commit(before); }
        current = null;
      };
      canvas.addEventListener('pointerup', end); canvas.addEventListener('pointercancel', end);
      // iPadOS: a pencil touch must never scroll the page; a finger scrolls unless finger writing is on.
      canvas.addEventListener('touchstart', e => {
        if (locked) return;
        if ([...e.touches].some(t => t.touchType === 'stylus') || (settings.finger && !penSeen)) e.preventDefault();
      }, { passive: false });
      canvas.addEventListener('touchmove', e => { if (pointer !== null) e.preventDefault(); }, { passive: false });
    }

    renderPages();
    return {
      el,
      serialize,
      isEmpty: () => pages.every(p => !p.strokes.length),
      setReadOnly(value) { locked = Boolean(value); renderPages(); },
      setInk(text) { pages = decode(text); undo.length = redo.length = 0; cached = null; renderPages(); },
      destroy() { resize.disconnect(); el.remove(); },
    };
  }

  window.DstaInk = { create, decode, encode, PAGE_W, PAGE_H };
})();
