// assets/js/users.js
// Users page: list, create, edit, (de)activate and delete users, plus the role-permission grid.
//   - Reading users and permissions: direct table queries (RLS: Admin / Super Admin only for users).
//   - Creating / changing / deleting users: Edge Functions create-user and manage-user.
//   - Permission grid: inserts / deletes rows in role_permissions (RLS: Admin / Super Admin).
// Load AFTER sidebar.js (it fires `app:ready`).
(() => {
  const TZ = 'Asia/Phnom_Penh';
  const MIN_PASSWORD = 8;
  const EMAIL_RE = /^\S+@\S+\.\S+$/;

  const { $, esc, toast, badge } = UI;
  const dateStr = (iso) => new Date(iso).toLocaleDateString('en-GB', { timeZone: TZ, day: '2-digit', month: 'short', year: 'numeric' });
  const role = () => document.querySelector('input[name="role"]:checked')?.value ?? '';

  // Random password: 12 characters with upper, lower and digits; look-alike characters (0/O, 1/l/I) left out.
  function generatePassword(len = 12) {
    const SETS = ['abcdefghijkmnpqrstuvwxyz', 'ABCDEFGHJKLMNPQRSTUVWXYZ', '23456789'];
    const all = SETS.join('');
    const rnd = (n) => {   // unbiased random integer in [0, n)
      const limit = Math.floor(0x100000000 / n) * n;
      const buf = new Uint32Array(1);
      do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
      return buf[0] % n;
    };
    const chars = SETS.map((set) => set[rnd(set.length)]);   // at least one of each kind
    while (chars.length < len) chars.push(all[rnd(all.length)]);
    for (let i = chars.length - 1; i > 0; i -= 1) { const j = rnd(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
    return chars.join('');
  }

  // Fills the password box with a fresh password and shows it, so the admin can read / copy it.
  function fillPassword() {
    $('uPassword').value = generatePassword();
    $('uPassword').type = 'text';
    const eye = document.querySelector('.password-toggle-btn');
    eye.classList.add('is-visible');
    eye.setAttribute('aria-pressed', 'true');
  }

  async function copyPassword() {
    try {
      await navigator.clipboard.writeText($('uPassword').value);
      toast('Password copied.', 'ok');
    } catch (_) {
      toast('Could not copy automatically. Select the password and copy it.');
    }
  }

  // Calls an Edge Function and turns any failure into an Error with a readable message.
  async function callFn(name, body) {
    const { data, error } = await sb.functions.invoke(name, { body });
    if (!error) return data;

    let msg = error.message;
    if (error.name === 'FunctionsFetchError') {
      msg = `Could not reach the "${name}" function. Check that it is deployed.`;
    } else {
      try { const j = await error.context.json(); if (j?.error) msg = j.error; } catch (_) { /* keep generic message */ }
    }
    throw new Error(msg);
  }

  let me;
  let rows = [];
  let editing = null;   // user being edited, or null for a new one

  const nameOf = (id) => (id === null ? 'Admin' : (rows.find((r) => r.id === id)?.name ?? '—'));  // NULL = Super Admin
  const isSelf = (r) => r.id === me.user.id;

  // ===================================================================
  // Users list
  // ===================================================================
  async function load() {
    const { data, error } = await sb.from('users').select('*').order('name');
    if (error) { toast(`Could not load users: ${error.message}`, 'error', { sticky: true }); return; }
    rows = data || [];
    renderList();
  }

  function renderList() {
    const term = $('search').value.trim().toLowerCase();
    const list = rows.filter((r) => ($('showInactive').checked || r.is_active)
      && (!term || [r.name, r.position, r.email, r.role].join(' ').toLowerCase().includes(term)));

    $('listBody').innerHTML = list.length ? list.map((r) => `
      <tr class="${r.is_active ? '' : 'row-inactive'}">
        <td>${esc(r.name)}${isSelf(r) ? ' <span class="small">(you)</span>' : ''}${r.position ? `<br><span class="small">${esc(r.position)}</span>` : ''}</td>
        <td>${esc(r.email)}</td>
        <td>${esc(r.role)}</td>
        <td>${badge(r.is_active ? 'Active' : 'Inactive')}</td>
        <td>${dateStr(r.updated_at)}<br><span class="small">by ${esc(nameOf(r.updated_by))}</span></td>
        <td><div class="actions">
          <button type="button" class="btn btn-sm btn-outline-secondary" data-act="edit" data-id="${r.id}">Edit</button>
          ${isSelf(r) ? '' : `
          <button type="button" class="btn btn-sm btn-outline-secondary" data-act="toggle" data-id="${r.id}">${r.is_active ? 'Deactivate' : 'Activate'}</button>
          <button type="button" class="btn btn-sm btn-outline-secondary" data-act="delete" data-id="${r.id}">Delete</button>`}
        </div></td>
      </tr>`).join('')
      : '<tr><td class="empty" colspan="6">No users.</td></tr>';
  }

  async function onListClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const row = rows.find((r) => r.id === btn.dataset.id);
    if (!row) return;

    if (btn.dataset.act === 'edit') return openForm(row);

    let body;
    if (btn.dataset.act === 'toggle') {
      if (row.is_active && !confirm(`Deactivate ${row.name}? They will no longer be able to sign in.`)) return;
      body = { action: 'update', id: row.id, is_active: !row.is_active };
    } else {
      if (!confirm(`Delete ${row.name}? This cannot be undone.`)) return;
      body = { action: 'delete', id: row.id };
    }

    btn.disabled = true;
    try { await callFn('manage-user', body); } catch (err) { toast(err.message, 'error', { sticky: true }); }
    await load();
  }

  // ===================================================================
  // Form
  // ===================================================================
  function openForm(row) {
    editing = row;
    $('formTitle').textContent = row ? 'Edit user' : 'New user';

    $('uName').value = row?.name ?? '';
    $('uPosition').value = row?.position ?? '';
    $('uEmail').value = row?.email ?? '';
    $('uPassword').value = '';
    $('uPassword').type = 'password';
    const eye = document.querySelector('.password-toggle-btn');
    eye.classList.remove('is-visible');
    eye.setAttribute('aria-pressed', 'false');
    $('pwLabel').textContent = row ? 'New password (leave blank to keep)' : 'Password *';
    $('pwTools').classList.toggle('hidden', Boolean(row));   // generator is for new users only
    if (!row) fillPassword();

    document.querySelectorAll('input[name="role"]').forEach((r) => { r.checked = r.value === (row?.role ?? 'Clerk'); });

    const self = Boolean(row && isSelf(row));
    document.querySelectorAll('input[name="role"]').forEach((r) => { r.disabled = self; });
    $('uActive').checked = row ? row.is_active : true;
    $('uActive').disabled = self;
    $('activeField').classList.toggle('hidden', !row);
    $('selfNote').classList.toggle('hidden', !self);

    UI.modal('sidePanel').show();
  }

  function closeForm() {
    editing = null;
    UI.modal('sidePanel').hide();
  }

  async function onSubmit(e) {
    e.preventDefault();

    const name = $('uName').value.trim();
    const position = $('uPosition').value.trim();
    const email = $('uEmail').value.trim().toLowerCase();
    const password = $('uPassword').value;

    if (!name) return toast('Name is required.');
    if (!EMAIL_RE.test(email)) return toast('Enter a valid email.');
    if (password && password.length < MIN_PASSWORD) return toast(`Password must be at least ${MIN_PASSWORD} characters.`);

    let call;
    if (!editing) {
      if (!password) return toast('Password is required.');
      call = () => callFn('create-user', { name, position, email, role: role(), password });
    } else {
      // Send only what changed, so untouched Auth fields are not rewritten.
      const body = { action: 'update', id: editing.id };
      if (name !== editing.name) body.name = name;
      if (position !== (editing.position ?? '')) body.position = position;
      if (email !== editing.email) body.email = email;
      if (!isSelf(editing)) {
        if (role() !== editing.role) body.role = role();
        if ($('uActive').checked !== editing.is_active) body.is_active = $('uActive').checked;
      }
      if (password) body.password = password;
      if (Object.keys(body).length === 2) return toast('Nothing was changed.');
      call = () => callFn('manage-user', body);
    }

    $('saveBtn').disabled = true;
    try {
      await call();
    } catch (err) {
      $('saveBtn').disabled = false;
      return toast(err.message);
    }
    $('saveBtn').disabled = false;

    closeForm();
    toast('Saved.', 'ok');
    await load();
  }

  // ===================================================================
  // Role permissions
  // ===================================================================
  const GRANTABLE = ['Store Manager', 'Clerk'];

  async function loadPerms() {
    const [perms, grants] = await Promise.all([
      sb.from('permissions').select('key, label, description').order('sort_order'),
      sb.from('role_permissions').select('role, permission_key')
    ]);
    const err = perms.error || grants.error;
    if (err) { toast(`Could not load permissions: ${err.message}`, 'error', { sticky: true }); return; }

    const granted = new Set(grants.data.map((g) => `${g.role}|${g.permission_key}`));
    $('permBody').innerHTML = perms.data.map((p) => `
      <tr>
        <td>${esc(p.label)}<br><span class="small">${esc(p.description)}</span></td>
        <td class="ctr" title="Always granted">✓</td>
        ${GRANTABLE.map((r) => `<td class="ctr"><input class="form-check-input" type="checkbox" aria-label="${esc(p.label)} for ${r}"
          data-role="${r}" data-key="${esc(p.key)}"${granted.has(`${r}|${p.key}`) ? ' checked' : ''}></td>`).join('')}
      </tr>`).join('');
  }

  async function onPermChange(e) {
    const cb = e.target.closest('input[type="checkbox"][data-role]');
    if (!cb) return;
    cb.disabled = true;

    const { role: r, key } = cb.dataset;
    const { error } = cb.checked
      ? await sb.from('role_permissions').insert({ role: r, permission_key: key })
      : await sb.from('role_permissions').delete().eq('role', r).eq('permission_key', key);

    if (error) toast(error.message); else toast('Saved.', 'ok');
    await loadPerms();   // re-read so the grid always shows what is really stored
  }

  // ===================================================================
  // Start
  // ===================================================================
  function selectTab(tab) {
    document.querySelectorAll('#tabs .nav-link').forEach((t) => {
      t.classList.toggle('active', t.dataset.tab === tab);
      t.setAttribute('aria-selected', String(t.dataset.tab === tab));
    });
    $('layout').classList.toggle('hidden', tab !== 'users');
    $('permsPanel').classList.toggle('hidden', tab !== 'perms');
    if (tab === 'perms') loadPerms();
  }

  function init(detail) {
    me = detail;

    $('tabs').addEventListener('click', (e) => { const t = e.target.closest('[data-tab]'); if (t) selectTab(t.dataset.tab); });
    $('listBody').addEventListener('click', onListClick);
    $('search').addEventListener('input', renderList);
    $('showInactive').addEventListener('change', renderList);
    $('newBtn').addEventListener('click', () => openForm(null));
    $('cancelBtn').addEventListener('click', closeForm);
    $('form').addEventListener('submit', onSubmit);
    $('pwGenBtn').addEventListener('click', fillPassword);
    $('pwCopyBtn').addEventListener('click', copyPassword);
    $('permBody').addEventListener('change', onPermChange);

    load();
  }

  window.addEventListener('app:ready', (e) => init(e.detail), { once: true });
})();
