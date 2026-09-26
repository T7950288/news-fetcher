/* 引擎文件永久缓存（首次下载后秒开） */
var CACHE = "pika-v1";
self.addEventListener("install", function (e) { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
  var url;
  try { url = new URL(e.request.url); } catch (err) { return; }
  if (url.origin === location.origin && url.pathname.indexOf("/chess/pikafish/") >= 0) {
    e.respondWith(
      caches.open(CACHE).then(function (c) {
        return c.match(e.request).then(function (r) {
          return r || fetch(e.request).then(function (resp) {
            if (resp && resp.ok) c.put(e.request, resp.clone());
            return resp;
          });
        });
      })
    );
  }
});
