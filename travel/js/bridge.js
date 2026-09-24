/* 数据持久化桥：Android JavascriptInterface / Windows QWebChannel / localStorage 兜底
   统一接口：Store.get(key)、Store.set(key,val)，均返回 Promise。 */
const Store = (function () {
  const KEY = 'doubao_travel_v1';
  let backend = 'local';
  let qtObj = null;

  const ready = new Promise(function (resolve) {
    // 安卓原生
    if (window.AndroidBridge && typeof window.AndroidBridge.getJSON === 'function') {
      backend = 'android';
      return resolve();
    }
    // Windows QWebChannel
    if (typeof QWebChannel !== 'undefined' && typeof qt !== 'undefined') {
      try {
        new QWebChannel(qt.webChannelTransport, function (channel) {
          qtObj = channel.objects.native || channel.objects.bridge;
          backend = qtObj ? 'qt' : 'local';
          resolve();
        });
        return;
      } catch (e) { /* 落到本地 */ }
    }
    backend = 'local';
    resolve();
  });

  function get(key) {
    return ready.then(function () {
      return new Promise(function (res) {
        try {
          if (backend === 'android') {
            const s = window.AndroidBridge.getJSON(key);
            res(s ? JSON.parse(s) : null);
          } else if (backend === 'qt') {
            qtObj.get(key, function (v) { res(v ? JSON.parse(v) : null); });
          } else {
            const s = localStorage.getItem(key);
            res(s ? JSON.parse(s) : null);
          }
        } catch (e) { res(null); }
      });
    });
  }

  function set(key, val) {
    return ready.then(function () {
      return new Promise(function (res) {
        const s = JSON.stringify(val);
        if (backend === 'android') { window.AndroidBridge.setJSON(key, s); res(); }
        else if (backend === 'qt') { qtObj.set(key, s); res(); }
        else { localStorage.setItem(key, s); res(); }
      });
    });
  }

  return { ready: ready, get: get, set: set, KEY: KEY };
})();
