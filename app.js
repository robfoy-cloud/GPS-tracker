(() => {
'use strict';
const $ = id => document.getElementById(id);

/* ---------------- constants ---------------- */
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const TILE_CACHE = 'fieldline-tiles-v1';
const K = { tracks:'fieldline.tracks.v2', last:'fieldline.lastpos', style:'fieldline.style', tj:'fieldline.tilejson', areas:'fieldline.areas' };
const MAX_Z = 14;            // vector tiles stop at z14; the map overzooms beyond
const MAX_TILES = 6000;
const AVG_TILE_KB = 35;

/* ---------------- small helpers ---------------- */
const R = 6371008.8, rad = d => d * Math.PI / 180;
function hav(a, b){const dLa=rad(b.lat-a.lat),dLo=rad(b.lon-a.lon);const s=Math.sin(dLa/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLo/2)**2;return 2*R*Math.asin(Math.sqrt(s));}
const fmtT = s => {s=Math.round(s);const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return h+':'+String(m).padStart(2,'0')+':'+String(x).padStart(2,'0');};
function dm(v,pos,neg){const a=Math.abs(v),d=Math.floor(a),m=(a-d)*60;return d+'° '+m.toFixed(3).padStart(6,'0')+'′ '+(v>=0?pos:neg);}
const fmtMB = b => b>=1e9?(b/1e9).toFixed(1)+' GB':b>=1e6?(b/1e6).toFixed(1)+' MB':Math.max(1,Math.round(b/1e3))+' KB';
function lsGet(k,def){try{const v=localStorage.getItem(k);return v==null?def:JSON.parse(v);}catch(e){return def;}}
function lsSet(k,v){try{localStorage.setItem(k,JSON.stringify(v));return true;}catch(e){return false;}}
function toast(t){const el=$('toast');el.textContent=t;el.hidden=false;clearTimeout(toast.h);toast.h=setTimeout(()=>el.hidden=true,3500);}
function banner(html){const b=$('banner');if(!html){b.hidden=true;return;}b.innerHTML=html;b.hidden=false;}
function status(s,t){$('status').dataset.s=s;$('statusText').textContent=t;}

/* ---------------- tile cache ---------------- */
let cachePromise = null;
function openCache(){ if(!('caches' in window)) return Promise.resolve(null); return cachePromise ||= caches.open(TILE_CACHE).catch(()=>null); }
async function cachedArrayBuffer(url, signal){
  const c = await openCache();
  const hit = c && await c.match(url);
  if (hit) return hit.arrayBuffer();
  let r;
  try { r = await fetch(url, {signal, mode:'cors'}); }
  catch (e) { if (e.name === 'AbortError') throw e; return new ArrayBuffer(0); }   // offline and not cached: blank tile
  if (!r.ok) return new ArrayBuffer(0);
  if (c) c.put(url, r.clone()).catch(()=>{});
  return r.arrayBuffer();
}
async function fetchJSONWithTimeout(url, ms){
  const ac = new AbortController(); const t = setTimeout(()=>ac.abort(), ms);
  try { const r = await fetch(url,{signal:ac.signal}); if(!r.ok) throw new Error(r.status); return await r.json(); }
  finally { clearTimeout(t); }
}

/* Map style: fetched once, then kept on the phone so the map opens offline.
   The tile set version is pinned so tiles saved earlier keep matching. */
async function loadStyle(){
  let style = lsGet(K.style, null), tj = lsGet(K.tj, null);
  if (!style){
    style = await fetchJSONWithTimeout(STYLE_URL, 10000);
    lsSet(K.style, style);
  }
  const srcKey = Object.keys(style.sources).find(k => style.sources[k].type === 'vector');
  const src = style.sources[srcKey];
  if (!tj){
    tj = src.url ? await fetchJSONWithTimeout(src.url, 10000) : src;
    tj = {tiles:tj.tiles, minzoom:tj.minzoom||0, maxzoom:tj.maxzoom||14, attribution:tj.attribution||src.attribution||''};
    lsSet(K.tj, tj);
  }
  const s = structuredClone(style);
  s.sources[srcKey] = {type:'vector', tiles:tj.tiles.map(u=>'cached://'+u), minzoom:tj.minzoom, maxzoom:tj.maxzoom,
    attribution:'<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank">© OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'};
  if (s.glyphs) s.glyphs = 'cached://' + s.glyphs;
  return {style:s, tj};
}
maplibregl.addProtocol('cached', async (params, ac) => {
  const url = params.url.slice('cached://'.length);
  const data = await cachedArrayBuffer(url, ac.signal);
  return {data};
});

/* ---------------- state ---------------- */
let map = null, mapReady = false;
let last = null, follow = true, firstFix = true, watchId = null;
let rec = null, paused = false, wake = null;
let tracks = lsGet(K.tracks, []);
let shown = null;   // saved track drawn on the map

/* ---------------- map ---------------- */
const lastPos = lsGet(K.last, null);
const empty = {type:'FeatureCollection',features:[]};

async function initMap(){
  let cfg;
  try { cfg = await loadStyle(); }
  catch(e){
    banner('<b>The map needs a connection the first time it opens.</b> Connect once, let the map load, then save your area under <b>Offline map</b>. Your position still shows below.');
    status('search','No map yet');
    return;
  }
  map = new maplibregl.Map({
    container:'map', style:cfg.style,
    center: lastPos ? [lastPos.lon,lastPos.lat] : [0,20], zoom: lastPos ? 14 : 1.5,
    attributionControl:{compact:true}, maxPitch:0, dragRotate:false
  });
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({showCompass:false}),'top-right');
  map.addControl(new maplibregl.ScaleControl({unit:'metric',maxWidth:110}),'bottom-left');
  map.on('dragstart', e => { if (e.originalEvent) setFollow(false); });
  map.on('moveend', () => { if (!$('pOffline').hidden) estimate(); });
  map.on('load', () => {
    map.addSource('acc',{type:'geojson',data:empty});
    map.addSource('me',{type:'geojson',data:empty});
    map.addSource('trk',{type:'geojson',data:empty});
    map.addSource('saved',{type:'geojson',data:empty});
    map.addLayer({id:'saved-line',type:'line',source:'saved',layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#5B3FA8','line-width':4,'line-opacity':.85}});
    map.addLayer({id:'trk-case',type:'line',source:'trk',layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#FFFFFF','line-width':7}});
    map.addLayer({id:'trk-line',type:'line',source:'trk',layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#C9440E','line-width':4}});
    map.addLayer({id:'acc-fill',type:'fill',source:'acc',paint:{'fill-color':'#1A73E8','fill-opacity':.14}});
    map.addLayer({id:'acc-line',type:'line',source:'acc',paint:{'line-color':'#1A73E8','line-width':1,'line-opacity':.5}});
    map.addLayer({id:'me-halo',type:'circle',source:'me',paint:{'circle-radius':11,'circle-color':'#FFFFFF'}});
    map.addLayer({id:'me-dot',type:'circle',source:'me',paint:{'circle-radius':7.5,'circle-color':'#1A73E8'}});
    mapReady = true;
    drawPosition(); drawTrack(); drawSaved();
  });
}

function accCircle(p){
  const n=48, coords=[], r=Math.max(p.acc||0,1);
  for(let i=0;i<=n;i++){const a=i/n*2*Math.PI;coords.push([p.lon+r*Math.cos(a)/(111320*Math.cos(rad(p.lat))),p.lat+r*Math.sin(a)/110574]);}
  return {type:'Feature',geometry:{type:'Polygon',coordinates:[coords]}};
}
function drawPosition(){
  if(!mapReady||!last) return;
  map.getSource('me').setData({type:'Feature',geometry:{type:'Point',coordinates:[last.lon,last.lat]}});
  map.getSource('acc').setData(last.acc ? accCircle(last) : empty);
}
const line = pts => pts.length>1 ? {type:'Feature',geometry:{type:'LineString',coordinates:pts.map(p=>[p.lon,p.lat])}} : empty;
function drawTrack(){ if(mapReady) map.getSource('trk').setData(rec?line(rec.pts):empty); }
function drawSaved(){ if(mapReady) map.getSource('saved').setData(shown?line(shown.pts):empty); $('bHide').hidden=!shown; }

function setFollow(on){
  follow = on; $('bFollow').setAttribute('aria-pressed', String(on));
  if(on && last && map) map.easeTo({center:[last.lon,last.lat], zoom:Math.max(map.getZoom(),15), duration:500});
}
$('bFollow').onclick = () => { if(!last){ toast('No position fix yet.'); return; } setFollow(true); };

/* ---------------- GPS ---------------- */
function startGPS(){
  if(!('geolocation' in navigator)){ status('off','No GPS'); banner('This browser has no location support.'); return; }
  status('search','Finding position');
  watchId = navigator.geolocation.watchPosition(onPos, onErr, {enableHighAccuracy:true, maximumAge:0, timeout:30000});
}
let lastSave = 0;
function onPos(pos){
  const c = pos.coords;
  const p = {lat:c.latitude, lon:c.longitude, acc:c.accuracy, ele:c.altitude, spd:c.speed, t:pos.timestamp};
  const prev = last; last = p;
  if(!rec) status('live','GPS ±'+Math.round(c.accuracy)+' m');
  if($('banner').dataset.kind==='gps') { banner(null); $('banner').dataset.kind=''; }
  if(Date.now()-lastSave>30000){ lsSet(K.last,{lat:p.lat,lon:p.lon}); lastSave=Date.now(); }
  if(p.spd==null||isNaN(p.spd)){ p.spd = prev ? (()=>{const dt=(p.t-prev.t)/1000;return dt>0?hav(prev,p)/dt:0;})() : null; }

  if(rec && !paused){
    const lp = rec.pts[rec.pts.length-1];
    if(p.acc<=50 && (!lp || hav(lp,p) >= Math.max(3, p.acc*0.4))){
      rec.pts.push({lat:+p.lat.toFixed(7), lon:+p.lon.toFixed(7), ele:p.ele==null?null:+p.ele.toFixed(1), t:p.t});
      drawTrack();
    }
  }
  if(map){
    if(firstFix){ firstFix=false; map.jumpTo({center:[p.lon,p.lat], zoom:Math.max(map.getZoom(),16)}); }
    else if(follow) map.easeTo({center:[p.lon,p.lat], duration:600});
  }
  drawPosition(); readouts();
}
function onErr(err){
  if(err.code===1){
    status('off','Location blocked');
    banner('<b>Location access is turned off for this site.</b> On iPhone: Settings → Privacy &amp; Security → Location Services → Safari Websites → While Using the App, then reload. If you added Fieldline to your home screen, allow it there too.');
    $('banner').dataset.kind='gps';
  } else {
    status('search','Waiting for GPS');
  }
}

/* ---------------- readouts ---------------- */
function trackStats(pts){
  let d=0, mv=0;
  for(let i=1;i<pts.length;i++){const a=pts[i-1],b=pts[i],seg=hav(a,b),dt=(b.t-a.t)/1000;d+=seg;if(dt>0&&dt<60&&seg/dt>0.3)mv+=dt;}
  return {d, mv};
}
function readouts(){
  const st = rec ? trackStats(rec.pts) : {d:0,mv:0};
  $('rDist').innerHTML = (st.d/1000).toFixed(2)+'<small>km</small>';
  $('rTime').textContent = fmtT(rec ? (Date.now()-rec.startedAt-rec.pausedMs-(paused?Date.now()-paused:0))/1000 : 0);
  $('rSpd').innerHTML = (last&&last.spd!=null ? (last.spd*3.6).toFixed(1) : '–')+'<small>km/h</small>';
  $('rAcc').innerHTML = (last ? '±'+Math.round(last.acc) : '–')+'<small>m</small>';
  $('rPos').textContent = last ? dm(last.lat,'N','S')+'  '+dm(last.lon,'E','W')+(last.ele!=null?'  ·  '+Math.round(last.ele)+' m':'') : 'Waiting for a position fix';
}
setInterval(()=>{ if(rec) readouts(); }, 1000);

/* ---------------- recording ---------------- */
async function lockScreen(){ try{ wake = await navigator.wakeLock?.request('screen'); }catch(e){ wake=null; } }
document.addEventListener('visibilitychange', ()=>{ if(rec && document.visibilityState==='visible') lockScreen(); });
function setRecButtons(){
  const b=$('bRec');
  b.classList.toggle('recording', !!rec && !paused);
  $('bRecT').textContent = !rec ? 'Record track' : paused ? 'Resume' : 'Pause';
  $('bStop').hidden = !rec;
}
$('bRec').onclick = () => {
  if(!rec){
    rec = {pts:[], startedAt:Date.now(), pausedMs:0}; paused=false;
    status('rec','Recording'); lockScreen(); setFollow(true);
  } else if(!paused){ paused = Date.now(); status('search','Paused'); }
  else { rec.pausedMs += Date.now()-paused; paused=false; status('rec','Recording'); }
  setRecButtons(); readouts(); drawTrack();
};
$('bStop').onclick = () => {
  const r = rec; rec=null; paused=false;
  try{ wake?.release(); }catch(e){} wake=null;
  if(r && r.pts.length>1){
    const d=new Date(r.startedAt);
    const t={id:'t'+r.startedAt, name:'Track '+d.toLocaleDateString(undefined,{day:'numeric',month:'short'})+' '+d.toLocaleTimeString(undefined,{hour:'2-digit',minute:'2-digit'}), pts:r.pts};
    tracks.unshift(t);
    if(!lsSet(K.tracks,tracks)) toast('Phone storage is full; export this track as GPX.'); else toast('Saved '+t.name);
    shown=t; drawSaved(); renderTracks();
  } else if(r) toast('Too few points to save.');
  status(last?'live':'search', last?'GPS ±'+Math.round(last.acc)+' m':'Finding position');
  setRecButtons(); readouts(); drawTrack();
};

/* ---------------- sheets ---------------- */
function openSheet(id){ document.querySelectorAll('.sheet').forEach(s=>s.hidden = s.id!==id); if(id==='pOffline'){estimate();renderAreas();} if(id==='pTracks') renderTracks(); }
document.querySelectorAll('[data-close]').forEach(b=>b.onclick=()=>b.closest('.sheet').hidden=true);
$('bTracks').onclick = () => openSheet('pTracks');
$('bOffline').onclick = () => openSheet('pOffline');

/* ---------------- tracks list + GPX ---------------- */
function renderTracks(){
  const tb=$('tbody'); tb.textContent='';
  $('trEmpty').hidden = tracks.length>0;
  for(const t of tracks){
    const st=trackStats(t.pts), tr=document.createElement('tr'); if(shown===t) tr.className='sel';
    const td=(txt,cls)=>{const c=document.createElement('td');if(cls)c.className=cls;c.textContent=txt;tr.appendChild(c);return c;};
    td(t.name); td((st.d/1000).toFixed(2)+' km','n'); td(fmtT(st.mv),'n');
    const a=td('','a');
    const mk=(l,fn)=>{const b=document.createElement('button');b.textContent=l;b.onclick=fn;a.appendChild(b);};
    mk('Show',()=>{shown=t;drawSaved();renderTracks();$('pTracks').hidden=true;fitTrack(t);});
    mk('GPX',()=>exportGPX(t));
    mk(t._c?'Confirm':'Delete',()=>{
      if(!t._c){t._c=true;renderTracks();setTimeout(()=>{t._c=false;renderTracks();},3000);return;}
      tracks=tracks.filter(x=>x!==t);lsSet(K.tracks,tracks);if(shown===t){shown=null;drawSaved();}renderTracks();
    });
    tb.appendChild(tr);
  }
}
function fitTrack(t){
  if(!map) return; setFollow(false);
  const b=new maplibregl.LngLatBounds(); t.pts.forEach(p=>b.extend([p.lon,p.lat]));
  map.fitBounds(b,{padding:{top:80,bottom:(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-h'))||200)+40,left:40,right:40},maxZoom:17});
}
$('bHide').onclick=()=>{shown=null;drawSaved();renderTracks();};
function toGPX(t){
  const esc=s=>s.replace(/[<&>"]/g,c=>({'<':'&lt;','&':'&amp;','>':'&gt;','"':'&quot;'}[c]));
  const pts=t.pts.map(p=>`      <trkpt lat="${p.lat}" lon="${p.lon}">${p.ele!=null?`<ele>${p.ele}</ele>`:''}${p.t?`<time>${new Date(p.t).toISOString()}</time>`:''}</trkpt>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Fieldline GPS" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk><name>${esc(t.name)}</name>\n    <trkseg>\n${pts}\n    </trkseg>\n  </trk>\n</gpx>\n`;
}
async function exportGPX(t){
  const name=t.name.replace(/[^\w\- ]+/g,'').trim().replace(/\s+/g,'-')+'.gpx';
  const file=new File([toGPX(t)],name,{type:'application/gpx+xml'});
  if(navigator.canShare?.({files:[file]})){ try{ await navigator.share({files:[file]}); return; }catch(e){ if(e.name==='AbortError') return; } }
  const a=document.createElement('a'); a.href=URL.createObjectURL(file); a.download=name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),4000);
}
$('fImp').onchange=async e=>{
  const f=e.target.files[0]; if(!f) return;
  try{
    const doc=new DOMParser().parseFromString(await f.text(),'application/xml');
    const pts=[...doc.getElementsByTagName('trkpt'),...doc.getElementsByTagName('rtept')].map(n=>{
      const ele=n.getElementsByTagName('ele')[0],tm=n.getElementsByTagName('time')[0];
      return {lat:+n.getAttribute('lat'),lon:+n.getAttribute('lon'),ele:ele?+ele.textContent:null,t:tm?Date.parse(tm.textContent):0};
    }).filter(p=>isFinite(p.lat)&&isFinite(p.lon));
    if(pts.length<2) throw 0;
    const t={id:'i'+Date.now(),name:doc.getElementsByTagName('name')[0]?.textContent?.trim()||f.name.replace(/\.gpx$/i,''),pts};
    tracks.unshift(t); lsSet(K.tracks,tracks); shown=t; drawSaved(); renderTracks(); $('pTracks').hidden=true; fitTrack(t);
    toast('Imported '+pts.length+' points');
  }catch(err){ toast('That file has no GPX track points.'); }
  e.target.value='';
};

/* ---------------- offline areas ---------------- */
const lon2x=(lon,z)=>Math.floor((lon+180)/360*2**z);
const lat2y=(lat,z)=>{const r=rad(Math.max(-85.05,Math.min(85.05,lat)));return Math.floor((1-Math.log(Math.tan(r)+1/Math.cos(r))/Math.PI)/2*2**z);};
function tileList(b){
  const tj=lsGet(K.tj,null); if(!tj) return [];
  const tpl=tj.tiles[0], maxz=Math.min(tj.maxzoom||14, MAX_Z), out=[];
  for(let z=0; z<=maxz; z++){
    const x0=lon2x(b.getWest(),z), x1=lon2x(b.getEast(),z), y0=lat2y(b.getNorth(),z), y1=lat2y(b.getSouth(),z);
    if((x1-x0+1)*(y1-y0+1)+out.length > MAX_TILES*2) return null;
    for(let x=x0;x<=x1;x++) for(let y=y0;y<=y1;y++) out.push(tpl.replace('{z}',z).replace('{x}',x).replace('{y}',y));
  }
  return out;
}
async function storageUsed(){ try{ const e=await navigator.storage.estimate(); $('oUsed').textContent=fmtMB(e.usage||0); }catch(e){ $('oUsed').textContent='–'; } }
function estimate(){
  storageUsed();
  if(!map){ $('oTiles').textContent='–'; $('oSize').textContent='–'; $('bSaveArea').disabled=true; return; }
  const list=tileList(map.getBounds());
  const w=$('oWarn');
  if(!list||list.length>MAX_TILES){ $('oTiles').textContent='Too many'; $('oSize').textContent='–'; w.textContent='That area is too large. Zoom in to a town or island, then save.'; w.hidden=false; $('bSaveArea').disabled=true; return; }
  w.hidden=true; $('bSaveArea').disabled=!!saving;
  $('oTiles').textContent=list.length.toLocaleString(); $('oSize').textContent='≈ '+fmtMB(list.length*AVG_TILE_KB*1000);
}
let saving=null;
$('bSaveArea').onclick=async()=>{
  if(!map||saving) return;
  if(!navigator.onLine){ toast('Connect to the internet to save an area.'); return; }
  const b=map.getBounds(), list=tileList(b); if(!list||!list.length) return;
  const c=await openCache(); if(!c){ toast('This browser cannot store map tiles.'); return; }
  try{ await navigator.storage?.persist?.(); }catch(e){}
  saving={cancel:false}; const job=saving;
  $('bSaveArea').disabled=true; $('bCancelSave').hidden=false; $('oProg').hidden=false;
  let done=0, failed=0, i=0;
  const worker=async()=>{
    while(i<list.length && !job.cancel){
      const u=list[i++];
      try{
        if(!(await c.match(u))){ const r=await fetch(u,{mode:'cors'}); if(r.ok) await c.put(u,r); else if(r.status!==404 && r.status!==204) failed++; }
      }catch(e){ failed++; }
      done++; $('oBar').style.width=(done/list.length*100).toFixed(1)+'%';
    }
  };
  await Promise.all(Array.from({length:6},worker));
  saving=null; $('bCancelSave').hidden=true; $('oProg').hidden=true; $('oBar').style.width='0';
  if(job.cancel){ toast('Stopped. Tiles already saved are kept.'); }
  else{
    const areas=lsGet(K.areas,[]);
    const c0=b.getCenter();
    areas.unshift({name:dm(c0.lat,'N','S')+' '+dm(c0.lng,'E','W'), date:Date.now(), tiles:list.length, b:[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()]});
    lsSet(K.areas,areas);
    toast(failed?`Saved, but ${failed} tiles failed. Try again on a better connection.`:'Area saved for offline use.');
  }
  estimate(); renderAreas();
};
$('bCancelSave').onclick=()=>{ if(saving) saving.cancel=true; };
function renderAreas(){
  const ul=$('areas'); ul.textContent='';
  const areas=lsGet(K.areas,[]);
  if(!areas.length){ const li=document.createElement('li'); li.className='none'; li.textContent='None yet. Pan to an area and tap Save this area.'; ul.appendChild(li); return; }
  for(const a of areas){
    const li=document.createElement('li');
    const t=document.createElement('div'); t.textContent=new Date(a.date).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'})+' · '+a.tiles.toLocaleString()+' tiles';
    const s=document.createElement('span'); s.textContent=a.name; t.appendChild(document.createElement('br')); t.appendChild(s);
    const go=document.createElement('button'); go.textContent='Go to';
    go.onclick=()=>{ setFollow(false); $('pOffline').hidden=true; map?.fitBounds([[a.b[0],a.b[1]],[a.b[2],a.b[3]]],{padding:20}); };
    li.append(t,go); ul.appendChild(li);
  }
}
let clearArm=false;
$('bClear').onclick=async()=>{
  if(!clearArm){ clearArm=true; $('bClear').textContent='Tap again to delete'; setTimeout(()=>{clearArm=false;$('bClear').textContent='Delete all offline maps';},3000); return; }
  clearArm=false; $('bClear').textContent='Delete all offline maps';
  try{ await caches.delete(TILE_CACHE); }catch(e){}
  cachePromise=null; lsSet(K.areas,[]); renderAreas(); estimate(); toast('Offline maps deleted.');
};

/* ---------------- connectivity + layout ---------------- */
function net(){ $('net').hidden=navigator.onLine; }
addEventListener('online',net); addEventListener('offline',net); net();
new ResizeObserver(()=>document.documentElement.style.setProperty('--dock-h',$('dock').offsetHeight+'px')).observe($('dock'));

if('serviceWorker' in navigator){ navigator.serviceWorker.register('sw.js').catch(()=>{}); }

initMap();
startGPS();
readouts();
})();
