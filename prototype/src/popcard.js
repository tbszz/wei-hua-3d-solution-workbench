// Floating cards for the side panels.
//
// The rails only ever show panel headers. Clicking a header opens the panel's body in a
// floating card over the 3D view, so opening one never pushes the others around. The body is
// moved (not cloned), so it keeps updating and its listeners keep working; closing puts it back
// behind a comment placeholder, the same way popout.js does.
//
// Contract
//   - Any `.panel` in `aside.left` / `aside.right` with a `.ph` or `.ahead` header is a card.
//   - `[data-open-card="<id>"]` anywhere opens that card. The id is a panel id, the id of an
//     element inside a panel, or a name listed in a panel's `data-card-alias="a b c"`.
//   - A minimised card shows a strip: `registerStrip(panelId, () => html)`, else the panel's
//     `data-strip` text, else the header's figures (`.num`, `span`, `.scnsel`).
//   - Removing `min-on` from a rail panel (old code that "opened" a panel) opens its card.
//   - A new card is cascaded so its corner never lands on another open card's corner.
//   - `document` gets `popcard:change` events ({ id, state: 'open' | 'min' | 'closed' }) and
//     `[data-open-card]` elements get `.pc-on` while their card is open or minimised.

import './popcard.css';

const strips = new Map();
export const registerStrip = (panelId, fn) => { strips.set(panelId, fn); };

const MOBILE = '(max-width: 760px)';
const KEY = 'pc.geom.';
const GAP = 10;
const CASCADE = 28;
const MIN_W = 240;
const MIN_H = 120;
const POP_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5 8.5 7.5M6.5 13.5h-4v-4M2.5 13.5l5-5"/></svg>';

export const escHtml = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));
const loadGeom = (id) => {
  try {
    const g = JSON.parse(localStorage.getItem(KEY + id) ?? 'null');
    return g && Number.isFinite(g.x) && Number.isFinite(g.y) && Number.isFinite(g.w) ? g : null;
  } catch { return null; }
};
const saveGeom = (id, g) => {
  try { localStorage.setItem(KEY + id, JSON.stringify(g)); } catch { /* private mode / quota */ }
};

const headOf = (p) => p?.querySelector?.(':scope > .ph, :scope > .ahead') ?? null;
const inRail = (p) => !!p?.closest?.('aside.left, aside.right');
const isCardPanel = (p) => !!p?.matches?.('.panel') && p.id !== 'drawer' && !!headOf(p);
const isEditable = (t) => !!t?.closest?.('textarea, input, select, [contenteditable="true"]');

