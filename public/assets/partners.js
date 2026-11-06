/* ============================================================
   partners.js — supported missionaries and global partners page
   /partners            everyone
   /cg/CODE/partners    everyone, with the ones that fit the group
                        highlighted and the reasons why (?demo: the
                        demo group's sample answers)
   ============================================================ */

'use strict';

const parts = location.pathname.split('/');
const CODE = parts[1] === 'cg' ? decodeURIComponent(parts[2] || '').toUpperCase() : null;
const DEMO = CODE === 'DEMO' || new URLSearchParams(location.search).has('demo');

let partners = [];
let kind = 'all';

document.addEventListener('DOMContentLoaded', async () => {
  setupNav();
  setupTabs();

  const url = CODE
    ? `/api/groups/${encodeURIComponent(CODE)}/partners${DEMO ? '?demo' : ''}`
    : '/api/partners';
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    partners = data.partners;
    if (data.group) showGroup(data.group, data.totalPeople);
    renderAll();
  } catch (e) {
    const notice = document.getElementById('notice');
    notice.textContent = e.message || "We couldn't load our partners. Please try again.";
    notice.hidden = false;
    document.getElementById('all').hidden = true;
  }
});

/** On a group's partner page, a link back to that group's page */
function setupNav() {
  if (!CODE) return;
  document.getElementById('group-link').href = `/cg/${encodeURIComponent(CODE)}${DEMO ? '?demo' : ''}`;
  document.getElementById('group-nav').hidden = false;
}

function setupTabs() {
  document.querySelectorAll('.tab').forEach(btn => btn.addEventListener('click', () => {
    kind = btn.dataset.kind;
    document.querySelectorAll('.tab').forEach(b => {
      b.classList.toggle('active', b === btn);
      b.setAttribute('aria-selected', String(b === btn));
    });
    renderAll();
  }));
}

function showGroup(group, totalPeople) {
  document.title = `${group.groupName} — Partners`;
  document.getElementById('title').textContent = `${group.groupName}: Partners for Our Heart`;
  document.getElementById('lead').textContent = totalPeople
    ? `Based on what ${totalPeople === 1 ? '1 person' : `${totalPeople} people`} in our group shared. Here's who our hearts line up with.`
    : 'Once our group shares, the partners that fit us show up here.';
  document.getElementById('fits-title').textContent = `Fits for ${group.groupName}`;

  const fits = partners.filter(p => p.fit);
  document.getElementById('fits').hidden = false;
  document.getElementById('fit-cards').innerHTML = fits.length
    ? fits.map(p => card(p, true)).join('')
    : '<p class="empty">No matches yet. As more of our group shares, partners that fit will show up here.</p>';
}

function renderAll() {
  const shown = partners
    .filter(p => kind === 'all' || p.kind === kind)
    // Fits first, then the rest in the list's own order
    .sort((a, b) => Number(!!b.fit) - Number(!!a.fit));
  document.getElementById('all-cards').innerHTML = shown.length
    ? shown.map(p => card(p, false)).join('')
    : '<p class="empty">No partners here yet.</p>';
}

function card(p, withReasons) {
  return `
    <article class="card${p.fit ? ' fit' : ''}">
      ${p.image ? `<img class="photo" src="${esc(p.image)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
      <div class="card-top">
        <span class="side">${p.kind}</span>
        ${p.fit ? '<span class="badge">Fits us</span>' : ''}
      </div>
      <h3>${esc(p.name)}</h3>
      <div class="place">${p.org ? `${esc(p.org)} · ` : ''}${esc(p.place)}</div>
      ${p.description ? `<p class="desc">${esc(p.description)}</p>` : ''}
      ${p.heartbeats.length ? `<div class="chips">${p.heartbeats.map(h => `<span class="chip">${esc(h)}</span>`).join('')}</div>` : ''}
      ${withReasons && p.reasons?.length ? `<ul class="reasons">${p.reasons.slice(0, 3).map(r => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      ${p.link ? `<a class="story" href="${esc(p.link)}" target="_blank" rel="noopener">${p.kind === 'Missionary' ? 'Read their story' : 'Go to site'} →</a>` : ''}
    </article>`;
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
