// assets/js/sidebar.js
//
// Shared sidebar for every page under /pages/. Load AFTER supabaseClient.js and auth.js.
//
// What it does
//   - Guards the page (Auth.guard): no session / inactive user -> back to login.
//   - Reads the user's permissions (my_permissions()) and shows only the links they may open.
//   - Redirects to the home if the user opens a page they have no permission for.
//     (Front-end convenience only; the database RLS is the real access control.)
//   - Desktop (>= 768px): collapsible icon rail (logo row toggles it); state remembered in localStorage.
//     Phones: Bootstrap offcanvas, opened by the menu button in each page's topbar.
//   - Account menu on the collapsed rail is a Bootstrap dropdown.
//   - Needs Bootstrap's JS bundle (load it before this file).
//   - Anti-flicker on full page loads: last-known sidebar is cached in sessionStorage and
//     painted before any network call; the real checks then run in the background.
//   - Fires `app:ready` on window when the user is verified:
//       window.addEventListener('app:ready', (e) => {
//         const { user, name, role, isAdmin, perms } = e.detail;
//       });
//
// ADD A PAGE: add one line to NAV below.
//   page = value of <body data-page="...">, perm = permission key from public.permissions,
//   or an array of keys (any one is enough), or 'admin' (Admin / Super Admin only),
//   or omit for "everyone signed in".
//
// Page skeleton: see pages/home.html.
(async function () {
  const LOGIN_PATH = '../index.html';
  const HOME_PAGE = 'home.html';
  const PARTIAL_PATH = '../assets/partials/sidebar.html';
  const CACHE_KEY = 'mw.sidebar.v1';   // sessionStorage: last-known sidebar for this tab
  const OPEN_KEY = 'mw.sidebar.open';  // localStorage: '1' = expanded
  const NARROW = window.matchMedia('(max-width: 767.98px)'); // phones: offcanvas instead of the rail

  const ICON = {
    home: '<path d="M3 9.5 12 3l9 6.5"></path><path d="M5 10v10a1 1 0 0 0 1 1h4v-6h4v6h4a1 1 0 0 0 1-1V10"></path>',
    sales: '<circle cx="8" cy="21" r="1"></circle><circle cx="19" cy="21" r="1"></circle><path d="M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12"></path>',
    reports: '<path d="M3 3v18h18"></path><path d="M18 17V9M13 17V5M8 17v-3"></path>',
    products: '<path d="m7.5 4.27 9 5.15"></path><path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path><path d="m3.3 7 8.7 5 8.7-5"></path><path d="M12 22V12"></path>',
    users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M22 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path>'
  };

  // Single source of truth for the menu AND page access.
  // A link to a page that doesn't exist yet gives a 404; comment its line out until the page is built.
  const NAV = [
    { page: 'home', href: 'home.html', label: 'Home', icon: ICON.home },
    { page: 'sales',   href: 'sales.html',   label: 'Sales',   icon: ICON.sales,   perm: 'enter_revenue' },
    { page: 'reports', href: 'reports.html', label: 'Reports', icon: ICON.reports, perm: 'view_report' },
    { page: 'products', href: 'products.html', label: 'Products', icon: ICON.products, perm: ['manage_catalog', 'manage_price'] },
    { page: 'users',   href: 'users.html',   label: 'Users',   icon: ICON.users,   perm: 'admin' },
  ];

  const appShell = document.getElementById('appShell');
  const sidebarRoot = document.getElementById('sidebarRoot');
  const activePage = document.body.dataset.page;

  // ---- Storage helpers (blocked storage must never break the page) ----
  const readCache = () => {
    try { const v = JSON.parse(sessionStorage.getItem(CACHE_KEY)); return v && typeof v.partial === 'string' ? v : null; }
    catch (_) { return null; }
  };
  const writeCache = (v) => { try { sessionStorage.setItem(CACHE_KEY, JSON.stringify(v)); } catch (_) { /* ignore */ } };
  const clearCache = () => { try { sessionStorage.removeItem(CACHE_KEY); } catch (_) { /* ignore */ } };
  const readOpen = () => { try { return !NARROW.matches && localStorage.getItem(OPEN_KEY) === '1'; } catch (_) { return false; } };
  const saveOpen = (open) => { if (NARROW.matches) return; try { localStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch (_) { /* ignore */ } };

  // ---- State + rendering (idempotent: runs from the cache first, then with verified data) ----
  let currentPartial = null;
  let access = { perms: [], isAdmin: false };
  let user = { name: '', initials: '?', roleText: '' };

  const canOpen = (item) => {
    if (!item.perm) return true;
    if (item.perm === 'admin') return access.isAdmin;
    return [].concat(item.perm).some((p) => access.perms.includes(p));   // string or array: any one is enough
  };

  const svg = (inner) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;

  const isOpen = () => appShell.classList.contains('sidebar-open');
  const expanded = () => NARROW.matches || isOpen();   // the account menu is only needed on the collapsed rail

  function setOpen(open, persist = true) {
    appShell.classList.toggle('sidebar-open', open);
    document.getElementById('sidebarToggle')?.setAttribute('aria-expanded', String(open));
    if (persist) saveOpen(open);
  }

  function renderNav() {
    const nav = document.getElementById('sidebarNav');
    if (!nav) return;
    nav.innerHTML = NAV.filter(canOpen).map((i) => {
      const active = i.page === activePage;
      return `<a href="${i.href}" class="nav-link sidebar-link${active ? ' active' : ''}" title="${i.label}"${active ? ' aria-current="page"' : ''}>`
        + `${svg(i.icon)}<span class="sidebar-label">${i.label}</span></a>`;
    }).join('');
  }

  function applyUser() {
    const set = (id, text) => { const el = document.getElementById(id); if (el) { el.textContent = text; el.title = text; } };
    set('sidebarUserAvatar', user.initials);
    set('sidebarUserName', user.name);
    set('sidebarUserRole', user.roleText);
    set('sidebarMenuName', user.name);
    set('sidebarMenuRole', user.roleText);
  }

  function mount(partialHtml) {
    sidebarRoot.innerHTML = partialHtml;
    currentPartial = partialHtml;
    renderNav();
    applyUser();
    document.getElementById('sidebarToggle')?.setAttribute('aria-expanded', String(isOpen()));

    // Account dropdown: fixed positioning so it is not clipped by the sidebar; skipped when names are already visible.
    const avatar = document.getElementById('sidebarAvatarBtn');
    if (avatar) {
      bootstrap.Dropdown.getOrCreateInstance(avatar, { popperConfig: (d) => ({ ...d, strategy: 'fixed' }) });
      avatar.addEventListener('show.bs.dropdown', (e) => { if (expanded()) e.preventDefault(); });
    }
  }

  function signOut() {
    clearCache();
    return Auth.signOut(LOGIN_PATH);
  }

  // ---- Events (delegated, so they survive a re-mount) ----
  sidebarRoot.addEventListener('click', (e) => {
    if (e.target.closest('#sidebarToggle')) {
      if (NARROW.matches) bootstrap.Offcanvas.getInstance(sidebarRoot)?.hide();   // phones: close the offcanvas
      else setOpen(!isOpen());
    } else if (e.target.closest('#sidebarSignOutBtn, #sidebarMenuSignOut')) signOut();
  });

  // ---- Instant paint from the last-known state (no network) ----
  // Transitions are off for this first paint so an expanded sidebar doesn't animate on every load.
  appShell.classList.add('sidebar-no-anim');
  const cached = readCache();
  if (cached) {
    access = { perms: cached.perms || [], isAdmin: cached.isAdmin === true };
    if (cached.user) user = cached.user;
    mount(cached.partial);
  }
  setOpen(readOpen(), false);
  // Hand over from the early <head> snippet (which only pre-sized the sidebar) to the real class.
  document.documentElement.classList.remove('sidebar-open-init');
  requestAnimationFrame(() => requestAnimationFrame(() => appShell.classList.remove('sidebar-no-anim')));

  // ---- Verified state: partial, session/profile and permissions load in parallel ----
  const partialPromise = fetch(PARTIAL_PATH)
    .then((res) => (res.ok ? res.text() : null))
    .catch((err) => { console.error('sidebar: failed to load partial:', err); return null; });

  const [result, permsRes] = await Promise.all([
    Auth.guard(LOGIN_PATH),          // redirects to login if not allowed
    sb.rpc('my_permissions').then((r) => r, (error) => ({ data: null, error }))
  ]);
  if (!result.ok) { clearCache(); return; }

  if (permsRes.error) console.error('sidebar: my_permissions failed:', permsRes.error);
  const perms = permsRes.error ? [] : (permsRes.data || []);
  const isAdmin = result.role === 'Admin' || result.role === 'Super Admin';
  access = { perms, isAdmin };

  // Page access (front-end convenience; RLS is the real control).
  const here = NAV.find((i) => i.page === activePage);
  if (here && !canOpen(here)) { location.replace(HOME_PAGE); return; }

  const parts = result.name.trim().split(/\s+/).filter(Boolean);
  const initials = (parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : (parts[0] || '?').slice(0, 2)).toUpperCase();
  user = { name: result.name, initials, roleText: result.role };

  const freshPartial = await partialPromise;
  if (freshPartial && freshPartial !== currentPartial) mount(freshPartial);
  else if (currentPartial) { renderNav(); applyUser(); }

  if (currentPartial) writeCache({ partial: currentPartial, perms, isAdmin, user });

  window.dispatchEvent(new CustomEvent('app:ready', {
    detail: { user: result.user, name: result.name, role: result.role, isAdmin, perms }
  }));
})();
