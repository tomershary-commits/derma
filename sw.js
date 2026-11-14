// Derma offline cache. Network first, revalidated with the server every time (so new chapters show up), cache when offline.
const VERSION='26006cebd6';
const CACHE='derma-'+VERSION;
const FILES=["./", "derma.js", "fflate.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "00.html", "01.html", "04.html", "08.html", "10.html", "12.html", "14.html", "21a.html", "21b-d.html", "review.html", "exam.html", "mine.html", "compare.html", "search.html", "index.html", "data/00.bin", "data/01.bin", "data/04.bin", "data/08.bin", "data/10.bin", "data/12.bin", "data/14.bin", "data/21a.bin", "data/21b-d.bin", "data/review.bin", "data/exam.bin", "data/mine.bin", "data/compare.bin", "data/search.bin", "data/index.bin"];
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
    fetch(e.request.url,{cache:'no-cache',credentials:'same-origin'}).then(r=>{
      if(r.ok){const c=r.clone();caches.open(CACHE).then(ca=>ca.put(e.request,c))}
      return r;
    }).catch(()=>caches.match(e.request,{ignoreSearch:true}).then(r=>r||caches.match('./')))
  );
});
