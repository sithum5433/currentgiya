'use strict';

const $ = id => document.getElementById(id);
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const escapeHTML = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const AREAS = [
  {name:'Colombo',lat:6.9271,lng:79.8612},{name:'Colombo 3',lat:6.9114,lng:79.8500},
  {name:'Nugegoda',lat:6.8649,lng:79.8997},{name:'Dehiwala',lat:6.8511,lng:79.8659},
  {name:'Maharagama',lat:6.8480,lng:79.9265},{name:'Moratuwa',lat:6.7730,lng:79.8816},
  {name:'Negombo',lat:7.2083,lng:79.8358},{name:'Gampaha',lat:7.0840,lng:80.0098},
  {name:'Kandy',lat:7.2906,lng:80.6337},{name:'Galle',lat:6.0535,lng:80.2210},
  {name:'Matara',lat:5.9549,lng:80.5550},{name:'Kurunegala',lat:7.4863,lng:80.3647},
  {name:'Ratnapura',lat:6.6828,lng:80.3992},{name:'Jaffna',lat:9.6615,lng:80.0255},
  {name:'Trincomalee',lat:8.5874,lng:81.2152},{name:'Batticaloa',lat:7.7310,lng:81.6747},
  {name:'Anuradhapura',lat:8.3114,lng:80.4037},{name:'Badulla',lat:6.9934,lng:81.0550},
  {name:'Polonnaruwa',lat:7.9403,lng:81.0188},{name:'Nuwara Eliya',lat:6.9497,lng:80.7891},
];
const LABELS = {power:'Power cut',water:'Water interruption',net:'Internet issue',restored:'Power restored'};
const ICONS = {power:'bolt',water:'drop',net:'signal',restored:'check'};
const state = {area:AREAS[0],gps:null,approximate:null,snapshot:null,filter:'all',board:'districts',isp:null,battery:null,
  online:false,chat:null,alarm:false,alarmSince:0,alarmIncident:false,audio:null,push:false,sw:null,pushConfig:null};
let toastTimer, refreshTimer, failures = 0, refreshing = false, areaVersion = 0, loopVersion = 0;
function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key,value) { try { localStorage.setItem(key,value); } catch {} }
function storageRemove(key) { try { localStorage.removeItem(key); } catch {} }
function toast(message) { $('toast').textContent=message; $('toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>$('toast').classList.remove('visible'),5500); }
function distance(a,b) { const rad=Math.PI/180, dlat=(a.lat-b.lat)*rad,dlng=(a.lng-b.lng)*rad;return 6371000*2*Math.asin(Math.min(1,Math.sqrt(Math.sin(dlat/2)**2+Math.cos(a.lat*rad)*Math.cos(b.lat*rad)*Math.sin(dlng/2)**2))); }
function timeAgo(value) { const minutes=Math.max(0,Math.floor((Date.now()-Date.parse(value))/60000));return minutes<1?'Just now':minutes<60?`${minutes}m ago`:`${Math.floor(minutes/60)}h ago`; }
function locationQuery(point=currentPoint()) { return new URLSearchParams({lat:point.lat,lng:point.lng,...(point.accuracy?{accuracy:point.accuracy}:{})}).toString(); }
function serviceUnavailable() { return ['localhost','127.0.0.1',''].includes(location.hostname)?'The reporting API is not running here. Start the project with npm start and open the address printed in the terminal.':'The reporting service is unavailable. Please retry in a moment.'; }
function validateStatus(snapshot) {
  if(!snapshot || !snapshot.counts || !['power','water','net'].every(type=>Number.isFinite(snapshot.counts[type])&&snapshot.counts[type]>=0) ||
    !Array.isArray(snapshot.reports) || !Array.isArray(snapshot.zones) || !snapshot.leaderboard || !Number.isFinite(Date.parse(snapshot.serverTime)))throw new Error(serviceUnavailable());
  return snapshot;
}
async function api(path,options={}) {
  const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),10000);
  try {
    const response=await fetch(path,{credentials:'same-origin',cache:'no-store',...options,signal:controller.signal,
      headers:{...(options.body?{'Content-Type':'application/json'}:{}),...options.headers}});
    if(!(response.headers.get('content-type')||'').toLowerCase().includes('application/json'))throw new Error(serviceUnavailable());
    let data;try{data=await response.json();}catch{throw new Error(serviceUnavailable());}
    if(!response.ok) throw Object.assign(new Error(data?.error||`Service returned ${response.status}.`),{status:response.status});
    if(path.startsWith('/api/status'))validateStatus(data);
    return data;
  } finally {clearTimeout(timer);}
}
function post(path,body) { return api(path,{method:'POST',body:JSON.stringify(body)}); }
function setConnected(connected) {
  state.online=connected;
  $('connectionBadge').innerHTML=`<span class="status-dot ${connected?'green':''}"></span>${connected?'Community live':'Reconnecting'}`;
  document.querySelector('.live-pill').innerHTML=`<span class="status-dot ${connected?'green':''}"></span>${connected?'LIVE':'OFFLINE'}`;
  $('serviceMessage').hidden=connected;
  if(!connected) $('serviceMessage').textContent=state.snapshot?'Connection interrupted. Showing the last successful update; new reports need a connection.':serviceUnavailable();
}
function currentPoint() { return state.gps||state.approximate||state.area; }
async function preciseLocation(force=false,requirePrecise=true) {
  if(!force&&state.gps&&Date.now()-state.gps.at<120000)return state.gps;
  if(!force&&!requirePrecise&&state.approximate&&Date.now()-state.approximate.at<120000)return state.approximate;
  if(!navigator.geolocation)throw new Error('This browser does not support location. You can still browse the radar.');
  if(!window.isSecureContext)throw new Error('Precise location needs HTTPS or localhost.');
  toast('Finding your street. Allow location access when your browser asks.');
  const position=await new Promise((resolve,reject)=>navigator.geolocation.getCurrentPosition(resolve,reject,{enableHighAccuracy:true,timeout:15000,maximumAge:15000})).catch(error=>{throw new Error(error.code===1?'Location access is needed to report or join a blackout room.':error.code===3?'Location timed out. Try outdoors or near a window.':'Could not find your location. Please try again.');});
  const {latitude:lat,longitude:lng,accuracy}=position.coords;
  if(!Number.isFinite(lat)||!Number.isFinite(lng)||lat<5.8||lat>10||lng<79.4||lng>82.1)throw new Error('Reporting is available for locations in Sri Lanka.');
  if(!Number.isFinite(accuracy)||accuracy<=0)throw new Error('Your browser did not return a valid location accuracy. Please try again.');
  if(requirePrecise&&accuracy>200)throw new Error(`Your location is accurate to ${Math.round(accuracy)} m. Please try again for a reading within 200 m.`);
  if(state.gps&&distance(state.gps,{lat,lng})>1000)disarmAlarm();
  const point={lat,lng,accuracy,at:Date.now()};
  state.gps=accuracy<=200?point:null;state.approximate=accuracy>200?point:null;
  if(!state.gps){disarmAlarm();lockChat('Your approximate location is useful for browsing. Chat and reports need a location reading within 200 metres.');}
  const nearest=AREAS.reduce((a,b)=>distance(a,point)<distance(b,point)?a:b);
  state.area=nearest; $('areaSelect').value=nearest.name;
  updateAreaLabels();
  $('locationHint').textContent=state.gps?`Using your location · accurate to ${Math.round(accuracy)} m`:`Approximate location · ±${Math.round(accuracy)} m · browse only`;
  map.setCenter(lat,lng,14);
  areaVersion++; refreshExtras();
  return point;
}
function updateAreaLabels() {
  document.querySelectorAll('.selected-area').forEach(el=>el.textContent=state.area.name);
  $('mapArea').textContent=state.area.name;
}
async function locate(requirePrecise=false) { try {await preciseLocation(true,requirePrecise);await refreshStatus();if(state.gps)await refreshChat();toast(state.gps?'Your street is in view. Your location is used for nearby reports, weather, and blackout chat.':'Approximate location found. You can browse reports and weather; reporting and chat still need a reading within 200 m.');}catch(error){toast(error.message);} }

