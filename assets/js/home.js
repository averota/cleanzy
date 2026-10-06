// assets/js/home.js
// Home page: greeting, quick actions, and today's sales at a glance.
// Reads: sales (+ sale_items) for today. Shown only to users who can enter revenue or view reports.
// Clicking a latest-sales row opens the receipt details (read-only) with the shared SaleForm (sale-form.js).
// Load AFTER sidebar.js (it fires `app:ready`) and sale-form.js.
(() => {
  const { $, esc, toast, badge, fetchAll, TZ, fmt, todayStr } = UI;
  const RECENT = 8;   // latest sales shown
  const SELECT = 'id, receipt_no, status, payment_method, total_khr, sale_time, sale_items(line_no, description, quantity)';

  const hhmm = (t) => (t || '').slice(0, 5);
  const sum = (rows, key = 'total_khr') => rows.reduce((s, r) => s + Number(r[key]), 0);

  function greeting() {
    const h = Number(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
    return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  }

  function renderStats(rows) {
    const live = rows.filter((r) => r.status !== 'Voided');
    const pending = rows.filter((r) => r.status === 'Pending');
    const by = (m) => sum(live.filter((r) => r.payment_method === m));

    $('statNet').textContent = fmt(sum(live));
    $('statNetSub').textContent = `${live.length} receipt${live.length === 1 ? '' : 's'}`;
    $('statCash').textContent = fmt(by('Cash'));
    $('statBank').textContent = fmt(by('Bank'));
    $('statPending').textContent = String(pending.length);
    $('statPendingSub').textContent = pending.length ? fmt(sum(pending)) : 'All confirmed';
  }

  function renderRecent(rows) {
    $('recentBody').innerHTML = rows.length
      ? rows.slice(0, RECENT).map((r) => {
        const items = [...(r.sale_items || [])]
          .sort((a, b) => a.line_no - b.line_no)
          .map((i) => `${esc(i.description)} ×${i.quantity}`)
          .join(', ');
        return `<tr class="row-click${r.status === 'Voided' ? ' row-voided' : ''}" data-id="${r.id}" tabindex="0" title="View details">
          <td>#${r.receipt_no}<br><span class="small">${hhmm(r.sale_time)} · ${esc(r.payment_method)}</span></td>
          <td>${items}</td>
          <td class="num">${fmt(r.total_khr)}</td>
          <td>${badge(r.status)}</td>
        </tr>`;
      }).join('')
      : '<tr><td colspan="4" class="empty">No sales yet today.</td></tr>';
  }

  let loadSeq = 0;
  async function load() {
    const my = ++loadSeq;
    let rows;
    try {
      rows = await fetchAll(() => sb.from('sales').select(SELECT)
        .eq('sale_date', todayStr())
        .order('sale_time', { ascending: false })
        .order('receipt_no', { ascending: false }));
    } catch (err) {
      if (my === loadSeq) toast(`Could not load today's sales: ${err.message}`);
      return;
    }
    if (my !== loadSeq) return;
    renderStats(rows);
    renderRecent(rows);
  }

  function init(detail) {
    const { name, perms } = detail;
    const can = (key) => perms.includes(key);

    $('greeting').textContent = `${greeting()}, ${name.trim().split(/\s+/)[0]}`;
    $('todayLabel').textContent = new Date(`${todayStr()}T00:00:00`)
      .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

    // Quick actions: only what this user may open.
    const actions = [];
    if (can('enter_revenue')) actions.push('<a class="btn btn-primary" href="sales.html">+ New sale</a>');
    if (can('view_report')) actions.push('<a class="btn btn-outline-secondary" href="reports.html">View reports</a>');
    $('quickActions').innerHTML = actions.join('');

    if (!can('enter_revenue') && !can('view_report')) return;   // nothing to show for sales
    $('todayBlock').classList.remove('hidden');

    SaleForm.init(detail, { onSaved: load });
    const openRow = (el) => { const tr = el.closest('tr[data-id]'); if (tr) SaleForm.open(tr.dataset.id, { view: true }); };
    $('recentBody').addEventListener('click', (e) => openRow(e.target));
    $('recentBody').addEventListener('keydown', (e) => { if (e.key === 'Enter') openRow(e.target); });
    load();
    RealtimeSync.watch({ name: 'home', tables: ['sales', 'sale_items'], onChange: load });
  }

  window.addEventListener('app:ready', (e) => init(e.detail), { once: true });
})();
