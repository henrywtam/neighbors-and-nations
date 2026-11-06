/* ============================================================
   site-nav.js — the tab bar every page shares.
   Fills <div id="site-tabs"> inside <nav id="app-nav"> and marks the
   current section. Load it right after the nav, before page scripts:
   on the dashboard, world.js wires the World/SF tabs (data-view) to
   switch views in place.
   ============================================================ */

(function () {
  'use strict';

  const TABS = [
    { id: 'world', href: '/world', label: '🌍 World Map', short: '🌍 Map', view: 'world' },
    { id: 'sf', href: '/sf', label: '🌉 San Francisco', short: '🌉 SF', view: 'sf' },
    { id: 'cg', href: '/cg', label: '👥 Community Groups', short: '👥 CGs' },
    { id: 'partners', href: '/partners', label: '🤝 Missionaries & Partners', short: '🤝 Partners' },
  ];

  function section(path) {
    if (path === '/partners' || /^\/cg\/[^/]+\/partners\/?$/.test(path)) return 'partners';
    if (path === '/cg' || path.startsWith('/cg/') || path.startsWith('/join') || path === '/start-group') return 'cg';
    if (path.replace(/^\/tv/, '') === '/sf') return 'sf';
    return 'world';
  }

  const el = document.getElementById('site-tabs');
  if (!el) return;
  // World/SF switch in place only on the dashboard itself
  const onDashboard = !!document.getElementById('world-view');
  const current = section(location.pathname);

  for (const t of TABS) {
    const a = document.createElement('a');
    a.className = 'app-tab' + (t.id === current ? ' active' : '');
    a.dataset.tab = t.id;
    a.href = t.href;
    a.innerHTML = '';
    a.append(Object.assign(document.createElement('span'), { className: 'tab-long', textContent: t.label }),
      Object.assign(document.createElement('span'), { className: 'tab-short', textContent: t.short }));
    if (t.id === current) a.setAttribute('aria-current', 'page');
    if (onDashboard && t.view) a.dataset.view = t.view;
    el.append(a);
  }
})();
