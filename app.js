let RECIPES=[];
const $=s=>document.querySelector(s);
const fmtTime=m=>m==null?'Tijd onbekend':m<60?`${m} min`:`${Math.floor(m/60)} u${m%60?` ${m%60} min`:''}`;
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function allIngredients(r){return r.ingredient_groups.flatMap(g=>g.items).join(' ')}
function checkedSet(id){return new Set(JSON.parse(localStorage.getItem('checked:'+id)||'[]'))}
function saveSet(id,set){localStorage.setItem('checked:'+id,JSON.stringify([...set]))}
function renderList(q=''){
  $('#detail').className='detail'; $('#list').style.display='grid';
  q=q.trim().toLowerCase();
  const rows=RECIPES.filter(r=>!q||(`${r.title} ${r.category||''} ${allIngredients(r)}`).toLowerCase().includes(q));
  $('#list').innerHTML=rows.length?rows.map(r=>`<article class="card" data-id="${esc(r.id)}"><h2>${esc(r.title)}</h2><div class="meta"><span class="pill">${esc(r.category||'Recept')}</span>${r.servings?`<span class="pill">${esc(r.servings)}</span>`:''}<span class="pill">${fmtTime(r.total_time_minutes)}${r.time_estimated?' · geschat':''}</span></div></article>`).join(''):'<div class="empty">Geen recepten gevonden.</div>';
  document.querySelectorAll('.card').forEach(x=>x.onclick=()=>openRecipe(x.dataset.id));
}
function openRecipe(id){
  const r=RECIPES.find(x=>x.id===id); if(!r)return;
  $('#list').style.display='none'; const d=$('#detail'); d.className='detail active';
  d.innerHTML=`<button class="back">← Alle recepten</button><h2>${esc(r.title)}</h2><div class="meta"><span class="pill">${esc(r.category||'Recept')}</span>${r.servings?`<span class="pill">${esc(r.servings)}</span>`:''}<span class="pill">${fmtTime(r.total_time_minutes)}${r.time_estimated?' · geschat':''}</span></div><div class="section"><h3>Ingrediënten</h3><div id="ingredients"></div></div><div class="section"><h3>Bereiding</h3><ol class="steps">${r.steps.map(s=>`<li>${esc(s)}</li>`).join('')}</ol></div>${(r.notes||[]).length?`<div class="section"><h3>Notities</h3>${r.notes.map(n=>`<p class="note">${esc(n)}</p>`).join('')}</div>`:''}${r.page?`<p class="note">Bronpagina: ${esc(r.page)}</p>`:''}`;
  d.querySelector('.back').onclick=()=>renderList($('#search').value); renderIngredients(r);
  window.scrollTo(0,0);
}
function renderIngredients(r){
  const set=checkedSet(r.id), host=$('#ingredients');
  const unchecked=[], checked=[];
  r.ingredient_groups.forEach((g,gi)=>g.items.forEach((item,ii)=>{const key=`${gi}:${ii}`; (set.has(key)?checked:unchecked).push({g:g.name,item,key})}));
  const render=(arr)=>{let last=null;return arr.map(x=>{const gt=x.g!==last?`<div class="group-title">${esc(x.g)}</div>`:'';last=x.g;return gt+`<label class="ingredient ${set.has(x.key)?'checked':''}"><input type="checkbox" data-key="${x.key}" ${set.has(x.key)?'checked':''}><span>${esc(x.item)}</span></label>`}).join('')};
  host.innerHTML=render(unchecked)+(checked.length?'<div class="group-title">Afgevinkt</div>'+render(checked):'');
  host.querySelectorAll('input').forEach(cb=>cb.onchange=()=>{cb.checked?set.add(cb.dataset.key):set.delete(cb.dataset.key);saveSet(r.id,set);renderIngredients(r)});
}
fetch('recipes.json').then(r=>r.json()).then(data=>{RECIPES=data;renderList()}).catch(()=>{$('#list').innerHTML='<div class="empty">Recepten konden niet worden geladen.</div>'});
$('#search').addEventListener('input',e=>renderList(e.target.value));
if('serviceWorker' in navigator) navigator.serviceWorker.register('service-worker.js').catch(()=>{});
