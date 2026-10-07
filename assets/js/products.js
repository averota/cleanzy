// assets/js/products.js
// Products page: one list per catalog table with add / edit / (de)activate / delete,
// plus the price for every sellable item (set price, scheduled price, history) and the USD->KHR rate.
// Click a row = details modal with every action button; each row also has a three-dot menu with the same actions.
// One config object per table (ENTITIES below) drives the tabs, list and forms.
//   - Adding a catalog table = one ENTITIES entry (+ one GROUPS entry).
//   - Making an entity priceable = give it `price` (column in public.prices) and `priceName`.
// Prices and rates are append-only (see 06_prices.sql): "Set price" adds a new row that takes
// effect now or at a scheduled time. Nothing is ever edited or deleted, so past sales never change.
// Read: everyone signed in. Write: 'manage_catalog' / 'manage_price' (enforced by RLS; the UI only hides buttons).
// Load AFTER sidebar.js and ui.js (sidebar fires `app:ready`).
(() => {
  const TZ = 'Asia/Phnom_Penh';
  const MAX_PHOTO = 2 * 1024 * 1024;   // matches the storage bucket limit
  const PHOTO_EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };

  const { $, esc, toast, badge, fetchAll } = UI;

  // ---- formatting (prices) ----
  const fmtDT = (iso) => new Date(iso).toLocaleString('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  const nowLocalInput = () => new Date().toLocaleString('sv-SE', { timeZone: TZ }).replace(' ', 'T').slice(0, 16);
  const toIso = (local) => new Date(`${local}:00+07:00`).toISOString();   // Cambodia has no daylight saving
  const money = (a, c) => (c === 'USD' ? `$${Number(a).toFixed(2)}` : `${Number(a).toLocaleString('en-US')} ៛`);
  const checked = (name) => document.querySelector(`input[name="${name}"]:checked`)?.value ?? '';
  const khrOf = (a, c) => (c === 'KHR' ? Math.floor(a / 100) * 100 : (rate ? Math.floor((a * rate) / 100) * 100 : null));   // same rounding as sales
  const twoDecimals = (n) => Math.round(n * 100) / 100 === n;

  function friendly(error, action) {
    if (error.code === '23505') return action === 'price'
      ? 'A price or rate already exists for that exact time. Please try again.'
      : 'This already exists (same code, name or description).';
    if (error.code === '23503' && action === 'delete') return 'Cannot delete: it is used by other records (prices or sales). Deactivate it instead.';
    if (error.code === '42501' || /row-level security/i.test(error.message)) return 'You do not have permission to do this.';
    return error.message;
  }

  // ---- lookups used by the select fields / columns ----
  let lookups = { sizes: [], cats: [] };
  async function loadLookups() {
    const [sizes, cats] = await Promise.all([
      sb.from('motorbike_sizes').select('id, code, is_active').order('sort_order'),
      sb.from('food_drink_categories').select('id, kind, name, is_active').order('sort_order')
    ]);
    lookups = { sizes: sizes.data || [], cats: cats.data || [] };
  }
  const sizeOptions = (cur) => lookups.sizes
    .filter((s) => s.is_active || String(s.id) === String(cur))
    .map((s) => ({ value: s.id, label: s.code }));
  const catOptions = (cur) => lookups.cats
    .filter((c) => c.is_active || String(c.id) === String(cur))
    .map((c) => ({ value: c.id, label: `${c.kind} – ${c.name}` }));
  const sizeName = (id) => lookups.sizes.find((s) => s.id === id)?.code ?? '';
  const catName = (id) => { const c = lookups.cats.find((x) => x.id === id); return c ? `${c.kind} – ${c.name}` : ''; };
  const catRank = (id) => { const i = lookups.cats.findIndex((c) => c.id === id); return i < 0 ? 9999 : i; };

  // ---- table configs ----
  // fields: { name, label, type: text|number|select, required, upper, numeric, default, options(cur) }
  // columns: { h, cell(row), cls }   (photo, price, Status and action columns are added automatically)
  // price: column in public.prices that points at this table (omit = no price)
  const serviceFields = [
    { name: 'description', label: 'Description', required: true },
    { name: 'description_kh', label: 'Khmer description' },
    { name: 'remark', label: 'Remark' }
  ];
  const serviceColumns = [
    { h: 'Description', cell: (r) => esc(r.description), cls: 'wide' },
    { h: 'Khmer', cell: (r) => esc(r.description_kh), cls: 'wide' },
    { h: 'Remark', cell: (r) => esc(r.remark), cls: 'wide' }
  ];

  const ENTITIES = {
    sizes: {
      label: 'Sizes', subLabel: 'Sizes & prices', title: 'Motorbike sizes & wash prices', singular: 'size', table: 'motorbike_sizes', order: ['sort_order', 'code'],
      price: 'motorbike_size_id', priceName: (r) => `Size ${r.code}`,
      fields: [
        { name: 'code', label: 'Code (e.g. S, M, 2XL)', required: true, upper: true },
        { name: 'sort_order', label: 'Sort order', type: 'number', default: 0 }
      ],
      columns: [
        { h: 'Order', cell: (r) => r.sort_order, cls: 'ctr fit' },
        { h: 'Code', cell: (r) => esc(r.code), cls: 'fit' }
      ]
    },
    models: {
      label: 'Models', subLabel: 'Models', singular: 'model', table: 'motorbike_models', bucket: 'motorbike-photos', order: ['brand', 'model'],
      fields: [
        { name: 'size_id', label: 'Size', type: 'select', required: true, numeric: true, options: sizeOptions },
        { name: 'brand', label: 'Brand', required: true },
        { name: 'model', label: 'Model', required: true },
        { name: 'remarks', label: 'Remarks' }
      ],
      columns: [
        { h: 'Size', cell: (r) => esc(sizeName(r.size_id)), cls: 'fit' },
        { h: 'Brand', cell: (r) => esc(r.brand) },
        { h: 'Model', cell: (r) => esc(r.model) },
        { h: 'Remarks', cell: (r) => esc(r.remarks), cls: 'wide' }
      ]
    },
    addons: {
      label: 'Add-on services', singular: 'add-on service', table: 'addon_services', bucket: 'addon-service-photos', order: ['description'],
      price: 'addon_service_id', priceName: (r) => r.description,
      fields: serviceFields, columns: serviceColumns
    },
    helmets: {
      label: 'Helmet services', singular: 'helmet service', table: 'helmet_services', bucket: 'helmet-service-photos', order: ['description'],
      price: 'helmet_service_id', priceName: (r) => r.description,
      fields: serviceFields, columns: serviceColumns
    },
    foodCats: {
      label: 'Food & drink categories', subLabel: 'Categories', singular: 'category', table: 'food_drink_categories', order: ['sort_order', 'name'],
      fields: [
        { name: 'kind', label: 'Kind', type: 'select', required: true, options: () => [{ value: 'Food', label: 'Food' }, { value: 'Drink', label: 'Drink' }] },
        { name: 'name', label: 'Name', required: true },
        { name: 'name_kh', label: 'Khmer name' },
        { name: 'sort_order', label: 'Sort order', type: 'number', default: 0 }
      ],
      columns: [
        { h: 'Order', cell: (r) => r.sort_order, cls: 'ctr fit' },
        { h: 'Kind', cell: (r) => esc(r.kind), cls: 'fit' },
        { h: 'Name', cell: (r) => esc(r.name) },
        { h: 'Khmer', cell: (r) => esc(r.name_kh) }
      ]
    },
    foods: {
      label: 'Food & drink items', subLabel: 'Items & prices', singular: 'item', table: 'food_drink_items', bucket: 'food-drink-photos', order: ['description'],
      price: 'food_drink_item_id', priceName: (r) => r.description,
      sort: (a, b) => catRank(a.category_id) - catRank(b.category_id),   // keep items in category order
      fields: [{ name: 'category_id', label: 'Category', type: 'select', required: true, numeric: true, options: catOptions }, ...serviceFields],
      columns: [{ h: 'Category', cell: (r) => esc(catName(r.category_id)), cls: 'fit' }, ...serviceColumns]
    },
    rate: { label: 'Exchange rate', title: 'Exchange rate (USD → KHR)', isRate: true }
  };

  // Top tabs. A group with several tables gets sub-tabs (label = subLabel).
  const GROUPS = [
    { label: 'Motorbikes', entities: ['sizes', 'models'] },
    { label: 'Add-on services', entities: ['addons'] },
    { label: 'Helmet services', entities: ['helmets'] },
    { label: 'Food & drink', entities: ['foodCats', 'foods'], open: 'foods' },
    { label: 'Exchange rate', entities: ['rate'] }
  ];
  const groupOf = (key) => GROUPS.find((g) => g.entities.includes(key));

  // ---- state ----
  let canEdit = false;    // manage_catalog
  let canPrice = false;   // manage_price
  let isSuper = false;    // Super Admin: may back-date prices and rates
  let current = 'sizes';
  let rows = [];          // catalog rows of the current tab
  let priceRows = [];     // prices of the current tab, newest first
  let rateRows = [];      // exchange rates, newest first
  let rate = null;        // current KHR per 1 USD
  let panel = null;       // { kind: 'item', row } | { kind: 'price', row } | { kind: 'rate' }
  let detail = null;      // { row, hist } while the details modal is open (hist = price history shown)
  const names = {};       // user id -> display name

  const photoUrl = (bucket, path) => sb.storage.from(bucket).getPublicUrl(path).data.publicUrl;

  // ---- price helpers ----
  const isFuture = (r) => new Date(r.effective_from) > new Date();
  const currentOf = (list) => list.find((r) => !isFuture(r)) || null;           // lists are newest first
  const nextOf = (list) => list.filter(isFuture).pop() || null;                 // earliest scheduled
  const statusOf = (r, list) => (isFuture(r) ? 'Scheduled' : r === currentOf(list) ? 'Current' : 'Past');
  const pricesOf = (E, row) => priceRows.filter((p) => p[E.price] === row.id);

  async function ensureNames(list) {
    const ids = [...new Set(list.map((r) => r.created_by).filter((id) => id && !(id in names)))];
    await Promise.all(ids.map(async (id) => {
      const { data } = await sb.rpc('actor_name', { actor: id });
      names[id] = data || '—';
    }));
  }
  const byName = (r) => (r.created_by === null ? 'Admin' : names[r.created_by] || '—');   // NULL = Super Admin

  // ===================================================================
  // Loading
  // ===================================================================
  async function loadRate() {
    const { data } = await sb.from('current_exchange_rate').select('usd_to_khr').maybeSingle();
    rate = data ? Number(data.usd_to_khr) : null;
    $('rateInfo').textContent = rate ? `1 USD = ${rate.toLocaleString('en-US')} ៛` : 'No exchange rate set';
  }

  async function load() {
    const key = current;
    const E = ENTITIES[key];
    let list; let prices = []; let rates = [];
    try {
      if (E.isRate) {
        rates = await fetchAll(() => sb.from('exchange_rates').select('*').order('effective_from', { ascending: false }).order('id'));
        await ensureNames(rates);
      } else {
        [list, prices] = await Promise.all([
          fetchAll(() => { let q = sb.from(E.table).select('*'); E.order.forEach((c) => { q = q.order(c); }); return q.order('id'); }),
          E.price ? fetchAll(() => sb.from('prices').select('*').not(E.price, 'is', null).order('effective_from', { ascending: false }).order('id')) : []
        ]);
      }
    } catch (err) {
      if (key === current) toast(`Could not load: ${err.message}`, 'error', { sticky: true });
      return;
    }
    if (key !== current) return;   // tab changed while loading
    if (E.isRate) rateRows = rates;
    else { rows = E.sort ? [...list].sort(E.sort) : list; priceRows = prices; }
    renderList();
  }

  // Reload the list (and the lookups, when a table other tabs depend on changed).
  async function refresh() {
    if (current === 'sizes' || current === 'foodCats') await loadLookups();
    await load();
  }

  // ===================================================================
  // List
  // ===================================================================
  function renderTabs() {
    const group = groupOf(current);
    $('tabs').innerHTML = GROUPS.map((g) =>
      `<button type="button" class="nav-link${g === group ? ' active' : ''}" role="tab" data-tab="${g.open || g.entities[0]}" aria-selected="${g === group}">${esc(g.label)}</button>`).join('');

    const subs = group.entities.length > 1;
    $('subTabs').classList.toggle('hidden', !subs);
    $('subTabs').innerHTML = subs
      ? group.entities.map((k) =>
          `<button type="button" class="nav-link${k === current ? ' active' : ''}" role="tab" data-tab="${k}" aria-selected="${k === current}">${esc(ENTITIES[k].subLabel)}</button>`).join('')
      : '';
  }

  function renderList() {
    const E = ENTITIES[current];
    const priced = Boolean(E.price);
    $('listTitle').textContent = E.title || E.label;
    $('search').classList.toggle('hidden', Boolean(E.isRate));
    $('inactiveWrap').classList.toggle('hidden', Boolean(E.isRate));
    $('rateInfo').classList.toggle('hidden', !(priced || E.isRate));
    $('newBtn').textContent = E.isRate ? '+ New rate' : '+ New';
    $('newBtn').classList.toggle('hidden', !(E.isRate ? canPrice : canEdit));
    $('note').classList.toggle('hidden', !(priced || E.isRate));
    $('note').textContent = E.isRate
      ? 'Rates are never edited: adding a new rate keeps the old one in history. Past sales keep the rate they were sold at.'
      : 'Prices are never edited: setting a price keeps the old one in history. Past sales keep the price they were sold at. Items without a price cannot be sold.';
    E.isRate ? renderRates() : renderItems(E);
  }

  // Columns of an item tab (used by the list AND the details modal).
  function itemColumns(E) {
    // Tabs with no wide text column (e.g. Sizes & prices): price columns share the free space instead of one text column taking it all.
    const priceCls = E.columns.some((c) => (c.cls || '').includes('wide')) ? 'fit' : 'mid';
    const priceCols = E.price ? [
      { h: 'Current price', cell: (r) => {
        const cur = currentOf(pricesOf(E, r));
        if (!cur) return badge('No price');
        const khr = cur.currency === 'USD' ? khrOf(Number(cur.amount), 'USD') : null;
        return `${money(cur.amount, cur.currency)}`
          + (cur.currency === 'USD' ? `<br><span class="small">${khr == null ? 'no exchange rate' : `≈ ${khr.toLocaleString('en-US')} ៛`}</span>` : '')
          + `<br><span class="small">since ${fmtDT(cur.effective_from)}</span>`;
      }, cls: priceCls },
      { h: 'Next (scheduled)', cell: (r) => {
        const next = nextOf(pricesOf(E, r));
        return next ? `${money(next.amount, next.currency)}<br><span class="small">from ${fmtDT(next.effective_from)}</span>` : '—';
      }, cls: priceCls }
    ] : [];

    return [
      ...(E.bucket ? [{ h: '', cell: (r) => (r.photo_path
        ? `<img class="thumb" src="${esc(photoUrl(E.bucket, r.photo_path))}" alt="" loading="lazy">`
        : '<span class="thumb thumb-empty"></span>'), cls: 'fit' }] : []),
      ...E.columns,
      ...priceCols,
      { h: 'Status', cell: (r) => badge(r.is_active ? 'Active' : 'Inactive'), cls: 'fit' }
    ];
  }

  // Columns of the exchange-rate tab (list + details modal).
  const rateCols = [
    { h: 'Rate', cell: (r) => `1 USD = ${Number(r.usd_to_khr).toLocaleString('en-US')} ៛`, cls: 'fit' },
    { h: 'Effective from', cell: (r) => fmtDT(r.effective_from), cls: 'fit' },
    { h: 'Status', cell: (r) => statusOf(r, rateRows), cls: 'fit' },
    { h: 'Remark', cell: (r) => esc(r.remark), cls: 'wide' },
    { h: 'Set by', cell: (r) => esc(byName(r)), cls: 'fit' }
  ];

  // The one list of row actions: used by the three-dot menu AND the details modal.
  // [action, label, button class in the details modal]
  const actionsOf = (E, r, histOpen) => [
    canEdit && ['edit', 'Edit', 'btn-outline-secondary'],
    E.price && canPrice && ['set', 'Set price', 'btn-primary'],
    E.price && canPrice && ['hist', histOpen ? 'Hide history' : 'History', 'btn-outline-secondary'],
    canEdit && ['toggle', r.is_active ? 'Deactivate' : 'Activate', 'btn-outline-secondary'],
    canEdit && ['delete', 'Delete', 'btn-outline-danger']
  ].filter(Boolean);

  const DOTS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="12" cy="19" r="2"></circle></svg>';

  const menuHtml = (E, r) => `<div class="dropdown">
    <button type="button" class="btn btn-sm btn-outline-secondary border-0 px-2" data-bs-toggle="dropdown" data-bs-popper-config='{"strategy":"fixed"}' aria-expanded="false" aria-label="Actions">${DOTS}</button>
    <ul class="dropdown-menu dropdown-menu-end">${actionsOf(E, r, false).map(([act, label]) =>
      `${act === 'delete' ? '<li><hr class="dropdown-divider"></li>' : ''}<li><button type="button" class="dropdown-item${act === 'delete' ? ' text-danger' : ''}" data-act="${act}" data-id="${r.id}">${label}</button></li>`).join('')}</ul>
  </div>`;

  const rowAttrs = (r) => `tabindex="0" data-id="${r.id}"`;

  function renderItems(E) {
    const cols = itemColumns(E);
    const hasActions = canEdit || (E.price && canPrice);
    $('listHead').innerHTML = `<tr>${cols.map((c) => `<th class="${c.cls || ''}">${esc(c.h)}</th>`).join('')}${hasActions ? '<th class="ctr fit">Action</th>' : ''}</tr>`;

    const term = $('search').value.trim().toLowerCase();
    const list = rows.filter((r) => ($('showInactive').checked || r.is_active)
      && (!term || cols.map((c) => c.cell(r)).join(' ').replace(/<[^>]*>/g, ' ').toLowerCase().includes(term)));

    $('listBody').innerHTML = list.map((r) => `<tr class="row-click${r.is_active ? '' : ' row-inactive'}" ${rowAttrs(r)}>
        ${cols.map((c) => `<td class="${c.cls || ''}">${c.cell(r)}</td>`).join('')}
        ${hasActions ? `<td class="row-menu ctr">${menuHtml(E, r)}</td>` : ''}
      </tr>`).join('') || `<tr><td class="empty" colspan="${cols.length + 1}">Nothing here yet.</td></tr>`;
  }

  function renderRates() {
    $('listHead').innerHTML = `<tr>${rateCols.map((c) => `<th class="${c.cls || ''}">${esc(c.h)}</th>`).join('')}</tr>`;
    $('listBody').innerHTML = rateRows.length
      ? rateRows.map((r) => `<tr class="row-click" ${rowAttrs(r)}>${rateCols.map((c) => `<td class="${c.cls || ''}">${c.cell(r)}</td>`).join('')}</tr>`).join('')
      : '<tr><td class="empty" colspan="5">No exchange rate yet. Add one before selling items priced in USD.</td></tr>';
  }

  // ===================================================================
  // Details modal (row click): all fields, price history and every action button
  // ===================================================================
  const currentList = () => (ENTITIES[current].isRate ? rateRows : rows);

  const detailList = (cols, r) => `<dl class="row mb-0">${cols.filter((c) => c.h).map((c) => {
    const v = c.cell(r);
    return `<dt class="col-sm-4 small fw-normal">${esc(c.h)}</dt><dd class="col-sm-8">${v === '' || v == null ? '—' : v}</dd>`;
  }).join('')}</dl>`;

  const historyHtml = (E, r) => {
    const hist = pricesOf(E, r);
    return `<hr><p class="fw-semibold small mb-2">Price history</p>${hist.length ? `<div class="table-responsive">
      <table class="table table-sm mb-0"><thead><tr><th>Price</th><th>Effective from</th><th>Status</th><th>Remark</th><th>Set by</th></tr></thead><tbody>
      ${hist.map((p) => `<tr><td>${money(p.amount, p.currency)}</td><td>${fmtDT(p.effective_from)}</td><td>${statusOf(p, hist)}</td><td>${esc(p.remark)}</td><td>${esc(byName(p))}</td></tr>`).join('')}
      </tbody></table></div>` : '<span class="small">No prices yet.</span>'}`;
  };

  function renderDetail() {
    const E = ENTITIES[current];
    const { row, hist } = detail;
    let body; let buttons = '';
    if (E.isRate) {
      $('detailTitle').textContent = 'Exchange rate details';
      body = detailList(rateCols, row);
    } else {
      $('detailTitle').textContent = `${E.singular.charAt(0).toUpperCase()}${E.singular.slice(1)} details`;
      body = (E.bucket && row.photo_path ? `<img class="img-fluid rounded d-block mb-3" style="max-height:180px" src="${esc(photoUrl(E.bucket, row.photo_path))}" alt="">` : '')
        + detailList(itemColumns(E), row)
        + (E.price && canPrice && hist ? historyHtml(E, row) : '');
      buttons = actionsOf(E, row, hist).map(([act, label, cls]) =>
        `<button type="button" class="btn btn-sm ${cls}" data-act="${act}" data-id="${row.id}">${label}</button>`).join('');
    }
    $('detailBody').innerHTML = body;
    $('detailActions').innerHTML = buttons;
    $('detailActions').classList.toggle('hidden', !buttons);
  }

  async function showDetail(id, hist = false) {
    const row = currentList().find((r) => String(r.id) === String(id));
    if (!row) return;
    if (hist) await ensureNames(pricesOf(ENTITIES[current], row));
    detail = { row, hist };
    renderDetail();
    UI.modal('detailPanel').show();
  }

  // Run fn once the details modal is fully closed (Bootstrap cannot stack two modals).
  function afterDetailClosed(fn) {
    if (!detail) return fn();
    $('detailPanel').addEventListener('hidden.bs.modal', fn, { once: true });
    UI.modal('detailPanel').hide();
  }

  function onListClick(e) {
    if (e.target.closest('button[data-act]')) return onActionClick(e);
    if (e.target.closest('.row-menu')) return undefined;   // the three-dot button itself
    const tr = e.target.closest('tr[data-id]');
    if (tr) showDetail(tr.dataset.id);
    return undefined;
  }

  function onListKey(e) {
    if ((e.key === 'Enter' || e.key === ' ') && e.target.matches('tr[data-id]')) { e.preventDefault(); showDetail(e.target.dataset.id); }
  }

  // Same handler for the three-dot menu and the details modal buttons.
  async function onActionClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = rows.find((r) => String(r.id) === btn.dataset.id);
    if (!row) return;
    const E = ENTITIES[current];

    switch (btn.dataset.act) {
      case 'edit': return afterDetailClosed(() => openItemForm(row));
      case 'set': return afterDetailClosed(() => openPriceForm(row));
      case 'hist': return showDetail(row.id, detail ? !detail.hist : true);   // show / hide history in the details modal
      default:
    }

    btn.disabled = true;
    if (btn.dataset.act === 'toggle') {
      const { error } = await sb.from(E.table).update({ is_active: !row.is_active }).eq('id', row.id);
      if (error) toast(friendly(error));
    } else {
      if (!confirm(`Delete this ${E.singular}? This cannot be undone.`)) { btn.disabled = false; return; }
      const { error } = await sb.from(E.table).delete().eq('id', row.id);
      if (error) toast(friendly(error, 'delete'), 'error', { sticky: true });
      else if (row.photo_path) await sb.storage.from(E.bucket).remove([row.photo_path]);
    }
    if (detail) UI.modal('detailPanel').hide();
    await refresh();
  }

  // ===================================================================
  // Modal (shared by the item form, "Set price" and "New rate")
  // ===================================================================
  function showPanel(kind, row) {
    panel = { kind, row };
    $('itemFields').classList.toggle('hidden', kind !== 'item');
    $('pricePane').classList.toggle('hidden', kind === 'item');
    $('priceFields').classList.toggle('hidden', kind !== 'price');
    $('rateFields').classList.toggle('hidden', kind !== 'rate');
    UI.modal('sidePanel').show();
  }

  function closePanel() {
    panel = null;
    UI.modal('sidePanel').hide();
  }

  // ---- item form ----
  function fieldHtml(f, v) {
    const id = `f_${f.name}`;
    const label = `<label class="form-label" for="${id}">${esc(f.label)}${f.required ? ' *' : ''}</label>`;
    if (f.type === 'select') {
      const opts = f.options(v).map((o) =>
        `<option value="${esc(o.value)}"${String(o.value) === String(v) ? ' selected' : ''}>${esc(o.label)}</option>`).join('');
      return `<div class="mb-2">${label}<select class="form-select form-select-sm" id="${id}"><option value="">Select…</option>${opts}</select></div>`;
    }
    return `<div class="mb-2">${label}<input class="form-control form-control-sm" id="${id}" type="${f.type || 'text'}"${f.type === 'number' ? ' step="1"' : ''}`
      + ` value="${esc(v ?? f.default ?? '')}" autocomplete="off"></div>`;
  }

  function openItemForm(row) {
    const E = ENTITIES[current];
    showPanel('item', row);
    $('formTitle').textContent = `${row ? 'Edit' : 'New'} ${E.singular}`;

    let html = E.fields.map((f) => fieldHtml(f, row ? row[f.name] : undefined)).join('');
    if (E.bucket) {
      html += `<div class="mb-2"><label class="form-label" for="f_photo">Photo (JPG, PNG or WebP, max 2 MB)</label>`
        + (row?.photo_path
          ? `<div class="photo-current d-flex align-items-center gap-2 mb-2"><img class="thumb" src="${esc(photoUrl(E.bucket, row.photo_path))}" alt="">`
            + `<div class="form-check mb-0"><input class="form-check-input" type="checkbox" id="f_removePhoto"><label class="form-check-label" for="f_removePhoto">Remove photo</label></div></div>`
          : '')
        + `<input class="form-control form-control-sm" type="file" id="f_photo" accept="image/jpeg,image/png,image/webp"></div>`;
    }
    html += `<div class="form-check mb-2"><input class="form-check-input" type="checkbox" id="f_is_active"${!row || row.is_active ? ' checked' : ''}><label class="form-check-label" for="f_is_active">Active</label></div>`;
    if (!row && E.price && canPrice) {   // price can be added together with a new item
      html += `<div class="form-check mb-2"><input class="form-check-input" type="checkbox" id="f_withPrice"><label class="form-check-label" for="f_withPrice">Set price now</label></div>`
        + `<div id="f_priceBox" class="hidden">`
        + `<div class="mb-2"><label class="form-label" for="f_newAmount">Amount *</label>`
        + `<input class="form-control form-control-sm" type="number" id="f_newAmount" min="0" step="any" inputmode="decimal"></div>`
        + `<div class="mb-2"><p class="form-label">Currency</p><div class="btn-group btn-group-sm" role="group" aria-label="Currency">`
        + `<input type="radio" class="btn-check" name="newCurrency" id="newCurKHR" value="KHR" checked><label class="btn btn-outline-primary" for="newCurKHR">៛ KHR</label>`
        + `<input type="radio" class="btn-check" name="newCurrency" id="newCurUSD" value="USD"><label class="btn btn-outline-primary" for="newCurUSD">$ USD</label></div></div>`
        + `<p class="small">Takes effect now. Use "Set price" later to change it or schedule a new one.</p></div>`;
    }
    $('itemFields').innerHTML = html;
    $('itemFields').querySelector('input, select')?.focus();
  }

  // ---- price / rate form ----
  function setWhen(mode) {
    document.querySelectorAll('input[name="when"]').forEach((r) => { r.checked = r.value === mode; });
    $('fWhen').classList.toggle('hidden', mode !== 'later');
    if (mode === 'later') {
      if (isSuper) $('fWhen').removeAttribute('min'); else $('fWhen').min = nowLocalInput();   // Super Admin may pick a past time
      $('fWhen').focus();
    } else { $('fWhen').value = ''; }
  }

  function openPriceForm(row) {
    const E = ENTITIES[current];
    showPanel('price', row);
    $('formTitle').textContent = 'Set price';
    $('targetLabel').textContent = E.priceName(row);
    $('fRemark').value = '';
    setWhen('now');
    const cur = currentOf(pricesOf(E, row));
    $('fAmount').value = cur ? Number(cur.amount) : '';
    document.querySelectorAll('input[name="currency"]').forEach((r) => { r.checked = r.value === (cur?.currency ?? 'KHR'); });
    updatePreview();
    $('fAmount').focus();
  }

  function openRateForm() {
    showPanel('rate');
    $('formTitle').textContent = 'New exchange rate';
    $('targetLabel').textContent = 'USD → KHR';
    $('fRemark').value = '';
    setWhen('now');
    $('fRate').value = rate ?? '';
    updatePreview();
    $('fRate').focus();
  }

  function updatePreview() {
    const el = $('preview');
    if (panel?.kind !== 'price') { el.textContent = ''; return; }
    const a = Number($('fAmount').value);
    const c = checked('currency');
    if (!(a > 0)) { el.textContent = ''; return; }
    const khr = khrOf(a, c);
    if (c === 'USD') el.textContent = khr == null ? 'No exchange rate yet: USD prices cannot be sold until one is added.' : `Sells as ${khr.toLocaleString('en-US')} ៛ (at 1 USD = ${rate.toLocaleString('en-US')} ៛, rounded down to 100).`;
    else el.textContent = khr !== a ? `Sells as ${khr.toLocaleString('en-US')} ៛ (rounded down to 100).` : '';
  }

  // ---- submit ----
  const onSubmit = (e) => { e.preventDefault(); return panel?.kind === 'item' ? saveItem() : panel ? savePrice() : undefined; };

  async function saveItem() {
    const E = ENTITIES[current];
    const editing = panel.row;

    const payload = {};
    for (const f of E.fields) {
      const raw = $(`f_${f.name}`).value.trim();
      if (f.required && !raw) return toast(`${f.label.replace(/ \(.*/, '')} is required.`);
      let val = raw === '' ? null : raw;
      if (f.type === 'number') {
        val = raw === '' ? (f.default ?? 0) : Number(raw);
        if (!Number.isInteger(val)) return toast(`${f.label} must be a whole number.`);
      }
      if (f.numeric && val !== null) val = Number(val);
      if (f.upper && val) val = val.toUpperCase();
      payload[f.name] = val;
    }
    payload.is_active = $('f_is_active').checked;

    // Optional price entered together with a new item.
    let price = null;
    if ($('f_withPrice')?.checked) {
      const raw = $('f_newAmount').value;
      const amount = Number(raw);
      if (raw === '' || !(amount >= 0)) return toast('Enter the price amount, or turn off "Set price now".');
      if (!twoDecimals(amount)) return toast('Amount can have at most 2 decimals.');
      price = { amount, currency: checked('newCurrency') };
    }

    // Photo: upload first; if saving the row then fails, the upload is removed again.
    const oldPath = editing?.photo_path ?? null;
    const removePhoto = Boolean(E.bucket && $('f_removePhoto')?.checked);
    let newPath = null;
    const file = E.bucket ? $('f_photo').files[0] : null;
    if (file) {
      if (!PHOTO_EXT[file.type]) return toast('Photo must be a JPG, PNG or WebP image.');
      if (file.size > MAX_PHOTO) return toast('Photo must be 2 MB or smaller.');
      newPath = `${crypto.randomUUID()}.${PHOTO_EXT[file.type]}`;
    }

    $('saveBtn').disabled = true;
    if (newPath) {
      const { error } = await sb.storage.from(E.bucket).upload(newPath, file, { contentType: file.type });
      if (error) { $('saveBtn').disabled = false; return toast(`Photo upload failed: ${friendly(error)}`); }
      payload.photo_path = newPath;
    } else if (removePhoto) {
      payload.photo_path = null;
    }

    const { data: saved, error } = editing
      ? await sb.from(E.table).update(payload).eq('id', editing.id)
      : await sb.from(E.table).insert(payload).select('id').single();

    if (error) {
      $('saveBtn').disabled = false;
      if (newPath) await sb.storage.from(E.bucket).remove([newPath]);
      return toast(friendly(error));
    }
    if ((newPath || removePhoto) && oldPath) await sb.storage.from(E.bucket).remove([oldPath]);

    let priceError = null;
    if (price) ({ error: priceError } = await sb.from('prices').insert({ [E.price]: saved.id, ...price }));
    $('saveBtn').disabled = false;

    closePanel();
    if (priceError) toast(`Saved, but the price was not set: ${friendly(priceError, 'price')} Use "Set price" on the row.`, 'warn', { sticky: true });
    else toast('Saved.', 'ok');
    await refresh();
  }

  async function savePrice() {
    const E = ENTITIES[current];
    const isRate = panel.kind === 'rate';

    // effective time
    let effective = null;
    if (checked('when') === 'later') {
      if (!$('fWhen').value) return toast('Pick the date and time.');
      effective = toIso($('fWhen').value);
      if (new Date(effective) <= new Date() && !isSuper) return toast('Scheduled time must be in the future.');
    }

    const remark = $('fRemark').value.trim() || null;
    let table; let payload;

    if (isRate) {
      const v = Number($('fRate').value);
      if (!(v > 0)) return toast('Enter the rate (must be more than 0).');
      if (!twoDecimals(v)) return toast('Rate can have at most 2 decimals.');
      if (!effective && v === rate) return toast('This is already the current rate.');
      table = 'exchange_rates';
      payload = { usd_to_khr: v, remark };
    } else {
      const amount = Number($('fAmount').value);
      const currency = checked('currency');
      if ($('fAmount').value === '' || !(amount >= 0)) return toast('Enter the amount.');
      if (!twoDecimals(amount)) return toast('Amount can have at most 2 decimals.');
      const cur = currentOf(pricesOf(E, panel.row));
      if (!effective && cur && Number(cur.amount) === amount && cur.currency === currency) return toast('This is already the current price.');
      table = 'prices';
      payload = { [E.price]: panel.row.id, amount, currency, remark };
    }
    if (effective) payload.effective_from = effective;

    $('saveBtn').disabled = true;
    const { error } = await sb.from(table).insert(payload);
    $('saveBtn').disabled = false;
    if (error) return toast(friendly(error, 'price'));

    closePanel();
    toast(effective && new Date(effective) > new Date() ? 'Saved. It will take effect at the scheduled time.' : 'Saved.', 'ok');
    if (isRate) await loadRate();
    await load();
  }

  // ===================================================================
  // Start
  // ===================================================================
  function selectTab(key) {
    if (!ENTITIES[key]) key = 'sizes';
    current = key;
    if (location.hash !== `#${key}`) history.replaceState(null, '', `#${key}`);
    closePanel();
    detail = null;
    $('search').value = '';
    $('listBody').innerHTML = '<tr><td class="empty">Loading…</td></tr>';
    renderTabs();
    load();
  }

  async function init(detail) {
    isSuper = detail.role === 'Super Admin';
    canEdit = detail.perms.includes('manage_catalog');
    canPrice = detail.perms.includes('manage_price');

    [$('tabs'), $('subTabs')].forEach((nav) => nav.addEventListener('click', (e) => {
      const t = e.target.closest('[data-tab]');
      if (t) selectTab(t.dataset.tab);
    }));
    $('listBody').addEventListener('click', onListClick);
    $('listBody').addEventListener('keydown', onListKey);
    $('detailActions').addEventListener('click', onActionClick);
    $('detailPanel').addEventListener('hidden.bs.modal', () => { detail = null; });
    $('search').addEventListener('input', renderList);
    $('showInactive').addEventListener('change', renderList);
    $('newBtn').addEventListener('click', () => (ENTITIES[current].isRate ? openRateForm() : openItemForm(null)));
    $('cancelBtn').addEventListener('click', closePanel);
    $('form').addEventListener('submit', onSubmit);
    $('form').addEventListener('input', updatePreview);
    $('form').addEventListener('change', (e) => {
      if (e.target.name === 'when') setWhen(e.target.value);
      if (e.target.id === 'f_withPrice') {
        $('f_priceBox').classList.toggle('hidden', !e.target.checked);
        if (e.target.checked) $('f_newAmount').focus();
      }
    });
    window.addEventListener('hashchange', () => selectTab(location.hash.slice(1)));

    await Promise.all([loadLookups(), loadRate()]);
    selectTab(location.hash.slice(1));
  }

  window.addEventListener('app:ready', (e) => init(e.detail), { once: true });
})();
