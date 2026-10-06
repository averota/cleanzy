// assets/js/ui.js
// Small helpers shared by page scripts. Needs Bootstrap's JS bundle (for toasts). Load before the page's own script, then:
//   const { $, esc, toast, badge, fetchAll, modal, TZ, fmt, signed, todayStr, dayLabel, shiftDay } = UI;
//
// MODALS (Bootstrap modal that already exists in the page HTML):
//   const m = UI.modal('myModalId');
//   m.show();  m.hide();
//   m.onHide(fn);   // runs as soon as the modal starts closing (X button, Esc or m.hide())
//   On show, the first visible text-like input is focused automatically.
//
// FORMATTING / DATES (shop time zone is Asia/Phnom_Penh):
//   fmt(n)            -> '12,000 ៛'
//   signed(n)         -> '+500 ៛' / '−500 ៛' / '0 ៛'
//   todayStr()        -> today's Phnom Penh date, 'YYYY-MM-DD'
//   dayLabel('2026-10-05') -> '05 Oct 2026'
//   shiftDay('2026-10-05', -1) -> '2026-10-04'
//
// BADGES: badge('Pending') -> Bootstrap badge, colour chosen from the text
//   (Pending, Confirmed, Voided, Active, Inactive, No price). badge('Voided', reason) adds a tooltip.
//
// ALERTS are Bootstrap toasts (top-right, no layout shift; nothing else needed):
//   toast('Saved.', 'ok');                              // auto-closes after ~3 s
//   toast('Could not load.', 'error');                  // auto-closes after ~6 s
//   toast('Please read this.', 'warn', { sticky: true });   // stays until the user clicks OK or ×
//   kinds: 'ok' | 'error' | 'warn'.  Use sticky for anything the user must read.
// Old API still works: flash(el, text, kind, opts) shows a toast (the .alert element stays hidden),
// clearFlash(el) closes it.
const UI = (() => {
  const $ = (id) => document.getElementById(id);

  // Escape text before putting it into innerHTML.
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---------------------------------------------------------------
  // Money and dates
  // ---------------------------------------------------------------
  const TZ = 'Asia/Phnom_Penh';
  const fmt = (n) => `${Number(n || 0).toLocaleString('en-US')} ៛`;
  const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('en-US')} ៛`;
  const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ }); // YYYY-MM-DD
  const dayLabel = (d) => new Date(`${d}T00:00:00`).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  const shiftDay = (d, delta) => {
    const [y, m, day] = d.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, day + delta)).toISOString().slice(0, 10);
  };

  // Status text -> Bootstrap colour
  const BADGE_COLOR = { Pending: 'warning', Confirmed: 'success', Voided: 'secondary', Active: 'success', Inactive: 'secondary', 'No price': 'warning' };
  const badge = (text, title = '') =>
    `<span class="badge text-bg-${BADGE_COLOR[text] || 'secondary'}"${title ? ` title="${esc(title)}"` : ''}>${esc(text)}</span>`;

  // ---------------------------------------------------------------
  // Toasts
  // ---------------------------------------------------------------
  const AUTO_MS = { ok: 3000, error: 6000, warn: 6000 };
  const TOAST_COLOR = { ok: 'success', error: 'danger', warn: 'warning' };

  let stack = null;
  function ensureStack() {
    if (stack?.isConnected) return stack;
    stack = document.createElement('div');
    stack.className = 'toast-container position-fixed top-0 end-0 p-3';
    stack.style.zIndex = '2000';
    document.body.appendChild(stack);
    return stack;
  }

  // Shows a Bootstrap toast. Returns { dismiss }. Never throws: if the toast cannot be drawn
  // (e.g. Bootstrap failed to load), it falls back to the browser's alert() so a message is never lost silently.
  function toast(text, kind = 'error', opts = {}) {
    try {
      const sticky = opts.sticky === true;
      const color = TOAST_COLOR[kind] || 'danger';
      const root = ensureStack();

      // Same message already showing: replace it instead of stacking duplicates.
      [...root.children].forEach((t) => {
        if (t.dataset.text === text && t.dataset.kind === kind) { bootstrap.Toast.getInstance(t)?.dispose(); t.remove(); }
      });

      const el = document.createElement('div');
      el.className = `toast align-items-center border-0 text-bg-${color}`;
      el.setAttribute('role', kind === 'ok' ? 'status' : 'alert');
      el.setAttribute('aria-live', kind === 'ok' ? 'polite' : 'assertive');
      el.setAttribute('aria-atomic', 'true');
      el.dataset.text = text;
      el.dataset.kind = kind;
      el.innerHTML = '<div class="d-flex"><div class="toast-body text-break" style="white-space:pre-line"></div>'
        + (sticky ? '<button type="button" class="btn btn-sm btn-link text-reset fw-semibold align-self-center" data-bs-dismiss="toast">OK</button>' : '')
        + `<button type="button" class="btn-close${color === 'warning' ? '' : ' btn-close-white'} me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button></div>`;
      el.querySelector('.toast-body').textContent = text;

      // Bootstrap pauses the auto-close timer while the pointer or focus is on the toast.
      const t = new bootstrap.Toast(el, { autohide: !sticky, delay: opts.ms ?? AUTO_MS[kind] ?? AUTO_MS.error });
      el.addEventListener('hidden.bs.toast', () => { t.dispose(); el.remove(); });
      root.appendChild(el);
      t.show();
      return { dismiss: () => t.hide() };
    } catch (err) {
      console.error('toast failed:', err);
      try { window.alert(text); } catch (_) { /* nothing more to try */ }
      return { dismiss() {} };
    }
  }

  // ---- Backward-compatible wrappers for pages that still pass an .alert element ----
  const shown = new WeakMap();
  function flash(el, text, kind = 'error', opts) {
    if (el) el.classList.add('hidden');   // the in-page alert box never shows (no layout shift)
    const t = toast(text, kind, opts);
    if (el) shown.set(el, t);
    return t;
  }
  function clearFlash(el) {
    if (!el) return;
    shown.get(el)?.dismiss();
    shown.delete(el);
    el.classList.add('hidden');
  }

  // Reads every row in chunks of 1000 (the server's per-request limit).
  // build: () => a fresh, ordered query (e.g. () => sb.from('x').select('*').order('id'))
  async function fetchAll(build) {
    const out = [];
    for (let from = 0; ; from += 1000) {
      const { data, error } = await build().range(from, from + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) break;
    }
    return out;
  }

  // ---------------------------------------------------------------
  // Modals
  // ---------------------------------------------------------------
  const FOCUS_SEL = 'input:not([type=hidden],[type=radio],[type=checkbox],[type=date],[type=time],[type=datetime-local],[type=file]), select';
  function modal(id) {
    const el = $(id);
    const m = bootstrap.Modal.getOrCreateInstance(el);
    if (!el.dataset.uiModal) {   // register the autofocus once per modal
      el.dataset.uiModal = '1';
      el.addEventListener('shown.bs.modal', () => {
        [...el.querySelectorAll(FOCUS_SEL)].find((x) => !x.disabled && x.offsetParent !== null)?.focus();
      });
    }
    return { show: () => m.show(), hide: () => m.hide(), onHide: (fn) => el.addEventListener('hide.bs.modal', fn) };
  }

  return { $, esc, toast, badge, flash, clearFlash, fetchAll, modal, TZ, fmt, signed, todayStr, dayLabel, shiftDay };
})();