// A small Web Mercator map: only tiles in the visible viewport are requested.
const map = (()=>{
  const element=$('outageMap'),tiles=$('tileLayer'),markers=$('markerLayer');
  let lat=state.area.lat,lng=state.area.lng,zoom=13,frame=0,drag=null;
  const tileImages=new Map();
  function project(latitude,longitude) { const size=256*2**zoom,sin=Math.sin(latitude*Math.PI/180);return {x:(longitude+180)/360*size,y:(.5-Math.log((1+sin)/(1-sin))/(4*Math.PI))*size}; }
  function unproject(x,y) {const size=256*2**zoom;return {lng:x/size*360-180,lat:Math.atan(Math.sinh(Math.PI*(1-2*y/size)))*180/Math.PI};}
  function screen(point){const c=project(lat,lng),p=project(point.lat,point.lng);return {x:p.x-c.x+element.clientWidth/2,y:p.y-c.y+element.clientHeight/2};}
  function drawMarkers(){
    const width=element.clientWidth,height=element.clientHeight;
    const zones=(state.snapshot?.zones||[]).filter(z=>state.filter==='all'||z.type===state.filter);
    let count=0;
    markers.replaceChildren();
    for(const zone of zones){
      const p=screen(zone);if(p.x < -30||p.x>width+30||p.y < -30||p.y>height+30)continue;
      count++;
      const btn=document.createElement('button');
      const status=zone.verified?(zone.scope==='area'?'verified':'street'):'';
      btn.className=`map-marker ${status} ${zone.type==='water'?'water-marker':zone.type==='net'?'net-marker':''}`;
      btn.style.left=`${p.x}px`;btn.style.top=`${p.y}px`;btn.textContent=zone.reportCount;
      const label=zone.verified?(zone.scope==='area'?'Verified area outage':'Verified · possible street fault'):'Unverified report';
      btn.setAttribute('aria-label',`${zone.area}: ${LABELS[zone.type]}, ${zone.reportCount} reports. ${label}`);
      btn.addEventListener('click',()=>{
        $('mapCallout').innerHTML=`<button aria-label="Close map detail">×</button><strong>${escapeHTML(zone.area)}</strong><p>${escapeHTML(LABELS[zone.type])} · ${zone.reportCount} reports</p><p>${label}</p><p>Reported ${timeAgo(zone.firstReportedAt)}</p>`;
        $('mapCallout').hidden=false;$('mapCallout').querySelector('button').onclick=()=>{$('mapCallout').hidden=true;};
      });markers.append(btn);
    }
    if(state.gps){const p=screen(state.gps),dot=document.createElement('span');dot.className='map-user';dot.style.left=`${p.x}px`;dot.style.top=`${p.y}px`;dot.title='Your location';markers.append(dot);}
    $('mapEmpty').hidden=count>0;
    if(!state.online&&!state.snapshot){$('mapEmpty').querySelector('strong').textContent='Waiting for the community feed.';$('mapEmpty').querySelector('p').textContent='Reports appear when the service is connected.';}
    else{$('mapEmpty').querySelector('strong').textContent='Your neighbours are the signal.';$('mapEmpty').querySelector('p').textContent=state.filter==='all'?'No active reports in this view yet.':'No reports of this type in this view.';}
  }
  function draw(){
    frame=0;const center=project(lat,lng),width=element.clientWidth,height=element.clientHeight;
    const left=center.x-width/2,top=center.y-height/2,needed=new Set();
    for(let x=Math.floor(left/256);x<=Math.floor((left+width-1)/256);x++)for(let y=Math.floor(top/256);y<=Math.floor((top+height-1)/256);y++){
      if(y<0||y>=2**zoom)continue;
      const wrappedX=((x%2**zoom)+2**zoom)%2**zoom,key=`${zoom}/${wrappedX}/${y}`;needed.add(key);
      let img=tileImages.get(key);
      if(!img){img=new Image();img.className='map-tile';img.alt='';img.draggable=false;img.decoding='async';img.addEventListener('error',()=>{img.style.visibility='hidden';element.dataset.basemap='unavailable';});img.addEventListener('load',()=>{img.style.visibility='visible';delete element.dataset.basemap;});img.src=`https://tile.openstreetmap.org/${key}.png`;tileImages.set(key,img);tiles.append(img);}
      img.style.left=`${Math.round(x*256-left)}px`;img.style.top=`${Math.round(y*256-top)}px`;
    }
    for(const[key,img]of tileImages)if(!needed.has(key)){img.remove();tileImages.delete(key);}
    const metresPerPixel=156543.03392*Math.cos(lat*Math.PI/180)/2**zoom;
    const scale=metresPerPixel*65; const rounded=scale>1000?Math.round(scale/500)*500:Math.round(scale/100)*100;
    $('mapScale').textContent=rounded>=1000?`${rounded/1000} km`:`${rounded} m`;
    $('mapScale').style.width=`${rounded/metresPerPixel}px`;
    drawMarkers();
  }
  function schedule(){if(!frame)frame=requestAnimationFrame(draw);}
  function changeZoom(delta){zoom=Math.min(17,Math.max(7,zoom+delta));schedule();}
  $('zoomIn').onclick=()=>changeZoom(1);$('zoomOut').onclick=()=>changeZoom(-1);
  element.addEventListener('pointerdown',event=>{if(event.target.closest('button,a'))return;drag={x:event.clientX,y:event.clientY,center:project(lat,lng)};element.setPointerCapture(event.pointerId);});
  element.addEventListener('pointermove',event=>{if(!drag)return;const p=unproject(drag.center.x-(event.clientX-drag.x),drag.center.y-(event.clientY-drag.y));lat=Math.max(5.2,Math.min(10.6,p.lat));lng=Math.max(78.8,Math.min(82.6,p.lng));schedule();});
  element.addEventListener('pointerup',()=>{drag=null;});element.addEventListener('pointercancel',()=>{drag=null;});
  element.addEventListener('keydown',event=>{if(event.target!==element)return;const deltas={ArrowLeft:[-80,0],ArrowRight:[80,0],ArrowUp:[0,-80],ArrowDown:[0,80]};if(deltas[event.key]){event.preventDefault();const c=project(lat,lng),d=deltas[event.key],p=unproject(c.x+d[0],c.y+d[1]);lat=p.lat;lng=p.lng;schedule();}else if(['+','=','-'].includes(event.key)){event.preventDefault();changeZoom(event.key==='-'?-1:1);}});
  new ResizeObserver(schedule).observe(element);schedule();
  return {render:schedule,setCenter(a,b,z){lat=a;lng=b;if(z)zoom=z;$('mapCallout').hidden=true;schedule();}};
})();

