// Derma offline cache. Network first (so new chapters show up), cache when offline.
const VERSION='54c02d9fd2';
const CACHE='derma-'+VERSION;
const FILES=["./", "derma.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "21a.html", "index.html", "data/21a.bin", "data/index.bin"];
self.addEventListener('install',e=>{
  e.waitUntil(caches.open(CACHE).then(c=>c.addAll(FILES)).then(()=>self.skipWaiting()));
});
self.addEventListener('activate',e=>{
  e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k.startsWith('derma-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));
});
self.addEventListener('fetch',e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=='GET'||u.origin!==location.origin)return;
  e.respondWith(
    fetch(e.request).then(r=>{
      if(r.ok){const c=r.clone();caches.open(CACHE).then(ca=>ca.put(e.request,c))}
      return r;
    }).catch(()=>caches.match(e.request,{ignoreSearch:true}).then(r=>r||caches.match('./')))
  );
});
