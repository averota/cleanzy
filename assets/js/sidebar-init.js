/* assets/js/sidebar-init.js
   Pre-sizes the sidebar before first paint (no jump when it was left expanded).
   Load it as a plain (non-deferred) <script> in <head> of every page, after the stylesheets. */
try {
  if (localStorage.getItem('mw.sidebar.open') === '1' && innerWidth > 767) {
    document.documentElement.classList.add('sidebar-open-init');
  }
} catch (e) { /* storage blocked: sidebar simply starts collapsed */ }