function renderStatus(snapshot){
  validateStatus(snapshot);
  state.snapshot=snapshot;
  for(const type of ['power','water','net'])$(`count${type[0].toUpperCase()+type.slice(1)}`).textContent=Number(snapshot.counts[type]||0).toLocaleString();
  $('countVerified').textContent=snapshot.zones.filter(z=>z.verified).length;
  $('lastSynced').textContent=`Updated ${new Date(snapshot.serverTime).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Colombo'})}`;
  map.render();renderActivity();renderBoard();checkRestoration(snapshot);prepareStory();
}
function renderActivity(){
  const reports=(state.snapshot?.reports||[]).filter(r=>distance(r,currentPoint())<=3000).sort((a,b)=>Date.parse(b.createdAt)-Date.parse(a.createdAt)).slice(0,4);
  $('activityFeed').innerHTML=reports.length?reports.map(r=>`<div class="activity-item"><span class="metric-icon ${r.type==='restored'?'safe':r.type}">${icon(ICONS[r.type]||'pin')}</span><div><strong>${escapeHTML(LABELS[r.type]||'Community report')}</strong><p>${escapeHTML(r.area)} · ${Math.max(0.1,distance(r,currentPoint())/1000).toFixed(1)} km away</p></div><time datetime="${escapeHTML(r.createdAt)}">${timeAgo(r.createdAt)}</time></div>`).join(''):`<div class="empty-state">${icon('pin')}<strong>All quiet in the feed.</strong><p>No recent reports within 3 km. Quiet does not guarantee service is working.</p></div>`;
}
function renderBoard(){
  const entries=state.snapshot?.leaderboard?.[state.board]||[];
  $('leaderboard').innerHTML=entries.length?entries.slice(0,3).map((entry,index)=>`<li><span class="rank">${String(index+1).padStart(2,'0')}</span><span>${escapeHTML(entry.name)}</span><span class="board-count">${entry.count}<small>reports</small></span></li>`).join(''):'<li class="leaderboard-empty">The board is clear. Let’s keep it that way.</li>';
}
async function refreshStatus(){
  if(refreshing)return;refreshing=true;const version=areaVersion;
  try{const data=await api(`/api/status?${locationQuery()}`);if(version!==areaVersion){setTimeout(refreshStatus,0);return;}failures=0;setConnected(true);renderStatus(data);}
  catch{failures++;setConnected(false);map.render();}
  finally{refreshing=false;}
}
async function refreshLoop(){const version=++loopVersion;clearTimeout(refreshTimer);if(!document.hidden){await refreshStatus();if(state.gps)await refreshChat();}if(version===loopVersion)refreshTimer=setTimeout(refreshLoop,Math.min(60000,15000*2**Math.min(failures,2)));}
let reportBusy=false;
async function report(type){
  if(reportBusy)return;reportBusy=true;
  const buttons=[...document.querySelectorAll('[data-report]')];buttons.forEach(button=>button.disabled=true);
  try{
    if(!state.online){await refreshStatus();if(!state.online)throw new Error(serviceUnavailable());}
    const gps=await preciseLocation();
    const result=await post('/api/reports',{type,lat:gps.lat,lng:gps.lng,accuracy:gps.accuracy,area:state.area.name});
    if(!result.report?.id)throw new Error('The service did not confirm your report. Refresh before trying again.');
    validateStatus(result.status);
    setConnected(true);renderStatus(result.status);
    const restoration=result.status.restoration;
    const message=type==='restored'?(restoration?.restored?'Current awa! Three nearby neighbours have confirmed restoration.':restoration?.count?`Current awa! ${restoration.count} of 3 neighbours have confirmed restoration.`:'Restoration report saved. There is no active power incident to clear at this location.'):result.status.nearbyZone?.verified?'Your report joined a verified zone. Thanks for looking out for your neighbours.':'Report added. It stays unverified until 5 independent neighbours report within 3 minutes.';
    $('reportFeedback').textContent=message;$('reportFeedback').hidden=false;toast(message);await refreshChat();
  }catch(error){toast(error.message);}
  finally{reportBusy=false;buttons.forEach(button=>button.disabled=false);}
}

