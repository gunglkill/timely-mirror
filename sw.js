
const CACHE = 'ggpk-v4';
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(ks){
    return Promise.all(ks.map(function(k){ return k === CACHE ? null : caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener('fetch', function(e){
  var req = e.request;
  if(req.method !== 'GET') return;
  var u = new URL(req.url);
  if(u.origin !== location.origin) return;
  e.respondWith(
    fetch(req).then(function(res){
      if(res && res.status === 200){
        var copy = res.clone();
        var key = new Request(u.origin + u.pathname);
        caches.open(CACHE).then(function(c){ c.put(key, copy); }).catch(function(){});
      }
      return res;
    }).catch(function(){
      return caches.match(req, {ignoreSearch: true}).then(function(m){
        return m || caches.match('./index.html', {ignoreSearch: true});
      });
    })
  );
});