export function initPopcards(app = {}) {
  const layer = document.createElement('div');
  layer.className = 'pc-layer';
  const dock = document.createElement('div');
  dock.className = 'pc-dock';
  layer.append(dock);
  document.body.append(layer);

  const mq = matchMedia(MOBILE);
  const cards = new Map(); // panel -> state
  const byCard = new WeakMap(); // card element -> state
  const watched = new WeakSet();
  let z = 0;
  let seq = 0;

  const keyOf = (panel) => panel.id || (panel.dataset.pcId ||= `pc${++seq}`);
  const sideOf = (panel) => (panel.matches('.agent') ? 'agent' : panel.closest('aside.right') ? 'right' : 'left');

  // ------------------------------------------------------------ lookup

  // Panel for an id / element; `target` is the element to scroll to when it sits inside a panel.
  function resolve(ref) {
    if (ref instanceof Element) {
      if (isCardPanel(ref)) return { panel: ref };
      const s = byCard.get(ref.closest('.pc-card'));
      if (s) return { panel: s.panel, target: ref };
      const p = ref.closest('.panel');
      return isCardPanel(p) ? { panel: p, target: ref } : null;
    }
    if (!ref) return null;
    for (const s of cards.values()) if (keyOf(s.panel) === ref) return { panel: s.panel };
    const el = document.getElementById(ref);
    if (el) {
      const hit = resolve(el);
      if (hit) return hit;
    }
    for (const n of document.querySelectorAll('[data-card-alias]')) {
      if (n.dataset.cardAlias.split(/\s+/).includes(ref)) return resolve(n);
    }
    return null;
  }

  // ------------------------------------------------------------ title / summary

  function titleHtml(panel) {
    const head = headOf(panel);
    const b = head?.querySelector(':scope > b');
    const idx = b?.querySelector(':scope > i')?.textContent.trim();
    const name = b ? [...b.childNodes].filter((n) => !(n.nodeType === 1 && n.matches('i, .r, .pop, button'))).map((n) => n.textContent).join('').trim() : '';
    const av = head?.querySelector('.avatar');
    return `${idx ? `<i class="num">${escHtml(idx)}</i>` : ''}${av ? `<em class="pc-av">${escHtml(av.textContent.trim())}</em>` : ''}<span>${escHtml(name || '详情')}</span>`;
  }
  const titleText = (panel) => {
    const tmp = document.createElement('div');
    tmp.innerHTML = titleHtml(panel);
    return tmp.querySelector('span').textContent;
  };

  function summaryHtml(panel) {
    const fn = strips.get(keyOf(panel));
    if (fn) {
      try {
        const html = fn();
        if (html != null && html !== '') return String(html);
      } catch (e) { console.warn('popcard strip', e); }
    }
    if (panel.dataset.strip) return escHtml(panel.dataset.strip);
    const head = headOf(panel);
    if (!head) return '';
    return [...head.querySelectorAll(':scope > .num, :scope > span, :scope > .scnsel')]
      .map((n) => n.textContent.trim()).filter(Boolean).map(escHtml).join(' · ');
  }

  const setHtml = (el, html) => { if (el && el.__pc !== html) { el.__pc = html; el.innerHTML = html; } };
  function refresh(s) {
    const title = titleHtml(s.panel);
    const sum = summaryHtml(s.panel);
    setHtml(s.titleEl, title);
    setHtml(s.metaEl, sum);
    s.card.querySelector('[data-pc="pop"]').hidden = !app.popout;
    if (s.strip) {
      setHtml(s.strip.querySelector('.pc-st'), title);
      setHtml(s.strip.querySelector('.pc-sv'), sum);
    }
  }

  // ------------------------------------------------------------ geometry

  function defaultGeom(s) {
    const W = innerWidth;
    const H = innerHeight;
    const rail = s.panel.closest('aside.left, aside.right')?.getBoundingClientRect();
    const head = headOf(s.panel).getBoundingClientRect();
    const railOk = rail && rail.width > 0;
    const topBar = document.querySelector('header.top')?.getBoundingClientRect();
    const botBar = document.querySelector('section.bottom')?.getBoundingClientRect();
    const top = topBar?.height ? topBar.bottom + GAP : GAP;
    const bottom = botBar?.height ? botBar.top - GAP : H - GAP;
    const n = [...cards.values()].filter((o) => o !== s && o.side === s.side && !o.minimised).length;
    const off = (n % 6) * CASCADE;
    if (s.side === 'agent') {
      const w = 400;
      const h = Math.max(MIN_H, Math.min(600, bottom - top));
      return { x: (railOk ? rail.left - GAP : W - GAP) - w - off, y: bottom - h - off, w, h };
    }
    const y = (head.height ? head.top : top) + off;
    if (s.side === 'right') {
      const w = 380;
      return { x: (railOk ? rail.left - GAP : W - GAP) - w - off, y, w, h: null };
    }
    return { x: (railOk ? rail.right + GAP : GAP) + off, y, w: 360, h: null };
  }

  function fit(g) {
    const W = innerWidth;
    const H = innerHeight;
    g.w = clamp(g.w, Math.min(MIN_W, W), W);
    g.x = clamp(g.x, 0, W - g.w);
    g.y = clamp(g.y, 0, H - 80);
    if (g.h != null) g.h = clamp(g.h, Math.min(MIN_H, H - g.y), H - g.y);
    return g;
  }

  // On phones the stylesheet turns the card into a bottom sheet and ignores these.
  function apply(s) {
    const c = s.card;
    if (mq.matches) {
      for (const k of ['left', 'top', 'width', 'height', 'maxHeight', 'transform']) c.style[k] = '';
      return;
    }
    const g = fit(s.geom);
    c.style.left = `${g.x}px`;
    c.style.top = `${g.y}px`;
    c.style.width = `${g.w}px`;
    c.style.height = g.h != null ? `${g.h}px` : '';
    // Auto-height cards stop above the timeline bar when there is room for it.
    const bar = document.querySelector('section.bottom')?.getBoundingClientRect();
    const room = bar?.height ? bar.top - GAP - g.y : 0;
    c.style.maxHeight = `${g.h == null && room >= 200 ? room : innerHeight - g.y - 6}px`;
  }

  const persist = (s) => saveGeom(keyOf(s.panel), s.geom);

  // A card never opens squarely on top of another: step it along the cascade until its corner is
  // clear of every visible card's corner (a remembered position can collide just like a default).
  function avoid(s) {
    const others = [...cards.values()].filter((o) => o !== s && o.geom && !o.minimised);
    for (let i = 0; i < 12; i++) {
      if (!others.some((o) => Math.abs(o.geom.x - s.geom.x) < CASCADE && Math.abs(o.geom.y - s.geom.y) < CASCADE)) break;
      s.geom.x += CASCADE;
      s.geom.y += CASCADE;
    }
  }

  // ------------------------------------------------------------ build / open / close

  function build(panel) {
    const head = headOf(panel);
    const placeholder = document.createComment('popcard');
    head.after(placeholder);
    const nodes = [...panel.childNodes].filter((n) => n !== head && n !== placeholder);

    const card = document.createElement('section');
    card.className = 'pc-card';
    card.setAttribute('role', 'dialog');
    card.dataset.card = keyOf(panel);
    card.innerHTML = `<div class="pc-grip" title="下拉收起"></div>
      <header class="pc-bar"><b class="pc-title"></b><span class="pc-meta"></span>
        <button type="button" class="pc-btn" data-pc="pop" title="弹出放大">${POP_ICON}</button>
        <button type="button" class="pc-btn" data-pc="min" title="最小化"><s></s></button>
        <button type="button" class="pc-btn pc-x" data-pc="close" title="关闭（Esc）">✕</button></header>
      <div class="pc-body"></div><div class="pc-rs" title="拖动调整大小"></div>`;
    const body = card.querySelector('.pc-body');
    body.append(...nodes);

    const s = {
      panel, head, placeholder, card, body,
      side: sideOf(panel),
      titleEl: card.querySelector('.pc-title'),
      metaEl: card.querySelector('.pc-meta'),
      strip: null,
      minimised: false,
      geom: null,
    };
    card.dataset.side = s.side;
    if (s.side === 'agent') card.classList.add('pc-agent');
    cards.set(panel, s);
    byCard.set(card, s);
    layer.append(card);
    head.classList.add('open');
    panel.classList.add('pc-open');
    refresh(s);
    card.setAttribute('aria-label', titleText(panel));

    s.geom = loadGeom(keyOf(panel)) ?? defaultGeom(s);
    avoid(s);
    apply(s);
    bindCard(s);
    // Scroll-to-bottom lists (the chat) were measured while hidden.
    for (const m of body.querySelectorAll('.msgs')) m.scrollTop = m.scrollHeight;
    return s;
  }

  function open(ref) {
    const hit = resolve(ref);
    if (!hit) {
      app.toast?.('这个模块还没有准备好', true);
      return false;
    }
    const { panel, target } = hit;
    watch(panel);
    if (panel.classList.contains('popped')) return true; // already shown in the big window
    const s = cards.get(panel) ?? build(panel);
    if (s.minimised) restore(s);
    front(s);
    if (target && target !== panel && s.body.contains(target)) target.scrollIntoView?.({ block: 'nearest' });
    emit(s.panel, 'open');
    return true;
  }

  function close(ref) {
    const s = stateOf(ref);
    if (!s) return false;
    s.placeholder.replaceWith(...s.body.childNodes);
    s.card.remove();
    s.strip?.remove();
    s.head.classList.remove('open');
    s.panel.classList.remove('pc-open');
    cards.delete(s.panel);
    markTop();
    emit(s.panel, 'closed');
    return true;
  }

  function minimise(ref) {
    const s = stateOf(ref);
    if (!s || s.minimised) return !!s;
    s.minimised = true;
    s.card.hidden = true;
    s.card.style.transform = '';
    if (!s.strip) {
      const strip = document.createElement('div');
      strip.className = 'pc-strip';
      strip.setAttribute('role', 'button');
      strip.tabIndex = 0;
      strip.title = '点击展开';
      strip.innerHTML = '<b class="pc-st"></b><span class="pc-sv"></span><button type="button" class="pc-sx" title="关闭">✕</button>';
      strip.addEventListener('click', (e) => {
        if (e.target.closest('.pc-sx')) close(s);
        else open(s.panel);
      });
      strip.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          open(s.panel);
        }
      });
      s.strip = strip;
    }
    dock.append(s.strip);
    refresh(s);
    markTop();
    emit(s.panel, 'min');
    return true;
  }

  function restore(s) {
    s.minimised = false;
    s.strip?.remove();
    s.card.hidden = false;
    apply(s);
  }

  function stateOf(ref) {
    if (ref && typeof ref === 'object' && ref.card && ref.panel) return ref;
    const hit = resolve(ref);
    return hit ? cards.get(hit.panel) ?? null : null;
  }

  const visible = () => [...cards.values()].filter((s) => !s.minimised);
  const topCard = () => visible().sort((a, b) => Number(b.card.style.zIndex) - Number(a.card.style.zIndex))[0] ?? null;
  function markTop() {
    const t = topCard();
    for (const s of cards.values()) s.card.classList.toggle('pc-top', s === t);
  }
  function front(s) {
    if (Number(s.card.style.zIndex) !== z || !z) s.card.style.zIndex = ++z;
    markTop();
  }

  function emit(panel, state) {
    const id = keyOf(panel);
    for (const n of document.querySelectorAll('[data-open-card]')) {
      const hit = resolve(n.dataset.openCard);
      if (hit?.panel !== panel) continue;
      n.classList.toggle('pc-on', state !== 'closed');
      n.setAttribute('aria-expanded', String(state === 'open'));
    }
    document.dispatchEvent(new CustomEvent('popcard:change', { detail: { id, state } }));
  }

  // Big pop-out window (popout.js): hand it the whole panel, unfolded, and fold it on return.
  function popBig(panel) {
    const po = app.popout;
    if (!po) return;
    if (cards.has(panel)) close(panel);
    panel.dataset.pcPopped = '1';
    panel.classList.remove('min-on');
    po.open(panel, titleText(panel));
  }

  // ------------------------------------------------------------ card interaction

  function bindCard(s) {
    const { card } = s;
    const bar = card.querySelector('.pc-bar');
    card.addEventListener('pointerdown', () => front(s), true);
    card.querySelector('[data-pc="close"]').addEventListener('click', () => close(s));
    card.querySelector('[data-pc="min"]').addEventListener('click', () => minimise(s));
    card.querySelector('[data-pc="pop"]').addEventListener('click', () => popBig(s.panel));

    // Move the card by its title bar.
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('button') || mq.matches) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      const dx = e.clientX - r.left;
      const dy = e.clientY - r.top;
      drag(bar, e, 'pc-moving', (ev) => {
        s.geom.x = clamp(ev.clientX - dx, 0, innerWidth - r.width);
        s.geom.y = clamp(ev.clientY - dy, 0, innerHeight - Math.min(r.height, innerHeight));
        card.style.left = `${s.geom.x}px`;
        card.style.top = `${s.geom.y}px`;
      }, () => { apply(s); persist(s); });
    });

    // Resize from the bottom-right corner.
    const rs = card.querySelector('.pc-rs');
    rs.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || mq.matches) return;
      e.preventDefault();
      const r = card.getBoundingClientRect();
      card.style.maxHeight = '';
      drag(rs, e, 'pc-sizing', (ev) => {
        s.geom.w = clamp(r.width + ev.clientX - e.clientX, MIN_W, innerWidth - r.left);
        s.geom.h = clamp(r.height + ev.clientY - e.clientY, MIN_H, innerHeight - r.top);
        card.style.width = `${s.geom.w}px`;
        card.style.height = `${s.geom.h}px`;
      }, () => { apply(s); persist(s); });
    });

    // Bottom sheet (phones): pull the handle down to minimise.
    const grip = card.querySelector('.pc-grip');
    const sheetDrag = (e) => {
      if (!mq.matches || e.button !== 0 || e.target.closest('button')) return;
      e.preventDefault();
      let dy = 0;
      drag(e.currentTarget, e, 'pc-moving', (ev) => {
        dy = Math.max(0, ev.clientY - e.clientY);
        card.style.transform = `translateY(${dy}px)`;
      }, () => {
        card.style.transform = '';
        if (dy > 90) minimise(s);
      });
    };
    grip.addEventListener('pointerdown', sheetDrag);
    bar.addEventListener('pointerdown', sheetDrag);

    // Files dragged onto the card reach the panel's own drop handling (小华 uploads).
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
      card.addEventListener(type, (e) => {
        let ev;
        try {
          ev = new DragEvent(type, { bubbles: false, cancelable: true, dataTransfer: e.dataTransfer, clientX: e.clientX, clientY: e.clientY });
        } catch { return; }
        s.panel.dispatchEvent(ev);
        if (ev.defaultPrevented) e.preventDefault();
      });
    }
  }

  function drag(handle, e, cls, move, end) {
    try { handle.setPointerCapture(e.pointerId); } catch { /* synthetic event */ }
    flag(cls, true);
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      flag(cls, false);
      end();
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  }
  const flag = (cls, on) => layer.classList.toggle(cls, on);

  // ------------------------------------------------------------ rails

  // Rails stay folded. Old code that "opens" a panel by removing min-on opens its card instead;
  // a panel coming back from the big pop-out window folds again.
  function watch(panel) {
    if (watched.has(panel) || !inRail(panel) || !isCardPanel(panel)) return;
    watched.add(panel);
    panel.classList.add('min-on');
    new MutationObserver(() => {
      const cl = panel.classList;
      cards.get(panel)?.card.classList.toggle('pc-dropping', cl.contains('dropping'));
      if (cl.contains('min-on') || cl.contains('popped')) return;
      cl.add('min-on');
      if (panel.dataset.pcPopped) delete panel.dataset.pcPopped;
      else open(panel);
    }).observe(panel, { attributes: true, attributeFilter: ['class'] });
  }
  const scan = () => document.querySelectorAll('aside.left .panel, aside.right .panel').forEach(watch);
  scan();
  for (const rail of document.querySelectorAll('aside.left, aside.right')) new MutationObserver(scan).observe(rail, { childList: true });

  // The rail header's 弹出放大 button pops the whole panel; it must not reach popout.js on its
  // own, since the body may be sitting in a floating card.
  document.addEventListener('click', (e) => {
    const b = e.target.closest?.('[data-pop]');
    const head = b?.closest('.panel > .ph, .panel > .ahead');
    const panel = head?.parentElement;
    if (!panel || !inRail(panel) || panel.classList.contains('popped')) return;
    e.preventDefault();
    e.stopPropagation();
    popBig(panel);
  }, true);

  // Header click opens (or focuses) the card; the fold button closes an open one. Other header
  // controls (the scene picker) do their own job.
  document.addEventListener('click', (e) => {
    const head = e.target.closest?.('.panel > .ph, .panel > .ahead');
    const panel = head?.parentElement;
    if (!panel || !inRail(panel) || panel.classList.contains('popped')) return;
    const control = e.target.closest('button, input, label, a, select, textarea');
    if (control && !control.matches('[data-min]')) return;
    const s = cards.get(panel);
    if (control && s && !s.minimised) close(s);
    else open(panel);
  });

  // Module navigation anywhere on the page.
  document.addEventListener('click', (e) => {
    const n = e.target.closest?.('[data-open-card]');
    if (!n) return;
    e.preventDefault();
    open(n.dataset.openCard);
  });

  // Esc closes the top card, unless something smaller (menu, editor, help, pop-out) owns it.
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || e.defaultPrevented || app.popout?.current || isEditable(e.target)) return;
    if (document.body.classList.contains('clean')) return;
    if (document.querySelector('.ctx, .zedit, .keyhelp:not([hidden]), .cmdline:not([hidden])')) return;
    const s = topCard();
    if (!s) return;
    e.stopPropagation();
    close(s);
  }, true);

  addEventListener('resize', () => { for (const s of cards.values()) if (!s.minimised) apply(s); });
  const onMedia = () => {
    layer.classList.toggle('pc-mobile', mq.matches);
    for (const s of cards.values()) apply(s);
  };
  mq.addEventListener?.('change', onMedia);
  onMedia();

  // Live titles and key figures.
  setInterval(() => { for (const s of cards.values()) refresh(s); }, 500);

  const api = {
    open,
    close,
    minimise,
    closeAll: () => { for (const s of [...cards.values()]) close(s); },
    registerStrip,
    isOpen: (id) => !!stateOf(id),
    list: () => [...cards.values()].map((s) => ({ id: keyOf(s.panel), minimised: s.minimised })),
  };
  app.cards = api;
  return api;
}