// HTTP probes deliberately do not claim to measure packet loss or last-mile access type.
let probing=false;
async function checkNetwork(){
  if(probing)return;probing=true;$('recheckNetwork').disabled=true;$('networkState').textContent='CHECKING';
  const times=[];
  const results=await Promise.all(Array.from({length:4},async(_,index)=>{
    await new Promise(resolve=>setTimeout(resolve,index*400));const start=performance.now();
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3000);
    try{const r=await fetch(`/api/ping?probe=${index}&t=${Date.now()}`,{method:'HEAD',cache:'no-store',signal:controller.signal,credentials:'same-origin'});if(!r.ok)throw new Error();times.push(performance.now()-start);return true;}catch{return false;}finally{clearTimeout(timer);}
  }));
  times.sort((a,b)=>a-b);const success=results.filter(Boolean).length,latency=times.length?Math.round(times[Math.floor(times.length/2)]):null;
  $('pingValue').innerHTML=`${latency??'—'}<small>ms</small>`;$('probeValue').innerHTML=`${success}<small>/ 4</small>`;
  $('networkState').textContent=success===4&&latency<250?'RESPONSIVE':success?'SLOW / UNSTABLE':state.online?'CHECK TIMED OUT':'NO RESPONSE';
  $('networkNote').textContent=success<4?`${4-success} of 4 HTTP checks timed out. This may indicate congestion or server delay; it is not a packet-loss test.`:`${state.isp||'Your connection'} reached this server in ${latency} ms. HTTP checks do not measure packet loss.`;
  $('recheckNetwork').disabled=false;probing=false;
}
async function detectNetwork(){try{const result=await api('/api/network');state.isp=result.available?result.isp:null;$('ispLabel').textContent=result.available?`${result.isp}${result.asn?` · AS${String(result.asn).replace(/^AS/i,'')}`:''}`:'Provider unavailable on this connection';}catch{$('ispLabel').textContent='Provider lookup unavailable';}}
async function refreshExtras(){
  const version=areaVersion,point={...currentPoint()},area=state.area.name;
  await Promise.allSettled([
    (async()=>{let result;try{result=await api(`/api/weather?${locationQuery(point)}`);}catch{result={available:false};}if(version!==areaVersion)return;
      $('weatherTitle').textContent=!result.available?'Forecast taking a rain check.':result.stormRisk?'Storm forecast. Charge up.':'A little peace of mind.';
      $('weatherDescription').textContent=result.available?result.summary:'Weather is temporarily unavailable. We’ll check again shortly.';
      const temp=result.current?.temperature;
      $('weatherMeta').textContent=result.available?`${Number.isFinite(temp)?`${Math.round(temp)}°C · `:''}${escapeHTML(area)} · Current / next-hour forecast`:'Weather data by Open-Meteo';
      $('weatherCard').classList.toggle('storm',Boolean(result.stormRisk));
    })(),
    (async()=>{let result;try{result=await api(`/api/notices?area=${encodeURIComponent(area)}`);}catch{result={notices:[],unavailable:true};}if(version!==areaVersion)return;
      $('noticeList').innerHTML=result.notices?.length?result.notices.map(n=>{
        let url='#';try{const parsed=new URL(n.url);if(parsed.protocol==='https:')url=parsed.href;}catch{}
        const start=n.startsAt?new Date(n.startsAt).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit',timeZone:'Asia/Colombo'}):'Time not specified';
        return `<article class="notice-card"><small>${escapeHTML(n.source)} · ${escapeHTML(start)}${result.stale?' · check source for updates':''}</small><h3>${escapeHTML(n.title)}</h3><p>${escapeHTML(n.summary)}</p><a href="${escapeHTML(url)}" target="_blank" rel="noopener">Read the official notice ↗</a></article>`;
      }).join(''):`<div class="empty-state">${icon('bell')}<strong>${result.unavailable?'Notice feed unavailable.':!result.configured?'Official notice feed awaiting setup.':'No published notices for this area.'}</strong><p>${result.unavailable?'Please check your utility’s official channels.':!result.configured?'When official sources are connected, only notices listing your area appear here.':'Check official sources too; an empty feed is not a service guarantee.'}</p></div>`;
    })()
  ]);
}

