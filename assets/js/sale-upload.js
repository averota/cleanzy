// assets/js/sale-upload.js
// Sales upload (modal): 1) download the Excel template  2) choose the filled file  3) preview + check  4) confirm upload.
// Self-contained: injects its own modal, wires the #uploadBtn button and starts on `app:ready` (like sales.js).
// Load AFTER sidebar.js and ui.js (before or after sales.js). Needs Bootstrap JS, supabase-js (sb) and the Excel library (loaded on first use).
//
// File layout: one row per item line. Rows with the same Group ID become ONE receipt.
//   Receipt fields (date, time, payment, plate, customer, remark, receipt discount, adjustment) are read from the
//   first filled row of the group; later rows may leave them blank (if filled they must match).
// Writes only through the database function create_sale (same as the New sale form), so prices, rounding and
// permission rules are applied by the database. Uploaded sales are saved as Pending.
// Free-price items (catalog price 0): the optional "Price (KHR)" column gives the price (0 or a multiple of 100 riel; blank = 0).
// It is refused for any item whose catalog price is not 0.
(() => {
  const { $, esc, toast, todayStr, TZ } = UI;

  const MAX_ROWS = 2000;
  const MAX_BYTES = 5 * 1024 * 1024;
  const nowTime = () => new Date().toLocaleTimeString('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const pad = (n) => String(n).padStart(2, '0');

  let can = () => false;
  let groups = [];
  let busy = false;
  let readSeq = 0;

  // ===================================================================
  // Columns (single source of truth for template, instructions and reading)
  // scope: 'receipt' = taken from the first filled row of the group, 'line' = every row, 'both' = every row (Group ID)
  // ===================================================================
  const FIELDS = [
    { key: 'group',     label: 'Group ID',               req: 'Required',                      scope: 'both',    hint: 'Any text or number. Rows with the same Group ID form one receipt.', ex: '1' },
    { key: 'date',      label: 'Date',                   req: 'Required (once per receipt)',   scope: 'receipt', hint: 'YYYY-MM-DD. Not in the future. Past dates need the back-dating permission.', ex: todayStr() },
    { key: 'time',      label: 'Time',                   req: 'Optional',                      scope: 'receipt', hint: 'HH:MM (24 hour). Blank = current time. Not in the future for today.', ex: '14:30' },
    { key: 'payment',   label: 'Payment',                req: 'Required (once per receipt)',   scope: 'receipt', hint: 'Cash or Bank', ex: 'Cash' },
    { key: 'plate',     label: 'Plate No',               req: 'Optional',                      scope: 'receipt', hint: 'If filled, only one motorbike with quantity 1 is allowed.', ex: '2AB-1234' },
    { key: 'customer',  label: 'Customer',               req: 'Optional',                      scope: 'receipt', hint: 'Customer name or ID.', ex: 'Sok' },
    { key: 'remark',    label: 'Remark',                 req: 'Optional',                      scope: 'receipt', hint: 'Free text.', ex: '' },
    { key: 'category',  label: 'Category',               req: 'Required',                      scope: 'line',    hint: 'Motorbike, Add-on, Helmet or Food & Drink', ex: 'Motorbike' },
    { key: 'item',      label: 'Item',                   req: 'Required',                      scope: 'line',    hint: 'Exact name from the "Lists" sheet for that Category (Motorbike = size code).', ex: '' },
    { key: 'qty',       label: 'Quantity',               req: 'Required',                      scope: 'line',    hint: 'Whole number, 1 or more.', ex: '1' },
    { key: 'price',     label: 'Price (KHR)',            req: 'Optional',                      scope: 'line',    hint: 'Only for items marked "Price 0" on the Lists sheet: the price in riel, 0 or a multiple of 100. Blank = 0. Leave empty for all other items.', ex: '' },
    { key: 'idtype',    label: 'Item Discount Type',     req: 'Optional',                      scope: 'line',    hint: 'Percent or Amount. Needs Item Discount Value.', ex: 'Percent' },
    { key: 'idval',     label: 'Item Discount Value',    req: 'Optional',                      scope: 'line',    hint: 'Percent: 0-100. Amount: riel.', ex: '10' },
    { key: 'idreason',  label: 'Item Discount Reason',   req: 'Optional',                      scope: 'line',    hint: 'Free text.', ex: '' },
    { key: 'rdtype',    label: 'Receipt Discount Type',  req: 'Optional',                      scope: 'receipt', hint: 'Percent or Amount. Applies to the whole receipt. Needs Receipt Discount Value.', ex: '' },
    { key: 'rdval',     label: 'Receipt Discount Value', req: 'Optional',                      scope: 'receipt', hint: 'Percent: 0-100. Amount: riel.', ex: '' },
    { key: 'rdreason',  label: 'Receipt Discount Reason', req: 'Optional',                     scope: 'receipt', hint: 'Free text.', ex: '' },
    { key: 'adj',       label: 'Adjustment (KHR)',       req: 'Optional',                      scope: 'receipt', hint: 'Whole number, multiple of 100. + extra / - short. Blank = 0.', ex: '' },
    { key: 'adjreason', label: 'Adjustment Reason',      req: 'Optional',                      scope: 'receipt', hint: 'Required when Adjustment is not 0.', ex: '' }
  ];
  const isReq = (f) => f.req.startsWith('Required');
  const headerText = (f) => f.label + (isReq(f) ? ' *' : '');
  const RECEIPT = FIELDS.filter((f) => f.scope === 'receipt');

  const CATS = {
    motorbike: { title: 'Motorbike' },
    addon: { title: 'Add-on' },
    helmet: { title: 'Helmet' },
    food: { title: 'Food & Drink' }
  };
  const CAT_ALIAS = { motorbike: 'motorbike', addon: 'addon', helmet: 'helmet', food: 'food', fooddrink: 'food', foodanddrink: 'food' };

  // ===================================================================
  // Small parsers
  // ===================================================================
  const toStr = (v) => (v == null ? '' : String(v).trim());
  const key = (s) => toStr(s).toLowerCase().replace(/[^a-z0-9]/g, '');   // header / category matching
  const norm = (s) => toStr(s).toLowerCase().replace(/\s+/g, ' ');       // item name matching
  const num = (v) => {
    const s = toStr(v).replace(/,/g, '');
    return s !== '' && Number.isFinite(Number(s)) ? Number(s) : NaN;
  };

  function parseDate(v) {   // 'YYYY-MM-DD' text or an Excel date number -> 'YYYY-MM-DD' or null
    if (typeof v === 'number') return v >= 1 ? new Date((Math.floor(v) - 25569) * 864e5).toISOString().slice(0, 10) : null;
    const s = toStr(v);
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
    if (!m) return null;
    return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).toISOString().slice(0, 10) === s ? s : null;
  }

  function parseTime(v) {   // 'HH:MM' text or an Excel time number -> 'HH:MM' or null
    if (typeof v === 'number') {
      if (!(v >= 0 && v < 1)) return null;
      const t = Math.round(v * 1440) % 1440;
      return `${pad(Math.floor(t / 60))}:${pad(t % 60)}`;
    }
    const m = /^(\d{1,2}):(\d{2})(:\d{2})?$/.exec(toStr(v));
    return m && +m[1] < 24 && +m[2] < 60 ? `${pad(+m[1])}:${m[2]}` : null;
  }

  function parseDiscount(typeRaw, valRaw, label, errs) {   // null = none (or invalid: an error is added)
    const t = toStr(typeRaw).toLowerCase();
    const v = toStr(valRaw);
    if (!t && !v) return null;
    const type = { percent: 'Percent', '%': 'Percent', amount: 'Amount' }[t];
    if (!type) { errs.push(`${label}: type must be Percent or Amount.`); return null; }
    const n = num(valRaw);
    if (!(n >= 0)) { errs.push(`${label}: enter a value of 0 or more.`); return null; }
    if (type === 'Percent' && n > 100) { errs.push(`${label}: percent cannot be more than 100.`); return null; }
    return n > 0 ? { type, value: n } : null;
  }

  // ===================================================================
  // Excel library + product catalog (loaded on first use)
  // ===================================================================
  let xlsxPromise = null;
  function loadXlsx() {
    if (window.XLSX) return Promise.resolve();
    xlsxPromise ??= new Promise((resolve, reject) => {
      const el = document.createElement('script');
      el.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
      el.onload = resolve;
      el.onerror = () => { xlsxPromise = null; reject(new Error('Could not load the Excel library. Check your internet connection.')); };
      document.head.appendChild(el);
    });
    return xlsxPromise;
  }

  // Active items the New sale form offers: { motorbike, addon, helmet, food } -> [{ field, id, label, group, k }]
  let catalogPromise = null;
  function loadCatalog() {
    catalogPromise ??= (async () => {
      const act = (q) => q.eq('is_active', true);
      const res = await Promise.all([
        act(sb.from('motorbike_sizes').select('id, code').order('sort_order')),
        act(sb.from('addon_services').select('id, description').order('description')),
        act(sb.from('helmet_services').select('id, description').order('description')),
        act(sb.from('food_drink_categories').select('id, kind, name').order('sort_order')),
        act(sb.from('food_drink_items').select('id, category_id, description').order('description')),
        sb.from('current_prices').select('motorbike_size_id, addon_service_id, helmet_service_id, food_drink_item_id, amount')
      ]);
      const failed = res.find((r) => r.error);
      if (failed) throw new Error(failed.error.message);
      const [sizes, addons, helmets, cats, foods, prices] = res.map((r) => r.data);

      // Items whose current price is 0: the file may give their price.
      const freeSet = new Set(prices.filter((p) => Number(p.amount) === 0).map((p) =>
        (p.motorbike_size_id != null ? `motorbike_size_id:${p.motorbike_size_id}`
          : p.addon_service_id ? `addon_service_id:${p.addon_service_id}`
          : p.helmet_service_id ? `helmet_service_id:${p.helmet_service_id}`
          : `food_drink_item_id:${p.food_drink_item_id}`)));
      const o = (field, id, label, group = '') => ({ field, id, label: String(label), group, k: norm(label), free: freeSet.has(`${field}:${id}`) });
      const catName = Object.fromEntries(cats.map((c) => [c.id, `${c.kind} – ${c.name}`]));
      return {
        motorbike: sizes.map((s) => o('motorbike_size_id', s.id, s.code)),
        addon: addons.map((a) => o('addon_service_id', a.id, a.description)),
        helmet: helmets.map((h) => o('helmet_service_id', h.id, h.description)),
        food: cats.flatMap((c) => foods.filter((f) => f.category_id === c.id))
          .map((f) => o('food_drink_item_id', f.id, f.description, catName[f.category_id]))
      };
    })().catch((err) => { catalogPromise = null; throw err; });
    return catalogPromise;
  }

  // ===================================================================
  // Step 1: template
  // ===================================================================
  async function downloadTemplate() {
    const btn = $('upTemplateBtn');
    btn.disabled = true;
    try {
      const [cat] = await Promise.all([loadCatalog(), loadXlsx()]);
      const wb = XLSX.utils.book_new();

      // Sheet 1: the sheet to fill in (* in the header = required)
      const heads = FIELDS.map(headerText);
      const ws = XLSX.utils.aoa_to_sheet([heads]);
      ws['!cols'] = heads.map((h) => ({ wch: Math.max(14, h.length + 2) }));
      XLSX.utils.book_append_sheet(wb, ws, 'Sales');

      // Sheet 2: field guide with Required / Optional indicator
      const example = FIELDS.map((f) => (f.key === 'item' ? (cat.motorbike[0]?.label ?? '') : f.ex));
      const guide = [
        ['HOW TO FILL THE "Sales" SHEET'],
        ['* in a column title = required. All other columns are optional.'],
        ['One row per item line. Rows with the same Group ID are saved as ONE receipt.'],
        ['Receipt fields (marked "Receipt") only need to be filled on the first row of each receipt.'],
        ['Uploaded sales are saved as Pending. Prices are applied by the system when saved; do not enter receipt numbers. Only items marked "Price 0" on the Lists sheet take a price in the Price (KHR) column.'],
        ['Keep the column titles in row 1 unchanged. Accepted file types: .xlsx, .csv'],
        [],
        ['Column', 'Required / Optional', 'Applies to', 'Format / allowed values', 'Example'],
        ...FIELDS.map((f, i) => [f.label, f.req, f.scope === 'receipt' ? 'Receipt (first row)' : 'Item line (every row)', f.hint, example[i]])
      ];
      const wg = XLSX.utils.aoa_to_sheet(guide);
      wg['!cols'] = [{ wch: 26 }, { wch: 28 }, { wch: 22 }, { wch: 80 }, { wch: 14 }];
      XLSX.utils.book_append_sheet(wb, wg, 'Instructions');

      // Sheet 3: valid Category / Item values
      const lists = [['Category', 'Item', 'Group', 'Price 0']];
      Object.keys(CATS).forEach((c) => cat[c].forEach((x) => lists.push([CATS[c].title, x.label, x.group, x.free ? 'Price 0 - enter Price (KHR)' : ''])));
      const wl = XLSX.utils.aoa_to_sheet(lists);
      wl['!cols'] = [{ wch: 16 }, { wch: 44 }, { wch: 30 }, { wch: 28 }];
      XLSX.utils.book_append_sheet(wb, wl, 'Lists');

      XLSX.writeFile(wb, 'sales_upload_template.xlsx');
    } catch (err) {
      toast(`Could not create the template: ${err.message}`);
    } finally {
      btn.disabled = false;
    }
  }

  // ===================================================================
  // Step 3: read the file, check every receipt
  // ===================================================================
  function validateGroup(g, cat) {
    const errs = g.errors;
    const rows = g.rows;
    if (g.noId) errs.push(`Row ${rows[0].n}: Group ID is missing.`);

    // Receipt-level fields: first filled value; later rows must match.
    const head = {};
    RECEIPT.forEach((f) => {
      const filled = rows.filter((r) => toStr(r.v[f.key]) !== '');
      if (new Set(filled.map((r) => toStr(r.v[f.key]).toLowerCase())).size > 1) {
        errs.push(`${f.label} is different on rows ${filled.map((r) => r.n).join(', ')}.`);
      }
      head[f.key] = filled[0]?.v[f.key] ?? '';
    });

    const today = todayStr();
    let date = '';
    if (toStr(head.date) === '') errs.push('Date is required.');
    else if (!(date = parseDate(head.date))) errs.push('Date must be YYYY-MM-DD.');
    else if (date > today) errs.push('Sale date cannot be in the future.');
    else if (date < today && !can('backdate_revenue')) errs.push('You are not allowed to back-date sales.');

    let time = null;
    if (toStr(head.time) !== '') {
      time = parseTime(head.time);
      if (!time) errs.push('Time must be HH:MM.');
      else if (date === today && time > nowTime()) errs.push('Sale time cannot be in the future.');
    }

    const payment = { cash: 'Cash', bank: 'Bank' }[toStr(head.payment).toLowerCase()];
    if (!payment) errs.push(toStr(head.payment) === '' ? 'Payment is required (Cash or Bank).' : 'Payment must be Cash or Bank.');

    const rd = parseDiscount(head.rdtype, head.rdval, 'Receipt discount', errs);

    let adj = 0;
    if (toStr(head.adj) !== '') {
      adj = num(head.adj);
      if (!Number.isInteger(adj) || adj % 100 !== 0) { errs.push('Adjustment must be a whole number, multiple of 100.'); adj = 0; }
    }
    if (adj !== 0 && toStr(head.adjreason) === '') errs.push('Adjustment reason is required.');

    // Item lines
    rows.forEach((r) => {
      const at = `Row ${r.n}: `;
      const c = CAT_ALIAS[key(r.v.category)];
      const name = toStr(r.v.item);
      if (toStr(r.v.category) === '') errs.push(`${at}Category is required.`);
      else if (!c) errs.push(`${at}Category "${toStr(r.v.category)}" is not valid (Motorbike, Add-on, Helmet or Food & Drink).`);
      if (name === '') errs.push(`${at}Item is required.`);

      const q = num(r.v.qty);
      if (!Number.isInteger(q) || q < 1 || q > 32767) errs.push(`${at}Quantity must be a whole number of 1 or more.`);

      const priceRaw = toStr(r.v.price);
      let price = 0;
      if (priceRaw !== '') {
        price = num(r.v.price);
        if (!Number.isInteger(price) || price < 0 || price % 100 !== 0) { errs.push(`${at}Price must be 0 or a multiple of 100 riel.`); price = 0; }
      }

      const disc = parseDiscount(r.v.idtype, r.v.idval, `${at}Item discount`, errs);

      if (c && name !== '') {
        const hits = cat[c].filter((x) => x.k === norm(name));
        if (!hits.length) errs.push(`${at}"${name}" is not an active ${CATS[c].title} item (see the Lists sheet).`);
        else if (hits.length > 1) errs.push(`${at}"${name}" matches more than one ${CATS[c].title} item; rename one of them in the catalog.`);
        else if (priceRaw !== '' && !hits[0].free) errs.push(`${at}Price can only be entered for items priced 0; "${name}" has a fixed price.`);
        else if (Number.isInteger(q) && q >= 1) {
          g.items.push({ c, field: hits[0].field, id: hits[0].id, label: hits[0].label, free: hits[0].free, price, qty: q, disc, reason: toStr(r.v.idreason) || null });
        }
      }
    });

    const plate = toStr(head.plate);
    const bikes = g.items.filter((i) => i.c === 'motorbike');
    if (plate && (bikes.length > 1 || bikes.some((i) => i.qty > 1))) errs.push('A plate number allows only one motorbike (quantity 1).');

    g.view = { date: date || toStr(head.date), time: time || toStr(head.time), payment: payment || toStr(head.payment), plate, customer: toStr(head.customer), remark: toStr(head.remark), rd, adj };

    if (!errs.length) {
      g.params = {
        p_items: g.items.map((i) => ({
          [i.field]: i.id,
          quantity: i.qty,
          ...(i.free ? { unit_price_khr: i.price } : {}),   // typed price for an item priced 0 (the database re-checks it)
          discount_type: i.disc?.type ?? null,
          discount_value: i.disc?.value ?? null,
          discount_reason: i.disc ? i.reason : null
        })),
        p_payment_method: payment,
        p_plate_no: plate || null,
        p_customer: toStr(head.customer) || null,
        p_discount_type: rd?.type ?? null,
        p_discount_value: rd?.value ?? null,
        p_discount_reason: toStr(head.rdreason) || null,
        p_remark: toStr(head.remark) || null,
        p_sale_date: date,
        p_adjustment_khr: adj,
        p_adjustment_reason: toStr(head.adjreason) || null,
        p_sale_time: time
      };
    }
    g.status = errs.length ? 'error' : 'ready';
    return g;
  }

  function buildGroups(rows, cat) {
    const map = new Map();
    rows.forEach((r) => {
      const gid = toStr(r.v.group);
      const k = gid || `__row${r.n}`;
      if (!map.has(k)) map.set(k, { label: gid || `Row ${r.n}`, noId: !gid, rows: [], errors: [], items: [], status: 'ready', msg: '', params: null, view: null });
      map.get(k).rows.push(r);
    });
    return [...map.values()].map((g) => validateGroup(g, cat));
  }

  async function onFile() {
    const file = $('upFile').files[0];
    clearPreview();
    if (!file) return;
    if (file.size > MAX_BYTES) { $('upFile').value = ''; return toast('The file is too large (limit 5 MB).'); }

    const my = ++readSeq;
    $('upStatus').textContent = 'Reading the file…';
    try {
      const [cat] = await Promise.all([loadCatalog(), loadXlsx()]);
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', codepage: 65001 });
      const ws = wb.Sheets[wb.SheetNames.includes('Sales') ? 'Sales' : wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true, blankrows: true });
      if (my !== readSeq) return;

      const col = {};   // field key -> column index
      (aoa[0] || []).forEach((h, i) => {
        const f = FIELDS.find((x) => key(x.label) === key(h));
        if (f && col[f.key] == null) col[f.key] = i;
      });
      const missing = FIELDS.filter((f) => isReq(f) && col[f.key] == null).map((f) => f.label);
      if (missing.length) throw new Error(`Missing column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Use the template.`);

      const rows = [];
      aoa.slice(1).forEach((cells, i) => {
        if (cells.every((c) => toStr(c) === '')) return;
        const v = {};
        FIELDS.forEach((f) => { v[f.key] = col[f.key] == null ? '' : cells[col[f.key]]; });
        rows.push({ n: i + 2, v });
      });
      if (!rows.length) throw new Error('The file has no data rows.');
      if (rows.length > MAX_ROWS) throw new Error(`Too many rows (${rows.length}). Upload at most ${MAX_ROWS} rows at a time.`);

      groups = buildGroups(rows, cat);
      renderPreview();
    } catch (err) {
      if (my !== readSeq) return;
      $('upFile').value = '';
      $('upStatus').textContent = '';
      toast(`Could not read the file: ${err.message}`, 'error', { sticky: true });
    }
  }

  // ===================================================================
  // Preview
  // ===================================================================
  const itemHtml = (i) => `${esc(i.label)} ×${i.qty}${i.free ? ` <span class="text-body-secondary">@ ${i.price.toLocaleString('en-US')} ៛</span>` : ''}${i.disc ? ` <span class="text-body-secondary">(−${i.disc.value.toLocaleString('en-US')}${i.disc.type === 'Percent' ? '%' : ' ៛'})</span>` : ''}`;

  function statusHtml(g) {
    if (g.status === 'ready') return '<span class="badge text-bg-success">Ready</span>';
    if (g.status === 'saved') return '<span class="badge text-bg-primary">Saved</span>';
    if (g.status === 'failed') return `<span class="badge text-bg-danger">Failed</span><div class="small text-danger">${esc(g.msg)}</div>`;
    return `<span class="badge text-bg-danger">Skipped</span><ul class="small text-danger mb-0 ps-3">${g.errors.map((e) => `<li>${esc(e)}</li>`).join('')}</ul>`;
  }

  function groupRowHtml(g, idx) {
    const v = g.view;
    const notes = [
      v.rd ? `Receipt discount −${v.rd.value.toLocaleString('en-US')}${v.rd.type === 'Percent' ? '%' : ' ៛'}` : '',
      v.adj ? `Adjustment ${v.adj > 0 ? '+' : '−'}${Math.abs(v.adj).toLocaleString('en-US')} ៛` : '',
      v.remark ? esc(v.remark) : ''
    ].filter(Boolean).join(' · ');
    const buyer = [v.plate, v.customer].filter(Boolean).map(esc).join('<br>') || '—';
    return `<tr data-i="${idx}">
      <td>${esc(g.label)}<br><span class="small text-body-secondary">${g.rows.length} line${g.rows.length === 1 ? '' : 's'}</span></td>
      <td>${esc(v.date) || '—'}<br><span class="small text-body-secondary">${esc(v.time) || 'now'}</span></td>
      <td>${esc(v.payment) || '—'}</td>
      <td>${buyer}</td>
      <td>${g.items.map(itemHtml).join('<br>') || '—'}${notes ? `<br><span class="small text-body-secondary">${notes}</span>` : ''}</td>
      <td class="up-status">${statusHtml(g)}</td>
    </tr>`;
  }

  function updateSummary() {
    const n = (s) => groups.filter((g) => g.status === s).length;
    const lines = groups.reduce((t, g) => t + g.rows.length, 0);
    const parts = [`${groups.length} receipt${groups.length === 1 ? '' : 's'} (${lines} line${lines === 1 ? '' : 's'})`];
    if (n('ready')) parts.push(`${n('ready')} ready`);
    if (n('saved')) parts.push(`${n('saved')} saved`);
    if (n('failed')) parts.push(`${n('failed')} failed`);
    if (n('error')) parts.push(`${n('error')} with errors (skipped)`);
    $('upStatus').textContent = parts.join(' · ');

    const todo = n('ready') + n('failed');
    $('upConfirm').disabled = busy || todo === 0;
    $('upConfirm').textContent = todo ? `${n('failed') ? 'Retry / upload' : 'Upload'} ${todo} receipt${todo === 1 ? '' : 's'}` : (n('saved') ? 'Done' : 'Upload');
  }

  function renderPreview() {
    $('upBody').innerHTML = groups.map(groupRowHtml).join('');
    $('upPreview').classList.remove('hidden');
    updateSummary();
  }

  function clearPreview() {
    readSeq += 1;
    groups = [];
    $('upBody').innerHTML = '';
    $('upPreview').classList.add('hidden');
    $('upStatus').textContent = '';
    $('upProgress').textContent = '';
    $('upConfirm').disabled = true;
    $('upConfirm').textContent = 'Upload';
  }

  // ===================================================================
  // Step 4: confirm upload (one create_sale call per receipt, in file order)
  // ===================================================================
  function setBusy(on) {
    busy = on;
    ['upFile', 'upTemplateBtn', 'upCancel', 'upClose'].forEach((id) => { $(id).disabled = on; });
    $('upConfirm').disabled = on;
  }

  async function doUpload() {
    const todo = groups.filter((g) => g.status === 'ready' || g.status === 'failed');
    if (!todo.length) return;
    if (!confirm(`Upload ${todo.length} receipt${todo.length === 1 ? '' : 's'} as Pending?`)) return;

    setBusy(true);
    let ok = 0;
    for (const [i, g] of todo.entries()) {
      $('upProgress').textContent = `Uploading ${i + 1} / ${todo.length}…`;
      let error = null;
      try {
        ({ error } = await sb.rpc('create_sale', g.params));
      } catch (err) {
        error = err;
      }
      if (error) { g.status = 'failed'; g.msg = error.message || 'Unknown error'; } else { g.status = 'saved'; g.msg = ''; ok += 1; }
      const cell = $('upBody').querySelector(`tr[data-i="${groups.indexOf(g)}"] .up-status`);
      if (cell) cell.innerHTML = statusHtml(g);
    }
    $('upProgress').textContent = '';
    setBusy(false);
    updateSummary();

    const failed = todo.length - ok;
    if (failed) toast(`Saved ${ok} of ${todo.length} receipts. ${failed} failed: see the Status column.`, 'error', { sticky: true });
    else toast(`${ok} receipt${ok === 1 ? '' : 's'} uploaded (Pending).`, 'ok');
  }

  // ===================================================================
  // Modal + start
  // ===================================================================
  const MARKUP = `
<div class="modal fade" id="uploadModal" tabindex="-1" aria-labelledby="uploadTitle" aria-hidden="true" data-bs-backdrop="static">
  <div class="modal-dialog modal-xl modal-dialog-centered modal-dialog-scrollable modal-fullscreen-lg-down">
    <div class="modal-content">
      <div class="modal-header">
        <h2 class="modal-title h6" id="uploadTitle">Upload sales</h2>
        <button type="button" class="btn-close" id="upClose" data-bs-dismiss="modal" aria-label="Close"></button>
      </div>
      <div class="modal-body">
        <div class="mb-3">
          <p class="fw-semibold mb-1">1. Download the template</p>
          <p class="small text-body-secondary mb-2">Column titles marked <strong>*</strong> are required; the others are optional. The template also has an Instructions sheet and a Lists sheet with the valid items.</p>
          <button type="button" class="btn btn-sm btn-outline-secondary" id="upTemplateBtn">Download template (.xlsx)</button>
        </div>
        <div class="mb-3">
          <p class="fw-semibold mb-1">2. Choose your filled file</p>
          <input class="form-control form-control-sm" type="file" id="upFile" accept=".xlsx,.csv" aria-label="Sales file (.xlsx or .csv)">
        </div>
        <div class="hidden" id="upPreview">
          <p class="fw-semibold mb-1">3. Check the preview</p>
          <p class="small mb-2" id="upStatus"></p>
          <div class="table-responsive border rounded" style="max-height:45vh">
            <table class="table table-sm align-middle mb-0">
              <thead class="table-light" style="position:sticky;top:0;z-index:1">
                <tr><th>Group</th><th>Date / Time</th><th>Payment</th><th>Plate / Customer</th><th>Items</th><th>Status</th></tr>
              </thead>
              <tbody id="upBody"></tbody>
            </table>
          </div>
          <p class="small text-body-secondary mt-2 mb-0">Receipts with errors are skipped; fix the file and upload it again for those. Uploaded sales are saved as Pending, and totals are calculated by the system when saved.</p>
        </div>
      </div>
      <div class="modal-footer">
        <span class="small me-auto" id="upProgress"></span>
        <button type="button" class="btn btn-outline-secondary btn-sm" id="upCancel" data-bs-dismiss="modal">Close</button>
        <button type="button" class="btn btn-primary btn-sm" id="upConfirm" disabled>Upload</button>
      </div>
    </div>
  </div>
</div>`;

  function init(detail) {
    can = (k) => detail.perms.includes(k);
    const btn = $('uploadBtn');
    if (!btn || !can('enter_revenue')) return;   // same permission as "New sale"
    btn.classList.remove('hidden');

    document.body.insertAdjacentHTML('beforeend', MARKUP);
    const m = UI.modal('uploadModal');
    $('uploadModal').addEventListener('hide.bs.modal', (e) => { if (busy) e.preventDefault(); });
    $('uploadModal').addEventListener('hidden.bs.modal', () => { $('upFile').value = ''; clearPreview(); });

    btn.addEventListener('click', () => { $('upFile').value = ''; clearPreview(); m.show(); });
    $('upTemplateBtn').addEventListener('click', downloadTemplate);
    $('upFile').addEventListener('change', onFile);
    $('upConfirm').addEventListener('click', doUpload);
  }

  window.addEventListener('app:ready', (e) => init(e.detail), { once: true });
})();
