// assets/js/sale-form.js
// Reusable sale form (modal): create a sale, edit a saved sale (Super Admin) or view any sale read-only.
// The page only needs this script + sale-form.css; the modal markup is injected by this file.
//
// USE ON ANY PAGE (after sidebar.js and ui.js, before the page script; the page's own tags must also
// load Bootstrap JS, supabase-js, config.js, supabaseClient.js, auth.js and styles.css):
//   <link rel="stylesheet" href="../assets/css/sale-form.css?v=1">
//   <script src="../assets/js/sale-form.js?v=1"></script>
//   // inside the page's init(detail) (detail = the `app:ready` event detail):
//   SaleForm.init(detail, { onSaved: ({ mode, date }) => reloadMyList(), onChanged: () => reloadMyList() });   // both optional
//     onSaved   = a sale was created / edited.   onChanged = a sale was confirmed / voided.
//   SaleForm.openNew();       // blank "New sale" form (needs permission enter_revenue)
//   SaleForm.open(saleId);    // Super Admin: edit (Pending / Confirmed). Everyone else, or a Voided sale: view only.
//   SaleForm.open(saleId, { view: true });   // always read-only, even for Super Admin (e.g. clicking a table row)
//                                            // the read-only view carries the Confirm / Void / Edit buttons the user is allowed to use
//   SaleForm.confirmSale({ id, receipt_no, status });   // confirm one sale (asks first). null = cancelled, true = done, false = failed
//
// Reads: product tables, current_prices, current_exchange_rate, sales (+ sale_items).
// Writes only through the database functions create_sale / update_sale.
// Products and prices are loaded the first time the form is opened.
(() => {
  const CHIP_MAX = 4;   // a product with this many choices or fewer shows them all as buttons

  const { $, esc, toast, fmt, signed, todayStr, TZ } = UI;
  const nowTime = () => new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' }); // HH:MM
  const hhmm = (t) => (t || '').slice(0, 5);   // 'HH:MM:SS' -> 'HH:MM'
  const checked = (name) => $('saleForm').querySelector(`input[name="${name}"]:checked`)?.value ?? '';

  let me;                      // app:ready detail
  let can = () => false;
  let opts = {};               // { onSaved }
  let editing = null;          // { id, receipt_no, status } while a saved sale is being edited, else null
  let viewing = false;         // true while a saved sale is shown read-only
  let current = null;          // the saved sale shown in the form (view / edit), else null
  const isSuper = () => me?.role === 'Super Admin';
  const modal = () => UI.modal('saleModal');

  const TEXT = { title: 'New sale', save: 'Save sale', clear: 'Clear', note: 'Total is an estimate; the final amount is calculated when saved.' };

  const MARKUP = `
<div class="modal fade" id="saleModal" tabindex="-1" aria-labelledby="saleTitle" aria-hidden="true" data-bs-backdrop="static">
    <div class="modal-dialog modal-dialog-centered modal-dialog-scrollable modal-fullscreen-sm-down">
      <div class="modal-content">
      <div class="modal-header">
        <h2 class="modal-title h6" id="saleTitle">New sale</h2>
        <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
      </div>
      <form id="saleForm" class="sale-form" novalidate>
              <fieldset id="formFields" class="sale-fields" disabled>
                <div class="modal-body sale-scroll">
                  <div class="sale-meta">
                    <div>
                      <label class="form-label" for="saleDate">Date <span aria-hidden="true">*</span></label>
                      <input class="form-control form-control-sm" type="date" id="saleDate" required>
                    </div>
                    <div>
                      <label class="form-label" for="saleTime">Time <span aria-hidden="true">*</span></label>
                      <input class="form-control form-control-sm" type="time" id="saleTime" required>
                    </div>
                    <div>
                      <label class="form-label" for="salePlate">Plate no.</label>
                      <input class="form-control form-control-sm" id="salePlate" placeholder="Optional" autocomplete="off">
                    </div>
                    <div>
                      <label class="form-label" for="saleCustomer">Customer</label>
                      <input class="form-control form-control-sm" id="saleCustomer" placeholder="Optional" autocomplete="off">
                    </div>
                  </div>
                  <h3 class="sale-sec-title">Items</h3>
                  <div id="saleProducts"></div>
                  <div class="sale-extras" id="optBar" role="group" aria-label="Optional details">
                    <span class="sale-sec-title">Optional</span>
                    <button type="button" class="opt-toggle btn btn-sm btn-outline-secondary rounded-pill" data-opt="optDiscount" data-label="Receipt discount" aria-pressed="false">+ Discount</button>
                    <button type="button" class="opt-toggle btn btn-sm btn-outline-secondary rounded-pill" data-opt="optAdjust" data-label="Adjustment" aria-pressed="false">+ Adjustment</button>
                    <button type="button" class="opt-toggle btn btn-sm btn-outline-secondary rounded-pill" data-opt="optRemark" data-label="Remark" aria-pressed="false">+ Remark</button>
                  </div>
                  <div class="opt-panel hidden" id="optDiscount">
                    <p class="opt-title">Receipt discount (whole receipt)</p>
                    <div class="opt-row">
                      <div class="btn-group btn-group-sm" role="group" aria-label="Discount type"><input type="radio" class="btn-check" name="discType" id="disc0" value="Percent" checked><label class="btn btn-outline-primary" for="disc0">%</label><input type="radio" class="btn-check" name="discType" id="disc1" value="Amount"><label class="btn btn-outline-primary" for="disc1">៛</label></div>
                      <input class="form-control form-control-sm opt-value" type="number" id="discValue" min="0" step="any" placeholder="Value" aria-label="Discount value">
                      <input class="form-control form-control-sm opt-text" id="discReason" placeholder="Reason (optional)" aria-label="Discount reason" autocomplete="off">
                    </div>
                  </div>
                  <div class="opt-panel hidden" id="optAdjust">
                    <p class="opt-title">Adjustment (+ extra / − short)</p>
                    <div class="opt-row">
                      <input class="form-control form-control-sm opt-value" type="number" id="adjAmount" step="100" value="0" aria-label="Adjustment in riel">
                      <input class="form-control form-control-sm opt-text" id="adjReason" placeholder="Reason" aria-label="Adjustment reason" autocomplete="off">
                    </div>
                  </div>
                  <div class="opt-panel hidden" id="optRemark">
                    <p class="opt-title">Remark</p>
                    <input class="form-control form-control-sm" id="saleRemark" aria-label="Remark" autocomplete="off">
                  </div>
                </div>
                <div class="sale-foot">
                  <div class="sale-total" aria-live="polite">
                    <span class="small" id="totBreak"></span>
                    <strong id="totTotal">0 ៛</strong>
                  </div>
                  <div class="sale-actions">
                    <div class="btn-group btn-group-sm" role="group" aria-label="Payment"><input type="radio" class="btn-check" name="payment" id="pay0" value="Cash" checked><label class="btn btn-outline-primary" for="pay0">Cash</label><input type="radio" class="btn-check" name="payment" id="pay1" value="Bank"><label class="btn btn-outline-primary" for="pay1">Bank</label></div>
                    <button type="button" class="btn btn-outline-secondary btn-sm" id="saleClearBtn">Clear</button>
                    <button type="submit" class="btn btn-primary btn-sm" id="saleSaveBtn">Save sale</button>
                  </div>
                  <p class="sale-note small" id="saleNote">Total is an estimate; the final amount is calculated when saved.</p>
                </div>
              </fieldset>
              <div class="sale-actions px-3 pb-3 bg-white hidden" id="saleViewActions" style="border-radius:0 0 var(--bs-modal-inner-border-radius) var(--bs-modal-inner-border-radius)">
                <button type="button" class="btn btn-primary btn-sm hidden" id="saleActConfirm" data-act="confirm">Confirm</button>
                <button type="button" class="btn btn-outline-danger btn-sm hidden" id="saleActVoid" data-act="void">Void</button>
                <button type="button" class="btn btn-outline-secondary btn-sm hidden" id="saleActEdit" data-act="edit">Edit</button>
              </div>
            </form>
      </div>
    </div>
  </div>
`;

  // ===================================================================
  // Products + prices
  // ===================================================================
  let prices = {};    // 'size:3' | 'addon:<id>' | 'helmet:<id>' | 'food:<id>' -> { amount, currency }
  let rate = null;    // KHR per 1 USD
  let products = [];  // [{ key, title, placeholder, single, optional, opts: [{ value, label, unit, group? }] }]
  let unitByValue = {};

  // Same rounding as the database: unit price rounded DOWN to 100 riel.
  function unitKhr(priceKey) {
    const p = prices[priceKey];
    if (!p) return null;
    if (p.currency === 'USD') return rate ? Math.floor((p.amount * rate) / 100) * 100 : null;
    return Math.floor(p.amount / 100) * 100;
  }

  // Same rule as calc_discount_khr(); null = invalid.
  function calcDiscount(base, type, v) {
    if (!(v >= 0)) return null;
    if (type === 'Percent' && v > 100) return null;
    const raw = type === 'Percent' ? (base * v) / 100 : v;
    if (raw > base) return null;
    return base - Math.floor((base - raw) / 100) * 100;
  }

  async function loadProducts() {
    const active = (q) => q.eq('is_active', true);
    const [sizes, addons, helmets, cats, foods, pr, rt] = await Promise.all([
      active(sb.from('motorbike_sizes').select('id, code').order('sort_order')),
      active(sb.from('addon_services').select('id, description').order('description')),
      active(sb.from('helmet_services').select('id, description').order('description')),
      active(sb.from('food_drink_categories').select('id, kind, name').order('sort_order')),
      active(sb.from('food_drink_items').select('id, category_id, description').order('description')),
      sb.from('current_prices').select('motorbike_size_id, addon_service_id, helmet_service_id, food_drink_item_id, amount, currency'),
      sb.from('current_exchange_rate').select('usd_to_khr').maybeSingle()
    ]);
    const failed = [sizes, addons, helmets, cats, foods, pr].find((r) => r.error);
    if (failed) throw new Error(failed.error.message);

    prices = {};
    pr.data.forEach((p) => {
      const key = p.motorbike_size_id != null ? `size:${p.motorbike_size_id}`
        : p.addon_service_id ? `addon:${p.addon_service_id}`
        : p.helmet_service_id ? `helmet:${p.helmet_service_id}`
        : `food:${p.food_drink_item_id}`;
      prices[key] = { amount: Number(p.amount), currency: p.currency };
    });
    rate = rt.data ? Number(rt.data.usd_to_khr) : null;

    const opt = (kind, id, label, group) => ({ value: `${kind}:${id}`, label, unit: unitKhr(`${kind}:${id}`), group });
    const catName = Object.fromEntries(cats.data.map((c) => [c.id, `${c.kind} – ${c.name}`]));
    const foodOrder = cats.data.flatMap((c) => foods.data.filter((f) => f.category_id === c.id));

    // `optional` products start switched off; their on/off switch adds them to the receipt.
    products = [
      { key: 'size',   title: 'Motorbike',      placeholder: 'Select size…',
        opts: sizes.data.map((s) => opt('size', s.id, s.code)) },
      { key: 'addon',  title: 'Add-on',         placeholder: 'Select service…', optional: true,
        opts: addons.data.map((a) => opt('addon', a.id, a.description)) },
      { key: 'helmet', title: 'Helmet',         placeholder: 'Select service…', optional: true,
        opts: helmets.data.map((h) => opt('helmet', h.id, h.description)) },
      { key: 'food',   title: 'Food & Drink',   placeholder: 'Select item…',    optional: true,
        opts: foodOrder.map((f) => opt('food', f.id, f.description, catName[f.category_id])) }
    ];
    unitByValue = {};
    products.forEach((p) => p.opts.forEach((o) => { unitByValue[o.value] = o.unit; }));
  }

  // ===================================================================
  // Product blocks, rows, totals
  // ===================================================================
  const usesChips = (p) => p.opts.length <= CHIP_MAX && !p.opts.some((o) => o.group);

  function selectHtml(p) {
    const optHtml = (o) =>
      `<option value="${o.value}"${o.unit == null ? ' disabled' : ''}>${esc(o.label)} — ${o.unit == null ? 'no price' : fmt(o.unit)}</option>`;
    let html = `<option value="">${esc(p.placeholder)}</option>`;
    const groups = [...new Set(p.opts.map((o) => o.group || ''))];
    groups.forEach((g) => {
      const list = p.opts.filter((o) => (o.group || '') === g).map(optHtml).join('');
      html += g ? `<optgroup label="${esc(g)}">${list}</optgroup>` : list;
    });
    return html;
  }

  function lineHtml(p) {
    const picker = usesChips(p)
      ? `<div class="chips" role="group" aria-label="${esc(p.title)}">${p.opts.map((o) =>
          `<button type="button" class="chip btn btn-sm btn-outline-primary" data-value="${o.value}" aria-pressed="false"${o.unit == null ? ' disabled' : ''}`
          + ` title="${o.unit == null ? 'No price set' : fmt(o.unit)}">${esc(o.label)}</button>`).join('')}</div>`
      : `<select class="form-select form-select-sm pl-select" aria-label="${esc(p.title)}">${selectHtml(p)}</select>`;
    return `<div class="pline" data-product="${p.key}" data-value="">
      ${picker}
      <div class="pl-ctl">
        <input class="form-control form-control-sm pl-qty" type="number" min="1" step="1" value="1" aria-label="Quantity" title="Quantity">
        <span class="pl-price"></span>
        <button type="button" class="btn btn-sm pl-remove" aria-label="Remove" title="Remove">✕</button>
      </div>
    </div>`;
  }

  // One bordered block per product. Optional blocks (Add-on, Helmet, Food & Drink) stay hidden
  // until their toggle button is switched on.
  function blockHtml(p) {
    const disc = p.opts.length
      ? `<button type="button" class="tool-btn" data-disc="${p.key}" aria-pressed="false">+ Discount</button>`
      : '';
    const add = p.opts.length
      ? `<button type="button" class="add-line" data-add="${p.key}">+ Add another</button>`
      : '';
    const hint = p.key === 'size' ? '<p class="product-hint small hidden">Plate number entered: one motorbike only.</p>' : '';
    const discPanel = p.opts.length
      ? `<div class="cat-disc hidden">
           <div class="btn-group btn-group-sm" role="group" aria-label="Discount type">
             <input type="radio" class="btn-check" name="cdType_${p.key}" id="cdP_${p.key}" value="Percent" checked><label class="btn btn-outline-primary" for="cdP_${p.key}">%</label>
             <input type="radio" class="btn-check" name="cdType_${p.key}" id="cdA_${p.key}" value="Amount"><label class="btn btn-outline-primary" for="cdA_${p.key}">៛</label>
           </div>
           <input class="form-control form-control-sm cd-value" type="number" min="0" step="any" inputmode="decimal" placeholder="Value" aria-label="${esc(p.title)} discount value">
           <input class="form-control form-control-sm cd-reason" type="text" maxlength="200" placeholder="Reason (optional)" aria-label="${esc(p.title)} discount reason">
         </div>`
      : '';
    return `<section class="product${p.optional ? ' is-optional hidden' : ''}" data-product="${p.key}">
      <div class="product-head">
        <h3 class="product-title">${esc(p.title)}</h3>
        <div class="product-tools">${disc}</div>
      </div>
      ${hint}
      <div class="rows">${p.opts.length ? lineHtml(p) : '<p class="small mb-0">Nothing set up yet.</p>'}</div>
      ${add}
      ${discPanel}
    </section>`;
  }

  function buildProducts() {
    const optional = products.filter((p) => p.optional);
    const bar = optional.length
      ? `<div class="cat-toggles" role="group" aria-label="Add more items">${optional.map((p) =>
          `<button type="button" class="cat-toggle btn btn-sm btn-outline-primary" data-toggle="${p.key}" aria-pressed="false"`
          + `${p.opts.length ? '' : ' disabled title="Nothing set up yet"'}>${esc(p.title)}</button>`).join('')}</div>`
      : '';
    $('saleProducts').innerHTML = products.filter((p) => !p.optional).map(blockHtml).join('')
      + bar
      + optional.map(blockHtml).join('');
  }

  const valueOf = (row) => row.querySelector('select')?.value ?? row.dataset.value ?? '';

  // Rows loaded from a saved sale (edit mode) keep their saved price, quantity and line discount
  // until the product on that row is changed; then they count as a new line.
  const lineRef = (row) => (row.dataset.keep && valueOf(row) === row.dataset.orig ? JSON.parse(row.dataset.keep) : null);
  const unitOf = (row, value) => (lineRef(row) ? Number(row.dataset.unit) : unitByValue[value]);
  const qtyOf = (row) => {
    const q = row.querySelector('.pl-qty');
    return q ? (parseInt(q.value, 10) || 1) : (Number(row.dataset.qty) || 1);
  };

  function resetRow(row) {
    row.dataset.value = '';
    ['keep', 'orig', 'unit', 'qty'].forEach((k) => { delete row.dataset[k]; });
    const sel = row.querySelector('select');
    if (sel) sel.value = '';
    row.querySelectorAll('.chip').forEach((c) => { c.setAttribute('aria-pressed', 'false'); c.classList.remove('active'); });
    const q = row.querySelector('.pl-qty');
    if (q) q.value = '1';
  }

  // Shows / hides an optional block and updates its toggle button (no data is touched).
  function markBlock(key, on) {
    document.querySelector(`#saleProducts section.product[data-product="${key}"]`)?.classList.toggle('hidden', !on);
    const btn = document.querySelector(`#saleProducts button[data-toggle="${key}"]`);
    btn?.setAttribute('aria-pressed', String(on));
    btn?.classList.toggle('active', on);
  }

  // Switch an optional block on/off. Switching off discards its lines and discount, so nothing hidden is ever submitted.
  function setBlock(key, on) {
    markBlock(key, on);
    if (!on) {
      const p = products.find((x) => x.key === key);
      const section = document.querySelector(`#saleProducts section.product[data-product="${key}"]`);
      section.querySelector('.rows').innerHTML = lineHtml(p);
      setCatDiscount(section, false);
    }
    recalc();
  }

  // ---- Category discount (one per product block) ----
  // Percent applies to every row of the block. Amount is spread over the rows in proportion to
  // their value (100-riel steps, remainder to the last rows), so each saved line carries its share.
  function catDiscount(section) {
    const panel = section.querySelector('.cat-disc');
    if (!panel || panel.classList.contains('hidden')) return null;
    const v = panel.querySelector('.cd-value').value;
    if (v === '') return { empty: true };
    return {
      type: panel.querySelector('input[type="radio"]:checked').value,
      value: Number(v),
      reason: panel.querySelector('.cd-reason').value.trim() || null
    };
  }

  function setCatDiscount(section, show, { type = 'Percent', value = '', reason = '' } = {}) {
    const panel = section.querySelector('.cat-disc');
    const btn = section.querySelector('[data-disc]');
    if (!panel || !btn) return;
    panel.classList.toggle('hidden', !show);
    btn.setAttribute('aria-pressed', String(show));
    btn.textContent = `${show ? '−' : '+'} Discount`;
    panel.querySelector(`input[type="radio"][value="${show ? type : 'Percent'}"]`).checked = true;
    panel.querySelector('.cd-value').value = show ? value : '';
    panel.querySelector('.cd-reason').value = show ? reason : '';
  }

  // One entry per row (or null = no discount), or null if the discount is not valid for these rows.
  function splitDiscount(grosses, cd) {
    if (!cd || cd.empty || !(cd.value > 0)) return grosses.map(() => null);
    if (cd.type === 'Percent') return cd.value > 100 ? null : grosses.map(() => ({ type: 'Percent', value: cd.value }));
    const sum = grosses.reduce((a, g) => a + g, 0);
    if (cd.value > sum) return null;
    const alloc = grosses.map((g) => (sum ? Math.floor((cd.value * g) / sum / 100) * 100 : 0));
    let rest = cd.value - alloc.reduce((a, x) => a + x, 0);
    for (let i = grosses.length - 1; i >= 0 && rest > 0; i -= 1) {
      const add = Math.min(rest, grosses[i] - alloc[i]);
      alloc[i] += add;
      rest -= add;
    }
    return alloc.map((a) => (a > 0 ? { type: 'Amount', value: a } : null));
  }

  // Filled rows of every product block with price, quantity and their share of the category discount.
  function readLines() {
    const lines = [];
    let itemDisc = 0;
    let bad = false;
    let missing = null;   // title of a block whose discount value is still empty
    document.querySelectorAll('#saleProducts section.product').forEach((section) => {
      const cd = catDiscount(section);
      if (cd?.empty) missing ??= section.querySelector('.product-title').textContent;
      const part = [...section.querySelectorAll('.pline')].filter((r) => valueOf(r)).map((row) => {
        const value = valueOf(row);
        const unit = unitOf(row, value);
        const qty = Math.max(1, qtyOf(row));
        return { row, value, unit, qty, gross: unit == null ? 0 : unit * qty, cd, split: null, disc: 0 };
      });
      const split = splitDiscount(part.map((l) => l.gross), cd);
      if (!split) bad = true;
      part.forEach((l, i) => {
        l.split = split?.[i] ?? null;
        if (l.split) {
          const d = calcDiscount(l.gross, l.split.type, l.split.value);
          if (d == null) bad = true; else l.disc = d;
        }
        itemDisc += l.disc;
      });
      lines.push(...part);
    });
    return { lines, itemDisc, bad, missing };
  }

  // ---- Motorbike: a plate number means one bike (one size, quantity 1); otherwise several sizes + quantities ----
  const plateEntered = () => $('salePlate').value.trim() !== '';
  let sizeSingle = false;

  function applySizeMode() {
    const section = document.querySelector('#saleProducts section.product[data-product="size"]');
    if (!section) return;
    sizeSingle = plateEntered();
    if (sizeSingle) {
      const rows = [...section.querySelectorAll('.pline')];
      const keep = rows.find((r) => valueOf(r)) || rows[0];
      rows.forEach((r) => { if (r !== keep) r.remove(); });
      const q = keep?.querySelector('.pl-qty');
      if (q) q.value = '1';
    }
    section.querySelectorAll('.pl-qty').forEach((q) => q.classList.toggle('hidden', sizeSingle));
    section.querySelector('[data-add]')?.classList.toggle('hidden', sizeSingle);
    section.querySelector('.product-hint')?.classList.toggle('hidden', !sizeSingle);
    recalc();
  }

  function onPlateInput() {
    if (plateEntered() === sizeSingle) return;
    if (plateEntered()) {
      const filled = [...document.querySelectorAll('#saleProducts section.product[data-product="size"] .pline')].filter((r) => valueOf(r));
      if ((filled.length > 1 || filled.some((r) => qtyOf(r) > 1))
          && !confirm('A plate number allows only one motorbike. Keep the first one and remove the others?')) {
        $('salePlate').value = '';
        return;
      }
    }
    applySizeMode();
  }

  function onProductsClick(e) {
    const tg = e.target.closest('button[data-toggle]');
    if (tg) { setBlock(tg.dataset.toggle, tg.getAttribute('aria-pressed') !== 'true'); return; }
    const dBtn = e.target.closest('[data-disc]');
    if (dBtn) {
      const section = dBtn.closest('.product');
      const show = dBtn.getAttribute('aria-pressed') !== 'true';
      setCatDiscount(section, show);
      if (show) section.querySelector('.cd-value').focus();
      recalc();
      return;
    }
    const add = e.target.closest('[data-add]');
    if (add) {
      const p = products.find((x) => x.key === add.dataset.add);
      add.closest('.product').querySelector('.rows').insertAdjacentHTML('beforeend', lineHtml(p));
      recalc();
      return;
    }
    const chip = e.target.closest('.chip');
    if (chip) {
      const row = chip.closest('.pline');
      const same = row.dataset.value === chip.dataset.value;
      row.dataset.value = same ? '' : chip.dataset.value;
      row.querySelectorAll('.chip').forEach((c) => {
        const on = c.dataset.value === row.dataset.value;
        c.setAttribute('aria-pressed', String(on));
        c.classList.toggle('active', on);
      });
      recalc();
      return;
    }
    const rm = e.target.closest('.pl-remove');
    if (rm) {
      const row = rm.closest('.pline');
      if (row.parentElement.children.length > 1) row.remove(); else resetRow(row);   // keep one row per product
      recalc();
    }
  }

  // ---- Optional details (discount, adjustment, remark) ----
  const isShown = (id) => !$(id).classList.contains('hidden');

  function setOpt(id, show) {
    const section = $(id);
    const btn = document.querySelector(`.opt-toggle[data-opt="${id}"]`);
    section.classList.toggle('hidden', !show);
    btn.setAttribute('aria-pressed', String(show));
    btn.classList.toggle('active', show);
    btn.textContent = `${show ? '−' : '+'} ${btn.dataset.label}`;
    if (show) {
      section.querySelector('input:not([type="radio"])')?.focus();
    } else {
      // Hiding discards what was typed, so nothing hidden is ever submitted.
      section.querySelectorAll('input').forEach((i) => {
        if (i.type === 'radio') i.checked = i.defaultChecked; else i.value = i.defaultValue;
      });
    }
    recalc();
  }

  const discountType = () => (isShown('optDiscount') ? checked('discType') : '');

  function recalc() {
    document.querySelectorAll('#saleProducts .pl-price').forEach((el) => { el.textContent = ''; });
    const { lines, itemDisc, bad } = readLines();
    let gross = 0;
    lines.forEach((l) => {
      if (l.unit == null) return;
      l.row.querySelector('.pl-price').textContent = fmt(l.gross - l.disc);
      gross += l.gross;
    });
    const sub = gross - itemDisc;   // the receipt discount applies on top of the category discounts

    const type = discountType();
    const val = $('discValue').value;
    let disc = 0;
    let discOk = true;
    if (type && val !== '') {
      const d = calcDiscount(sub, type, Number(val));
      if (d == null) discOk = false; else disc = d;
    }
    const adj = Number($('adjAmount').value) || 0;

    $('totBreak').textContent = [
      `Subtotal ${fmt(gross)}`,
      bad ? 'Invalid category discount' : itemDisc ? `Category discount −${fmt(itemDisc)}` : '',
      !discOk ? 'Invalid discount' : disc ? `Discount −${fmt(disc)}` : '',
      adj ? `Adjustment ${signed(adj)}` : ''
    ].filter(Boolean).join(' · ');
    $('totTotal').textContent = fmt(sub - disc + adj);
  }

  // Time field: starts at "now"; counts as edited once the user changes it.
  let timeEdited = false;

  function resetForm() {
    $('saleForm').reset();
    $('saleDate').value = todayStr();
    $('saleTime').value = nowTime();
    timeEdited = false;
    document.querySelectorAll('.opt-toggle').forEach((b) => setOpt(b.dataset.opt, false));
    buildProducts();
    sizeSingle = false;
    applySizeMode();   // also recalculates
  }

  // 'size:3' -> { motorbike_size_id: 3, quantity } etc.
  function itemJson(value, quantity) {
    const [kind, id] = value.split(':');
    const key = { size: 'motorbike_size_id', addon: 'addon_service_id', helmet: 'helmet_service_id', food: 'food_drink_item_id' }[kind];
    return { [key]: kind === 'size' ? Number(id) : id, quantity };
  }

  async function onSubmit(e) {
    e.preventDefault();

    for (const row of document.querySelectorAll('#saleProducts .pline')) {
      const q = row.querySelector('.pl-qty');
      if (valueOf(row) && q && !(parseInt(q.value, 10) >= 1)) return toast('Quantity must be at least 1.');
    }
    const { lines, bad, missing } = readLines();
    if (!lines.length) return toast('Select at least one item.');
    if (missing) return toast(`Enter the discount value for ${missing}.`);
    if (bad) return toast('A category discount is not valid.');
    const bikes = lines.filter((l) => l.row.closest('.product').dataset.product === 'size');
    if (plateEntered() && (bikes.length > 1 || bikes.some((l) => l.qty > 1))) return toast('A plate number allows only one motorbike.');

    const items = lines.map((l) => {
      const ref = lineRef(l.row);   // edit mode: an unchanged saved line keeps its id and price
      const item = ref ? { id: ref.id, remark: ref.remark, quantity: l.qty } : itemJson(l.value, l.qty);
      return {
        ...item,
        discount_type: l.split?.type ?? null,
        discount_value: l.split?.value ?? null,
        discount_reason: l.split ? l.cd.reason : null
      };
    });

    const discType = discountType();
    if (discType && $('discValue').value === '') return toast('Enter the discount value.');

    const adj = Number($('adjAmount').value) || 0;
    if (adj % 100 !== 0) return toast('Adjustment must be a multiple of 100 riel.');
    if (adj !== 0 && !$('adjReason').value.trim()) return toast('Enter the adjustment reason.');

    const date = $('saleDate').value;
    if (!date) return toast('Select the sale date.');
    if (date > todayStr()) return toast('Sale date cannot be in the future.');
    const isToday = date === todayStr();
    const saleDate = isToday && !editing ? null : date;   // edits always send the date

    const time = $('saleTime').value;
    if (!time) return toast('Select the sale time.');
    if (isToday && time > nowTime()) return toast('Sale time cannot be in the future.');
    // Today + time untouched: let the database use the exact current time.
    const saleTime = isToday && !timeEdited ? null : time;

    if (editing?.status === 'Confirmed' && !confirm(`Receipt #${editing.receipt_no} is Confirmed. Save these changes?`)) return;

    const params = {
      p_items: items,
      p_payment_method: checked('payment'),
      p_plate_no: $('salePlate').value.trim() || null,
      p_customer: $('saleCustomer').value.trim() || null,
      p_discount_type: discType || null,
      p_discount_value: discType ? Number($('discValue').value) : null,
      p_discount_reason: $('discReason').value.trim() || null,
      p_remark: $('saleRemark').value.trim() || null,
      p_sale_date: saleDate,
      p_adjustment_khr: adj,
      p_adjustment_reason: $('adjReason').value.trim() || null,
      p_sale_time: saleTime
    };
    $('saleSaveBtn').disabled = true;
    const { error } = editing
      ? await sb.rpc('update_sale', { p_sale_id: editing.id, ...params })
      : await sb.rpc('create_sale', params);
    $('saleSaveBtn').disabled = false;

    if (error) return toast(error.message);

    if (editing) {
      const no = editing.receipt_no;
      exitEdit();
      modal().hide();
      toast(`Receipt #${no} updated.`, 'ok');
      return opts.onSaved?.({ mode: 'update', date });
    }

    resetForm();
    $('saleDate').value = date;   // keep the date, handy when entering several back-dated sales
    toast('Sale saved (Pending).', 'ok');
    opts.onSaved?.({ mode: 'create', date });   // the page can refresh its list
  }


  // ===================================================================
  // Edit / view an existing sale
  // ===================================================================
  function showSectionOf(inputId) {
    const id = [...document.querySelectorAll('.opt-toggle')].map((b) => b.dataset.opt).find((o) => $(o)?.contains($(inputId)));
    if (id) setOpt(id, true);
  }

  function setText(inputId, v) {
    if (v == null || v === '') return;
    showSectionOf(inputId);
    $(inputId).value = v;
  }

  // Fills one product row from a saved line, even if that product is no longer listed.
  function fillRow(row, p, it, value) {
    const sel = row.querySelector('select');
    if (sel && ![...sel.options].some((o) => o.value === value)) {
      sel.insertAdjacentHTML('beforeend', `<option value="${value}">${esc(it.description)} — no longer listed</option>`);
    } else if (!sel && !row.querySelector(`.chip[data-value="${value}"]`)) {
      row.querySelector('.chips').insertAdjacentHTML('beforeend',
        `<button type="button" class="chip btn btn-sm btn-outline-primary" data-value="${value}" aria-pressed="false">${esc(it.description)}</button>`);
    }
    row.dataset.value = value;
    if (sel) sel.value = value;
    row.querySelectorAll('.chip').forEach((c) => {
      const on = c.dataset.value === value;
      c.setAttribute('aria-pressed', String(on));
      c.classList.toggle('active', on);
    });
    const q = row.querySelector('.pl-qty');
    if (q) q.value = String(it.quantity);

    row.dataset.orig = value;
    row.dataset.unit = String(it.unit_price_khr);
    row.dataset.qty = String(it.quantity);
    row.dataset.keep = JSON.stringify({ id: it.id, remark: it.remark });
  }

  function fillLines(items) {
    const kindOf = (i) => (i.motorbike_size_id != null ? `size:${i.motorbike_size_id}`
      : i.addon_service_id ? `addon:${i.addon_service_id}`
      : i.helmet_service_id ? `helmet:${i.helmet_service_id}`
      : `food:${i.food_drink_item_id}`);
    const sorted = [...items].sort((a, b) => a.line_no - b.line_no);

    products.forEach((p) => {
      const list = sorted.filter((i) => kindOf(i).startsWith(`${p.key}:`));
      if (!list.length) return;
      const section = document.querySelector(`#saleProducts section.product[data-product="${p.key}"]`);
      const rowsEl = section.querySelector('.rows');
      if (p.optional) markBlock(p.key, true);   // show the block
      rowsEl.innerHTML = list.map(() => lineHtml(p)).join('');
      rowsEl.querySelectorAll('.pline').forEach((row, k) => fillRow(row, p, list[k], kindOf(list[k])));

      // Rebuild the category discount: same Percent on every line, otherwise the total Amount.
      const disc = list.filter((i) => i.discount_type);
      if (disc.length) {
        const percent = disc.length === list.length
          && disc.every((i) => i.discount_type === 'Percent' && Number(i.discount_value) === Number(disc[0].discount_value));
        setCatDiscount(section, true, {
          type: percent ? 'Percent' : 'Amount',
          value: percent ? Number(disc[0].discount_value) : list.reduce((t, i) => t + Number(i.discount_khr), 0),
          reason: disc[0].discount_reason ?? ''
        });
      }
    });
  }

  // ---- Confirm / Void / Edit: what the current user may do with a saved sale ----
  const isOwn = (s) => s.created_by === me.user.id || (s.created_by === null && isSuper());
  const allowed = (s) => ({
    confirm: s.status === 'Pending' && can('confirm_revenue'),
    void: (s.status === 'Pending' && (can('confirm_revenue') || isOwn(s))) || (isSuper() && s.status === 'Confirmed'),
    edit: isSuper() && s.status !== 'Voided'   // Super Admin is not limited by status
  });

  // kind = 'confirm' | 'void'. Returns null when the user cancels, true when done, false when the database refused.
  async function act(kind, s) {
    let call;
    if (kind === 'confirm') {
      if (!confirm(`Confirm receipt #${s.receipt_no}?${isSuper() ? '' : ' A confirmed sale can no longer be voided.'}`)) return null;
      call = sb.rpc('confirm_sale', { p_sale_id: s.id });
    } else {
      const reason = prompt(`Reason for voiding${s.status === 'Confirmed' ? ' CONFIRMED' : ''} receipt #${s.receipt_no}:`);
      if (!reason || !reason.trim()) return null;
      call = sb.rpc('void_sale', { p_sale_id: s.id, p_reason: reason.trim() });
    }
    const { error } = await call;
    if (error) toast(error.message, 'error', { sticky: true });
    return !error;
  }

  async function onViewAction(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn || !current) return;
    if (btn.dataset.act === 'edit') return open(current.id);
    btn.disabled = true;
    const done = await act(btn.dataset.act, current);
    btn.disabled = false;
    if (done === null) return;
    if (done) modal().hide();
    opts.onChanged?.();   // refresh the list (also after a failure: the sale may have changed)
  }

  // Read-only view shows only what was recorded: empty details, empty product rows and unused blocks are hidden
  // (the CSS class .is-view hides the editing controls: toggles, + Discount, + Add another, remove, unselected chips).
  function markView(view) {
    $('saleForm').classList.toggle('is-view', view);
    ['salePlate', 'saleCustomer'].forEach((id) => $(id).parentElement.classList.toggle('meta-empty', view && !$(id).value.trim()));
    document.querySelectorAll('#saleProducts .pline').forEach((r) => r.classList.toggle('is-empty', view && !valueOf(r)));
    document.querySelectorAll('#saleProducts section.product').forEach((sec) =>
      sec.classList.toggle('is-empty', view && ![...sec.querySelectorAll('.pline')].some((r) => valueOf(r))));
  }

  // new / edit / view: title, buttons, note, and whether the inputs are locked
  function setMode(mode, s) {
    const view = mode === 'view';
    current = s ?? null;
    markView(view);
    const a = view ? allowed(s) : {};
    $('saleActConfirm').classList.toggle('hidden', !a.confirm);
    $('saleActVoid').classList.toggle('hidden', !a.void);
    $('saleActEdit').classList.toggle('hidden', !a.edit);
    $('saleViewActions').classList.toggle('hidden', !(a.confirm || a.void || a.edit));
    $('formFields').disabled = view;
    $('saleSaveBtn').classList.toggle('hidden', view);
    $('saleClearBtn').classList.toggle('hidden', view);
    $('saleTitle').textContent = mode === 'new' ? TEXT.title : `${mode === 'edit' ? 'Edit receipt' : 'Receipt'} #${s.receipt_no}`;
    $('saleSaveBtn').textContent = mode === 'edit' ? 'Save changes' : TEXT.save;
    $('saleClearBtn').textContent = mode === 'edit' ? 'Cancel edit' : TEXT.clear;
    $('saleNote').textContent = view
      ? `${s.status}${s.void_reason ? `: ${s.void_reason}` : ''}. Saved total ${fmt(s.total_khr)}.`
      : TEXT.note;
  }

  // Back to a blank "New sale" form.
  function exitEdit() {
    editing = null;
    viewing = false;
    setMode('new');
    resetForm();
  }

  // Products and prices are loaded once, the first time the form is needed.
  let ready = null;
  function ensureProducts() {
    ready ??= loadProducts().then(() => resetForm()).catch((err) => {
      ready = null;
      toast(`Could not load products and prices: ${err.message}`, 'error', { sticky: true });
      return false;
    });
    return ready.then((r) => r !== false);
  }

  async function openNew() {
    if (!can('enter_revenue')) return toast('You do not have permission to enter sales.');
    if (!(await ensureProducts())) return;
    if (editing || viewing) exitEdit();
    setMode('new');   // unlocks the inputs (the form starts locked until products are loaded)
    if (!timeEdited && $('saleTime').value) $('saleTime').value = nowTime();   // fresh "now" when the form opens
    modal().show();
  }

  async function open(id, { view = false } = {}) {
    if (!(await ensureProducts())) return;
    const { data: s, error } = await sb.from('sales').select('*, sale_items(*)').eq('id', id).single();
    if (error) return toast(`Could not open the sale: ${error.message}`);

    const canEdit = !view && allowed(s).edit;
    resetForm();
    editing = canEdit ? { id: s.id, receipt_no: s.receipt_no, status: s.status } : null;
    viewing = !canEdit;

    $('saleDate').value = s.sale_date;
    $('saleTime').value = hhmm(s.sale_time);
    timeEdited = true;
    const pay = $('saleForm').querySelector(`input[name="payment"][value="${s.payment_method}"]`);
    if (pay) pay.checked = true;
    setText('salePlate', s.plate_no);
    setText('saleCustomer', s.customer);
    setText('saleRemark', s.remark);
    if (s.discount_type) {
      showSectionOf('discValue');
      const t = $('saleForm').querySelector(`input[name="discType"][value="${s.discount_type}"]`);
      if (t) t.checked = true;
      $('discValue').value = s.discount_value ?? '';
      $('discReason').value = s.discount_reason ?? '';
    }
    if (Number(s.adjustment_khr)) {
      showSectionOf('adjAmount');
      $('adjAmount').value = s.adjustment_khr;
      $('adjReason').value = s.adjustment_reason ?? '';
    }
    fillLines(s.sale_items || []);
    applySizeMode();

    setMode(canEdit ? 'edit' : 'view', s);
    recalc();
    modal().show();
  }

  // ===================================================================
  // Start
  // ===================================================================
  let started = false;
  function init(detail, options = {}) {
    me = detail;
    can = (key) => me.perms.includes(key);
    opts = options;
    if (started) return;
    started = true;

    document.body.insertAdjacentHTML('beforeend', MARKUP);

    $('saleDate').max = todayStr();
    $('saleDate').disabled = !can('backdate_revenue');   // others can only sell for today
    if ($('saleDate').disabled) $('saleDate').title = 'Back-dating needs permission';

    $('saleTime').addEventListener('input', () => { timeEdited = true; });
    $('salePlate').addEventListener('input', onPlateInput);
    $('saleForm').addEventListener('submit', onSubmit);
    $('saleForm').addEventListener('input', recalc);
    $('optBar').addEventListener('click', (e) => {
      const btn = e.target.closest('.opt-toggle');
      if (btn) setOpt(btn.dataset.opt, btn.getAttribute('aria-pressed') !== 'true');
    });
    $('saleProducts').addEventListener('click', onProductsClick);
    $('saleViewActions').addEventListener('click', onViewAction);
    $('saleClearBtn').addEventListener('click', () => {   // while editing, this cancels the edit and goes back to the read-only view
      if (!editing) return resetForm();
      const { id } = editing;
      exitEdit();
      open(id, { view: true });
    });
    modal().onHide(() => { if (editing || viewing) exitEdit(); });   // X button / Esc = cancel the edit or close the view
  }

  window.SaleForm = { init, openNew, open, confirmSale: (s) => act('confirm', s) };
})();