function lockChat(message){
  state.chat=null;$('chatBadge').textContent='ZONE LOCKED';$('chatStatus').hidden=false;
  if(message)$('chatStatus').querySelector('p').textContent=message;
  $('chatMessages').replaceChildren();$('chatInput').disabled=true;$('chatForm').querySelector('button').disabled=true;$('chatExpiry').textContent='No active room';
}
function renderChat(result){
  if(!result.unlocked){lockChat('No verified blackout room at your location. Rooms unlock within 3 km of a verified power outage and close when power returns.');return;}
  const lastSignature=state.chat?.messages?.map(m=>`${m.id}:${m.battery??''}`).join(','),signature=result.messages.map(m=>`${m.id}:${m.battery??''}`).join(',');
  state.chat=result;$('chatBadge').textContent='ZONE OPEN';$('chatStatus').hidden=true;$('chatInput').disabled=false;$('chatForm').querySelector('button').disabled=false;
  $('chatExpiry').textContent=result.expiresAt?`Expires ${new Date(result.expiresAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Colombo'})}`:'Until the power returns';
  if(signature!==lastSignature){const box=$('chatMessages');const bottom=box.scrollHeight-box.scrollTop-box.clientHeight<60;box.innerHTML=result.messages.map(m=>`<div class="chat-msg"><div class="chat-msg-meta"><strong>${escapeHTML(m.nickname)}</strong>${Number.isFinite(m.battery)?`<span>🔋 ${m.battery}%</span>`:''}<time>${new Date(m.createdAt).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Colombo'})}</time></div><p>${escapeHTML(m.text)}</p></div>`).join('')||'<div class="empty-state"><strong>You’re not alone in the dark.</strong><p>Start a conversation with your neighbours.</p></div>';if(bottom)box.scrollTop=box.scrollHeight;}
}
async function refreshChat(){
  if(!state.gps)return;
  if(Date.now()-state.gps.at>300000){lockChat('Your location reading has expired. Find your zone again to keep the room local.');return;}
  const version=areaVersion;
  try{const result=await api(`/api/chat?${locationQuery(state.gps)}`);if(version===areaVersion)renderChat(result);}catch(error){if(version!==areaVersion)return;if(error.status===400||error.status===403)lockChat(error.message);else{$('chatBadge').textContent='RECONNECTING';$('chatInput').disabled=true;$('chatForm').querySelector('button').disabled=true;}}
}
async function sendChat(event){
  event.preventDefault();const input=$('chatInput'),text=input.value.trim();if(!text||!state.chat?.unlocked)return;
  const button=$('chatForm').querySelector('button');button.disabled=true;
  try{const gps=await preciseLocation();await post('/api/chat',{lat:gps.lat,lng:gps.lng,accuracy:gps.accuracy,text,...(state.battery!==null?{battery:state.battery}:{})});input.value='';await refreshChat();}catch(error){toast(error.message);}finally{button.disabled=!state.chat?.unlocked;}
}
async function initBattery(){
  if(!navigator.getBattery)return;
  try{const battery=await navigator.getBattery();const update=()=>{state.battery=Math.round(battery.level*100);$('batteryBadge').textContent=`${battery.charging?'⚡':'🔋'} ${state.battery}%${battery.charging?' · charging':''}`;const version=areaVersion;if(state.chat?.unlocked&&state.gps&&Date.now()-state.gps.at<300000)post('/api/chat/battery',{...state.gps,battery:state.battery}).then(result=>{if(version===areaVersion)renderChat(result);}).catch(()=>{});};update();battery.addEventListener('levelchange',update);battery.addEventListener('chargingchange',update);}catch{}
}

