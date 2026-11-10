// Pop a panel or a chat card out into a large window when it is too small to read.
// The element itself is moved (not cloned), so it keeps updating and its buttons keep
// working; closing puts it back where it was.

const ZOOMS = [1, 1.15, 1.3, 1.5, 1.75, 2];
const ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 2.5h4v4M13.5 2.5 8.5 7.5M6.5 13.5h-4v-4M2.5 13.5l5-5"/></svg>';

export const popButton = (title = '弹出放大') => `<button type="button" class="pop" data-pop title="${title}">${ICON}</button>`;

export function initPopout({ onChange, titleFor } = {}) {
  const mask = document.createElement('div');
  mask.className = 'pop-mask';
  mask.hidden = true;
  mask.innerHTML = `<div class="pop-win" role="dialog" aria-modal="true">
    <div class="pop-bar"><b class="pop-title"></b>
      <div class="pop-zoom"><button type="button" data-zoom="-1" title="缩小字号">A−</button><span class="num"></span><button type="button" data-zoom="1" title="放大字号">A+</button></div>
      <button type="button" class="pop-x" title="关闭（Esc）">✕</button></div>
    <div class="pop-body"></div></div>`;
  document.body.append(mask);
  const body = mask.querySelector('.pop-body');
  const zoomLabel = mask.querySelector('.pop-zoom span');
  let current = null; // { el, placeholder, watch }
  let zi = 2;

  const applyZoom = () => {
    zoomLabel.textContent = `${Math.round(ZOOMS[zi] * 100)}%`;
    if (current) current.el.style.zoom = ZOOMS[zi];
  };

  const close = () => {
    if (!current) return;
    const { el, placeholder, watch } = current;
    watch.disconnect();
    el.style.zoom = '';
    el.classList.remove('popped');
    placeholder.replaceWith(el);
    current = null;
    mask.hidden = true;
    onChange?.(null);
  };

  const open = (el, title) => {
    if (current?.el === el) return;
    close();
    const placeholder = document.createComment('popout');
    el.before(placeholder);
    // A panel that its own code hides (e.g. the table drawer) closes the window too.
    const watch = new MutationObserver(() => { if (el.hidden) close(); });
    watch.observe(el, { attributes: true, attributeFilter: ['hidden'] });
    current = { el, placeholder, watch };
    el.classList.add('popped');
    mask.querySelector('.pop-title').textContent = title || '详情';
    body.append(el);
    mask.hidden = false;
    applyZoom();
    onChange?.(el);
  };

  const titleOf = (el) => {
    const custom = titleFor?.(el);
    if (custom) return custom;
    const head = el.querySelector(':scope > .ph > b, :scope > .ahead > b, :scope > h4');
    if (!head) return '详情';
    return [...head.childNodes].filter((n) => !(n.nodeType === 1 && n.matches('i, .r, .pop'))).map((n) => n.textContent).join('').trim() || '详情';
  };

  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pop]');
    if (!b) return;
    const el = b.closest('.card') ?? b.closest('.panel');
    if (el) open(el, titleOf(el));
  });
  mask.addEventListener('click', (e) => {
    if (e.target === mask || e.target.closest('.pop-x')) close();
    const z = e.target.closest('[data-zoom]');
    if (z) {
      zi = Math.min(ZOOMS.length - 1, Math.max(0, zi + Number(z.dataset.zoom)));
      applyZoom();
    }
  });
  addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && current) close();
  });

  // Every panel header gets the button, right before its fold button.
  for (const head of document.querySelectorAll('.panel > .ph, .panel > .ahead')) {
    if (head.querySelector('[data-pop]')) continue;
    const tmp = document.createElement('div');
    tmp.innerHTML = popButton();
    const min = head.querySelector('[data-min]');
    if (min) min.before(tmp.firstChild);
    else head.append(tmp.firstChild);
  }

  return { open, close, get current() { return current?.el ?? null; } };
}
