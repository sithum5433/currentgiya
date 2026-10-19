'use strict';
const CACHE='currentgiya-shell-v3';
const PAGES=['/','/index.html','/lite.html','/lite'];
const SHELL=[...PAGES,'/style.css','/app.js','/manifest.webmanifest'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(new URL(self.location.href).searchParams.has('lite')?[]:SHELL))));
self.addEventListener('activate',e=>e.waitUntil(Promise.all([
  caches.keys().then(names=>Promise.all(names.filter(n=>n.startsWith('currentgiya-shell-')&&n!==CACHE).map(n=>caches.delete(n)))),self.clients.claim()
])));
self.addEventListener('message',e=>{
  if(e.data?.type==='SKIP_WAITING')self.skipWaiting();
  // Cache the pristine Lite DOM without downloading its HTML a second time.
  if(e.data?.type==='CACHE_LITE'&&typeof e.data.html==='string'&&e.data.html.length<20000&&e.data.html.startsWith('<!doctype html>')&&e.source?.url){
    const u=new URL(e.source.url);
    if(u.origin===self.location.origin&&['/lite.html','/lite'].includes(u.pathname))e.waitUntil(caches.open(CACHE).then(c=>c.put('/lite.html',new Response(e.data.html,{headers:{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'"}}))));
  }
});
self.addEventListener('fetch',e=>{
  const r=e.request,u=new URL(r.url),nav=r.mode==='navigate';
  if(r.method!=='GET'||u.origin!==self.location.origin||!(nav?PAGES:SHELL).includes(u.pathname))return;
  const key=nav?(u.pathname.startsWith('/lite')?'/lite.html':'/index.html'):u.pathname;
  e.respondWith(fetch(r).then(response=>{
    if(response.ok){const copy=response.clone();e.waitUntil(caches.open(CACHE).then(c=>c.put(key,copy)));}
    return response;
  }).catch(async()=>{
    const cached=await caches.match(key);
    return cached||(nav?new Response('CurrentGiya is offline. Connect once to make this page available.',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8'}}):Response.error());
  }));
});
function safeURL(value){
  try{const u=new URL(typeof value==='string'?value:'/',self.location.origin);if(u.origin===self.location.origin&&PAGES.includes(u.pathname))return u.href;}catch{}
  return self.location.origin+'/';
}
self.addEventListener('push',e=>{
  let d={};try{d=e.data?e.data.json():{};}catch{}
  e.waitUntil(self.registration.showNotification(typeof d.title==='string'?d.title.slice(0,100):'CurrentGiya.lk',{
    body:typeof d.body==='string'?d.body.slice(0,300):'There is an update for your area. Open CurrentGiya to check.',tag:'currentgiya-area-alert',data:{path:safeURL(d.url)}
  }));
});
self.addEventListener('notificationclick',e=>{
  e.notification.close();const destination=safeURL(e.notification.data?.path);
  e.waitUntil(self.clients.matchAll({type:'window',includeUncontrolled:true}).then(async clients=>{
    for(const c of clients)if(new URL(c.url).origin===self.location.origin&&'focus'in c){if('navigate'in c)await c.navigate(destination);return c.focus();}
    return self.clients.openWindow(destination);
  }));
});
