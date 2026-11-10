// Phone layout.
//
// On a phone the prototype is a viewer: the 3D site you can turn and pinch, the 项目案例库, the
// 工序流程 animation, and the 可视化大屏. Everything else (left/right rails, 小华, tables, step
// nav, KPIs) is hidden by mobile.css while <html> carries `.m-phone`.
//
//   - A bottom dock (inside section.bottom, so main.js still measures the free 3D area between the
//     title bar and the dock) opens 项目案例库 / 工序流程 as bottom sheets via app.cards, and has a
//     [data-open-dashboard] button that the dashboard module picks up with its document listener.
//   - The 工序流程 sheet gets a transport row (play/pause · 全流程 · 下一步). Tapping a step plays it
//     and minimises the sheet to its strip (current step · total), so the animation is in view.
//   - Only the two phone cards may be open; any other card (小华, 设备卡 …) that something opens on a
//     phone is closed again.
//   - Rotating the phone or crossing the breakpoint re-measures the canvas and re-frames the view.

import './mobile.css';

export const PHONE_QUERY = '(max-width: 760px), (max-height: 500px) and (max-width: 1000px)';
const LANDSCAPE_QUERY = '(max-height: 500px) and (orientation: landscape)';
const PHONE_CARDS = new Set(['secCases', 'secProcess']);

const ICONS = {
  cases: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7.5V18a1.5 1.5 0 0 0 1.5 1.5h15A1.5 1.5 0 0 0 21 18V9a1.5 1.5 0 0 0-1.5-1.5h-7.2L10.5 5H4.5A1.5 1.5 0 0 0 3 6.5z"/><path d="M3 10.5h18"/></svg>',
  process: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="5" cy="6" r="2"/><circle cx="5" cy="18" r="2"/><path d="M10 6h10M10 12h10M10 18h10"/><path d="M5 8v8"/><circle cx="5" cy="12" r="1.2" fill="currentColor"/></svg>',
  dash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="13" rx="1.5"/><path d="M8 21h8M12 17v4"/><path d="M7 13l3-3 2.5 2.5L17 8"/></svg>',
};

export function initMobile(app, { relayout } = {}) {
  const root = document.documentElement;
  const phone = matchMedia(PHONE_QUERY);
  const land = matchMedia(LANDSCAPE_QUERY);
  const $ = (id) => document.getElementById(id);
  const isPhone = () => phone.matches;

  // ------------------------------------------------------------ dock
  const dock = document.createElement('nav');
  dock.className = 'm-dock';
  dock.setAttribute('aria-label', '手机导航');
  dock.innerHTML = `
    <button type="button" data-m-card="secCases">${ICONS.cases}<span>项目案例库</span></button>
    <button type="button" data-m-card="secProcess">${ICONS.process}<span>工序流程</span></button>
    <button type="button" class="m-dash" data-open-dashboard>${ICONS.dash}<span>可视化大屏</span></button>`;
  document.querySelector('section.bottom')?.append(dock);

  const stateOf = (id) => app.cards?.list().find((c) => c.id === id) ?? null;

  // Tap: open the sheet (closing the other one), tap again: close it.
  dock.addEventListener('click', (e) => {
    const b = e.target.closest('[data-m-card]');
    if (!b || !app.cards) return;
    const id = b.dataset.mCard;
    const s = stateOf(id);
    if (s && !s.minimised) {
      app.cards.close(id);
      return;
    }
    for (const other of PHONE_CARDS) if (other !== id && stateOf(other) && !stateOf(other).minimised) app.cards.close(other);
    app.cards.open(id);
  });

  const markDock = () => {
    for (const b of dock.querySelectorAll('[data-m-card]')) {
      const s = stateOf(b.dataset.mCard);
      b.classList.toggle('on', !!s && !s.minimised);
    }
  };

  // ------------------------------------------------------------ play / pause in the title bar
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'm-play';
  play.title = '播放 / 暂停';
  play.addEventListener('click', () => $('playBtn')?.click());
  document.querySelector('header.top')?.append(play);

  // ------------------------------------------------------------ process sheet transport
  const procBody = document.querySelector('#secProcess .secbody');
  const ctl = document.createElement('div');
  ctl.className = 'm-proc';
  ctl.innerHTML = `<button type="button" class="m-pp">▶ 播放</button>
    <button type="button" data-m-play="all">全流程</button>
    <button type="button" data-m-play="next">下一步 ▸</button>
    <span class="m-hint">点工序单独播放</span>`;
  procBody?.prepend(ctl);
  ctl.querySelector('.m-pp').addEventListener('click', () => $('playBtn')?.click());
  ctl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-m-play]');
    if (b) app.play?.({ mode: b.dataset.mPlay });
  });

  // A tapped step plays; on a phone fold the sheet to its strip so the animation is visible.
  $('procList')?.addEventListener('click', (e) => {
    if (!isPhone() || !e.target.closest('[data-play]')) return;
    setTimeout(() => app.cards?.minimise('secProcess'), 0);
  });

  // Mirror the transport state (main.js keeps #playBtn's label current every frame).
  const syncPlay = () => {
    const src = $('playBtn');
    if (!src) return;
    const paused = src.classList.contains('paused');
    const label = src.textContent.trim();
    const pp = ctl.querySelector('.m-pp');
    if (pp.textContent !== label) pp.textContent = label;
    pp.classList.toggle('paused', paused);
    const icon = paused ? '▶' : '❚❚';
    if (play.textContent !== icon) play.textContent = icon;
    play.classList.toggle('paused', paused);
    play.title = label;
  };
  setInterval(() => { if (isPhone()) syncPlay(); }, 300);

  // ------------------------------------------------------------ only the phone cards
  const closeOthers = () => {
    if (!isPhone() || !app.cards) return;
    for (const c of app.cards.list()) if (!PHONE_CARDS.has(c.id)) app.cards.close(c.id);
  };
  document.addEventListener('popcard:change', (e) => {
    if (isPhone() && e.detail.state !== 'closed' && !PHONE_CARDS.has(e.detail.id)) {
      setTimeout(() => app.cards?.close(e.detail.id), 0);
    }
    markDock();
  });

  // ------------------------------------------------------------ mode switch / rotation
  let framed = null;
  const apply = (initial) => {
    const on = isPhone();
    root.classList.toggle('m-phone', on);
    root.classList.toggle('m-land', on && land.matches);
    if (on) {
      closeOthers();
      syncPlay();
      if (document.body.classList.contains('clean')) document.body.classList.remove('clean');
    }
    markDock();
    // Bars changed size: re-measure the canvas and re-frame once layout has settled.
    // (At start-up boot() frames the view itself once the site has loaded.)
    if (initial === true) return;
    cancelAnimationFrame(framed);
    framed = requestAnimationFrame(() => {
      try { relayout?.(); } catch (err) { console.warn('mobile relayout', err); } // site may still be loading
    });
  };
  phone.addEventListener?.('change', () => apply());
  land.addEventListener?.('change', () => apply());
  // Some phones report the new size only after the rotation animation.
  addEventListener('orientationchange', () => setTimeout(apply, 250));
  apply(true);

  app.mobile = { isPhone, query: PHONE_QUERY };
  return app.mobile;
}
