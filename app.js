const WORKER_URL = 'https://recepten-api.semvmeurs.workers.dev';

const CATEGORY_LABELS = {
  main: { nl: 'Hoofdgerecht', en: 'Main course' },
  soup: { nl: 'Soep', en: 'Soup' },
  lunch: { nl: 'Lunch', en: 'Lunch' },
  vegetarian: { nl: 'Vegetarisch', en: 'Vegetarian' },
  fish: { nl: 'Vis', en: 'Fish' },
  side: { nl: 'Bijgerecht', en: 'Side dish' },
  sauce: { nl: 'Saus', en: 'Sauce' },
  dessert: { nl: 'Toetje', en: 'Dessert' },
  other: { nl: 'Overig', en: 'Other' },
};
const CATEGORY_KEYWORDS = [
  ['soup', ['soep', 'soup']],
  ['dessert', ['toetje', 'dessert', 'gebak', 'taart', 'cake', 'cookie']],
  ['sauce', ['saus', 'sauce', 'dressing', 'marinade']],
  ['side', ['bijgerecht', 'salade', 'salad', 'side']],
  ['lunch', ['lunch', 'broodje', 'sandwich']],
  ['fish', ['vis', 'fish', 'zalm', 'salmon', 'garnaal', 'shrimp']],
  ['vegetarian', ['vegetarisch', 'vegetarian', 'vegan']],
  ['main', ['hoofdgerecht', 'main', 'diner', 'dinner']],
];
function guessCategoryId(text) {
  const hay = String(text || '').toLowerCase();
  for (const [id, keywords] of CATEGORY_KEYWORDS) if (keywords.some(k => hay.includes(k))) return id;
  return 'other';
}

let RECIPES = [];
let LANG = localStorage.getItem('lang') || 'nl';
let ACTIVE_CAT = 'all';
const $ = s => document.querySelector(s);
const fmtTime = m => m == null ? 'Tijd onbekend' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} u${m % 60 ? ` ${m % 60} min` : ''}`;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Werkt zowel met het oude platte schema als het nieuwe tweetalige (nl/en) schema.
function view(r) {
  const loc = r.nl || r.en ? (r[LANG] || r.nl || r.en) : r;
  const categoryId = r.category_id || guessCategoryId(loc.category);
  return {
    id: r.id, title: loc.title, category: loc.category, categoryId,
    ingredient_groups: loc.ingredient_groups, steps: loc.steps, notes: loc.notes || [],
    servings: r.servings, total_time_minutes: r.total_time_minutes,
    time_estimated: r.time_estimated, page: r.page,
  };
}
function allIngredients(v) { return v.ingredient_groups.flatMap(g => g.items).join(' '); }
function checkedSet(id) { return new Set(JSON.parse(localStorage.getItem('checked:' + id) || '[]')); }
function saveSet(id, set) { localStorage.setItem('checked:' + id, JSON.stringify([...set])); }

function renderCategoryRow(allViews) {
  const present = [...new Set(allViews.map(v => v.categoryId))];
  const label = id => CATEGORY_LABELS[id]?.[LANG] || id;
  const allLabel = LANG === 'en' ? 'All' : 'Alle';
  const pills = [{ id: 'all', label: allLabel }, ...present.map(id => ({ id, label: label(id) }))];
  $('#catRow').innerHTML = pills.map(p => `<button type="button" class="catBtn ${ACTIVE_CAT === p.id ? 'active' : ''}" data-cat="${esc(p.id)}">${esc(p.label)}</button>`).join('');
  $('#catRow').querySelectorAll('.catBtn').forEach(b => b.onclick = () => { ACTIVE_CAT = b.dataset.cat; renderList($('#search').value); });
}

function renderList(q = '') {
  $('#detail').className = 'detail'; $('#list').style.display = 'grid';
  q = q.trim().toLowerCase();
  const allViews = RECIPES.map(view);
  renderCategoryRow(allViews);
  const rows = allViews.filter(v => (ACTIVE_CAT === 'all' || v.categoryId === ACTIVE_CAT) && (!q || (`${v.title} ${v.category || ''} ${allIngredients(v)}`).toLowerCase().includes(q)));
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
$('#langToggle').onclick = () => { LANG = LANG === 'nl' ? 'en' : 'nl'; localStorage.setItem('lang', LANG); $('#langToggle').textContent = LANG.toUpperCase(); ACTIVE_CAT = 'all'; renderList($('#search').value); };

// ── Recept toevoegen (link of foto) ───────────────────────────────────
const modal = $('#addModal'), status = $('#addStatus'), form = $('#addForm'), urlInput = $('#addUrl'), photoInput = $('#addPhotos'), codeInput = $('#addCode'), submitBtn = $('#addSubmit');
let ADD_MODE = 'link';
codeInput.value = localStorage.getItem('accessCode') || '';

$('#addOpen').onclick = () => { modal.classList.add('active'); status.textContent = ''; urlInput.value = ''; photoInput.value = ''; urlInput.focus(); };
$('#addClose').onclick = () => modal.classList.remove('active');
$('#tabLink').onclick = () => { ADD_MODE = 'link'; $('#tabLink').classList.add('active'); $('#tabPhoto').classList.remove('active'); $('#paneLink').classList.add('active'); $('#panePhoto').classList.remove('active'); };
$('#tabPhoto').onclick = () => { ADD_MODE = 'photo'; $('#tabPhoto').classList.add('active'); $('#tabLink').classList.remove('active'); $('#panePhoto').classList.add('active'); $('#paneLink').classList.remove('active'); };

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const code = codeInput.value.trim();
  if (!code) { status.textContent = '⚠ Vul een toegangscode in.'; return; }
  localStorage.setItem('accessCode', code);

  submitBtn.disabled = true; submitBtn.textContent = 'Bezig…';
  try {
    let res;
    if (ADD_MODE === 'link') {
      const url = urlInput.value.trim();
      if (!url) throw new Error('Vul een link in.');
      status.textContent = 'Recept wordt opgehaald en toegevoegd…';
      res = await fetch(WORKER_URL + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, code }) });
    } else {
      const files = photoInput.files;
      if (!files || !files.length) throw new Error('Kies minstens één foto.');
      status.textContent = 'Foto wordt geanalyseerd en toegevoegd…';
      const fd = new FormData();
      fd.append('code', code);
      for (const f of files) fd.append('images', f);
      res = await fetch(WORKER_URL + '/submit', { method: 'POST', body: fd });
    }
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