function disarmAlarm(){state.alarm=false;state.alarmSince=0;state.alarmIncident=false;$('alarmToggle').setAttribute('aria-checked','false');$('alarmHint').textContent='An alert after 3 neighbours confirm restoration.';}
let alarmBusy=false;
async function toggleAlarm(){
  if(alarmBusy)return;
  if(state.alarm){disarmAlarm();return;}
  alarmBusy=true;$('alarmToggle').disabled=true;
  try{const Audio=window.AudioContext||window.webkitAudioContext;if(!Audio)throw new Error('This browser cannot play a restoration alarm.');state.audio||=new Audio();
    // Resume in the original click, before a location prompt can consume user activation.
    const resumed=state.audio.resume();
    const o=state.audio.createOscillator(),g=state.audio.createGain();g.gain.value=0;o.connect(g).connect(state.audio.destination);o.start();o.stop(state.audio.currentTime+.01);
    await resumed;await preciseLocation();
    state.alarm=true;state.alarmSince=Date.now();state.alarmIncident=Boolean(state.snapshot?.zones?.some(zone=>zone.type==='power'&&distance(zone,state.gps)<=1000));$('alarmToggle').setAttribute('aria-checked','true');$('alarmHint').textContent='Armed for this location. Keep this tab open and your device awake; sleeping browsers may delay audio.';toast('Restoration alarm armed. Keep this tab open and the device awake.');await refreshStatus();
  }catch(error){toast(error.message);}finally{alarmBusy=false;$('alarmToggle').disabled=false;}
}
function checkRestoration(snapshot){
  if(!state.alarm||!state.gps)return;
  if(snapshot.zones?.some(zone=>zone.type==='power'&&distance(zone,state.gps)<=1000))state.alarmIncident=true;
  const restored=snapshot.restoration;
  if(!restored?.restored||!restored.confirmedAt||Date.parse(restored.confirmedAt)<state.alarmSince||!state.alarmIncident)return;
  if(state.audio){const now=state.audio.currentTime;for(let i=0;i<6;i++){const oscillator=state.audio.createOscillator(),gain=state.audio.createGain();oscillator.frequency.value=i%2?880:660;gain.gain.setValueAtTime(0,now+i*.35);gain.gain.linearRampToValueAtTime(.12,now+i*.35+.03);gain.gain.exponentialRampToValueAtTime(.001,now+i*.35+.3);oscillator.connect(gain).connect(state.audio.destination);oscillator.start(now+i*.35);oscillator.stop(now+i*.35+.32);}}
  navigator.vibrate?.([200,100,200]);toast('Current awa! Three nearby neighbours confirmed power is back.');disarmAlarm();lockChat('Power is back! This temporary room and its messages have been cleared.');
}
function urlBase64(value){return Uint8Array.from(atob(value.replace(/-/g,'+').replace(/_/g,'/')),c=>c.charCodeAt(0));}
async function initServiceWorker(){
  if(!('serviceWorker'in navigator)||!window.isSecureContext)return;
  try{await navigator.serviceWorker.register('/service-worker.js');state.sw=await navigator.serviceWorker.ready;const sub=await state.sw.pushManager?.getSubscription();if(sub){state.push=true;$('enablePush').innerHTML=`Disable weather alerts ${icon('check')}`;$('pushHint').textContent='Background alerts enabled for your saved area.';}}catch{}
}
async function loadPushConfig(){try{state.pushConfig=await api('/api/push/public-key');$('pushHint').textContent=state.push?'Background alerts enabled for your saved area.':state.pushConfig.enabled?'Optional alerts when thunder is forecast.':'Background alerts need server VAPID keys; live forecasts work without them.';}catch{state.pushConfig=null;}}
let pushBusy=false;
async function togglePush(){
  if(pushBusy)return;
  if(!('Notification'in window)||!('PushManager'in window)||!window.isSecureContext){toast('Background alerts need a supported browser on HTTPS. On iPhone, add the site to your home screen first.');return;}
  if(!state.pushConfig){loadPushConfig();toast('Loading notification settings. Tap again in a moment.');return;}
  if(!state.push&&!state.pushConfig.enabled){toast('Background weather alerts need server configuration. Live forecasts are available above.');return;}
  if(!state.sw){initServiceWorker();toast('Preparing notifications. Tap again in a moment.');return;}
  if(!state.push&&Notification.permission==='denied'){toast('Notifications are blocked. Allow them in your browser’s site settings, then try again.');return;}
  // Keep permission requests inside the click event; mobile browsers require this.
  const permissionRequest=!state.push?(Notification.permission==='granted'?Promise.resolve('granted'):Notification.requestPermission()):null;
  pushBusy=true;
  const button=$('enablePush');button.disabled=true;
  try{
    if(state.push){const sub=await state.sw.pushManager.getSubscription();if(sub){await post('/api/push/unsubscribe',{endpoint:sub.endpoint});await sub.unsubscribe();}state.push=false;button.innerHTML=`Enable weather alerts ${icon('arrow')}`;$('pushHint').textContent='Optional alerts when thunder is forecast.';toast('Weather alerts disabled.');return;}
    const permission=await permissionRequest;if(permission!=='granted')throw new Error('Notification access was not granted. You can enable it in your browser settings.');
    const previous=await state.sw.pushManager.getSubscription();const subscription=previous||await state.sw.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:urlBase64(state.pushConfig.publicKey)});
    try{await post('/api/push/subscribe',{subscription:subscription.toJSON(),lat:currentPoint().lat,lng:currentPoint().lng,area:state.area.name});}catch(error){if(!previous)await subscription.unsubscribe();throw error;}
    state.push=true;button.innerHTML=`Disable weather alerts ${icon('check')}`;$('pushHint').textContent=`Alerts enabled for ${state.area.name}. Checked every 15 minutes.`;toast(`Weather alerts enabled for ${state.area.name}.`);
  }catch(error){toast(error.message);}finally{button.disabled=false;pushBusy=false;}
}

