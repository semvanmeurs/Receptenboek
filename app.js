const WORKER_URL = 'https://recepten-api.semvmeurs.workers.dev';

let RECIPES = [];
let LANG = localStorage.getItem('lang') || 'nl';
const $ = s => document.querySelector(s);
const fmtTime = m => m == null ? 'Tijd onbekend' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} u${m % 60 ? ` ${m % 60} min` : ''}`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Werkt zowel met het oude platte schema als het nieuwe tweetalige (nl/en) schema.
function view(r) {
  const loc = r.nl || r.en ? (r[LANG] || r.nl || r.en) : r;
  return {
    id: r.id, title: loc.title, category: loc.category,
    ingredient_groups: loc.ingredient_groups, steps: loc.steps, notes: loc.notes || [],
    servings: r.servings, total_time_minutes: r.total_time_minutes,
    time_estimated: r.time_estimated, page: r.page,
  };
}
function allIngredients(v) { return v.ingredient_groups.flatMap(g => g.items).join(' '); }
function checkedSet(id) { return new Set(JSON.parse(localStorage.getItem('checked:' + id) || '[]')); }
function saveSet(id, set) { localStorage.setItem('checked:' + id, JSON.stringify([...set])); }

function renderList(q = '') {
  $('#detail').className = 'detail'; $('#list').style.display = 'grid';
  q = q.trim().toLowerCase();
  const rows = RECIPES.map(view).filter(v => !q || (`${v.title} ${v.category || ''} ${allIngredients(v)}`).toLowerCase().includes(q));
  $('#list').innerHTML = rows.length ? rows.map(v => `<article class="card" data-id="${esc(v.id)}"><h2>${esc(v.title)}</h2><div class="meta"><span class="pill">${esc(v.category || 'Recept')}</span>${v.servings ? `<span class="pill">${esc(v.servings)}</span>` : ''}<span class="pill">${fmtTime(v.total_time_minutes)}${v.time_estimated ? ' · geschat' : ''}</span></div></article>`).join('') : '<div class="empty">Geen recepten gevonden.</div>';
  document.querySelectorAll('.card').forEach(x => x.onclick = () => openRecipe(x.dataset.id));
}

function openRecipe(id) {
  const r = RECIPES.find(x => x.id === id); if (!r) return;
  const v = view(r);
  $('#list').style.display = 'none'; const d = $('#detail'); d.className = 'detail active';
  d.innerHTML = `<button class="back">← Alle recepten</button><h2>${esc(v.title)}</h2><div class="meta"><span class="pill">${esc(v.category || 'Recept')}</span>${v.servings ? `<span class="pill">${esc(v.servings)}</span>` : ''}<span class="pill">${fmtTime(v.total_time_minutes)}${v.time_estimated ? ' · geschat' : ''}</span></div><div class="section"><h3>Ingrediënten</h3><div id="ingredients"></div></div><div class="section"><h3>Bereiding</h3><ol class="steps">${v.steps.map(s => `<li>${esc(s)}</li>`).join('')}</ol></div>${v.notes.length ? `<div class="section"><h3>Notities</h3>${v.notes.map(n => `<p class="note">${esc(n)}</p>`).join('')}</div>` : ''}${v.page ? `<p class="note">Bronpagina: ${esc(v.page)}</p>` : ''}${r.source_url ? `<p class="note">Bron: <a href="${esc(r.source_url)}" target="_blank" rel="noopener">${esc(r.source || r.source_url)}</a></p>` : ''}`;
  d.querySelector('.back').onclick = () => renderList($('#search').value); renderIngredients(v);
  window.scrollTo(0, 0);
}

function renderIngredients(v) {
  const set = checkedSet(v.id), host = $('#ingredients');
  const unchecked = [], checked = [];
  v.ingredient_groups.forEach((g, gi) => g.items.forEach((item, ii) => { const key = `${gi}:${ii}`; (set.has(key) ? checked : unchecked).push({ g: g.name, item, key }); }));
  const render = (arr) => { let last = null; return arr.map(x => { const gt = x.g !== last ? `<div class="group-title">${esc(x.g)}</div>` : ''; last = x.g; return gt + `<label class="ingredient ${set.has(x.key) ? 'checked' : ''}"><input type="checkbox" data-key="${x.key}" ${set.has(x.key) ? 'checked' : ''}><span>${esc(x.item)}</span></label>`; }).join(''); };
  host.innerHTML = render(unchecked) + (checked.length ? '<div class="group-title">Afgevinkt</div>' + render(checked) : '');
  host.querySelectorAll('input').forEach(cb => cb.onchange = () => { cb.checked ? set.add(cb.dataset.key) : set.delete(cb.dataset.key); saveSet(v.id, set); renderIngredients(v); });
}

function loadRecipes() {
  return fetch('recipes.json?t=' + Date.now()).then(r => r.json()).then(data => { RECIPES = data; renderList($('#search').value); });
}
loadRecipes().catch(() => { $('#list').innerHTML = '<div class="empty">Recepten konden niet worden geladen.</div>'; });
$('#search').addEventListener('input', e => renderList(e.target.value));
if ('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(() => {});

// ── Taal-toggle ────────────────────────────────────────────────────────
$('#langToggle').textContent = LANG.toUpperCase();
$('#langToggle').onclick = () => { LANG = LANG === 'nl' ? 'en' : 'nl'; localStorage.setItem('lang', LANG); $('#langToggle').textContent = LANG.toUpperCase(); renderList($('#search').value); };

// ── Recept toevoegen (link) ───────────────────────────────────────────
const modal = $('#addModal'), status = $('#addStatus'), form = $('#addForm'), urlInput = $('#addUrl'), submitBtn = $('#addSubmit');
$('#addOpen').onclick = () => { modal.classList.add('active'); status.textContent = ''; urlInput.value = ''; urlInput.focus(); };
$('#addClose').onclick = () => modal.classList.remove('active');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = urlInput.value.trim();
  if (!url) return;
  submitBtn.disabled = true; submitBtn.textContent = 'Bezig…'; status.textContent = 'Recept wordt opgehaald en toegevoegd…';
  try {
    const res = await fetch(WORKER_URL + '/submit', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Fout ${res.status}`);
    status.textContent = `✓ "${data.recipe?.nl?.title || data.recipe?.title || 'Recept'}" ${data.action} (${data.method}).`;
    await loadRecipes();
    setTimeout(() => modal.classList.remove('active'), 1200);
  } catch (err) {
    status.textContent = '⚠ ' + err.message;
  } finally {
    submitBtn.disabled = false; submitBtn.textContent = 'Toevoegen';
  }
});
