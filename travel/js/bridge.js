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
          if (backend === 'qt') {
            // 迁移：首次启用 qt 后端时，把 localStorage 里的旧数据搬进 store.json
            try {
              const old = localStorage.getItem(KEY);
              if (old) {
                qtObj.get(KEY, function (cur) {
                  if (!cur) { qtObj.set(KEY, old); }
                });
              }
            } catch (e) { /* 迁移失败不影响使用 */ }
          }
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

  /* 一键备份 / 一键恢复 / 一键永久存档：仅桌面版可用（需要读写本地文件）。
     action = 'export' 备份（滚动保留 10 份）｜ 'import' 恢复
              ｜ 'archive' 永久存档（长期保留，不参与自动清理）。
     返回字符串，空串表示当前环境不支持。 */
  function backup(action) {
    return ready.then(function () {
      return new Promise(function (res) {
        var fn = (action === 'import') ? 'importBackup'
               : (action === 'archive') ? 'exportArchive' : 'exportBackup';
        if (backend === 'qt' && qtObj && typeof qtObj[fn] === 'function') {
          try {
            qtObj[fn](function (m) { res(m || ''); });
            return;
          } catch (e) { /* 落到"不支持" */ }
        }
        res('');
      });
    });
  }

  /* 照片模块：仅桌面版可用（需要读本地照片文件）。
     action = status 状态 ｜ scan 开始扫描 ｜ payload 县市聚合 ｜ list 某县照片
              ｜ view 取大图 ｜ delete 删除原图（送系统回收站）｜ clear 清缓存。
     返回原始 JSON 字符串；空串表示当前环境不支持。 */
  function photos(action, arg) {
    return ready.then(function () {
      return new Promise(function (res) {
        if (backend !== 'qt' || !qtObj) { res(''); return; }
        try {
          if (action === 'status') { qtObj.photoStatus(function (m) { res(m || ''); }); }
          else if (action === 'scan') { qtObj.photoScan(arg ? '1' : '0', function (m) { res(m || ''); }); }
          else if (action === 'payload') { qtObj.photoPayload(function (m) { res(m || ''); }); }
          else if (action === 'list') { qtObj.photoList(String(arg || ''), function (m) { res(m || ''); }); }
          else if (action === 'view') { qtObj.photoView(String(arg || ''), function (m) { res(m || ''); }); }
          else if (action === 'delete') { qtObj.photoDelete(String(arg || ''), function (m) { res(m || ''); }); }
          else if (action === 'clear') { qtObj.photoClear(function (m) { res(m || ''); }); }
          else { res(''); }
        } catch (e) { res(''); }
      });
    });
  }

  return { ready: ready, get: get, set: set, backup: backup, photos: photos, KEY: KEY };
})();