function complaintKey(){return `cg_account_${$('utilitySelect').value}`;}
function updateComplaint(){
  const utility=$('utilitySelect').value,number=utility==='power'?'1987':'1939';const account=$('accountNumber').value.trim();
  const text=`${utility==='power'?'Power supply interruption':'Water supply interruption'}\n${account?`Account: ${account}\n`:''}Area: ${state.area.name}${$('complaintAddress').value.trim()?`\nAddress: ${$('complaintAddress').value.trim()}`:''}\nPlease investigate and advise on restoration.`;
  $('complaintPreview').textContent=text;const separator=/iPad|iPhone|iPod/.test(navigator.userAgent)?'&':'?';$('smsLink').href=`sms:${number}${separator}body=${encodeURIComponent(text)}`;$('callLink').href=`tel:${number}`;$('callLink').textContent=`Call ${number}`;
  if($('rememberAccount').checked)storageSet(complaintKey(),account);else storageRemove(complaintKey());
}
function loadAccount(){const saved=storageGet(complaintKey());$('accountNumber').value=saved||'';$('rememberAccount').checked=Boolean(saved);updateComplaint();}
async function copyComplaint(){
  const text=$('complaintPreview').textContent;
  try{
    if(navigator.clipboard?.writeText){try{await navigator.clipboard.writeText(text);toast('Complaint draft copied. Paste it into your messaging app.');return;}catch{}}
    const input=document.createElement('textarea');input.value=text;input.style.position='fixed';input.style.opacity='0';$('complaintDialog').append(input);input.focus();input.select();
    let copied;try{copied=document.execCommand('copy');}finally{input.remove();$('copyComplaint').focus();}
    if(!copied)throw new Error();toast('Complaint draft copied. Paste it into your messaging app.');
  }catch{toast('Copy is unavailable in this browser. You can select and copy the draft text below.');}
}
async function buildStoryFile(snapshot){
    const canvas=document.createElement('canvas');canvas.width=1080;canvas.height=1920;const c=canvas.getContext('2d');
    c.fillStyle='#f5f4ef';c.fillRect(0,0,1080,1920);c.fillStyle='#e65d50';c.fillRect(72,100,9,48);c.fillStyle='#263b35';c.font='bold 33px system-ui';c.fillText('CurrentGiya.lk',104,138);
    c.fillStyle='#80908a';c.font='22px system-ui';c.fillText('THE DAILY SHAME BOARD',76,245);c.fillStyle='#253b33';c.font='bold 79px system-ui';c.fillText('Who let us',70,369);c.fillText('down today?',70,462);
    c.font='24px system-ui';c.fillStyle='#8a948e';c.fillText(new Date().toLocaleDateString('en-GB',{day:'numeric',month:'long',year:'numeric',timeZone:'Asia/Colombo'}),76,530);
    function drawRanking(title,key,y){c.fillStyle='#788b80';c.font='22px system-ui';c.fillText(title.toUpperCase(),76,y);const entries=(snapshot.leaderboard[key]||[]).slice(0,3);if(!entries.length){c.fillStyle='#86968a';c.font='30px system-ui';c.fillText('No reports today. A little peace.',76,y+70);}entries.forEach((entry,index)=>{const top=y+65+index*99;c.fillStyle='#d2b494';c.font='26px system-ui';c.fillText(String(index+1).padStart(2,'0'),76,top);c.fillStyle='#284238';c.font='bold 33px system-ui';c.fillText(String(entry.name).slice(0,30),139,top);c.textAlign='right';c.fillStyle='#e06b54';c.fillText(String(entry.count),995,top);c.textAlign='left';c.fillStyle='#e1e6dd';c.fillRect(76,top+29,928,1);});}
    drawRanking('Most blacked-out districts','districts',666);drawRanking('Most unstable ISP','isps',1100);
    c.fillStyle='#294a41';c.fillRect(0,1590,1080,330);c.fillStyle='#f4f5e9';c.font='bold 35px system-ui';c.fillText('Is it just your place?',76,1675);c.font='25px system-ui';c.fillText('Check your neighbourhood at CurrentGiya.lk',76,1730);c.font='18px system-ui';c.fillStyle='#a8bfb1';c.fillText('Community reports · unofficial · not a reliability assessment',76,1830);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));if(!blob)throw new Error('Could not create the story image.');return new File([blob],'currentgiya-today.png',{type:'image/png'});
}
let storyKey='',storyFile=null,storyPromise=null;
function prepareStory(){
  if(!state.snapshot)return;
  const key=new Date().toLocaleDateString('en-CA',{timeZone:'Asia/Colombo'})+JSON.stringify(state.snapshot.leaderboard);
  if(key===storyKey)return;
  storyKey=key;storyFile=null;$('shareStory').disabled=true;
  storyPromise=buildStoryFile(state.snapshot).then(file=>{if(key===storyKey){storyFile=file;$('shareStory').disabled=false;}}).catch(()=>{if(key===storyKey){storyKey='';$('shareStory').disabled=false;}});
}
function downloadStory(file){const url=URL.createObjectURL(file),a=document.createElement('a');a.href=url;a.download=file.name;document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);toast('Story image saved. Share it to your favourite app.');}
async function shareStory(){
  if(!state.snapshot){toast('Connect to the community feed before creating a story.');return;}
  if(!storyFile){prepareStory();toast('Preparing the story image. Tap again in a moment.');return;}
  const file=storyFile;$('shareStory').disabled=true;
  try{
    if(navigator.share&&navigator.canShare?.({files:[file]})){
      try{await navigator.share({files:[file],title:'Today on CurrentGiya.lk',text:`Today’s community outage reports. ${location.origin}`});}
      catch(error){if(error.name!=='AbortError')downloadStory(file);}
    }else downloadStory(file);
  }catch(error){toast(error.message);}finally{$('shareStory').disabled=false;}
}

