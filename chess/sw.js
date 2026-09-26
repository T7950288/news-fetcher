/* 引擎文件永久缓存（首次下载后秒开）——象棋 pikafish + 围棋模型/tfjs */
var CACHE = "chess-v2";
self.addEventListener("install", function (e) { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("fetch", function (e) {
  var url;
  try { url = new URL(e.request.url); } catch (err) { return; }
  if (url.origin !== location.origin) return;
  var p = url.pathname;
  var cacheable =
    p.indexOf("/chess/pikafish/") >= 0 ||
    p.indexOf("/chess/go_model/") >= 0 ||
    p === "/news-fetcher/chess/vendor/tf.min.js" ||
    p === "/news-fetcher/chess/weiqi.html" ||
    p === "/news-fetcher/chess/go_engine.js";
  if (cacheable) {
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
