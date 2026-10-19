self.addEventListener('install',()=>self.skipWaiting());
self.addEventListener('fetch',e=>{if(e.request.method!=='GET'||e.request.url.includes('/api/'))return;e.respondWith(fetch(e.request).then(r=>{const c=r.clone();caches.open('ss1').then(k=>k.put(e.request,c));return r}).catch(()=>caches.match(e.request)))});
