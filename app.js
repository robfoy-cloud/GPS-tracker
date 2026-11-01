(() => {
'use strict';
const $ = id => document.getElementById(id);

/* ---------------- constants ---------------- */
const STYLE_URL = 'https://tiles.openfreemap.org/styles/liberty';
const TILE_CACHE = 'fieldline-tiles-v1';
const K = { tracks:'fieldline.tracks.v2', last:'fieldline.lastpos', style:'fieldline.style', tj:'fieldline.tilejson', areas:'fieldline.areas' };
const MAX_TILES = 15000;
// Saved-map detail levels: highest zoom stored. Vector tiles stop at z14; the map overzooms beyond.
const DETAIL = { overview:{z:7, label:'Overview'}, region:{z:9, label:'Region'}, street:{z:14, label:'Street'} };
// Rough average tile size by zoom, for the size estimate only.
const tileKB = z => z<=5?180 : z<=7?110 : z<=10?60 : 35;

/* ---------------- small helpers ---------------- */
const R = 6371008.8, rad = d => d * Math.PI / 180;
function hav(a, b){const dLa=rad(b.lat-a.lat),dLo=rad(b.lon-a.lon);const s=Math.sin(dLa/2)**2+Math.cos(rad(a.lat))*Math.cos(rad(b.lat))*Math.sin(dLo/2)**2;return 2*R*Math.asin(Math.sqrt(s));}
const fmtT = s => {s=Math.max(0,Math.round(s));const h=Math.floor(s/3600),m=Math.floor(s%3600/60),x=s%60;return h+':'+String(m).padStart(2,'0')+':'+String(x).padStart(2,'0');};
function dm(v,pos,neg){const a=Math.abs(v),d=Math.floor(a),m=(a-d)*60;return d+'° '+m.toFixed(3).padStart(6,'0')+'′ '+(v>=0?pos:neg);}
const fmtMB = b => b>=1e9?(b/1e9).toFixed(1)+' GB':b>=1e6?(b/1e6).toFixed(1)+' MB':Math.max(1,Math.round(b/1e3))+' KB';
function lsGet(k,def){try{const v=localStorage.getItem(k);return v==null?def:JSON.parse(v);}catch(e){return def;}}
function lsSet(k,v){try{localStorage.setItem(k,JSON.stringify(v));return true;}catch(e){return false;}}
function toast(t){const el=$('toast');el.textContent=t;el.hidden=false;clearTimeout(toast.h);toast.h=setTimeout(()=>el.hidden=true,3500);}
function banner(html){const b=$('banner');if(!html){b.hidden=true;return;}b.innerHTML=html;b.hidden=false;}
function status(s,t,q){$('status').dataset.s=s;$('status').dataset.q=q||0;$('statusText').textContent=t;}
/* GPS signal: bars from the reported accuracy; "no signal" when fixes stop arriving. */
let lastFixAt = 0, gpsBlocked = false;
function gpsQuality(acc){ return acc<=10?4 : acc<=30?3 : acc<=100?2 : 1; }
const QWORD = ['','Weak','Fair','Good','Good'];
function showGps(){
  if(gpsBlocked) return;
  if(!last){ status('search','Finding GPS',0); return; }
  const age=(Date.now()-lastFixAt)/1000;
  if(age>15){ status('off','No GPS signal · '+(age<90?Math.round(age)+' s':Math.round(age/60)+' min'),0); return; }
  const q=gpsQuality(last.acc);
  status(q>=3?'live':'search', 'GPS '+QWORD[q].toLowerCase()+' ±'+Math.round(last.acc)+' m', q);
}
setInterval(showGps, 2000);

/* ---------------- tile cache ---------------- */
let cachePromise = null;
const preview = lsGet('fieldline.preview', false) === true;   // offline preview: draw saved maps only
function openCache(){ if(!('caches' in window)) return Promise.resolve(null); return cachePromise ||= caches.open(TILE_CACHE).catch(()=>null); }
const notSaved = url => Object.assign(new Error('Not saved for offline use: '+url), {notSaved:true, url});
async function cachedArrayBuffer(url, signal){
  const c = await openCache();
  const hit = c && await c.match(url);
  if (hit) return hit.arrayBuffer();
  // Not saved: in offline preview, or with no connection, fail the tile (not a 404, which the map would
  // treat as an empty tile). The map 'error' handler then makes the map fall back to coarser saved tiles.
  if (preview) throw notSaved(url);
  let r;
  // no-store: never draw from the phone's short-term web cache, so offline shows only saved maps
  try { r = await fetch(url, {signal, mode:'cors', cache:'no-store'}); }
  catch (e) { if (e.name === 'AbortError') throw e; throw notSaved(url); }
  if (!r.ok) return new ArrayBuffer(0);
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
  // The map asks for 'cached://tile/z/x/y'; the handler below rebuilds the real address. Passing the full
  // address inside the custom URL is not safe: Safari rewrites 'cached://https://…', so lookups missed.
  REAL.tile = tj.tiles[0]; REAL.glyphs = style.glyphs || null;
  s.sources[srcKey] = {type:'vector', tiles:['cached://tile/{z}/{x}/{y}'], minzoom:tj.minzoom, maxzoom:tj.maxzoom,
    attribution:'<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" target="_blank">© OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>'};
  if (s.glyphs) s.glyphs = 'cached://font/{fontstack}/{range}';
  // Drop the shaded-relief picture layer: plain land with a sharp coastline reads better and saves space.
  for (const k in s.sources) if (s.sources[k].type === 'raster') { s.layers = s.layers.filter(l => l.source !== k); delete s.sources[k]; }
  return {style:s, tj};
}
const REAL = {tile:null, glyphs:null};
function realURL(u){
  let m = u.match(/tile\/+(\d+)\/+(\d+)\/+(\d+)\/?$/i);
  if (m && REAL.tile) return REAL.tile.replace('{z}',m[1]).replace('{x}',m[2]).replace('{y}',m[3]);
  m = u.match(/font\/+(.+?)\/+(\d+-\d+)\/?$/i);
  if (m && REAL.glyphs) return REAL.glyphs.replace('{fontstack}', decodeURIComponent(m[1])).replace('{range}', m[2]);
  return null;
}
maplibregl.addProtocol('cached', async (params, ac) => {
  const url = realURL(params.url);
  if (!url) throw Object.assign(new Error('Unrecognised map request '+params.url), {notSaved:true});
  try {
    return {data: await cachedArrayBuffer(url, ac.signal)};
  } catch (e) {
    // A missing font file must not sink the whole map piece: the map discards a piece if any of its
    // labels can't get its letters. Give an empty font instead; only those characters go missing.
    if (e.notSaved && /\/fonts\//.test(url)) return {data: new ArrayBuffer(0)};
    throw e;
  }
});

/* ---------------- state ---------------- */
let map = null, mapReady = false;
let last = null, follow = true, firstFix = true, watchId = null, bearing = 0;
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
  window.fieldlineMap = map;   // handy for debugging from the browser console
  map.addControl(new maplibregl.NavigationControl({showCompass:false}),'top-right');
  map.addControl(new maplibregl.ScaleControl({unit:'metric',maxWidth:110}),'bottom-left');
  map.on('dragstart', e => { if (e.originalEvent) setFollow(false); });
  map.on('moveend', () => { if (!$('pOffline').hidden) estimate(); });
  // A tile that is not saved fails; ask the map at once to look for coarser saved tiles to draw instead
  // (otherwise it waits for the next pan or zoom and leaves the square blank).
  let refill = null;
  map.on('error', e => {
    { const msg=String(e.error?.message||e.error), fm=msg.match(/fonts\/[^/]+\/(\d+-\d+)/), k=fm?'font range '+fm[1]:/Not saved/.test(msg)?'map piece not saved':msg.slice(0,60); (window.__mapErrTally ||= {})[k]=(window.__mapErrTally[k]||0)+1; }
    (window.__mapErrors ||= []).push((e.error?.message||String(e.error)).slice(0,160)+(e.tile?' @'+e.tile.tileID?.canonical?.z+'/'+e.tile.tileID?.canonical?.x+'/'+e.tile.tileID?.canonical?.y:'')); if(window.__mapErrors.length>50) window.__mapErrors.shift();
    if (!e.tile) { console.warn(e.error); return; }
    clearTimeout(refill);
    refill = setTimeout(() => {
      try { for (const sc of Object.values(map.style.sourceCaches)) sc.update(map.transform, map.terrain); map.triggerRepaint(); } catch (err) {}
    }, 60);
  });
  map.on('load', () => {
    map.addSource('acc',{type:'geojson',data:empty});
    map.addSource('me',{type:'geojson',data:empty});
    map.addSource('trk',{type:'geojson',data:empty});
    map.addSource('saved',{type:'geojson',data:empty});
    map.addSource('route',{type:'geojson',data:empty});
    map.addLayer({id:'route-line',type:'line',source:'route',filter:['==','$type','LineString'],layout:{'line-cap':'round'},paint:{'line-color':'#1A73E8','line-width':2.5,'line-dasharray':[2,2],'line-opacity':.8}});
    map.addLayer({id:'route-ends',type:'circle',source:'route',filter:['==','$type','Point'],paint:{'circle-radius':6,'circle-color':'#FFFFFF','circle-stroke-color':'#1A73E8','circle-stroke-width':3}});
    map.addLayer({id:'saved-line',type:'line',source:'saved',layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#5B3FA8','line-width':4,'line-opacity':.85}});
    map.addLayer({id:'trk-case',type:'line',source:'trk',layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#FFFFFF','line-width':7}});
    map.addLayer({id:'trk-line',type:'line',source:'trk',layout:{'line-join':'round','line-cap':'round'},paint:{'line-color':'#C9440E','line-width':4}});
    map.addLayer({id:'acc-fill',type:'fill',source:'acc',paint:{'fill-color':'#1A73E8','fill-opacity':.14}});
    map.addLayer({id:'acc-line',type:'line',source:'acc',paint:{'line-color':'#1A73E8','line-width':1,'line-opacity':.5}});
    map.addImage('arrow', arrowImage(), {pixelRatio:2});
    map.addImage('jet-anim', animatedJet(), {pixelRatio:2});
    map.addLayer({id:'me-jet',type:'symbol',source:'me',layout:{'icon-image':['get','icon'],'icon-rotate':['get','brg'],
      'icon-rotation-alignment':'map','icon-allow-overlap':true,'icon-ignore-placement':true}});
    mapReady = true;
    drawPosition(); drawTrack(); drawSaved(); drawJourney();
    // A fix that arrived before the map was ready: go there now.
    if(last && firstFix){ firstFix=false; map.jumpTo({center:[last.lon,last.lat], zoom:Math.max(map.getZoom(),(last.spd||0)>40?7:16)}); }
  });
}

/* Small top-down jet, nose up (north); rotated to the direction of travel on the map. */
/* Position marker: a navigation arrow on the ground, an animated jet in the air. Both point north
   in the image and are rotated on the map to the direction of travel. */
const JET=[[32,2],[35.5,9],[35.5,25],[61,40],[61,45],[35.5,38],[35,51],[44,57.5],[44,61.5],[32,58.5],[20,61.5],[20,57.5],[29,51],[28.5,38],[3,45],[3,40],[28.5,25],[28.5,9]];
function arrowImage(){
  const n=64, c=document.createElement('canvas'); c.width=c.height=n; const g=c.getContext('2d');
  g.shadowColor='rgba(0,0,0,.3)'; g.shadowBlur=4; g.shadowOffsetY=1;
  g.beginPath(); g.moveTo(32,6); g.lineTo(54,55); g.lineTo(32,44); g.lineTo(10,55); g.closePath();
  g.lineJoin='round'; g.lineWidth=5; g.strokeStyle='#FFFFFF'; g.stroke();
  g.shadowColor='transparent'; g.fillStyle='#1A73E8'; g.fill();
  return g.getImageData(0,0,n,n);
}
// The jet is drawn centred on a larger canvas so its exhaust and trails fit behind it while it rotates
// about its own centre. Redrawn at ~14 frames a second only while airborne, to spare the battery.
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
function animatedJet(){
  const N=192, U=N/128;               // canvas px; 128 drawing units; plane is 64 units wide in the middle
  let ctx=null, last=0;
  const img={ width:N, height:N, data:new Uint8Array(N*N*4),
    onAdd(){ const c=document.createElement('canvas'); c.width=c.height=N; ctx=c.getContext('2d',{willReadFrequently:true}); },
    render(){
      const now=performance.now();
      if(last && now-last<70) return false;
      last=now; draw(reduceMotion?0:now/1000);
      img.data.set(ctx.getImageData(0,0,N,N).data);
      return true;
    }};
  function draw(t){
    const g=ctx; g.setTransform(1,0,0,1,0,0); g.clearRect(0,0,N,N); g.setTransform(U,0,0,U,32*U,32*U); // plane space: 0..64
    // vapour trails streaming back from the two engines, with moving puffs to show speed
    for(const ex of [19,45]){
      const grad=g.createLinearGradient(0,40,0,100); grad.addColorStop(0,'rgba(255,255,255,.95)'); grad.addColorStop(1,'rgba(255,255,255,0)');
      const edge=g.createLinearGradient(0,40,0,100); edge.addColorStop(0,'rgba(20,50,90,.35)'); edge.addColorStop(1,'rgba(20,50,90,0)');
      g.beginPath(); g.moveTo(ex-2.5,41); g.lineTo(ex+2.5,41); g.lineTo(ex+6,100); g.lineTo(ex-6,100); g.closePath();
      g.fillStyle=grad; g.fill(); g.lineWidth=1; g.strokeStyle=edge; g.stroke();
      for(let k=0;k<5;k++){
        const y=46+((t*45+k*11+ex)%54), r=2+(y-46)*0.07, a=Math.max(0,.8-(y-46)/70);
        g.fillStyle=`rgba(255,255,255,${a.toFixed(2)})`; g.strokeStyle=`rgba(20,50,90,${(a*0.35).toFixed(2)})`;
        g.beginPath(); g.arc(ex+Math.sin(t*3+k)*0.7,y,r,0,7); g.fill(); g.stroke();
      }
      // flickering flame at the engine exhaust
      const f=1+0.35*Math.sin(t*31+ex)+0.2*Math.sin(t*17.3+ex*2);
      const fg=g.createLinearGradient(0,38,0,38+14*f); fg.addColorStop(0,'rgba(255,250,200,1)'); fg.addColorStop(.4,'rgba(255,160,40,1)'); fg.addColorStop(1,'rgba(240,70,20,0)');
      g.fillStyle=fg; g.beginPath(); g.moveTo(ex-3.2,38); g.quadraticCurveTo(ex,38+17*f,ex+3.2,38); g.closePath(); g.fill();
    }
    // engine pods under the wings
    g.fillStyle='#0F4FA8'; for(const ex of [19,45]){ g.beginPath(); g.ellipse(ex,33.5,2.4,5,0,0,7); g.fill(); }
    // the jet
    g.beginPath(); JET.forEach(([x,y],i)=>i?g.lineTo(x,y):g.moveTo(x,y)); g.closePath();
    g.lineJoin='round'; g.lineWidth=3.5; g.strokeStyle='#FFFFFF'; g.stroke(); g.fillStyle='#1A73E8'; g.fill();
    g.fillStyle='rgba(255,255,255,.7)'; g.beginPath(); g.ellipse(32,12,1.6,3.4,0,0,7); g.fill();   // cockpit glint
  }
  return img;
}
// Keep the jet animating while airborne and the app is on screen
let animTimer=null;
function setJetAnimation(on){
  on = on && !reduceMotion && document.visibilityState==='visible';
  if(on && !animTimer) animTimer=setInterval(()=>map&&map.triggerRepaint(),70);
  if(!on && animTimer){ clearInterval(animTimer); animTimer=null; }
}
document.addEventListener('visibilitychange',()=>setJetAnimation(flight?.phase==='air'));
function brg(a,b){const y=Math.sin(rad(b.lon-a.lon))*Math.cos(rad(b.lat)),x=Math.cos(rad(a.lat))*Math.sin(rad(b.lat))-Math.sin(rad(a.lat))*Math.cos(rad(b.lat))*Math.cos(rad(b.lon-a.lon));return (Math.atan2(y,x)*180/Math.PI+360)%360;}
function accCircle(p){
  const n=48, coords=[], r=Math.max(p.acc||0,1);
  for(let i=0;i<=n;i++){const a=i/n*2*Math.PI;coords.push([p.lon+r*Math.cos(a)/(111320*Math.cos(rad(p.lat))),p.lat+r*Math.sin(a)/110574]);}
  return {type:'Feature',geometry:{type:'Polygon',coordinates:[coords]}};
}
function drawPosition(){
  if(!mapReady||!last) return;
  const air = flight.phase==='air';
  map.getSource('me').setData({type:'Feature',properties:{brg:bearing, icon: air?'jet-anim':'arrow'},geometry:{type:'Point',coordinates:[last.lon,last.lat]}});
  setJetAnimation(air);
  map.getSource('acc').setData(last.acc ? accCircle(last) : empty);
}
const line = pts => pts.length>1 ? {type:'Feature',geometry:{type:'LineString',coordinates:pts.map(p=>[p.lon,p.lat])}} : empty;
function drawTrack(){ if(mapReady) map.getSource('trk').setData(rec?line(rec.pts):empty); }
function drawSaved(){ if(mapReady) map.getSource('saved').setData(shown?line(shown.pts):empty); $('bHide').hidden=!shown; }

function setFollow(on){
  follow = on; $('bFollow').setAttribute('aria-pressed', String(on));
  if(on && last && map) map.easeTo({center:[last.lon,last.lat], zoom:Math.max(map.getZoom(),(last.spd||0)>40?6:15), duration:500});
}
$('bFollow').onclick = () => { if(!last){ toast('No position fix yet.'); return; } setFollow(true); };

/* ---------------- GPS ---------------- */
function startGPS(){
  if(!('geolocation' in navigator)){ status('off','No GPS'); banner('This browser has no location support.'); return; }
  showGps();
  watchId = navigator.geolocation.watchPosition(onPos, onErr, {enableHighAccuracy:true, maximumAge:0, timeout:30000});
  gpsWatchStarted = Date.now();
}
/* iOS can quietly stop sending positions after a signal dropout (common in a cabin) or after the app
   was in the background. Restart the watch if nothing has arrived for 45 s, and on returning to the app. */
let gpsWatchStarted = 0;
function restartGPS(){
  if(sim || gpsBlocked || !gpsStarted) return;
  if(watchId!=null){ try{ navigator.geolocation.clearWatch(watchId); }catch(e){} watchId=null; }
  startGPS();
}
setInterval(()=>{
  if(document.visibilityState!=='visible') return;
  const quietFor = Date.now() - Math.max(lastFixAt, gpsWatchStarted);
  if(quietFor > 45000) restartGPS();
}, 15000);
document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') restartGPS(); });
/* Precise Location off: iOS blurs the position to several km. Say how to fix it. */
let coarseFixes = 0;
let lastSave = 0, headFrom = null;
function onPos(pos){
  const c = pos.coords;
  const p = {lat:c.latitude, lon:c.longitude, acc:c.accuracy, ele:c.altitude, spd:c.speed, t:pos.timestamp};
  const prev = last; last = p;
  lastFixAt = Date.now(); gpsBlocked = false; showGps();
  coarseFixes = c.accuracy > 1500 ? coarseFixes+1 : 0;
  if(coarseFixes===3 && !sim){ banner('<b>Your position is only approximate (±'+Math.round(c.accuracy/1000)+' km).</b> Turn on Precise Location: Settings → Privacy &amp; Security → Location Services → Safari Websites (or Flightroute) → Precise Location.'); $('banner').dataset.kind='gps'; }
  if($('banner').dataset.kind==='gps') { banner(null); $('banner').dataset.kind=''; }
  if(!sim && Date.now()-lastSave>30000){ lsSet(K.last,{lat:p.lat,lon:p.lon}); lastSave=Date.now(); }
  // Direction of travel: the GPS heading when moving, otherwise the bearing from the last clearly separate fix.
  if(isFinite(c.heading) && c.heading!==null && (c.speed||0)>1) bearing=c.heading;
  else if(headFrom && hav(headFrom,p) > Math.max(8, p.acc)) bearing=brg(headFrom,p);
  if(!headFrom || hav(headFrom,p) > Math.max(8, p.acc)) headFrom=p;
  if(p.spd==null||isNaN(p.spd)){ p.spd = prev ? (()=>{const dt=(p.t-prev.t)/1000;return dt>0?hav(prev,p)/dt:0;})() : null; }

  if(rec && !paused){
    const lp = rec.pts[rec.pts.length-1];
    // In the air a fix through the cabin window is rougher, but ±250 m hardly matters at 800 km/h
    const maxAcc = flight.phase==='air' ? 250 : 50;
    if(p.acc<=maxAcc && (!lp || hav(lp,p) >= Math.max(3, Math.min(p.acc*0.4, 40)))){
      rec.pts.push({lat:+p.lat.toFixed(7), lon:+p.lon.toFixed(7), ele:p.ele==null?null:+p.ele.toFixed(1), t:p.t});
      drawTrack();
    }
  }
  if(map){
    if(firstFix){ firstFix=false; map.jumpTo({center:[p.lon,p.lat], zoom:Math.max(map.getZoom(),(p.spd||0)>40?7:16)}); }
    else if(follow) map.easeTo({center:[p.lon,p.lat], duration:600});
  }
  flightCheck(p);
  drawPosition(); readouts();
}
function onErr(err){
  if(err.code===1){
    gpsBlocked = true; status('off','Location blocked',0);
    banner('<b>Location access is turned off for this site.</b> On iPhone: Settings → Privacy &amp; Security → Location Services → Safari Websites → While Using the App, then reload. If you added Flightroute to your home screen, allow it there too.');
    $('banner').dataset.kind='gps';
  } else {
    showGps();
  }
}

/* ---------------- readouts ---------------- */
function trackStats(pts){
  let d=0, mv=0;
  for(let i=1;i<pts.length;i++){const a=pts[i-1],b=pts[i],seg=hav(a,b),dt=(b.t-a.t)/1000;d+=seg;if(dt>0&&dt<900&&seg/dt>0.3)mv+=dt;}
  return {d, mv};
}
function readouts(){
  const st = rec ? trackStats(rec.pts) : {d:0,mv:0};
  $('rDist').innerHTML = (st.d/1000).toFixed(2)+'<small>km</small>';
  $('rTime').textContent = fmtT(rec ? (Date.now()-rec.startedAt-rec.pausedMs-(paused?Date.now()-paused:0))/1000 : 0);
  const kmh = last&&last.spd!=null ? last.spd*3.6 : null;
  $('rSpd').innerHTML = (kmh==null ? '–' : kmh>=100 ? Math.round(kmh).toLocaleString() : kmh.toFixed(1))+'<small>km/h</small>';
  $('rAlt').innerHTML = (last&&last.ele!=null ? Math.round(last.ele).toLocaleString() : '–')+'<small>m</small>';
  const togo = (journey&&last) ? '  ·  '+Math.round(hav(last,journey.to)/1000).toLocaleString()+' km to '+journey.to.name : '';
  $('rPos').textContent = last ? dm(last.lat,'N','S')+'  '+dm(last.lon,'E','W')+(last.ele!=null?'  ·  '+Math.round(last.ele).toLocaleString()+' m / '+Math.round(last.ele*3.28084).toLocaleString()+' ft':'')+togo : 'Waiting for a position fix';
}
setInterval(()=>{ if(rec) readouts(); showFlight(); }, 1000);

/* ---------------- flight simulator (for testing on the ground) ---------------- */
let sim = null;   // {timer, saved}
function simulateFlight(){
  if(sim) return;
  if(rec){ toast('Stop recording first.'); return; }
  // Route: the planned journey, else 600 km north-west of here
  const here = last || (map ? {lat:map.getCenter().lat, lon:map.getCenter().lng} : {lat:35.85, lon:14.48});
  let A = (journey&&journey.from) || J.from || here, B = (journey&&journey.to) || J.to;
  if(!B){ const d=600/6371, b=rad(315), la=rad(A.lat), lo=rad(A.lon);
    const la2=Math.asin(Math.sin(la)*Math.cos(d)+Math.cos(la)*Math.sin(d)*Math.cos(b));
    const lo2=lo+Math.atan2(Math.sin(b)*Math.sin(d)*Math.cos(la),Math.cos(d)-Math.sin(la)*Math.sin(la2));
    B={lat:la2*180/Math.PI, lon:lo2*180/Math.PI, name:'test destination'}; }
  const g = A.elev ?? 60, path = gcPoints(A,B,5);
  // Flight profile: [steps, speed m/s from→to, altitude m from→to]; one step = 5 s of GPS time
  // [steps, seconds of flight per step, speed m/s from→to, altitude m from→to]: about an hour gate to gate
  const prof=[[8,15,6,6,g,g],[5,6,20,78,g,g],[25,25,85,230,g+60,11000],[50,50,230,230,11000,11000],[25,30,230,85,11000,g+250],[3,10,75,35,g+40,g],[12,5,10,6,g,g]];
  const steps=[]; for(const [n,dt,s0,s1,e0,e1] of prof) for(let i=0;i<n;i++){ const f=n>1?i/(n-1):1; steps.push({dt, spd:s0+(s1-s0)*f, ele:e0+(e1-e0)*f}); }
  // Spread the route over the flight in proportion to speed, so the whole journey plays in about a minute
  const tot=steps.reduce((a,x)=>a+x.spd,0); let cum=0;
  for(const st of steps){ cum+=st.spd; st.f=cum/tot; }
  const at=f=>{ const x=f*(path.length-1), i=Math.min(path.length-2,Math.floor(x)), r=x-i; return {lat:path[i].lat+(path[i+1].lat-path[i].lat)*r, lon:path[i].lon+(path[i+1].lon-path[i].lon)*r, hd:brg(path[i],path[i+1])}; };
  // Pause real GPS and keep the real flight timer to restore afterwards
  if(watchId!=null){ navigator.geolocation.clearWatch(watchId); watchId=null; }
  sim={saved:flight, timer:null};
  flight={phase:'ground'}; groundAlt=null; slowSince=null; showFlight();
  $('simPill').hidden=false; $('pOffline').hidden=true;
  if(map){ map.jumpTo({center:[A.lon,A.lat], zoom:13}); }
  setFollow(true); firstFix=false;
  let k=0, gt=Date.now();
  sim.timer=setInterval(()=>{
    if(k>=steps.length){ clearInterval(sim.timer); setTimeout(()=>endSimulation('Simulated flight finished.'), 5000); return; }
    const st=steps[k], p=at(st.f); gt+=st.dt*1000; sim.now=gt;
    onPos({timestamp:gt, coords:{latitude:p.lat, longitude:p.lon, accuracy:6, altitude:st.ele, speed:st.spd, heading:p.hd}});
    k++;
  }, 420);
}
function endSimulation(msg){
  if(!sim) return;
  clearInterval(sim.timer);
  flight=sim.saved||{phase:'ground'}; sim=null;
  groundAlt=null; slowSince=null; last=null; firstFix=true;
  $('simPill').hidden=true; showFlight(); setJetAnimation(false);
  status('search','Finding GPS',0);
  gpsStarted=false; startGPSOnce(); if(msg) toast(msg);
}
$('bSim').onclick=simulateFlight;
$('simPill').onclick=()=>endSimulation('Simulation stopped.');

/* ---------------- flight timer ---------------- */
// state: {phase:'ground'|'air'|'landed', takeoff, landing}; survives reloads.
let flight = lsGet('fieldline.flight', {phase:'ground'});
let groundAlt = null, groundAt = 0, slowSince = null;
const AIR_ABOVE = 50;        // metres above the ground to count as airborne
function saveFlight(){ if(!sim) lsSet('fieldline.flight', flight); }
function flightCheck(p){
  if(p.ele==null || !isFinite(p.ele)) return;
  const spd = p.spd ?? 0, gt = p.t || Date.now(), wall = sim ? gt : Date.now();   // gt: GPS time for durations; wall: clock for the timer (the simulator's own clock in a simulation)
  // Ground level: the departure airport's elevation when known, otherwise the altitude while moving slowly.
  if(spd < 15 && p.acc <= 50 && flight.phase !== 'air'){
    const ref = (journey && journey.from && journey.from.elev!=null && hav(p,journey.from) < 15000) ? journey.from.elev : null;
    if(ref!=null) groundAlt = ref;
    else if(groundAlt==null || gt-groundAt > 600000 || p.ele < groundAlt) groundAlt = p.ele;
    groundAt = gt;
  }
  if(flight.phase !== 'air'){
    const climbed = groundAlt!=null && p.ele - groundAlt > AIR_ABOVE && spd > 25;
    if(climbed || spd > 70){ flight = {phase:'air', takeoff: wall}; slowSince = null; saveFlight(); toast('Airborne: flight timer started.');
      if(map && follow && map.getZoom() > 10) map.jumpTo({center:[p.lon,p.lat], zoom:8}); }
  } else {
    if(spd < 20){ slowSince ??= gt; if(gt - slowSince > 30000){ flight = {phase:'landed', takeoff: flight.takeoff, landing: sim ? slowSince : wall - (gt - slowSince)}; saveFlight(); groundAlt = p.ele; groundAt = gt; toast('Landed. Flight time '+fmtT((flight.landing-flight.takeoff)/1000)+'.'); } }
    else slowSince = null;
  }
  showFlight();
}
function showFlight(){
  const el=$('flight'), now = sim ? (sim.now||Date.now()) : Date.now();
  if(flight.phase==='air'){ el.hidden=false; el.dataset.state='air'; $('flightText').textContent='In the air '+fmtT((now-flight.takeoff)/1000); }
  else if(flight.phase==='landed' && now-flight.landing < 6*3600e3){ el.hidden=false; el.dataset.state='landed'; $('flightText').textContent='Landed · flight '+fmtT((flight.landing-flight.takeoff)/1000); }
  else el.hidden=true;
}
showFlight();

/* ---------------- recording ---------------- */
async function lockScreen(){ try{ wake = await navigator.wakeLock?.request('screen'); }catch(e){ wake=null; } }
document.addEventListener('visibilitychange', ()=>{ if(rec && document.visibilityState==='visible') lockScreen(); });
function setRecButtons(){
  const b=$('bRec');
  b.classList.toggle('recording', !!rec && !paused);
  $('bRecT').textContent = !rec ? 'Record track' : paused ? 'Resume' : 'Pause';
  $('bStop').hidden = !rec;
  $('recPill').hidden = !rec; $('recText').textContent = paused ? 'Paused' : 'Recording';
}
$('bRec').onclick = () => {
  if(!rec){
    rec = {pts:[], startedAt:Date.now(), pausedMs:0}; paused=false;
    lockScreen(); setFollow(true);
  } else if(!paused){ paused = Date.now(); }
  else { rec.pausedMs += Date.now()-paused; paused=false; }
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
  setRecButtons(); readouts(); drawTrack();
};

/* ---------------- sheets ---------------- */
function openSheet(id){ document.querySelectorAll('.sheet').forEach(s=>s.hidden = s.id!==id); if(id==='pOffline'){estimate();renderAreas();planJourney();} if(id==='pTracks') renderTracks(); }
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
  return `<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1" creator="Flightroute" xmlns="http://www.topografix.com/GPX/1/1">\n  <trk><name>${esc(t.name)}</name>\n    <trkseg>\n${pts}\n    </trkseg>\n  </trk>\n</gpx>\n`;
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
/* Besides the map data, the style draws low zooms from shaded-relief images and needs fonts and icons. */
function styleExtras(){
  const st=lsGet(K.style,null); if(!st) return {raster:[], assets:[]};
  const raster=[];   // relief layer is not used (see loadStyle)
  const assets=[];
  if(st.glyphs){
    const fonts=new Set();
    for(const l of st.layers){ const f=l.layout?.['text-font']; if(Array.isArray(f)&&f.every(x=>typeof x==='string')) fonts.add(f.join(',')); }
    // Latin, Latin Extended, Greek, Cyrillic, Hebrew, Arabic (names also show in local script), and
    // General Punctuation (8192-8447: curly apostrophes and dashes, common in French and Italian names)
    for(const f of fonts) for(const r of [0,1,2,3,4,5,6,32]) assets.push(st.glyphs.replace('{fontstack}',f).replace('{range}',`${256*r}-${256*r+255}`));
  }
  if(typeof st.sprite==='string') for(const sfx of ['.json','.png','@2x.json','@2x.png']) assets.push(st.sprite+sfx);
  return {raster, assets};
}
const xyz = (tpl,z,x,y) => tpl.replace('{z}',z).replace('{x}',x).replace('{y}',y);
const detail = () => (document.querySelector('input[name="detail"]:checked')||{}).value || 'overview';
function tileList(b){
  const tj=lsGet(K.tj,null); if(!tj) return [];
  const tpl=tj.tiles[0], maxz=Math.min(tj.maxzoom||14, DETAIL[detail()].z), out=[];
  for(let z=0; z<=maxz; z++){
    const x0=lon2x(b.getWest(),z), x1=lon2x(b.getEast(),z), y0=lat2y(b.getNorth(),z), y1=lat2y(b.getSouth(),z);
    if((x1-x0+1)*(y1-y0+1)+out.length > MAX_TILES*2) return null;
    for(let x=x0;x<=x1;x++) for(let y=y0;y<=y1;y++) out.push({z,x,y,u:xyz(tpl,z,x,y)});
  }
  return out;
}
async function storageUsed(){ try{ const e=await navigator.storage.estimate(); $('oUsed').textContent=fmtMB(e.usage||0); }catch(e){ $('oUsed').textContent='–'; } }
function estimate(){
  storageUsed();
  if(!map){ $('oTiles').textContent='–'; $('oSize').textContent='–'; $('bSaveArea').disabled=true; return; }
  const list=tileList(map.getBounds());
  const w=$('oWarn');
  if(!list||list.length>MAX_TILES){ $('oTiles').textContent='Too many'; $('oSize').textContent='–';
    w.textContent = detail()==='overview' ? 'That area is too large even at overview detail. Zoom in a little.' : 'Too large at this detail. Choose a lower detail level or zoom in.';
    w.hidden=false; $('bSaveArea').disabled=true; return; }
  const bytes=list.reduce((a,t)=>a+tileKB(t.z)*1000,0);
  w.textContent='That is a large download. Use Wi-Fi and keep this screen open until it finishes.';
  w.hidden = bytes < 150e6; $('bSaveArea').disabled=!!saving;
  $('oTiles').textContent=list.length.toLocaleString(); $('oSize').textContent='≈ '+fmtMB(bytes);
}
let saving=null;
/* Downloads tile URLs into the offline cache. Resolves {cancelled, failed}, or null if it could not start. */
/* Downloads map pieces into the offline store. Each piece is tried up to 3 times (the map server can
   turn requests away when many arrive at once). Afterwards the store is checked, so the result says how
   many pieces are really saved. Resolves {cancelled, saved, total, failed, reasons} or null. */
async function downloadTiles(urls, label){
  if(saving) return null;
  if(!navigator.onLine){ toast('Connect to the internet to save maps.'); return null; }
  const c=await openCache(); if(!c){ toast('This browser cannot store map tiles.'); return null; }
  try{ await navigator.storage?.persist?.(); }catch(e){}
  saving={cancel:false}; const job=saving; lockScreen();
  $('bSaveArea').disabled=true; $('bSaveJourney').disabled=true; $('oResult').hidden=true;
  $('oProg').hidden=false; $('oProgT').textContent=label;
  const reasons={}; let done=0, i=0, pause=0;
  const sleep=ms=>new Promise(r=>setTimeout(r,ms));
  async function getOne(u){
    for(let attempt=0; attempt<3 && !job.cancel; attempt++){
      if(pause>Date.now()) await sleep(pause-Date.now());
      try{
        const r=await fetch(u,{mode:'cors'});
        if(r.ok){ await c.put(u, r.redirected ? new Response(await r.blob(),{headers:r.headers}) : r); return true; }
        if(r.status===404||r.status===204) return true;                       // genuinely empty piece
        reasons['server '+r.status]=(reasons['server '+r.status]||0)+1;
        if(r.status===429||r.status>=500){ const ra=+r.headers.get('retry-after')||2; pause=Date.now()+ra*1000; }
      }catch(e){
        const why=e.name==='QuotaExceededError'?'phone storage full':'connection';
        reasons[why]=(reasons[why]||0)+1;
        if(e.name==='QuotaExceededError') { job.cancel='full'; return false; }
      }
      await sleep(600*(attempt+1)**2);
    }
    return false;
  }
  const worker=async()=>{
    while(i<urls.length && !job.cancel){
      const u=urls[i++];
      try{ if(!(await c.match(u))) await getOne(u); }catch(e){ reasons['storage']=(reasons['storage']||0)+1; }
      done++; $('oBar').style.width=(done/urls.length*100).toFixed(1)+'%';
      $('oProgT').textContent=label+' · '+Math.floor(done/urls.length*100)+'%';
    }
  };
  await Promise.all(Array.from({length:4},worker));
  // Check what really got stored
  $('oProgT').textContent='Checking saved maps…';
  let saved=0; for(const u of urls){ try{ if(await c.match(u)) saved++; }catch(e){} }
  saving=null; if(!rec){ try{ wake?.release(); }catch(e){} wake=null; }
  $('oProg').hidden=true; $('oBar').style.width='0';
  const failed=urls.length-saved, why=Object.entries(reasons).map(([k,v])=>k+' ×'+v).join(', ');
  const res=$('oResult'); res.hidden=false; res.classList.toggle('err', failed>0);
  if(job.cancel==='full') res.textContent=`Stopped: the phone's storage for this site is full. ${saved.toLocaleString()} of ${urls.length.toLocaleString()} map pieces saved.`;
  else if(job.cancel) res.textContent=`Stopped. ${saved.toLocaleString()} of ${urls.length.toLocaleString()} map pieces saved; tap Save again to finish.`;
  else if(failed) res.textContent=`${saved.toLocaleString()} of ${urls.length.toLocaleString()} map pieces saved. ${failed.toLocaleString()} could not be downloaded (${why||'unknown'}). Tap Save again to fill the gaps; pieces already saved are skipped.`;
  else res.textContent=`All ${urls.length.toLocaleString()} map pieces saved.`;
  estimate(); planJourney();
  return {cancelled:!!job.cancel, saved, total:urls.length, failed, reasons:why};
}
$('bSaveArea').onclick=async()=>{
  if(!map) return;
  const b=map.getBounds(), list=tileList(b); if(!list||!list.length) return;
  const ex=styleExtras(), urls=list.map(t=>t.u);
  for(const t of list) if(t.x!=null) for(const r of ex.raster) if(t.z<=r.maxz) urls.push(xyz(r.tpl,t.z,t.x,t.y));
  const res=await downloadTiles(urls.concat(ex.assets), 'Saving area');
  if(!res||(res.cancelled&&!res.saved)) return;
  const areas=lsGet(K.areas,[]), c0=b.getCenter();
  areas.unshift({name:dm(c0.lat,'N','S')+' '+dm(c0.lng,'E','W'), detail:detail(), date:Date.now(), tiles:list.length, saved:res.saved, total:res.total, b:[b.getWest(),b.getSouth(),b.getEast(),b.getNorth()]});
  lsSet(K.areas,areas); renderAreas();
  if(!res.failed) toast('Area saved for offline use.');
};

/* ---------------- check what is saved for the view on screen ---------------- */
$('bCheck').onclick=async()=>{
  const out=$('checkOut'); if(!map) return;
  const tj=lsGet(K.tj,null), c=await openCache();
  if(!tj||!c){ out.hidden=false; out.textContent='No saved maps yet.'; return; }
  out.hidden=false; out.textContent='Checking…';
  const b=map.getBounds(), tpl=tj.tiles[0], zNow=map.getZoom(), rows=[];
  for(let z=0; z<=14; z++){
    const x0=lon2x(b.getWest(),z), x1=lon2x(b.getEast(),z), y0=lat2y(b.getNorth(),z), y1=lat2y(b.getSouth(),z);
    const n=(x1-x0+1)*(y1-y0+1);
    if(n>300){ rows.push([z,'–','too many to check']); continue; }
    let have=0, bytes=0;
    for(let x=x0;x<=x1;x++) for(let y=y0;y<=y1;y++){ const r=await c.match(xyz(tpl,z,x,y)); if(r){ have++; bytes+=+(r.headers.get('content-length')||0); } }
    rows.push([z, have+' of '+n, have===n?'all saved':have?'partly saved':'none saved']);
  }
  const t=document.createElement('table');
  t.innerHTML='<thead><tr><th>Zoom</th><th>Map pieces</th><th></th></tr></thead>';
  const tb=document.createElement('tbody');
  for(const [z,a,w] of rows){ const tr=document.createElement('tr'); if(Math.floor(zNow)===z) tr.className='sel';
    for(const v of [z,a,w]){ const td=document.createElement('td'); td.textContent=v; tr.appendChild(td); } tb.appendChild(tr); }
  t.appendChild(tb); out.textContent='';
  const note=document.createElement('p'); note.className='hint';
  note.textContent='Screen is at zoom '+zNow.toFixed(1)+' (highlighted). Map data version '+(tpl.match(/planet\/([^/]+)\//)?.[1]||'?')+'.';
  out.append(note,t);
};

/* ---------------- diagnostics to paste into a support chat ---------------- */
$('bDiag').onclick=async()=>{
  const out=$('diagOut'); out.hidden=false; out.value='Collecting…';
  const lines=[], tj=lsGet(K.tj,null);
  lines.push('Flightroute diagnostics '+new Date().toISOString());
  lines.push('App: '+(document.querySelector('.ver')?.textContent||'?')+' | preview '+preview+' | online '+navigator.onLine);
  lines.push('Browser: '+navigator.userAgent);
  lines.push('Map data: '+(tj?tj.tiles[0]:'none')+' maxzoom '+(tj?.maxzoom??'?'));
  try{ const e=await navigator.storage.estimate(); lines.push('Storage used '+fmtMB(e.usage||0)+' of '+fmtMB(e.quota||0)+' | persisted '+(await navigator.storage.persisted?.())); }catch(e){ lines.push('Storage: n/a'); }
  try{
    const names=await caches.keys(); lines.push('Caches: '+names.join(', '));
    const c=await openCache(); const keys=c?await c.keys():[];
    const byZ={}, other={}; let redirected=0, sample=null;
    for(const r of keys){
      const m=r.url.match(/\/(\d+)\/(\d+)\/(\d+)\.pbf/);
      if(m){ byZ[m[1]]=(byZ[m[1]]||0)+1; if(!sample) sample=r.url; }
      else { const k=r.url.includes('/fonts/')?'fonts':r.url.includes('/sprites/')?'icons':'other'; other[k]=(other[k]||0)+1; }
    }
    lines.push('Saved map pieces: '+keys.length+' | by zoom '+Object.keys(byZ).sort((a,b)=>a-b).map(z=>'z'+z+':'+byZ[z]).join(' ')+' | '+JSON.stringify(other));
    if(sample){ lines.push('Example saved: '+sample); const r=await c.match(sample); if(r){ const b=await r.arrayBuffer(); lines.push('Example size '+b.byteLength+' bytes, type '+r.headers.get('content-type')+', redirected '+r.redirected); } else lines.push('Example NOT readable back'); }
    if(map){
      const z=Math.floor(map.getZoom()), ctr=map.getCenter(), u=tj?xyz(tj.tiles[0],z,lon2x(ctr.lng,z),lat2y(ctr.lat,z)):'';
      lines.push('Screen zoom '+map.getZoom().toFixed(2)+' centre '+ctr.lat.toFixed(3)+','+ctr.lng.toFixed(3)+' | centre piece saved: '+(u&&c?!!(await c.match(u)):'?')+' '+u);
      try{ const sc=map.style.sourceCaches; for(const k in sc){ const ids=sc[k].getIds(); if(!ids.length) continue; const st={}; ids.forEach(i=>{const t=sc[k].getTileByID(i); st[t.state]=(st[t.state]||0)+1;}); lines.push('Map source '+k+': '+JSON.stringify(st)); } }catch(e){}
    }
  }catch(e){ lines.push('Cache error: '+e.name+' '+e.message); }
  for(const a of lsGet(K.areas,[])) lines.push('Saved: '+(a.journey?'journey '+a.name:'area '+(a.detail||''))+' | '+(a.total?a.saved+'/'+a.total:a.tiles+' planned')+' | '+new Date(a.date).toISOString());
  lines.push('Last save result: '+($('oResult').textContent||'none this session'));
  lines.push('All map errors by kind: '+JSON.stringify(window.__mapErrTally||{}));
  lines.push('Recent map errors: '+(window.__mapErrors||[]).slice(-5).join(' || '));
  out.value=lines.join('\n');
  try{ await navigator.clipboard.writeText(out.value); toast('Diagnostics copied. Paste them into the chat.'); }
  catch(e){ out.focus(); out.select(); toast('Select all the text in the box and copy it.'); }
};

/* ---------------- journeys ---------------- */
const J = {from:null, to:null};
let journey = lsGet('fieldline.journey', null);   // the route drawn on the map: {from,to,...}
function gcPoints(a,b,stepKm){
  const p1=[rad(a.lat),rad(a.lon)], p2=[rad(b.lat),rad(b.lon)];
  const d=hav(a,b)/R, n=Math.max(1,Math.ceil(d*R/1000/stepKm)), out=[];
  for(let i=0;i<=n;i++){
    const f=i/n; if(d===0){out.push({lat:a.lat,lon:a.lon});continue;}
    const A=Math.sin((1-f)*d)/Math.sin(d), B=Math.sin(f*d)/Math.sin(d);
    const x=A*Math.cos(p1[0])*Math.cos(p1[1])+B*Math.cos(p2[0])*Math.cos(p2[1]);
    const y=A*Math.cos(p1[0])*Math.sin(p1[1])+B*Math.cos(p2[0])*Math.sin(p2[1]);
    const z=A*Math.sin(p1[0])+B*Math.sin(p2[0]);
    out.push({lat:Math.atan2(z,Math.hypot(x,y))*180/Math.PI, lon:Math.atan2(y,x)*180/Math.PI});
  }
  return out;
}
// Tiles covering a box of radius km around a point, for zooms z0..z1
function addBox(set, tpl, p, km, z0, z1){
  const dLat=km/110.574, dLon=km/(111.32*Math.max(0.05,Math.cos(rad(p.lat))));
  for(let z=z0;z<=z1;z++){
    const x0=lon2x(Math.max(-180,p.lon-dLon),z), x1=lon2x(Math.min(179.9999,p.lon+dLon),z);
    const y0=lat2y(p.lat+dLat,z), y1=lat2y(p.lat-dLat,z);
    for(let x=x0;x<=x1;x++) for(let y=y0;y<=y1;y++) set.set(z+'/'+x+'/'+y, z);
  }
}
function journeyTiles(a,b){
  const tj=lsGet(K.tj,null); if(!tj) return null;
  const tpl=tj.tiles[0], set=new Map(), maxz=Math.min(tj.maxzoom||14,14);
  // flight path: wide overview corridor, narrower corridor with towns
  // backdrop for the whole trip when zoomed right out
  const half=hav(a,b)/2000+800;
  addBox(set,tpl,{lat:(a.lat+b.lat)/2,lon:(a.lon+b.lon)/2},half,0,6);
  for(let z=0;z<=2;z++) for(let x=0;x<2**z;x++) for(let y=0;y<2**z;y++) set.set(z+'/'+x+'/'+y,z);   // whole world, very coarse
  // Along the route: overview wide, then sharper coastlines and towns closer to the line
  for(const p of gcPoints(a,b,20)){ addBox(set,tpl,p,250,0,6); addBox(set,tpl,p,150,7,8); addBox(set,tpl,p,50,9,9); }
  // departure and arrival: region around, streets close in
  for(const p of [a,b]){ addBox(set,tpl,p,35,0,12); addBox(set,tpl,p,10,13,maxz); }
  const urls=[], zs=[];
  const ex=styleExtras(); let extra=0;
  for(const [k,z] of set){
    const [zz,x,y]=k.split('/'); urls.push(xyz(tpl,zz,x,y)); zs.push(z);
    for(const r of ex.raster) if(z<=r.maxz){ urls.push(xyz(r.tpl,zz,x,y)); extra+=40e3; }
  }
  urls.push(...ex.assets); extra+=ex.assets.length*60e3;
  return {urls, tiles:set.size, bytes:zs.reduce((s,z)=>s+tileKB(z)*1000,0)+extra};
}
function planJourney(){
  const ok=J.from&&J.to;
  $('jEst').hidden=!ok;
  if(!ok){ $('bSaveJourney').disabled=true; return; }
  const plan=journeyTiles(J.from,J.to);
  $('jDist').innerHTML=Math.round(hav(J.from,J.to)/1000).toLocaleString()+'<small>km</small>';
  if(!plan){ $('jTiles').textContent='–'; $('jSize').textContent='–'; $('bSaveJourney').disabled=true; return; }
  $('jTiles').textContent=plan.tiles.toLocaleString(); $('jSize').textContent='≈ '+fmtMB(plan.bytes);
  $('bSaveJourney').disabled=!!saving||plan.urls.length>MAX_TILES*2;
}
function setPlace(which, place, quiet){
  J[which]=place; const inp=$(which==='from'?'jFrom':'jTo');
  inp.value=place?(place.code?place.code+' · ':'')+place.name:''; inp.classList.toggle('set',!!place);
  $(which==='from'?'rFrom':'rTo').hidden=true; planJourney();
  if(place && !quiet) rememberPlace(place);
}

/* ---- recent places and journeys ---- */
const RK = {places:'fieldline.recentPlaces', journeys:'fieldline.recentJourneys'};
const samePlace = (a,b) => a && b && a.name===b.name && Math.abs(a.lat-b.lat)<1e-3 && Math.abs(a.lon-b.lon)<1e-3;
function rememberPlace(p){
  if(p.name==='My position') return;
  const list=lsGet(RK.places,[]).filter(x=>!samePlace(x,p)); list.unshift(p); lsSet(RK.places,list.slice(0,8));
}
function rememberJourney(a,b,flightNo){
  const list=lsGet(RK.journeys,[]).filter(j=>!(samePlace(j.from,a)&&samePlace(j.to,b))); list.unshift({from:a,to:b,flight:flightNo||null}); lsSet(RK.journeys,list.slice(0,6));
  renderRecentJourneys();
}
function renderRecentJourneys(){
  const list=lsGet(RK.journeys,[]), box=$('jRecentList'); box.textContent='';
  $('jRecent').hidden=!list.length;
  for(const j of list){
    const b=document.createElement('button');
    b.textContent=(j.flight?j.flight+' · ':'')+(j.from.code||j.from.name)+' → '+(j.to.code||j.to.name);
    b.onclick=()=>{ setPlace('from',j.from,true); setPlace('to',j.to,true); if(j.flight) $('jFlight').value=j.flight; };
    box.appendChild(b);
  }
}
renderRecentJourneys();

/* ---- airports (bundled list, works offline) ---- */
let airports=null;
async function loadAirports(){
  if(airports) return airports;
  try{ const r=await fetch('airports.json'); airports=(await r.json()).map(a=>({iata:a[0],icao:a[1],name:a[2],city:a[3],cc:a[4],lat:a[5],lon:a[6],ft:a[7],
    key:(a[0]+' '+a[1]+' '+a[2]+' '+a[3]).normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase()})); }
  catch(e){ airports=[]; }
  return airports;
}
const fold = q => q.normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase();
function airportPlace(a){ return {name:a.city||a.name, code:a.iata, airport:a.name, lat:a.lat, lon:a.lon, elev:a.ft!=null?Math.round(a.ft*0.3048):null}; }
function findAirports(q){
  if(!airports) return [];
  const Q=q.trim().toUpperCase(), f=fold(q.trim()), out=[];
  const exact=airports.filter(a=>a.iata===Q||a.icao===Q);
  const starts=airports.filter(a=>!exact.includes(a)&&(fold(a.city).startsWith(f)||fold(a.name).startsWith(f)));
  const has=f.length>=3?airports.filter(a=>!exact.includes(a)&&!starts.includes(a)&&a.key.includes(f)):[];
  return out.concat(exact,starts,has).slice(0,6);
}

function placeLabel(f){
  const p=f.properties, parts=[p.city&&p.city!==p.name?p.city:null, p.state, p.country].filter(Boolean);
  return {name:p.name||p.city||p.country||'Unnamed place', sub:parts.join(', ')};
}
function wireSearch(which){
  const inp=$(which==='from'?'jFrom':'jTo'), ul=$(which==='from'?'rFrom':'rTo');
  let t=null, ac=null;
  const add=(label,sub,code,place)=>{
    const li=document.createElement('li'), b=document.createElement('button');
    if(code){ const c=document.createElement('span'); c.className='code'; c.textContent=code; b.appendChild(c); }
    b.appendChild(document.createTextNode(label));
    if(sub){ const sm=document.createElement('small'); sm.textContent=sub; b.appendChild(sm); }
    b.onclick=()=>setPlace(which,place); li.appendChild(b); ul.appendChild(li);
  };
  const tag=t=>{const li=document.createElement('li');li.className='tagline';li.textContent=t;ul.appendChild(li);};
  const msg=m=>{const li=document.createElement('li');li.className='msg';li.textContent=m;ul.appendChild(li);ul.hidden=false;};
  const showRecent=()=>{
    const list=lsGet(RK.places,[]); ul.textContent='';
    if(!list.length||inp.value.trim()){ if(!inp.value.trim()) ul.hidden=true; return; }
    tag('Recent'); for(const p of list) add(p.name, p.airport||'', p.code, p); ul.hidden=false;
  };
  inp.addEventListener('focus',()=>{ loadAirports(); if(!inp.value.trim()) showRecent(); });
  inp.addEventListener('blur',()=>setTimeout(()=>{ if(document.activeElement?.closest?.('.results')!==ul) ul.hidden=true; },200));
  inp.addEventListener('input',()=>{
    J[which]=null; inp.classList.remove('set'); planJourney();
    clearTimeout(t); const q=inp.value.trim();
    if(!q){ showRecent(); return; }
    if(q.length<2){ ul.hidden=true; return; }
    t=setTimeout(async()=>{
      await loadAirports();
      ul.textContent='';
      const aps=findAirports(q);
      if(aps.length){ tag('Airports'); for(const a of aps) add(a.city||a.name, a.name+' · '+a.cc, a.iata, airportPlace(a)); ul.hidden=false; }
      if(q.length<3) { if(!aps.length) ul.hidden=true; return; }
      if(!navigator.onLine){ if(!aps.length) msg('No airport matches. Searching other places needs a connection.'); return; }
      ac?.abort(); ac=new AbortController();
      try{
        const r=await fetch('https://photon.komoot.io/api/?limit=5&q='+encodeURIComponent(q),{signal:ac.signal});
        const js=await r.json();
        if(js.features?.length){ tag('Places'); for(const f of js.features){ const L=placeLabel(f); add(L.name,L.sub,null,{name:L.name,lat:f.geometry.coordinates[1],lon:f.geometry.coordinates[0]}); } ul.hidden=false; }
        else if(!aps.length) msg('No places found. Try an airport code or city name.');
      }catch(e){ if(e.name!=='AbortError' && !aps.length) msg('Place search failed. Check your connection.'); }
    },250);
  });
}
wireSearch('from'); wireSearch('to');
$('bFromHere').onclick=()=>{ if(!last){ toast('No position fix yet.'); return; } setPlace('from',{name:'My position',lat:+last.lat.toFixed(5),lon:+last.lon.toFixed(5),elev:last.ele!=null?Math.round(last.ele):null}); };

/* ---- flight number lookup (adsbdb.com, free, needs a connection) ---- */
let flightNo=null;
async function findFlight(){
  const raw=$('jFlight').value.toUpperCase().replace(/[^A-Z0-9]/g,''), m=$('jFlightMsg');
  const say=(t,err)=>{ m.textContent=t; m.hidden=false; m.classList.toggle('err',!!err); };
  if(raw.length<3){ say('Enter a flight number, for example KM114 or FR1234.',true); return; }
  if(!navigator.onLine){ say('Flight lookup needs a connection. You can still enter the airports below.',true); return; }
  say('Looking up '+raw+'…');
  try{
    const r=await fetch('https://api.adsbdb.com/v0/callsign/'+encodeURIComponent(raw));
    if(r.status===404){ say('No route found for '+raw+'. Some flights are listed under a different callsign; enter the airports below instead.',true); return; }
    if(!r.ok) throw new Error(r.status);
    const fr=(await r.json())?.response?.flightroute;
    if(!fr?.origin||!fr?.destination) throw new Error('no route');
    const ap=x=>({name:x.municipality||x.name, code:x.iata_code||x.icao_code, airport:x.name, lat:x.latitude, lon:x.longitude, elev:x.elevation!=null?Math.round(x.elevation*0.3048):null});
    flightNo=fr.callsign_iata||raw;
    setPlace('from',ap(fr.origin)); setPlace('to',ap(fr.destination));
    say((fr.airline?.name?fr.airline.name+' ':'')+flightNo+': '+fr.origin.name+' → '+fr.destination.name+'. Check this matches your booking; routes can change.');
  }catch(e){ say('Flight lookup failed. Check your connection, or enter the airports below.',true); }
}
$('bFlight').onclick=findFlight;
$('jFlight').addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); findFlight(); } });
$('jFlight').addEventListener('input',()=>{ flightNo=null; });

$('bSaveJourney').onclick=async()=>{
  if(!J.from||!J.to) return;
  const plan=journeyTiles(J.from,J.to); if(!plan) return;
  const res=await downloadTiles(plan.urls,'Saving '+J.from.name+' → '+J.to.name);
  if(!res||(res.cancelled&&!res.saved)) return;
  const areas=lsGet(K.areas,[]).filter(a=>!(a.journey&&samePlace(a.from,J.from)&&samePlace(a.to,J.to)));
  const lats=[J.from.lat,J.to.lat], lons=[J.from.lon,J.to.lon];
  areas.unshift({journey:true, name:J.from.name+' → '+J.to.name, from:J.from, to:J.to, date:Date.now(), tiles:plan.tiles, saved:res.saved, total:res.total,
    b:[Math.min(...lons),Math.min(...lats),Math.max(...lons),Math.max(...lats)]});
  lsSet(K.areas,areas);
  showJourney({from:J.from,to:J.to});
  rememberJourney(J.from,J.to,flightNo);
  renderAreas();
  if(!res.failed) toast('Journey maps saved. The route is on the map.');
};
function showJourney(j){
  journey=j; lsSet('fieldline.journey',j); drawJourney(); readouts();
}
function drawJourney(){
  if(!mapReady) return;
  const src=map.getSource('route'); if(!src) return;
  if(!journey){ src.setData(empty); return; }
  const pts=gcPoints(journey.from,journey.to,20);
  src.setData({type:'FeatureCollection',features:[
    {type:'Feature',properties:{},geometry:{type:'LineString',coordinates:pts.map(p=>[p.lon,p.lat])}},
    {type:'Feature',properties:{end:1},geometry:{type:'Point',coordinates:[journey.from.lon,journey.from.lat]}},
    {type:'Feature',properties:{end:1},geometry:{type:'Point',coordinates:[journey.to.lon,journey.to.lat]}}]});
}
document.querySelectorAll('input[name="detail"]').forEach(r=>r.onchange=()=>{try{localStorage.setItem('fieldline.detail',r.value);}catch(e){} estimate();});
try{const d=localStorage.getItem('fieldline.detail'); if(d&&DETAIL[d]) document.querySelector(`input[name="detail"][value="${d}"]`).checked=true;}catch(e){}
$('bCancelSave').onclick=()=>{ if(saving) saving.cancel=true; };
function renderAreas(){
  const ul=$('areas'); ul.textContent='';
  const areas=lsGet(K.areas,[]);
  if(!areas.length){ const li=document.createElement('li'); li.className='none'; li.textContent='None yet. Plan a journey or save the area on screen.'; ul.appendChild(li); return; }
  for(const a of areas){
    const li=document.createElement('li');
    const t=document.createElement('div'); t.textContent=(a.journey?a.name:(DETAIL[a.detail]?.label||'Street'))+(a.total? (a.saved<a.total?' · ⚠ '+a.saved.toLocaleString()+' of '+a.total.toLocaleString()+' saved':' · complete') : ' · '+a.tiles.toLocaleString()+' tiles');
    if(a.total&&a.saved<a.total) li.classList.add('incomplete');
    const s=document.createElement('span'); s.textContent=(a.journey?'Journey':a.name)+' · '+new Date(a.date).toLocaleDateString(undefined,{day:'numeric',month:'short',year:'numeric'}); t.appendChild(document.createElement('br')); t.appendChild(s);
    const go=document.createElement('button'); go.textContent='Go to';
    go.textContent=a.journey?'Show route':'Go to';
    go.onclick=()=>{ if(a.journey) showJourney({from:a.from,to:a.to}); setFollow(false); $('pOffline').hidden=true; map?.fitBounds([[a.b[0],a.b[1]],[a.b[2],a.b[3]]],{padding:{top:90,bottom:(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--dock-h'))||200)+40,left:40,right:40},maxZoom:14}); };
    li.append(t,go);
    if(a.journey && a.total && a.saved<a.total){
      const fin=document.createElement('button'); fin.textContent='Finish saving';
      fin.onclick=()=>{ setPlace('from',a.from,true); setPlace('to',a.to,true); $('bSaveJourney').click(); };
      li.appendChild(fin);
    }
    ul.appendChild(li);
  }
}
let clearArm=false;
$('bClear').onclick=async()=>{
  if(!clearArm){ clearArm=true; $('bClear').textContent='Tap again to delete'; setTimeout(()=>{clearArm=false;$('bClear').textContent='Delete all offline maps';},3000); return; }
  clearArm=false; $('bClear').textContent='Delete all offline maps';
  try{ await caches.delete(TILE_CACHE); await caches.delete('fieldline-runtime-v1'); }catch(e){}
  cachePromise=null; lsSet(K.areas,[]); journey=null; lsSet('fieldline.journey',null); drawJourney(); renderAreas(); estimate();
  // Reload so the map drops tiles it is still holding in memory
  if(!rec){ lsSet('fieldline.toast','Offline maps deleted.'); location.reload(); } else toast('Offline maps deleted. The map updates after you stop recording.');
};

/* ---------------- connectivity + layout ---------------- */
function net(){ $('net').hidden=navigator.onLine && !preview; $('net').textContent = preview ? 'Offline preview' : 'Offline'; }
$('tPreview').checked=preview;
$('tPreview').onchange=e=>{
  if(rec){ e.target.checked=preview; toast('Stop recording first.'); return; }
  lsSet('fieldline.preview', e.target.checked);
  lsSet('fieldline.toast', e.target.checked ? 'Offline preview on: only saved maps are shown.' : 'Offline preview off.');
  location.reload();
};
{ const t=lsGet('fieldline.toast',null); if(t){ lsSet('fieldline.toast',null); setTimeout(()=>toast(t),600); } }
addEventListener('online',net); addEventListener('offline',net); net();
new ResizeObserver(()=>document.documentElement.style.setProperty('--dock-h',$('dock').offsetHeight+'px')).observe($('dock'));

if('serviceWorker' in navigator){
  navigator.serviceWorker.register('sw.js',{updateViaCache:'none'}).then(reg=>{
    // Check for a new version on start and whenever the app comes back to the front.
    reg.update().catch(()=>{});
    document.addEventListener('visibilitychange',()=>{ if(document.visibilityState==='visible') reg.update().catch(()=>{}); });
  }).catch(()=>{});
  // A new version took over: reload once to show it, unless a track is being recorded.
  let reloaded=false;
  navigator.serviceWorker.addEventListener('controllerchange',()=>{ if(!reloaded && !rec && navigator.serviceWorker.controller){ reloaded=true; location.reload(); } });
}

/* ---------------- welcome page and install ---------------- */
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ua = navigator.userAgent;
const isIPad = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
const isIOS = isIPad || /iPhone|iPod/.test(ua);
const isMacSafari = !isIOS && /Macintosh/.test(ua) && /Safari/.test(ua) && !/Chrome|Chromium|Edg|Firefox/.test(ua);
let installPrompt = null, gpsStarted = false;
addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });
addEventListener('appinstalled', () => { installPrompt = null; $('wInstall').textContent = 'Installed'; $('wInstall').disabled = true; });
function startGPSOnce(){ if(!gpsStarted && !sim){ gpsStarted = true; startGPS(); } }
function showWelcome(){
  $('welcome').hidden = false; $('welcome').scrollTop = 0;
  if(standalone){ $('wInstall').textContent = 'Installed'; $('wInstall').disabled = true; $('wWeb').textContent = 'Open map'; }
}
$('wWeb').onclick = () => { lsSet('fieldline.web', true); $('welcome').hidden = true; startGPSOnce(); };
$('bAbout').onclick = () => { $('pOffline').hidden = true; showWelcome(); };
$('wInstall').onclick = async () => {
  if(installPrompt){                                  // Chrome, Edge, Android: the browser's own install prompt
    installPrompt.prompt();
    const { outcome } = await installPrompt.userChoice.catch(() => ({}));
    installPrompt = null;
    if(outcome === 'accepted') toast('Installing Flightroute. Open it from your home screen.');
    return;
  }
  const steps = $('isSteps'), intro = $('isIntro');
  if(isIOS){
    intro.textContent = "Apple doesn't let websites install themselves, so it takes three taps" + (/CriOS|FxiOS|EdgiOS/.test(ua) ? ':' : ' in Safari:');
    $('isWhere').textContent = isIPad ? 'at the top right of Safari' : 'at the bottom of the screen';
    steps.hidden = false;
  } else if(isMacSafari){
    intro.innerHTML = 'In Safari on a Mac, choose <b>File → Add to Dock</b>, then <b>Add</b>. Flightroute then opens like an app from the Dock.';
    steps.hidden = true;
  } else {
    intro.innerHTML = "Open your browser's menu and choose <b>Install app</b> or <b>Add to Home screen</b>. If you don't see either, this browser can't install web apps; use the web version instead.";
    steps.hidden = true;
  }
  $('installSheet').hidden = false;
};
const closeInstall = () => { $('installSheet').hidden = true; };
$('isClose').onclick = closeInstall; $('isDone').onclick = closeInstall;
$('installSheet').addEventListener('click', e => { if(e.target === $('installSheet')) closeInstall(); });

initMap();
if(!standalone && !lsGet('fieldline.web', false)) showWelcome(); else startGPSOnce();
readouts();
})();