// Bind the interface once; server data never creates executable markup.
$('areaSelect').innerHTML=AREAS.map(a=>`<option>${a.name}</option>`).join('');
$('areaSelect').addEventListener('change',()=>{state.area=AREAS.find(a=>a.name===$('areaSelect').value);state.gps=null;state.approximate=null;areaVersion++;disarmAlarm();lockChat();updateAreaLabels();$('locationHint').textContent='Browsing the town centre · locate to report';map.setCenter(state.area.lat,state.area.lng,13);refreshStatus();refreshExtras();});
$('locateBtn').onclick=()=>locate();$('mapLocate').onclick=()=>locate();$('chatLocate').onclick=()=>locate(true);
for(const button of document.querySelectorAll('[data-report]'))button.onclick=()=>report(button.dataset.report);
for(const button of document.querySelectorAll('[data-filter]'))button.onclick=()=>{state.filter=button.dataset.filter;document.querySelectorAll('[data-filter]').forEach(b=>b.classList.toggle('selected',b===button));map.render();};
for(const button of document.querySelectorAll('[data-board]'))button.onclick=()=>{state.board=button.dataset.board;document.querySelectorAll('[data-board]').forEach(b=>b.classList.toggle('selected',b===button));renderBoard();};
for(const button of document.querySelectorAll('[data-open]'))button.onclick=()=>{if(button.dataset.open==='complaintDialog')loadAccount();$(button.dataset.open).showModal();};
for(const dialog of document.querySelectorAll('dialog'))dialog.addEventListener('click',event=>{if(event.target!==dialog)return;const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();});
for(const link of document.querySelectorAll('[data-lite]'))link.addEventListener('click',()=>storageSet('cg_lite','1'));
for(const link of document.querySelectorAll('.side-nav a'))link.addEventListener('click',()=>{document.querySelectorAll('.side-nav a').forEach(a=>a.classList.toggle('active',a===link));});
$('chatForm').onsubmit=sendChat;$('alarmToggle').onclick=toggleAlarm;$('enablePush').onclick=togglePush;$('notificationBtn').onclick=togglePush;$('recheckNetwork').onclick=()=>{checkNetwork();detectNetwork();};$('shareStory').onclick=shareStory;
$('complaintForm').onsubmit=event=>event.preventDefault();$('utilitySelect').onchange=loadAccount;
$('copyComplaint').onclick=copyComplaint;
for(const id of ['accountNumber','complaintAddress','rememberAccount'])$(id).addEventListener('input',updateComplaint);
$('forgetAccounts').onclick=()=>{storageRemove('cg_account_power');storageRemove('cg_account_water');$('accountNumber').value='';$('rememberAccount').checked=false;updateComplaint();toast('Saved utility account numbers removed from this browser.');};
$('todayLabel').textContent=new Date().toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'Asia/Colombo'});
if(new URLSearchParams(location.search).has('full'))storageRemove('cg_lite');
updateAreaLabels();refreshLoop();refreshExtras();checkNetwork();detectNetwork();initBattery();initServiceWorker();loadPushConfig();
setInterval(()=>{if(!document.hidden)refreshExtras();},20*60000);
document.addEventListener('visibilitychange',()=>{clearTimeout(refreshTimer);if(!document.hidden)refreshLoop();else loopVersion++;});
window.addEventListener('online',()=>{refreshLoop();checkNetwork();});window.addEventListener('offline',()=>{setConnected(false);});
