/* 豆包旅游地图 主程序：地图标注、景点检索、行程规划展示、足迹联动 */
(function () {
  'use strict';
  const A = window.APP_DATA;
  const AT = A.attractions;
  const CITIES = A.cities.cities;          // 市级（363）
  const COUNTIES = A.cities.counties || []; // 县级（2824，含直辖市区）
  // 铁路可达标记（近似）：无县级归属（地级市直属）、市辖区、县级市按可能通高铁/动车；纯县按大巴
  AT.forEach(s => {
    const cy = s.county || s.city || '';
    s.rail = !cy || /(区|市)$/.test(cy);
  });

  /* 全量景点去重已移除：data_bundle已是去重后的358个官方5A，运行时不再去重避免误删 */

  /* 补全5A已移除：data_bundle已含全部358个官方5A，无需运行时补录 */

  const PROVS = A.cities.provinces;

  // 各省范围（用县级中心点计算），点击景点时框住全省视野
  const PROV_BOUNDS = {};
  A.cities.counties.forEach(c => {
    if (!c.center) return;
    const nm = c.province;
    let b = PROV_BOUNDS[nm];
    if (!b) { b = PROV_BOUNDS[nm] = { minLat: 90, maxLat: -90, minLng: 180, maxLng: -180, cnt: 0 }; }
    const la = c.center[1], lo = c.center[0];
    if (la < b.minLat) b.minLat = la;
    if (la > b.maxLat) b.maxLat = la;
    if (lo < b.minLng) b.minLng = lo;
    if (lo > b.maxLng) b.maxLng = lo;
    b.cnt++;
  });
  Object.keys(PROV_BOUNDS).forEach(nm => {
    const b = PROV_BOUNDS[nm];
    if (b.cnt < 2 || (b.maxLat - b.minLat < .4 && b.maxLng - b.minLng < .4)) delete PROV_BOUNDS[nm];
  });

  const CATS = { 1: '历史古迹', 2: '自然风光', 3: '宗教文化', 4: '园林公园', 5: '博物馆/科教', 6: '主题乐园', 7: '古城古镇', 8: '海滨/水域', 9: '都市地标', 10: '民俗文化', 11: '名山' };
  const CAT_COLORS = { 1: '#b07643', 2: '#3fa66d', 3: '#9b6dd7', 4: '#4caf8a', 5: '#4e9af1', 6: '#e05d6b', 7: '#d98a4b', 8: '#3fb8c4', 9: '#7a869a', 10: '#c9674a', 11: '#7a5230' };
  const DAY_COLORS = ['#1d6fe0', '#f59e0b', '#06b6d4', '#ec4899', '#a16207', '#0891b2', '#be185d', '#475569'];

  // 索引
  const byId = {};
  const byCity = {};
  AT.forEach(s => {
    byId[s.id] = s;
    const c = Footprint.normCity(s.city);
    (byCity[c] = byCity[c] || []).push(s);
  });
  const cityCenter = {};
  CITIES.forEach(c => { cityCenter[c.name] = c.center; });
  COUNTIES.forEach(c => { cityCenter[c.name] = c.center; });
  // 城市 → 省份（市级 + 县级 + 省级兜底）
  const cityProv = {};
  CITIES.forEach(c => { cityProv[c.name] = c.province; });
  COUNTIES.forEach(c => { cityProv[c.name] = c.province; });
  // 市辖区判定：以“区”结尾（神农架林区、六枝特区等县级单位除外）
  function isDistrictName(n) { return n.endsWith('区') && n !== '神农架林区' && !n.endsWith('特区'); }
  const districtCity = {};
  COUNTIES.forEach(c => { if (isDistrictName(c.name)) districtCity[c.name] = c.city || c.province; });
  // —— 无归属景点的就近归属 ——
  // 数据里有 161 个「热门 / 新点」只填了省份，city 与 county 都是空的
  // （环球影城、古北水镇、应县木塔、茶卡盐湖…）。原逻辑取 county||city 得到空串，
  // 点这些景点什么都不会点亮（占景点库 21%）。这里按坐标就近落到最近的县级单位，
  // 70km 内没有县级单位就落最近的地级市；直辖市直接用市名（市即最小可点单位）。
  const UNIT_PTS = [];
  CITIES.forEach(c => { if (c.center) UNIT_PTS.push({ n: c.name, x: c.center[0], y: c.center[1], isCity: true }); });
  COUNTIES.forEach(c => { if (c.center) UNIT_PTS.push({ n: c.name, x: c.center[0], y: c.center[1], isCity: false }); });
  function km2To(lng, lat, x, y) {            // 近似平面距离的平方（km²）
    const k = Math.cos(lat * Math.PI / 180);
    const dx = (x - lng) * k, dy = y - lat;
    return (dx * dx + dy * dy) * 12392;       // 111.32²
  }
  const unitCache = {};
  function inferUnit(lat, lng, prov) {
    if (MUNI.indexOf(prov) >= 0) return prov;
    let bcN = '', bcD = 1e18, cyN = '', cyD = 1e18;
    for (let i = 0; i < UNIT_PTS.length; i++) {
      const u = UNIT_PTS[i];
      const d = km2To(lng, lat, u.x, u.y);
      if (u.isCity) { if (d < cyD) { cyD = d; cyN = u.n; } }
      else if (d < bcD) { bcD = d; bcN = u.n; }
    }
    if (bcN && bcD <= 4900) return isDistrictName(bcN) ? (districtCity[bcN] || bcN) : bcN;   // 70km
    return cyN;
  }
  // 景点 → 「最小所在地」名：优先县，无县则市。
  // · 县是市辖区时归并到所属地级市（市辖区在左侧列表与地图上都不单独出现，
  //   直接点亮它会变成一条看不见的幽灵记录）；
  // · 名单外的县级名（如撤县设市没跟上的「米林市」）退回市级归属；
  // · city 与 county 全空的热门点按坐标就近归属，否则点了等于没点。
  function spotUnitName(sp) {
    let n = Footprint.normCity(sp.county || sp.city);
    if (n && isDistrictName(n)) n = districtCity[n] || Footprint.normCity(sp.city) || n;
    if (n && cityProv[n] === undefined) {
      const alt = Footprint.normCity(sp.city);
      if (alt && cityProv[alt] !== undefined) n = alt;
    }
    if (n && cityProv[n] !== undefined) return n;
    if (sp.id in unitCache) return unitCache[sp.id];
    let m = '';
    if (typeof sp.lat === 'number' && typeof sp.lng === 'number') m = inferUnit(sp.lat, sp.lng, sp.province);
    if (!m && cityProv[sp.province] !== undefined) m = sp.province;
    unitCache[sp.id] = m;
    return m;
  }
  const countySet = new Set(COUNTIES.map(c => c.name));
  // 市级 → 下属县级名（用于“市级包含县级点亮”统计）
  const countyOfCity = {};
  const MUNI = ['北京市', '上海市', '天津市', '重庆市'];
  COUNTIES.forEach(c => {
    let parent = c.city;
    if (!parent && MUNI.includes(c.province)) parent = c.province;
    if (parent) (countyOfCity[parent] = countyOfCity[parent] || []).push(c.name);
  });
  // 归一化：判断市级是否点亮（含下属县级）
  function cityLit(lit, cityName) {
    if (lit[cityName] && lit[cityName].length) return lit[cityName];
    const subs = countyOfCity[cityName] || [];
    const ids = [];
    subs.forEach(n => { const v = lit[n]; if (v) ids.push(...v); });
    return ids.length ? Array.from(new Set(ids)) : null;
  }
  // 市级候选景点 = 市级直属 + 下属县级所有景点（行程规划按地级市聚合）
  const byCityAll = {};
  // 先按景点归属填充（县级/市直属）
  Object.keys(byCity).forEach(n => {
    (byCityAll[n] = byCityAll[n] || []).push(...byCity[n]);
  });
  // 再为每个地级市聚合下属县级景点（含本身无直属景点的地区/州/盟）
  CITIES.forEach(c => {
    const subs = countyOfCity[c.name] || [];
    const pool = (byCityAll[c.name] || []).concat(...subs.map(sn => byCity[sn] || []));
    if (pool.length) byCityAll[c.name] = pool;
  });

  let state = { footprint: Footprint.defaultState(), savedTrips: [], days: 2, prefs: [], curCat: 0, curQ: '' };
  let lastPlan = null;
  let lastRouteRes = null;

  /* ---------- 照片图层（独立模块，默认关闭；关闭时不读任何照片数据） ---------- */
  let photoOn = false;        // 是否显示照片图层
  let photoUnits = {};        // {单位名: {n, lat, lng, prov}}
  let photoUnit = '';         // 当前在右侧展开的单位
  let photoPollTimer = null;  // 扫描进度轮询
  let photoList = [];         // 当前面板里的照片（已按拍摄时间倒序）
  let viewerIdx = -1;         // 大图查看器当前索引

  /* 把当前内存状态整份推到存储槽，并在「Python 侧确实收下」之后才 resolve。
     ★ 备份 / 恢复 / 存档 之前必须先 await 它 —— 这两条通道都是异步的、互不等待，
       不等就会读到还没落地的旧数据（2026-10-02 实测：点亮城市后立刻存档，8/8 轮都缺最后一条）。 */
  function flushStore() {
    // 合并保存：不覆盖 nameOverrides/mySpots/posOverrides（此前整体覆盖导致改名、拖拽位置丢失）
    return Store.get(Store.KEY).then(saved => {
      saved = saved || {};
      Object.assign(saved, state);
      saved.nameOverrides = nameOverrides;
      saved.mySpots = mySpots;
      saved.posOverrides = posOverrides;
      saved.deletedSpots = deletedSpots;
      saved.showTextOverrides = showTextOverrides;
      // set 之后再 get 一次：两者走同一条有序通道，get 能回来就说明 Python 侧
      // 已把这批数据收进 self.data —— 而备份 / 存档读的正是它。
      return Store.set(Store.KEY, saved).then(() => Store.get(Store.KEY));
    });
  }
  function save() { flushStore(); }

  /* ---------- 地图 ---------- */
  const map = L.map('map', { attributionControl: false, zoomControl: false }).setView([35.6, 105.5], 4);
  window.__map = map;
  window.__fly = function (name) {
    const c = CITIES.find(x => x.name === name) || COUNTIES.find(x => x.name === name);
    if (c) map.setView(disp(c.center[1], c.center[0]), COUNTIES.some(x => x.name === name) ? 10 : 9, { animate: false });
  };
  const baseTile = L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    { subdomains: ['1', '2', '3', '4'], maxZoom: 18, minZoom: 2, minNativeZoom: 3, keepBuffer: 4 }).addTo(map);
  const satTile = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 18, minZoom: 2, keepBuffer: 8, updateWhenZooming: false });
  /* 🌍世界板块专用底图（地图外观 + 境外放大有路网，2026-10-04 定稿）：
     「地图」= 本自定义层按瓦片分流 ——
       · z≤8 全球 / 境内 z9+：高德中文路网（境内 z18 级、境外数据 z8 封顶），
         空白瓦片（固定 179B 纯色图）垫高德海色 #a3ccff（实测采样）；
       · 境外 z9+：Esri World_Street_Map 彩色街道图 —— 用户 2026-10-04 拍板
         「改回带英文的」：日本等汉字文化圈直接显示汉字地名（皇居東御苑/江戸城/
         千代田，东京皇居 z16 取证），欧美显示英文路名；路网/水系/绿地完整。
         原生数据实测：纽约/伦敦到 z17-18 有真瓦片，东京只到 z16（z17+ 返回
         2521B「Map data not yet available」占位图）→ 先请求原级别，
         遇占位图退 z16 瓦片 CSS 背景裁剪放大（最多放大 4 倍，远优于旧
         「灰底图退 z13」方案）。海洋无数据区垫街道图海色 #99d9f2（实测采样）。
       境内判定 = 瓦片中心经纬度（73-136E/17-54N，z>8 时一格范围已很小）。
     「卫星」= 纯 Esri World_Imagery（osmTile，变量沿用旧名），toggleSat 换层。
     两模式完全独立不叠底（用户要求地图/卫星彻底分开）。 */
  const TransparentPx = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  const AmapWorldTile = L.TileLayer.extend({
    createTile: function (coords, done) {
      const tile = document.createElement('img');
      const self = this;
      tile.onload = function () { done(null, tile); };
      tile.onerror = function () { done({ err: 'load' }, tile); };
      const streetAt = (z, x, y) => 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/' + z + '/' + y + '/' + x;
      const SM_NA = 2521, SM_SEA = '#99d9f2', AMAP_SEA = '#a3ccff';
      /* 街道图「Map data not yet available」固定 2521B —— 按无数据处理垫街道海色 */
      const smSea = () => { tile.style.background = SM_SEA; tile.src = TransparentPx; };
      const setBgTile = (u, scale, sx, sy) => {   // CSS 背景裁剪：子区放大不串格
        const im = new Image();
        im.onload = () => {
          tile.style.backgroundImage = 'url("' + u + '")';
          tile.style.backgroundRepeat = 'no-repeat';
          tile.style.backgroundSize = (256 * scale) + 'px ' + (256 * scale) + 'px';
          tile.style.backgroundPosition = (-sx) + 'px ' + (-sy) + 'px';
          tile.src = TransparentPx;              // 透明触发 onload → done
        };
        im.onerror = smSea;
        im.src = u;                              // 同 URL 已被 fetch 缓存，秒加载
      };
      // 瓦片中心经纬度 → 是否境内（z>8 时一格范围已很小，中心判定足够）
      const n = Math.pow(2, coords.z);
      const lng = (coords.x + 0.5) / n * 360 - 180;
      const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * (coords.y + 0.5) / n))) * 180 / Math.PI;
      const inCN = lng >= 73 && lng <= 136 && lat >= 17 && lat <= 54;
      if (coords.z <= 8 || inCN) {              // 高德：z≤8 全球有数据；境内 z9+ 有数据
        const u0 = this.getTileUrl(coords);
        fetch(u0).then(r => r.arrayBuffer()).then(buf => {
          if (buf.byteLength >= 500) { tile.src = u0; return; }
          tile.style.background = AMAP_SEA; tile.src = TransparentPx;   // 远海垫高德海色
        }).catch(() => { tile.src = u0; });
        return tile;
      }
      /* 境外 z9+：彩色街道图。原级别正常 → 直接显示；遇占位图 →
         z≤16 视为远海无数据垫海色，z>16 退 z16 裁剪放大（纽约/伦敦 z17-18
         有原生数据不经此路，东京 z17+ 走此路）。 */
      const u0 = streetAt(coords.z, coords.x, coords.y);
      fetch(u0).then(r => r.arrayBuffer()).then(buf => {
        if (buf.byteLength >= 500 && buf.byteLength !== SM_NA) { tile.src = u0; return; }
        if (coords.z <= 16) { smSea(); return; }
        const s = 1 << (coords.z - 16);
        const x16 = coords.x >> (coords.z - 16), y16 = coords.y >> (coords.z - 16);
        const u16 = streetAt(16, x16, y16);
        fetch(u16).then(r => r.arrayBuffer()).then(b2 => {
          if (b2.byteLength < 500 || b2.byteLength === SM_NA) { smSea(); return; }
          setBgTile(u16, s, (coords.x - x16 * s) * 256, (coords.y - y16 * s) * 256);
        }).catch(smSea);
      }).catch(() => { tile.src = u0; });
      return tile;
    }
  });
  const worldMap = new AmapWorldTile('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    { subdomains: ['1', '2', '3', '4'], maxZoom: 18, minZoom: 2, minNativeZoom: 3, keepBuffer: 4 });
  const osmTile = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    { maxZoom: 18, minZoom: 2, keepBuffer: 4 });
  var satOn = false;
  /* ---------- 卫星瓦片预取：地图静止约 0.8 秒后，后台按"中心优先"预下载
     放大一级后整屏所需的全部瓦片（4 路并发）。瓦片源有 24 小时缓存头，
     之后用户再放大就命中本地缓存、直接秒开。视图一变即中止本轮。 ---------- */
  const prefetchDone = new Set();
  function prefetchSat() {
    if (!satOn) return;
    const z = Math.round(map.getZoom());
    if (z < 3 || z >= 18) return;
    const nz = z + 1, n = Math.pow(2, nz);
    function tx(lng) { return Math.floor((lng + 180) / 360 * n); }
    function ty(lat) {
      const r = Math.max(-85.05, Math.min(85.05, lat)) * Math.PI / 180;
      return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * n);
    }
    const size = map.getSize();
    const tl = map.containerPointToLatLng([0, 0]);
    const br = map.containerPointToLatLng([size.x, size.y]);
    const c = map.getCenter();
    let x0 = tx(tl.lng), x1 = tx(br.lng), y0 = ty(br.lat), y1 = ty(tl.lat);
    if (x0 > x1) { const t = x0; x0 = x1; x1 = t; }
    if (y0 > y1) { const t = y0; y0 = y1; y1 = t; }
    // 异常兜底：范围过大时退回中心 7×7
    if ((x1 - x0 + 1) * (y1 - y0 + 1) > 60) {
      x0 = tx(c.lng) - 3; x1 = x0 + 6; y0 = ty(c.lat) - 3; y1 = y0 + 6;
    }
    const cxT = tx(c.lng), cyT = ty(c.lat);
    const jobs = [];
    for (let x = Math.max(0, x0); x <= x1; x++) {
      for (let y = Math.max(0, y0); y <= y1; y++) {
        if (x >= n || y >= n) continue;
        jobs.push([x, y, Math.abs(x - cxT) + Math.abs(y - cyT)]);
      }
    }
    jobs.sort(function (a, b) { return a[2] - b[2]; }); // 中心优先
    setTimeout(function () {
      if (!satOn || Math.round(map.getZoom()) !== z) return; // 视图又变了，放弃本轮
      let i = 0, active = 0;
      (function pump() {
        while (active < 4 && i < jobs.length) {
          const url = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/'
            + nz + '/' + jobs[i][1] + '/' + jobs[i][0];
          i++;
          if (prefetchDone.has(url)) continue;
          prefetchDone.add(url);
          active++;
          const img = new Image();
          img.onload = img.onerror = function () { active--; pump(); };
          img.src = url;
        }
      })();
    }, 800);
  }
  map.on('moveend', prefetchSat);
  map.on('zoomend', prefetchSat);
  // 火星坐标(GCJ-02)与标准坐标(WGS-84)互转：普通图=高德(火星)，卫星图=ArcGIS(标准)
  function wgs2gcj(wlat, wlng) {
    function outOfChina(lat, lng) { return (lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271); }
    function tLat(x, y) { var r = -100 + 2*x + 3*y + 0.2*y*y + 0.1*x*y + 0.2*Math.sqrt(Math.abs(x)); r += (20*Math.sin(6*x*Math.PI) + 20*Math.sin(2*x*Math.PI)) * 2/3; r += (20*Math.sin(y*Math.PI) + 40*Math.sin(y/3*Math.PI)) * 2/3; r += (160*Math.sin(y/12*Math.PI) + 320*Math.sin(y*Math.PI/30)) * 2/3; return r; }
    function tLng(x, y) { var r = 300 + x + 2*y + 0.1*x*x + 0.1*x*y + 0.1*Math.sqrt(Math.abs(x)); r += (20*Math.sin(6*x*Math.PI) + 20*Math.sin(2*x*Math.PI)) * 2/3; r += (20*Math.sin(x*Math.PI) + 40*Math.sin(x/3*Math.PI)) * 2/3; r += (150*Math.sin(x/12*Math.PI) + 300*Math.sin(x/30*Math.PI)) * 2/3; return r; }
    if (outOfChina(wlat, wlng)) return [wlat, wlng];
    var a = 6378245.0, ee = 0.00669342162296594323;
    var dLat = tLat(wlng - 105.0, wlat - 35.0), dLng = tLng(wlng - 105.0, wlat - 35.0);
    var radLat = wlat / 180.0 * Math.PI;
    var magic = Math.sin(radLat); magic = 1 - ee * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((a * (1 - ee)) / (magic * sqrtMagic) * Math.PI);
    dLng = (dLng * 180.0) / (a / sqrtMagic * Math.cos(radLat) * Math.PI);
    return [wlat + dLat, wlng + dLng];
  }
  function gcj2wgs(glat, glng) {
    var g = wgs2gcj(glat, glng);
    return [2*glat - g[0], 2*glng - g[1]];
  }
  /* 显示坐标换算。基准事实（2026-10-04 实测）：大陆点存 GCJ-02（高德大陆瓦片网格）；
     台湾点存 WGS-84（行政区数据的台湾坐标本就是 WGS 原值），且高德在台湾的瓦片
     不做 GCJ 偏移、与 Esri 影像同为 WGS 网格。故台湾框内两种模式一律恒等显示，
     框外维持「地图=原值 / 卫星=转WGS」的既有换算。框(119.4~122.2E,21.75~25.45N)
     已全量验证：COUNTIES/CITIES/景点/自建/posOverrides 内均无大陆点误入。 */
  const TW_BOX = (la, lo) => (lo >= 119.4 && lo <= 122.2 && la >= 21.75 && la <= 25.45);
  const disp = (la, lo) => (satOn && !TW_BOX(la, lo)) ? gcj2wgs(la, lo) : [la, lo];
  // 入库反算：把当前底图上的坐标换算回该区域的统一存储基准（台湾=WGS 恒等，大陆=GCJ-02）
  const toStore = (la, lo) => (satOn && !TW_BOX(la, lo)) ? wgs2gcj(la, lo) : [la, lo];
  function toggleSat() {
    satOn = !satOn;
    const c = map.getCenter(), z = map.getZoom();
    const inCN = c.lng >= 73 && c.lng <= 136 && c.lat >= 17 && c.lat <= 54;   // 中国境内才有偏移
    if (curTab === 'world') {
      // 🌍世界：地图(高德中文)↔卫星(纯影像) —— 两模式完全独立不叠底（用户 2026-10-04）
      if (satOn) {
        map.removeLayer(worldMap);
        if (!map.hasLayer(osmTile)) osmTile.addTo(map);
      } else {
        map.removeLayer(osmTile);
        if (!map.hasLayer(worldMap)) worldMap.addTo(map);
      }
      const w = (inCN && !TW_BOX(c.lat, c.lng)) ? (satOn ? gcj2wgs(c.lat, c.lng) : wgs2gcj(c.lat, c.lng)) : [c.lat, c.lng];
      map.setView([w[0], w[1]], z, { animate: false });
    } else if (satOn) {
      map.removeLayer(baseTile); satTile.addTo(map);
      const w = TW_BOX(c.lat, c.lng) ? [c.lat, c.lng] : gcj2wgs(c.lat, c.lng);
      map.setView([w[0], w[1]], z, { animate: false });
    } else {
      map.removeLayer(satTile); baseTile.addTo(map);
      const g = TW_BOX(c.lat, c.lng) ? [c.lat, c.lng] : wgs2gcj(c.lat, c.lng);
      map.setView([g[0], g[1]], z, { animate: false });
    }
    var b = document.getElementById('btnSat');
    if (b) { b.classList.toggle('on', satOn); b.innerHTML = satOn ? '🗺 地图' : '🛰 卫星'; }
    refreshMarkers();
    prefetchSat();
  }
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  const provFillLayer = L.layerGroup().addTo(map);   // 👣足迹省级色块：去过的省整块上色（仅足迹板块 z4/z5 地图模式），必须在 provLayer 之前加入以垫底
  const provLayer = L.layerGroup().addTo(map);
  const cityLayer = L.layerGroup().addTo(map);
  const spotLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const litLayer = L.layerGroup().addTo(map);
  const worldLayer = L.layerGroup().addTo(map);   // 🌍世界：大洲 / 国家 / 境外城市注记（只读，不可交互）

  /* ---------- 海拔：GPS 实测 + 地图点查（多源高程） ---------- */
  function altTimeout(p, ms){ return Promise.race([p, new Promise(function(_, rej){ setTimeout(function(){ rej(new Error('超时')); }, ms); })]); }
  async function altFetch(lat, lng){
    var list = [
      { n:'Open-Meteo', u:'https://api.open-meteo.com/v1/elevation?latitude='+lat+'&longitude='+lng, k:function(j){ return j.elevation; } },
      { n:'OpenTopoData', u:'https://api.opentopodata.org/v1/srtm30m?locations='+lat+','+lng, k:function(j){ return j.results && j.results[0] ? j.results[0].elevation : null; } },
      { n:'Open-Elevation', u:'https://api.open-elevation.com/api/v1/lookup?locations='+lat+','+lng, k:function(j){ return j.results && j.results[0] ? j.results[0].elevation : null; } }
    ];
    for(var i=0;i<list.length;i++){
      try{
        var r = await altTimeout(fetch(list[i].u), 7000);
        if(!r.ok) throw new Error('HTTP '+r.status);
        var j = await r.json();
        var v = list[i].k(j);
        if(v===null || v===undefined || isNaN(v)) throw new Error('无数据');
        return { elevation: v, source: list[i].n };
      }catch(e){ /* 尝试下一源 */ }
    }
    throw new Error('所有高程源均失败');
  }
  var altFloat = document.getElementById('altFloat');
  var altTimer = null;
  function altShow(html, sticky){
    if(!altFloat) return;
    altFloat.style.display = 'block';
    altFloat.innerHTML = html;
    if(altTimer) clearTimeout(altTimer);
    if(sticky === 'live'){ altTimer = null; return; }   /* 持续跟踪：不自动消失 */
    var ms = (typeof sticky === 'number') ? sticky : (sticky ? 8000 : 3500);
    altTimer = setTimeout(function(){ altFloat.style.display = 'none'; }, ms);
  }

  /* ---------- 天气：Open-Meteo（免 key，国内可达）实时 + 7天 ---------- */
  var WXICONS = { 0:'☀️ 晴',1:'🌤️ 多云',2:'⛅ 多云',3:'☁️ 阴',45:'🌫️ 雾',48:'🌫️ 雾',51:'🌦️ 毛毛雨',53:'🌦️ 毛毛雨',55:'🌦️ 毛毛雨',61:'🌧️ 小雨',63:'🌧️ 中雨',65:'🌧️ 大雨',66:'🌧️ 冻雨',67:'🌧️ 冻雨',71:'🌨️ 小雪',73:'🌨️ 中雪',75:'❄️ 大雪',77:'❄️ 雪',80:'🌦️ 阵雨',81:'🌧️ 阵雨',82:'🌧️ 强阵雨',85:'🌨️ 阵雪',86:'❄️ 阵雪',95:'⛈️ 雷雨',96:'⛈️ 雷雨',99:'⛈️ 雷雨' };
  function wxName(c){ return WXICONS[c] || '🌡️'; }
  function wxFetch(lat, lng){
    var u = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat + '&longitude=' + lng +
      '&current=temperature_2m,relative_humidity_2m,apparent_temperature,weather_code,wind_speed_10m' +
      '&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=auto&forecast_days=7';
    return altTimeout(fetch(u), 8000).then(function(r){ if(!r.ok) throw new Error('HTTP '+r.status); return r.json(); });
  }
  function wxToday(w){
    if(!w || !w.current) return '🌤️ 天气：查询失败';
    var c = w.current;
    return '🌤️ 天气：<b>' + wxName(c.weather_code) + ' ' + Math.round(c.temperature_2m) + '°C</b>';
  }
  function wxWeek(w){
    if(!w || !w.daily || !w.daily.time) return '';
    var dnames = ['周日','周一','周二','周三','周四','周五','周六'];
    var out = '<div class="wxweek">';
    for(var i=0;i<w.daily.time.length;i++){
      var d = new Date(w.daily.time[i] + 'T00:00:00');
      var day = (i===0) ? '今天' : dnames[d.getDay()];
      out += '<div class="wxd"><div class="wxd1">' + day + '</div><div class="wxd2">' + wxName(w.daily.weather_code[i]) + '</div><div class="wxd3">' + Math.round(w.daily.temperature_2m_max[i]) + '°/' + Math.round(w.daily.temperature_2m_min[i]) + '°</div></div>';
    }
    return out + '</div>';
  }
  function wxCardHTML(lat, lng){
    return '<div class="wx" data-lat="' + lat + '" data-lng="' + lng + '">🌤️ 天气：查询中…</div>' +
           '<div class="wxweekbox" data-lat="' + lat + '" data-lng="' + lng + '"></div>';
  }

  /* 点查十字标记 + GPS 定位标记（独立层，不干扰景点标注） */
  var altPin = L.marker([35.6,105.5], { interactive:false, icon: L.divIcon({ className:'', html:'<div style="width:18px;height:18px;border:3px solid #ffd479;border-radius:50%;background:rgba(18,42,34,.72);box-shadow:0 0 8px rgba(0,0,0,.5)"></div>', iconSize:[18,18], iconAnchor:[9,9] }) }).addTo(map);
  altPin.setOpacity(0);
  var gpsPin = L.marker([35.6,105.5], { interactive:false, icon: L.divIcon({ className:'', html:'<div style="width:16px;height:16px;border-radius:50%;background:#13a06f;border:3px solid #fff;box-shadow:0 0 10px rgba(19,160,111,.95)"></div>', iconSize:[16,16], iconAnchor:[8,8] }) }).addTo(map);
  gpsPin.setOpacity(0);
  /* 点地图任意位置 → 查该点地表海拔 + 当天天气 */
  map.on('click', function(e){
    if (window.__annotate) { window.__annotate(e); return; }   // 标注模式下，左键 = 选点标注
    var lat=e.latlng.lat, lng=e.latlng.lng;
    altPin.setLatLng([lat,lng]).setOpacity(1);
    var geo = (!satOn && !TW_BOX(lat,lng)) ? gcj2wgs(lat,lng) : [lat,lng];   // 海拔/天气 API 用标准坐标（台湾瓦片本就是 WGS）
    altShow('🗺️ 该点海拔查询中…', false);
    var altTxt = '📍 海拔查询失败', wxTxt = '';
    function showAltCard(){ altShow(altTxt + (wxTxt ? '<br>' + wxTxt : ''), 3000); }
    altFetch(geo[0],geo[1]).then(function(res){
      altTxt = '📍 该点地表海拔 <b>'+Math.round(res.elevation)+' 米</b><br><small>来源 '+res.source+' · '+geo[0].toFixed(4)+', '+geo[1].toFixed(4)+'</small>';
      showAltCard();
    }).catch(function(){ altTxt = '📍 海拔查询失败（网络或数据源不可达）'; showAltCard(); });
    wxFetch(geo[0],geo[1]).then(function(w){ wxTxt = wxToday(w); showAltCard(); }).catch(function(){ /* 天气失败不影响海拔 */ });
  });
  /* GPS 实测当前海拔 + 移动速度（持续跟踪：点一下开始、再点停止） */
  var gpsWatch = null, spdSamples = [], gpsRunning = false;
  function fmtSpeed(ms){ return (ms==null || isNaN(ms)) ? '—' : (ms*3.6).toFixed(1); }
  /* GPS 拿不到高度时的兜底：用定位经纬度查地表高程（8 秒内不重复查） */
  var fallbackLast = 0, fallbackBusy = false;
  function tryFallback(lat, lng){
    if(fallbackBusy) return;
    var now = Date.now();
    if(now - fallbackLast < 8000) return;
    fallbackLast = now; fallbackBusy = true;
    altFetch(lat,lng).then(function(res){
      fallbackBusy = false;
      altShow('📡 GPS 未返回高度，按你所在位置地面海拔约 <b>' + Math.round(res.elevation) + ' 米</b><br><small>（不含楼层）</small>', 'live');
    }).catch(function(){
      fallbackBusy = false;
      altShow('📡 海拔未获取（GPS 高度不可用，且地面海拔查询失败）', 'live');
    });
  }
  document.getElementById('btnSat').addEventListener('click', toggleSat);
  document.getElementById('btnGps').addEventListener('click', function(){
    var btn = document.getElementById('btnGps');
    if(gpsRunning){   /* 再点一次 → 停止 */
      navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null;
      gpsRunning = false; spdSamples = [];
      btn.innerHTML = '📡 海拔'; btn.title = 'GPS 测当前海拔与移动速度';
      altShow('⏹ 已停止定位', true);
      return;
    }
    if(!('geolocation' in navigator)){ altShow('📡 当前浏览器不支持定位', true); return; }
    gpsRunning = true; spdSamples = [];
    btn.innerHTML = '⏹ 停止'; btn.title = '点击停止定位';
    altShow('📡 定位中…请到开阔室外并移动以测速', 'live');
    gpsWatch = navigator.geolocation.watchPosition(function(pos){
      var lat = pos.coords.latitude, lng = pos.coords.longitude;
      var alt = pos.coords.altitude, spd = pos.coords.speed;
      var acc = pos.coords.accuracy, altAcc = pos.coords.altitudeAccuracy;
      gpsPin.setLatLng((!satOn && !TW_BOX(lat,lng)) ? wgs2gcj(lat,lng) : [lat,lng]).setOpacity(1);
      if(spd != null && !isNaN(spd)){ spdSamples.push(spd); if(spdSamples.length > 200) spdSamples.shift(); }
      var avg = spdSamples.length ? spdSamples.reduce(function(a,b){return a+b;},0)/spdSamples.length : null;
      var max = spdSamples.length ? Math.max.apply(null, spdSamples) : null;
      var speedLine = '时速 <b>'+fmtSpeed(spd)+' 公里/时</b>' +
        (avg != null ? '<br><small>平均 '+fmtSpeed(avg)+' · 最高 '+fmtSpeed(max)+' 公里/时</small>' : '');
      var accTxt = '水平±'+(acc ? Math.round(acc)+' 米' : '未知') + (altAcc ? ' · 垂直±'+Math.round(altAcc)+' 米' : '');
      if(alt != null && !isNaN(alt)){
        altShow('📡 海拔 <b>'+Math.round(alt)+' 米</b><br>'+speedLine+'<br><small>'+accTxt+'</small>', 'live');
      } else {
        /* GPS 高度不可用 → 提示并自动查所在位置地面海拔兜底 */
        altShow('📡 海拔 未获取（正在查所在位置地面海拔…）<br>'+speedLine, 'live');
        tryFallback(lat, lng);
      }
    }, function(err){
      gpsRunning = false; if(gpsWatch){ navigator.geolocation.clearWatch(gpsWatch); gpsWatch = null; }
      btn.innerHTML = '📡 海拔'; btn.title = 'GPS 测当前海拔与移动速度';
      var m = err.code===1 ? '用户拒绝了定位授权' : (err.code===2 ? 'GPS 信号弱，请到室外' : '定位失败');
      altShow('📡 '+m+'（代码 '+err.code+'）', true);
    }, { enableHighAccuracy:true, maximumAge:0 });
  });
  /* 「点查」按键已移除：点地图任意位置即可查该点海拔 + 天气（引导提示） */
  setTimeout(function(){ altShow('💡 点地图任意位置查看海拔+天气 · 顶部 📡 测当前位置海拔', false); }, 2600);
  /* 景点弹窗内补充显示该景点海拔 + 天气（今天 + 7天折叠） */
  map.on('popupopen', function(e){
    var el = e.popup && e.popup.getElement();
    if(!el) return;
    var pals = el.querySelectorAll('.pal');
    pals.forEach(function(p){
      // 库内已带海拔的景点（十大高峰等）：直接用内置值，不再点查、更不许被覆盖成「未知」
      if(p.dataset.lat === undefined || p.dataset.lng === undefined) return;
      var lat=+p.dataset.lat, lng=+p.dataset.lng;
      if(isNaN(lat) || isNaN(lng)){ p.innerHTML = '🏔️ 海拔：查询中…'; return; }
      altFetch(lat,lng).then(function(res){
        p.innerHTML = '🏔️ 海拔：<b>'+Math.round(res.elevation)+' 米</b> <small>（地表高程）</small>';
      }).catch(function(){ p.innerHTML = '🏔️ 海拔：查询失败'; });
    });
    var wxs = el.querySelectorAll('.wx');
    wxs.forEach(function(w){
      var lat=+w.dataset.lat, lng=+w.dataset.lng;
      wxFetch(lat,lng).then(function(wj){
        w.innerHTML = wxToday(wj) + ' <span class="wxmore">[7天▾]</span>';
        var box = w.parentElement.querySelector('.wxweekbox');
        if(box){ box.innerHTML = wxWeek(wj); box.style.display = 'none'; }
        w.onclick = function(ev){ if(box){ ev.stopPropagation(); box.style.display = (box.style.display === 'block') ? 'none' : 'block'; } };
      }).catch(function(){ w.innerHTML = '🌤️ 天气：查询失败'; });
    });
  });


  function shortProv(n) {
    return n.replace('壮族自治区', '').replace('回族自治区', '').replace('维吾尔自治区', '').replace(/省|市|自治区|特别行政区/g, '');
  }
  function divIcon(html, size, lift) {
    const dy = lift || 0;   // lift>0：图标整体上移，给底图自带的景点文字让位（圆圈悬在文字上方，绝不盖字）
    // 弹窗不再紧贴圆圈：在圆圈上方再抬 POPUP_LIFT，留出空档看清底图上的景点名称
    return L.divIcon({ className: '', html: html, iconSize: [size, size], iconAnchor: [size / 2, size / 2 + dy], popupAnchor: [0, -size / 2 - dy - POPUP_LIFT] });
  }
  // 景点圆圈相对坐标点的上移量（px）：底图的景点文字画在坐标点附近，圆圈必须悬在文字上方
  const ICON_LIFT = 14;
  // 弹窗相对圆圈上缘的额外抬高量（px）：用户要求约 3 厘米空档，方便看清景点名称
  const POPUP_LIFT = 110;
  // 挂在县市名后面的可点数字，如「林州市 (171)」
  function pcnHtml(pc) {
    return ' <em class="pc-n" title="点击查看该地的 ' + pc.n + ' 张照片">(' + pc.n + ')</em>';
  }

  // 单击直接点亮（不飞行、地图保持，便于连续点亮）
  function doToggleCity(name) {
    const fp = state.footprint;
    const pref = CITIES.find(c => c.name === name);
    if (pref) {
      // 地级市 / 直辖市：整体点亮或取消（不带动下属县，也不吞并它们）
      const subs = countyOfCity[name] || [];
      Footprint.togglePrefecture(fp, name, subs);
    } else {
      // 县 / 县级市：独立点亮。★ 原先这里有一句「所属市已点亮就直接 return」——
      // 静默无反应，且点亮市会把下属县记录一并删掉，导致这些小地方再也点不动。
      // 按规则「大的不能带动小的」，点市不影响县，县永远可以单独点亮/取消。
      Footprint.toggleCity(fp, name);
    }
    save(); refreshMarkers(); renderFoot();
  }
  function doToggleSpot(sp) {
    Footprint.markSpot(state.footprint, sp, spotUnitName(sp));
    save(); refreshMarkers(); renderFoot();
  }
  // 官方景点标记：可拖拽调位置，右键改名（位置调整存 posOverrides，卫星图模式下自动做坐标反算）
  function bindSpotEdit(m, sp) {
    m.on('contextmenu', (e) => openMkMenu(e, sp, false));
    m.on('dragend', () => {
      const ll = m.getLatLng();
      const g = toStore(ll.lat, ll.lng);   // 台湾存 WGS、大陆存 GCJ，与 disp 同一套判定
      uiPrompt('把「' + dispName(sp) + '」保存到新位置？', '', (ok) => {
        if (!ok) { refreshMarkers(); return; }   // 取消：弹回原位
        posOverrides[sp.id] = { lat: g[0], lng: g[1] };
        saveMyData(); refreshMarkers();
      });
    });
  }
  /* ---------- 👣 足迹省级色块（2026-10-06，规格用户逐条拍板）----------
     仅「👣足迹」板块 + 地图模式（卫星不画）+ z4/z5：给当前查看成员点亮过
     任一市/县的省份整块上色（该成员代表色）。
     ★ 级别范围与省名标注严格对齐（2026-10-06 二次反馈）：省名只在 z4/z5 有，
       z6 既无省名、底图也不印省名 → 有颜色也对不上是哪省，故 z6 不再变色。
     · 未去过的省一律不画；省名/省界维持现状（底图 + 既有省级注记），不加不减；
     · 港澳同其他省一样画（用户：别管大小）；台湾省正常画；
     · 数据 prov_bounds.js = 阿里 DataV 官方省级边界（与高德同源 GCJ-02，
       adcode/省名与 data_bundle 逐条一致），坐标 2 位小数 ≈1.1km（z4/z5 下不足 1 像素）；
     · 性能：签名比对 —— 平移（moveend）时地图动了但要素没变 → 跳过重建；
       只有缩放级别 / 成员 / 点亮集合 / 模式变化才真正重建。 */
  let provFillSig = null;
  let PROV_BOUNDS_BY_NAME = null;
  function renderProvFill() {
    const z = map.getZoom();
    const on = (curTab === 'foot' && !satOn && (z === 4 || z === 5) && window.PROV_BOUNDS);
    if (!on) {
      if (provFillSig !== null) { provFillSig = null; provFillLayer.clearLayers(); }
      return;
    }
    const st = state.footprint;
    const rec = st.visits[st.active];
    const mem = st.members.find(m => m.id === st.active);
    const color = (mem && mem.color) || '#e05d6b';
    const names = [];
    if (rec) rec.cities.forEach(n => { const p = cityProv[n]; if (p && names.indexOf(p) < 0) names.push(p); });
    names.sort();
    const sig = [st.active, color, z, names.join(',')].join('|');
    if (sig === provFillSig) return;
    provFillSig = sig;
    if (!PROV_BOUNDS_BY_NAME) {
      PROV_BOUNDS_BY_NAME = {};
      Object.keys(window.PROV_BOUNDS).forEach(k => { PROV_BOUNDS_BY_NAME[window.PROV_BOUNDS[k].n] = window.PROV_BOUNDS[k]; });
    }
    provFillLayer.clearLayers();
    // 浓淡（2026-10-06 二次反馈「颜色都淡了，不够显眼，都加深点」）：
    //   旧值 z5=10% / z6=15% → 现 z4=22% / z5=26%，描边同步加浓加粗，一眼可辨。
    const fillOp = (z === 4) ? 0.22 : 0.26;
    names.forEach(pn => {
      const f = PROV_BOUNDS_BY_NAME[pn];
      if (!f) return;
      f.p.forEach(poly => {
        provFillLayer.addLayer(L.polygon(
          poly.map(ring => ring.map(c => [c[1], c[0]])),
          { stroke: true, color: color, weight: 1.6, opacity: 0.8,
            fillColor: color, fillOpacity: fillOp, interactive: false, noClip: true }
        ));
      });
    });
  }
  // 只读诊断出口（与 window.__map 同款模式）：色块图层数 / 颜色 / 当前签名
  window.__provFillInfo = function () {
    const ls = provFillLayer.getLayers();
    const l0 = ls.length ? ls[0].options : null;
    return { n: ls.length, color: l0 ? l0.fillColor : null, fillOp: l0 ? l0.fillOpacity : null,
             strokeOp: l0 ? l0.opacity : null, weight: l0 ? l0.weight : null,
             sig: provFillSig, z: map.getZoom(), sat: satOn, tab: curTab };
  };
  function refreshMarkers() {
    map.closePopup();
    provLayer.clearLayers(); cityLayer.clearLayers(); spotLayer.clearLayers();
    const z = map.getZoom();
    // 16 级起底图出现同名注记：把我们的名称标签切到圆点右侧（样式见 body.zhi 规则）
    document.body.classList.toggle('zhi', z >= 16);
    document.body.classList.toggle('z18', z >= 18);   // 18 级底图注记最密：名称再往左上错开，把原图名称完全让出来
    const vb = map.getBounds().pad(0.5);   // 视野裁剪盒（含缓冲），只渲染可见区域
    /* ★ 足迹可见性总开关（用户明确要求，2026-10-02）——
       「点亮」只在「👣 足迹」版块成立；景点 / 行程 / 照片 / 卫星等其它版块一律按
       「无足迹」渲染：lit 为空对象、isDone 恒为 false，下面所有依赖它的标记
       （省级 n 城、城市红飞机、下属县红三角、无景点县兜底红飞机、景点红圈 / 白飞机、
        景点叠放提权）便自动退回中性外观，无需逐处判断。
       原先这些判定写死在公共渲染里，导致任何版块都能看到点亮痕迹。 */
    const FP_ON = (curTab === 'foot');
    /* ★ 世界板块只读开关（用户 2026-10-03 拍板）：🌍世界 里中国部分与「景点」显示完全一致，
       但整板块只读浏览 —— 不弹卡、不联动、不可拖拽、无右键菜单，行程 / 足迹图层一律不进。
       下文所有 bindPopup / bindCity / bindPhotoCity / bindSpotEdit / draggable 都受它约束。 */
    const WORLD_RO = (curTab === 'world');
    const isDone = sp => FP_ON && Footprint.isSpotDone(state.footprint, sp);
    const lit = FP_ON ? Footprint.litMap(state.footprint) : {};
    const footMode = FP_ON;   // 足迹 tab：单击即点亮
    // 本轮已由「县级点层」画过的地名：供有照片的市辖区补点、高缩放兜底去重，避免同一地名叠两层
    const countyDrawn = new Set();
    const HIT = 30;                              // 统一命中区，视觉再小也容易点中
    const hitWrap = inner => `<div style="width:${HIT}px;height:${HIT}px;display:flex;align-items:center;justify-content:center">${inner}</div>`;
    const PLANE = px => `<svg class="plane" width="${px}" height="${px}" viewBox="0 0 24 24"><path fill="#fff" d="M21 16v-2l-8-5V3.5C13 2.67 12.33 2 11.5 2S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5L21 16z"/></svg>`;
    const MTN = px => `<svg class="mtn" width="${px}" height="${px}" viewBox="0 0 24 24"><path d="M12 1 L23 23 H1 Z" fill="#7a5230"/><path d="M12 1 L18.5 23 H5.5 Z" fill="#ffffff"/><path d="M12 7 L16 23 H8 Z" fill="#b9d3e8"/></svg>`;
    function bindCity(m, c, isLit, vis) {
      if (footMode) m.on('click', function () { doToggleCity(c.name); linkToLeft('city', c.name); });
      else { m.bindPopup(cityPop(c, isLit, vis)); m.on('click', function () { linkToLeft('city', c.name); }); }
    }
    // 有照片的县市标记：点数字（或非足迹模式下点整个标记）→ 右侧滑出该地照片
    function bindPhotoCity(m, c) {
      m.on('click', function (e) {
        const t = e.originalEvent && e.originalEvent.target;
        const onNum = !!(t && t.classList && t.classList.contains('pc-n'));
        if (onNum || !footMode) { openPhotoPanel(c.name); return; }
        doToggleCity(c.name); linkToLeft('city', c.name);
      });
    }

    // 山峰：任何缩放级别都渲染并置顶（不被景点/城市圆点覆盖）
    AT.filter(sp => sp.cat === 11 && z >= 6 && vb.contains(disp(spotLat(sp), spotLng(sp)))).forEach(sp => {
      const done = isDone(sp);
      const wantNm = !!showTextOverrides[sp.id];   // 默认不带文字（底图有字）；右键「补文字」才显示
      // 十大高峰：海拔默认常显（底图没有海拔数字，不会与底图注记打架）；名称仍按老规矩默认不显示
      const altTxt = sp.alt ? fmtAlt(sp.alt) + '米' : '';
      const nm = (wantNm || altTxt)
        ? `<div class="mk-name ${done ? '' : 'w'}">` + (wantNm ? dispName(sp) : '') + (altTxt ? `<i>${altTxt}</i>` : '') + `</div>`
        : '';
      const inner = `<div class="spot-marker mt${done ? ' done' : ''}" style="width:27px;height:27px"><b>山</b>${nm}</div>`;
      const m = L.marker(disp(spotLat(sp), spotLng(sp)), { icon: divIcon(hitWrap(inner), 34, ICON_LIFT), zIndexOffset: 5000, draggable: !WORLD_RO });
      if (!WORLD_RO) {
        bindSpotEdit(m, sp);
        if (footMode) m.on('click', function () {
          doToggleSpot(sp);
          linkToLeft('city', spotUnitName(sp));
        });
        else { m.bindPopup(spotPop(sp), { autoPan: false }); m.on('click', function () { linkToLeft('spot', sp.id); }); }
      }
      spotLayer.addLayer(m);
    });
    if (z <= 5) {
      if (z >= 4) {
        /* ★ 省级注记 v2（用户 2026-10-03 二次反馈后重做）——
           旧方案（质心锚点 + 视野内贪心错位）实测两处翻车：新疆的市县绿洲全在
           盆地边缘，质心被拽出腹地；上海被错位逻辑推出自己的边界、压到浙江。
           现改为：
           ① 每省一个**人工核定的地理中心锚点**（见 PROV_LABEL_CFG，逐一对照省界
             核过，全部在界内），标签在锚点居中，**彻底取消贪心错位**——
             宁可相邻标签偶有轻微贴近，也绝不把字挪出省界；
           ② z5 不再给直辖市与港澳加名：高德底图这两级已自带同名注记，再画就是
             一地两名；z4 底图无城市名 → 直辖市 / 港澳仍显示；
           ③ 字号分档（以「完全落在省界内」为前提）：
             z4 统一小字；z5 边界特大的省（新/藏/蒙/青/黑/川/滇）放大字号、
             放宽字距，其余省份常规字号，小省级单位维持最小档。 */
        const z5 = (z >= 5);
        const FS = { xl: [12, 17], lg: [12, 14], sm: [10, 11] };   // 各档字号 [z4, z5]
        /* 字距（用户 2026-10-03：省名字间拉开如「新 疆」，与底图紧排的省会名明显区分）。
           text-indent 抵消 letter-spacing 在末字后多出的一份，保证居中不偏。 */
        const LS = { xl: [6, 12], lg: [4, 8], sm: [2, 4] };
        PROVS.forEach(pr => {
          const cfg = PROV_LABEL_CFG[pr.name];
          if (!cfg) return;                                        // 未配置锚点：宁可不显示，也不放错位置
          if (z5 && PROV_NO_LABEL_Z5.has(pr.name)) return;         // 直辖市 / 港澳：底图已有，不重名
          const a = (!z5 && cfg.a4) ? cfg.a4 : cfg.a;              // 个别省 z4 / z5 分锚点（河北）
          const fs = FS[cfg.cls][z5 ? 1 : 0];
          const lsp = cfg.v ? 0 : LS[cfg.cls][z5 ? 1 : 0];
          const litN = countProvLit(pr.name, lit);
          const sub = litN ? `<i class="pl-n">${litN} 城</i>` : '';
          const nm = cfg.v ? shortProv(pr.name).split('').join('<br>') : shortProv(pr.name);
          const spSt = `display:inline-block;letter-spacing:${lsp}px;text-indent:${lsp}px;${cfg.v ? 'line-height:1.15;' : ''}`;
          const m = L.marker(disp(a[1], a[0]), {
            icon: L.divIcon({
              className: '',
              html: `<div class="prov-label" style="font-size:${fs}px"><span style="${spSt}">${nm}</span>${sub}</div>`,
              iconSize: [0, 0], iconAnchor: [0, 0], popupAnchor: [0, -18]
            })
          });
          if (!WORLD_RO) { m.bindPopup(provPop(pr, litN)); m.on('click', function () { linkToLeft('prov', pr.name); }); }
          provLayer.addLayer(m);
        });
      }
    } else if (z <= 7) {
      CITIES.forEach(c => {
        if (!vb.contains(disp(c.center[1], c.center[0]))) return;
        const fullLit = !!lit[c.name];
        const subN = (countyOfCity[c.name] || []).filter(n => lit[n]).length;
        let isLit = false, inner = '', vis = '';
        if (fullLit) {
          isLit = true; vis = memberName(lit[c.name][0]);
          inner = `<div class="city-marker lit" style="width:30px;height:30px;position:relative">${PLANE(17)}<div class="mk-name">${c.name}</div></div>`;
        } else if (subN > 0) {
          vis = `下属 ${subN} 个县/市有足迹`;
          inner = `<div class="city-marker partial" style="width:30px;height:30px;position:relative">${PLANE(17)}<div class="mk-name w" style="display:none">${c.name}</div></div>`;
        } else {
          inner = `<div class="city-marker normal" style="width:13px;height:13px"><div class="mk-name w" style="display:none">${c.name}</div></div>`;
        }
        const m = L.marker(disp(c.center[1], c.center[0]), { icon: divIcon(hitWrap(inner), HIT), zIndexOffset: 1000 });
        bindCity(m, c, isLit, vis);
        cityLayer.addLayer(m);
      });
      // 新疆/西藏/青海/内蒙古的景点从 6 级起全部提前显示（含名称）：
      // 西部景区间距大，6-7 级全国视图下提前露出，8 级起与常规景点层自然合流。
      // 名山(cat 11)已在上面的山峰块渲染，这里不重复。
      if (z >= 6) {
        AT.filter(sp => sp.cat !== 11 &&
            ['新疆', '西藏', '青海', '内蒙古'].some(p => sp.province.indexOf(p) >= 0) &&
            vb.contains(disp(spotLat(sp), spotLng(sp)))).forEach(sp => {
          const done = isDone(sp);
          const lv = sp.level;
          const is5 = lv === '5A', is4 = lv === '4A', isHot = lv === 'hot' || sp.cat === 'hot';
          const sz = is5 ? 27 : is4 ? 24 : isHot ? 22 : 18;
          const cls = is5 ? 'a5' : isHot ? 'hot' : is4 ? 'a4' : (done ? 'lit' : 'normal');
          const lvNum = is5 ? '<b>5</b>' : isHot ? '<b style="font-size:11px">景</b>' : is4 ? '<b>4</b>' : '';
          const nm = showTextOverrides[sp.id] ? `<div class="mk-name ${done ? '' : 'w'}">${dispName(sp)}</div>` : '';
          // 5A / 热门点亮后仍显示级别字符（转红），只有普通景点保留白色飞机
          const glyph = (done && !is5 && !isHot) ? PLANE(is4 ? 14 : 12) : lvNum;
          const inner = `<div class="spot-marker ${cls}${done ? ' done' : ''}" style="width:${sz}px;height:${sz}px">${glyph}${nm}</div>`;
          const m = L.marker(disp(spotLat(sp), spotLng(sp)), { icon: divIcon(hitWrap(inner), Math.max(HIT, sz + 2), ICON_LIFT), zIndexOffset: 0, draggable: true });
          bindSpotEdit(m, sp);
          if (footMode) m.on('click', function () { doToggleSpot(sp); linkToLeft('city', spotUnitName(sp)); });
          else { m.bindPopup(spotPop(sp), { autoPan: false }); m.on('click', function () { linkToLeft('spot', sp.id); }); }
          spotLayer.addLayer(m);
        });
      }
    } else {
      /* 8 级及以上：地级市 + 县级同层显示（照片标记也挂在这一层）。
         ★ 县级点 8 级起全程显示 ——
           左侧列表点一个县城会飞到 10 级，这一档若不画县级点，飞过去就没有可点的对象，
           这正是「小县城很难点亮」的直接原因。
           （原第三档条件是 `z === -1`，是死代码：等于 8 级以后全县级点消失。）
         ★ 地级市点同样 8 级起全程显示（原条件是 `if (z <= 8)`，9 级起整层收起）—— 后果有二：
           ① 左侧列表点一个城市（flyCity）恰好飞到 9 级，收起后飞过去无点可点；
           ② 站在县城级别（10 级）想点亮它所属的地级市（如太原市）也无处可点。
         ★ 9 级起未点亮市点随点显示名称：未点亮市点只有 15px 且名称默认隐藏，
           用户只能去认底图注记，而底图文字是**不可交互**的 —— 点上去毫无反应，
           这正是「太原市点不亮、像是被景字挡住」的观感来源。
           （实测视野内地级市数量：8 级 23~39 个太密故不显示名称，9 级 8~15 个、10 级 3~4 个，密度可接受。） */
      const CITY_NM = z >= 9;   // 9 级起底图已铺满市名，我们的市点必须自带名称才找得到
      CITIES.forEach(c => {
        if (!vb.contains(disp(c.center[1], c.center[0]))) return;
        const pc = photoOn ? photoUnits[c.name] : null;
        const fullLit = !!lit[c.name];
        const subN = (countyOfCity[c.name] || []).filter(n => lit[n]).length;
        const isLit = fullLit;
        const vis = isLit ? memberName(lit[c.name][0]) : (subN > 0 ? `下属 ${subN} 个县/市有足迹` : '');
        let inner;
        if (isLit) {
          inner = `<div class="city-marker lit" style="width:30px;height:30px;position:relative">${PLANE(17)}<div class="mk-name${pc ? ' w' : ''}">${c.name}${pc ? pcnHtml(pc) : ''}</div></div>`;
        } else if (pc) {
          inner = `<div class="city-marker ph" style="width:16px;height:16px;position:relative"><div class="mk-name w cnm">${c.name}${pcnHtml(pc)}</div></div>`;
        } else if (subN > 0) {
          // 红色三角（本级未点亮、下属县市有足迹）用 clip-path 画的，会连带裁掉子元素，
          // 所以名称必须放在外层容器里 —— 否则「悬停显示名称」这条规则一直是失效的。
          inner = `<div class="cm-hold" style="position:relative;width:30px;height:30px">`
                + `<div class="city-marker partial" style="position:absolute;left:0;top:0;width:30px;height:30px">${PLANE(17)}</div>`
                + `<div class="mk-name w cnm"${CITY_NM ? '' : ' style="display:none"'}>${c.name}</div></div>`;
        } else {
          inner = `<div class="city-marker normal" style="width:15px;height:15px;position:relative"><div class="mk-name w cnm"${CITY_NM ? '' : ' style="display:none"'}>${c.name}</div></div>`;
        }
        const m = L.marker(disp(c.center[1], c.center[0]), { icon: divIcon(hitWrap(inner), HIT), zIndexOffset: 1000 });
        if (!WORLD_RO) { if (pc) bindPhotoCity(m, c); else bindCity(m, c, isLit, vis); }
        cityLayer.addLayer(m);
      });
      // ★ 县级点：8 级起全程显示（原先 9 级起整层消失 → 从列表飞进来的县城点不到）
      const NAME_GRID2 = 130;
      const usedNm2 = new Set();
      COUNTIES.forEach(c => {
        const pc = photoOn ? photoUnits[c.name] : null;
        // 市辖区不单独成点；例外：有照片的单位（如长乐区）照常显示
        if (isDistrictName(c.name) && !pc) return;
        if (!vb.contains(disp(c.center[1], c.center[0]))) return;
        countyDrawn.add(c.name);   // 供「有照片的市辖区补点」与高缩放兜底去重
        const isLit = !!lit[c.name];
        const n = (byCity[c.name] || []).length;
        const base = isLit ? 28 : (n ? 12 : 9);
        let litNm = false;
        if (isLit) {
          const pp = map.latLngToContainerPoint(disp(c.center[1], c.center[0]));
          const k = Math.floor(pp.x / NAME_GRID2) + ',' + Math.floor(pp.y / NAME_GRID2);
          if (!usedNm2.has(k)) { usedNm2.add(k); litNm = true; }
        }
        let inner;
        if (isLit) {
          inner = `<div class="city-marker lit" style="width:28px;height:28px;position:relative">${PLANE(16)}<div class="mk-name${pc ? ' w' : ''}" ${litNm ? '' : 'style="display:none"'}>${c.name}${pc ? pcnHtml(pc) : ''}</div></div>`;
        } else if (pc) {
          inner = `<div class="city-marker ph" style="width:16px;height:16px;position:relative"><div class="mk-name w">${c.name}${pcnHtml(pc)}</div></div>`;
        } else {
          inner = `<div class="city-marker normal" style="width:${base}px;height:${base}px">${n ? '·' : ''}<div class="mk-name w" style="display:none">${c.name}</div></div>`;
        }
        const m = L.marker(disp(c.center[1], c.center[0]), { icon: divIcon(hitWrap(inner), HIT) });
        if (!WORLD_RO) {
          if (pc) bindPhotoCity(m, c);
          else bindCity(m, c, isLit, isLit ? lit[c.name].map(id => memberName(id)).join('、') : '');
        }
        cityLayer.addLayer(m);
      });
      // 9 级及以上：市点收起后，只补「县级点层没画过」的有照片单位（主要是市辖区，
      // 如长乐区／海淀区），否则放大一级后 (张数) 会突然消失。
      if (z > 8 && photoOn) {
        Object.keys(photoUnits).forEach(function (name) {
          const pc = photoUnits[name];
          const ctr = cityCenter[name];
          if (!ctr) return;
          if (countyDrawn.has(name)) return;
          if (!vb.contains(disp(ctr[1], ctr[0]))) return;
          const inner = `<div class="city-marker ph" style="width:16px;height:16px;position:relative"><div class="mk-name w">${name}${pcnHtml(pc)}</div></div>`;
          const m = L.marker(disp(ctr[1], ctr[0]), { icon: divIcon(hitWrap(inner), HIT), zIndexOffset: 1200 });
          if (!WORLD_RO) bindPhotoCity(m, { name: name, center: ctr });
          cityLayer.addLayer(m);
        });
      }
      // 圆圈只挂图标，不带文字（底图有景点文字）；只有右键「补文字」过的才显示我方文字
      const spots = AT.filter(sp => vb.contains(disp(spotLat(sp), spotLng(sp))));
      spots.sort((x, y) => {
        // 叠放提权同样只在足迹版块生效（非足迹版块 isDone 恒 false，排序权重退回纯等级/类别）
        const rx = ((x.cat === 11 ? 5 : x.level === '5A' ? 4 : x.level === '4A' ? 3 : x.level === '3A' ? 2 : 1)) * 10 + (isDone(x) ? 100 : 0);
        const ry = ((y.cat === 11 ? 5 : y.level === '5A' ? 4 : y.level === '4A' ? 3 : y.level === '3A' ? 2 : 1)) * 10 + (isDone(y) ? 100 : 0);
        return ry - rx;
      });
      spots.forEach(sp => {   // 所有景点（含 5A）一直显示到 18 级
        if (sp.cat === 11) return;   // 山峰已在独立块渲染，避免重复
        const done = isDone(sp);
        const isMt = false;
        const lv = sp.level;
        const is5 = lv === '5A', is4 = lv === '4A', is3 = lv === '3A', isHot = lv === 'hot' || sp.cat === 'hot';
        // 山峰 26px 山峰图标；景点 1.5 倍圆点级别数字：5A 27px / 4A 24px / 3A 21px / 普通 18px
        const sz = isMt ? 32 : is5 ? 27 : isHot ? 22 : is4 ? 24 : is3 ? 21 : 18;
        const cls = isMt ? ('mt' + (done ? ' done' : '')) : ((is5 ? 'a5' : isHot ? 'hot' : is4 ? 'a4' : is3 ? 'a3' : (done ? 'lit' : 'normal')) + (done ? ' done' : ''));
        const rank = isMt ? 5 : is5 ? 4 : sp.level === '4A' ? 3 : sp.level === '3A' ? 2 : 1;
        // 名称：默认完全不显示（利用底图原有文字）；右键「补文字」过的景点才显示
        const nm = showTextOverrides[sp.id] ? `<div class="mk-name ${done ? '' : 'w'}">${dispName(sp)}</div>` : '';
        const lvNum = isMt ? MTN(20) : is5 ? '<b>5</b>' : isHot ? '<b style="font-size:11px">景</b>' : is4 ? '<b>4</b>' : is3 ? '<b>3</b>' : '';
        // 5A / 热门点亮后仍显示级别字符（转红），只有普通景点保留白色飞机
        const glyph = (done && !is5 && !isHot && !isMt) ? PLANE(is4 ? 14 : 12) : lvNum;
        const inner = `<div class="spot-marker ${cls}" style="width:${sz}px;height:${sz}px">${glyph}${nm}</div>`;
        const m = L.marker(disp(spotLat(sp), spotLng(sp)), { icon: divIcon(hitWrap(inner), Math.max(HIT, sz + 2), ICON_LIFT), zIndexOffset: isMt ? 5000 : 0, draggable: !WORLD_RO });
        if (!WORLD_RO) {
          bindSpotEdit(m, sp);
          // 列表第二次点击触发的闪烁：setView 后 moveend 会重建标记，重建时自动补上（否则闪一下就被新元素顶掉）
          if (pendingFlash && pendingFlash.id === sp.id && Date.now() < pendingFlash.until) paintFlash(m);
          if (footMode) m.on('click', function () {
            doToggleSpot(sp);
            linkToLeft('city', spotUnitName(sp));
          });
          else { m.bindPopup(spotPop(sp), { autoPan: false }); m.on('click', function () { linkToLeft('spot', sp.id); }); }
        } else if (pendingFlash && pendingFlash.id === sp.id && Date.now() < pendingFlash.until) {
          paintFlash(m);
        }
        spotLayer.addLayer(m);
      });
    }
    // 高缩放兜底：无景点的点亮县（如固始县）红飞机。
    // ★ 仅在足迹版块绘制：该层读的是原始足迹数据（不走 lit），必须单独受 FP_ON 约束。
    litLayer.clearLayers();
    if (FP_ON && z >= 10) {
      const fp = state.footprint;
      const rec = fp.visits[fp.active];
      if (rec) rec.cities.forEach(cn => {
        const ctr = cityCenter[cn];
        if (!ctr) return;
        if (!vb.contains(disp(ctr[1], ctr[0]))) return;
        if ((byCity[cn] || []).length) return;   // 有景点的已由景点 marker 显示，避免重叠
        if (countyDrawn.has(cn)) return;         // 已由县级点层显示，避免叠两层
        const inner = `<div class="city-marker lit" style="width:28px;height:28px;position:relative">${PLANE(16)}<div class="mk-name">${cn}</div></div>`;
        const m = L.marker(disp(ctr[1], ctr[0]), { icon: divIcon(hitWrap(inner), HIT) });
        if (footMode) m.on('click', function () { doToggleCity(cn); linkToLeft('city', cn); });
        else { m.bindPopup(cityPop({ name: cn }, true, memberName(fp.active))); m.on('click', function () { linkToLeft('city', cn); }); }
        litLayer.addLayer(m);
      });
    }
    // 自建景点跟随缩放/拖动重绘（与 5A / 热门同为 8 级起显示，缩到 8 级以下自动收起）
    renderMySpots();
    // 👣足迹省级色块：跟随本函数的所有触发点（缩放/平移/切板块/切卫星/点亮变化/切成员），
    //   内部有签名比对，平移不动图层；其他级别与其他板块自动清空。
    renderProvFill();
    // 🌍世界板块：世界注记（大洲 / 国家 / 境外城市 + 台湾补齐的县市）随每次重建一起刷新
    if (WORLD_RO) renderWorld();
  }
  /* ---------- 🌍 世界板块（2026-10-04 新增，规格用户逐条拍板）---------- */
  /* 一张图不分家：中国部分走 refreshMarkers 原有渲染（只读化，见 WORLD_RO），
     本节只负责「境外 + 大洲 + 国家 + 台湾补齐县市」的注记渲染与进出板块的视野切换。
     坐标一律 WGS-84 原值、不做 disp() 换算 —— 高德在境外不做 GCJ 偏移、
     ArcGIS 卫星本就是 WGS，两边都零偏移（用户硬指标：卫星里要对得上真实位置）。 */
  function renderWorld() {
    worldLayer.clearLayers();
    const W = window.WORLD_DATA;
    if (!W) return;
    const z = map.getZoom();
    const vb = map.getBounds();
    const put = (html, lng, lat, zo) => {
      worldLayer.addLayer(L.marker([lat, lng], {
        icon: L.divIcon({ className: '', html: html, iconSize: [0, 0], iconAnchor: [0, 0] }),
        zIndexOffset: zo || 0, interactive: false
      }));
    };
    /* 大洲名：仅卫星模式 —— 地图模式 z2-3 高德底图自带「欧洲」等大洲名（实测）。 */
    if (satOn && z < 3.5) {
      W.continents.forEach(co => {
        if (!vb.contains([co.a[1], co.a[0]])) return;
        put('<div class="w-cont"><span>' + co.n + '</span></div>', co.a[0], co.a[1], 150);
      });
    }
    /* 国名：两种模式都画 —— 高德境外瓦片实测不印国名（z4 只有国界线，2026-10-04 取证）。
       big:2 中国/台湾不画（z4 起国内省级注记接管，避免重叠）；
       显示区间 3.5~6.5，z7 起改由首都/城市接棒。 */
    if (z >= 3.5 && z < 6.5) {
      W.countries.forEach(c => {
        if (c.big === 2 || !vb.contains([c.a[1], c.a[0]])) return;
        put('<div class="w-country" style="font-size:' + (c.big === 1 ? 15 : 10.5) + 'px"><span>' + c.n + '</span></div>', c.a[0], c.a[1], 200);
      });
    }
    /* 首都/城市：两种模式都画境外（高德境外瓦片基本不印城市名，z8 实测仅零星）；
       中国/台湾境内跳过 —— 高德境内中文标注齐全，避免重叠。
       首都 z4.5 起（★ 红字）→ 全部城市 z5.5 起；d:1 港澳/台湾六大市在 z≥8
       由国内县级点接管，隐藏世界标签避免一地两名。 */
    if (z >= 4.5) {
      W.countries.forEach(c => {
        if (!c.cc || c.big === 2 || !vb.contains([c.cc[1], c.cc[0]])) return;
        put('<div class="w-city cap">★' + c.cap + '</div>', c.cc[0], c.cc[1], 300);
      });
      W.cities.forEach(c => {
        if (z < 5.5) return;                // 全部城市 6 级起显示（5 级只有首都，避免欧洲一屏过挤）
        if (c.d && z >= 7.5) return;
        if (c.cn === '中国' || c.cn === '台湾') return;
        if (!vb.contains([c.c[1], c.c[0]])) return;
        put('<div class="w-city' + (c.z === 6 ? ' mega' : '') + '">' + c.n + '</div>', c.c[0], c.c[1], 100);
      });
    }
  }
  /* 离开世界：清注记、换回高德路网、恢复最小级别；若人在境外，
     飞回全国（高德境外放大无图，留着空白视野会让人以为地图坏了） */
  function leaveWorld() {
    worldLayer.clearLayers();
    if (map.hasLayer(worldMap)) map.removeLayer(worldMap);   // 高德地图层只在世界板块用
    if (map.hasLayer(osmTile)) map.removeLayer(osmTile);     // 影像层只在世界板块（卫星态）用
    baseTile.addTo(map);                                     // 两态都必须加回国内底图（地图态进世界时被移走了）
    if (satOn) satTile.addTo(map);   // 卫星态回国内：影像换回 satTile（同一张图，保持国内换算语义）
    map.setMinZoom(3);   // 当前若在 2.x 会自动吸附回 3，随后 syncMapToTab 再飞全国
    const c = map.getCenter();
    if (c.lng < 73 || c.lng > 136 || c.lat < 17 || c.lat > 54) {
      map.flyTo([35.6, 105.5], 4, { duration: .6 });   // moveend 会触发 refreshMarkers
    }
  }
  /* 世界板块搜索：国家（含简称/首都）+ 世界城市 + 中国景点 / 自建 / 市县点。
     只飞不弹卡（用户拍板）；国内条目经 disp()、世界条目用 WGS 原值。 */
  const _wsEl = document.getElementById('worldSearch');
  if (_wsEl) _wsEl.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter') return;
    const q = _wsEl.value.trim().toLowerCase();
    const _n = document.getElementById('worldSearchN');
    if (!q) { if (_n) _n.textContent = ''; return; }
    const W = window.WORLD_DATA || { countries: [], cities: [] };
    const has = s => String(s || '').toLowerCase().indexOf(q) >= 0;
    const hits = [];
    W.countries.forEach(c => {
      const inCap = c.cap && has(c.cap);
      if (has(c.n) || has(c.f) || inCap) hits.push({ nm: inCap ? c.cap : c.n, c: inCap ? c.cc : c.a, z: inCap ? 8 : 4, w: 1 });
    });
    W.cities.forEach(c => { if (has(c.n)) hits.push({ nm: c.n, c: c.c, z: 10, w: 1 }); });
    AT.forEach(sp => { if (has(dispName(sp))) hits.push({ nm: dispName(sp), c: [spotLng(sp), spotLat(sp)], z: 13, w: 0 }); });
    mySpots.forEach(sp => { if (has(sp.name)) hits.push({ nm: sp.name, c: [sp.lng, sp.lat], z: 13, w: 0 }); });
    CITIES.forEach(cc => { if (has(cc.name)) hits.push({ nm: cc.name, c: cc.center, z: 9, w: 0 }); });
    COUNTIES.forEach(kc => { if (has(kc.name)) hits.push({ nm: kc.name, c: kc.center, z: 10, w: 0 }); });
    if (_n) _n.textContent = hits.length ? hits.length + ' 个结果' : '无结果';
    if (hits.length) {
      const h = hits[0];
      // 世界条目 c=[lng,lat]（WGS 原值），国内条目 c=[lng,lat]（GCJ，须 disp 换算）
      map.flyTo(h.w ? [h.c[1], h.c[0]] : disp(h.c[1], h.c[0]), h.z, { duration: .8 });
    }
  });

  /* 大洲直达：两级列表 —— 大洲行（洲名 + 国家数）点击展开该国列表并飞过去；
     国家行（国名 + 首都）点击飞到该国。手风琴式：同时只展开一个大洲。 */
  const _wq = document.getElementById('worldQuick');
  if (_wq) {
    const WQ = window.WORLD_DATA;
    _wq.innerHTML = '';
    if (WQ) {
      const cnt = {};
      WQ.countries.forEach(c => { cnt[c.ct] = (cnt[c.ct] || 0) + 1; });
      WQ.continents.forEach(co => {
        const list = WQ.countries.filter(c => c.ct === co.n);
        const row = document.createElement('div');
        row.className = 'wq-cont';
        row.innerHTML = '<span class="wq-name">' + co.n + '</span><span class="wq-n">' +
          (list.length ? list.length + ' 国' : '—') + '</span>';
        const box = document.createElement('div');
        box.className = 'wq-box';
        box.style.display = 'none';
        list.forEach(c => {
          const r = document.createElement('div');
          r.className = 'wq-cty';
          r.innerHTML = '<span class="wq-cty-n">' + c.n + '</span>' +
            (c.cap ? '<span class="wq-cty-cap">' + c.cap + '</span>' : '');
          r.addEventListener('click', function () {
            map.flyTo([c.a[1], c.a[0]], 4, { duration: .8 });   // 国家锚点 WGS 原值
          });
          box.appendChild(r);
        });
        row.addEventListener('click', function () {
          const wasOpen = box.style.display !== 'none';
          _wq.querySelectorAll('.wq-box').forEach(x => { x.style.display = 'none'; });
          _wq.querySelectorAll('.wq-cont').forEach(x => { x.classList.remove('open'); });
          if (!wasOpen) {
            box.style.display = '';
            row.classList.add('open');
            map.flyTo([co.a[1], co.a[0]], 4, { duration: .8 });   // 展开的同时飞到大洲
          }
        });
        _wq.appendChild(row);
        _wq.appendChild(box);
      });
    }
  }

  /* ---------- 地图与左侧双向联动 ---------- */
  // 程序性滚动时间戳：我们自己改 scrollTop 时记一笔，避免被「滚出视野自动收起」误判成用户滚动
  let autoScrollAt = 0;
  function flashCard(el) {
    if (!el) return;
    const box = el.closest('.list');
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    if (box) { autoScrollAt = Date.now(); box.scrollTop = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2; }
  }
  function linkToLeft(type, key) {
    if (type === 'spot') {
      // 右侧点景点 → 左侧景点列表滚动高亮
      if (curTab !== 'spots') switchTab('spots');
      state.curQ = ''; renderSpotList();
      const card = document.querySelector('#spotList .card[data-id="' + key + '"]');
      if (card) flashCard(card);
    } else if (type === 'city') {
      // 右侧点城市/县 → 左侧对应跳转
      if (curTab === 'foot') {
        const row = document.querySelector('#cityFootList .city-row[data-city="' + key + '"]');
        if (row) flashCard(row);
      } else {
        switchTab('spots');
        state.curQ = key; renderSpotList();
      }
    } else if (type === 'prov') {
      // 右侧点省份 → 左侧跳转
      if (curTab === 'foot') {
        const title = Array.from(document.querySelectorAll('.prov-title')).find(t => t.textContent === key);
        if (title) flashCard(title);
      } else {
        switchTab('spots');
        state.curQ = key; renderSpotList();
      }
    }
  }
  function flyProv(name) {
    const pr = PROVS.find(x => x.name === name);
    if (pr) map.flyTo(disp(pr.center[1], pr.center[0]), 6, { duration: .7 });
  }
  function memberName(id) { const m = state.footprint.members.find(x => x.id === id); return m ? m.name : ''; }
  function countProvLit(provName, lit) {
    let n = 0;
    CITIES.filter(c => c.province === provName).forEach(c => { if (cityLit(lit, c.name)) n++; });
    COUNTIES.filter(c => c.province === provName).forEach(c => { if (lit[c.name]) n++; });
    return n;
  }
  /* ★ 省名锚点表 v2（用户 2026-10-03：省名必须以省界为准、不能超出）——
     旧方案用「市县点质心」+「视野内贪心错位」，实测两处翻车：
     新疆的市县绿洲全分布在盆地边缘，质心被拽出腹地；上海被错位逻辑推到浙江地界。
     现改为每省**人工核定的地理中心锚点**（逐一对照省界核对，全部在界内），
     标签在锚点居中、永不挪位。
     cls 字号档：xl=边界特大省（z5 放大字号 + 放宽字距）/ lg=常规 / sm=小省级单位。
     未配置的省不显示（宁缺毋错）。 */
  const PROV_LABEL_CFG = {
    '黑龙江省': { a: [127.6, 47.9], cls: 'xl' },
    '吉林省': { a: [127.0, 42.95], cls: 'lg' },
    '辽宁省': { a: [122.3, 40.7], cls: 'lg' },
    '内蒙古自治区': { a: [113.8, 43.9], cls: 'xl' },
    '新疆维吾尔自治区': { a: [85.6, 41.5], cls: 'xl' },
    '西藏自治区': { a: [87.8, 31.3], cls: 'xl' },
    '青海省': { a: [96.2, 35.6], cls: 'xl' },
    '甘肃省': { a: [100.3, 38.4], cls: 'lg' },
    '宁夏回族自治区': { a: [106.1, 37.0], cls: 'lg' },
    '陕西省': { a: [108.9, 35.7], cls: 'lg' },
    '山西省': { a: [112.5, 36.6], cls: 'lg' },
    '河北省': { a: [116.15, 38.45], a4: [115.5, 37.6], cls: 'lg' },
    '河南省': { a: [113.4, 33.6], cls: 'lg' },
    '山东省': { a: [118.75, 35.85], cls: 'lg' },
    '江苏省': { a: [119.9, 34.15], cls: 'lg' },
    '安徽省': { a: [116.6, 30.85], cls: 'lg' },
    '湖北省': { a: [112.3, 30.9], cls: 'lg' },
    '湖南省': { a: [111.45, 27.6], cls: 'lg' },
    '江西省': { a: [115.7, 27.5], cls: 'lg' },
    '浙江省': { a: [119.7, 29.1], cls: 'lg' },
    '福建省': { a: [117.6, 25.8], cls: 'lg' },
    '广东省': { a: [114.65, 23.95], cls: 'lg' },
    '广西壮族自治区': { a: [108.7, 23.9], cls: 'lg' },
    '贵州省': { a: [107.9, 27.6], cls: 'lg' },
    '云南省': { a: [100.9, 24.7], cls: 'xl' },
    '四川省': { a: [102.0, 30.6], cls: 'xl' },
    '海南省': { a: [109.6, 19.2], cls: 'sm' },
    '重庆市': { a: [107.5, 29.9], cls: 'sm' },
    '北京市': { a: [115.9, 40.5], cls: 'sm' },
    '天津市': { a: [117.6, 38.9], cls: 'sm' },
    '上海市': { a: [121.5, 31.2], cls: 'sm' },
    '台湾省': { a: [120.9, 23.7], cls: 'sm' },
    '香港特别行政区': { a: [114.5, 22.3], v: 1, cls: 'sm' },
    '澳门特别行政区': { a: [113.52, 22.13], v: 1, cls: 'sm' }
  };
  // z5 底图已自带直辖市与港澳的名称注记，再画就是一地两名（用户 2026-10-03）
  const PROV_NO_LABEL_Z5 = new Set(['北京市', '天津市', '上海市', '重庆市', '香港特别行政区', '澳门特别行政区']);

  /* ---------- 弹窗 ---------- */
  // 已核实有淡旺季价差的景区（旺季价/淡季价，斜杠显示）；未列出的景区为全年统一票价
  const LOWSEASON = {
    '故宫博物院': '40元', '九寨沟景区': '80元', '黄龙风景名胜区': '60元',
    '峨眉山景区': '110元', '黄山风景区': '150元', '庐山风景名胜区': '135元',
    '布达拉宫景区': '100元', '南山文化旅游区': '108元'
  };
  function ticketTxt(s) {
    if (s.ticket === '免费') return '免费';
    if (!s.ticket) return '';
    const m = /^旺季(\d+)元(.*)$/.exec(s.ticket);
    if (m && LOWSEASON[s.name]) return '旺季' + m[1] + '元/淡季' + LOWSEASON[s.name] + m[2];
    return s.ticket;
  }
  // ★ 景点弹窗：不再含「标记去过」按钮（用户明确要求，2026-10-02）——
  //   点亮入口统一收归「👣 足迹」版块，景点 / 行程等版块的弹窗只保留「规划此城行程」。
  function spotPop(s) {
    // data-sid：唯一标识这张卡片属于哪个景点，供 openSpotCard 判断「同一张是否已经开着」，避免重复开窗
    return `<div class="pop-card" data-sid="${s.id}">
      <h4>${dispName(s)}${s.cat === 11 ? '<span class="badge mtb">名山</span>' : (s.level === '5A' ? '<span class="badge a5">5A</span>' : (s.level === '4A' ? '<span class="badge">4A</span>' : ''))}</h4>
      <div class="pinfo">📍 ${s.province} · ${Footprint.normCity(s.city)}<br>🎫 ${ticketTxt(s)}　🕘 ${s.open || ''}<br>⏱ 建议游玩 ${s.dur || 3} 小时　⭐ ${s.rating || 4.5}</div>
      <div class="pintro">${s.intro || ''}</div>
      <div class="ptags">${(s.tags || []).map(t => `<span>${t}</span>`).join('')}</div>
      ${s.alt ? `<div class="pal">🏔️ 海拔 <b>${fmtAlt(s.alt)} 米</b></div>` : `<div class="pal" data-lat="${s.lat}" data-lng="${s.lng}">🏔️ 海拔：查询中…</div>`}
      ${wxCardHTML(s.lat, s.lng)}
      <div class="pbtns">
        <button class="go" data-act="goplan" data-city="${Footprint.normCity(s.city)}">规划此城行程</button>
      </div></div>`;
  }
  // ★ 城市弹窗：非足迹版块一律不显示点亮信息，也不再提供「点亮城市 / 取消点亮」按钮。
  function cityPop(c, isLit, vis) {
    const n = (byCity[c.name] || []).length;
    if (curTab !== 'foot') { isLit = false; vis = ''; }
    return `<div class="pop-card"><h4>${c.name}${isLit ? '<span class="badge a5">已点亮</span>' : ''}</h4>
      <div class="pinfo">收录景点 ${n} 个${isLit ? '<br>去过的成员：' + vis : ''}</div>
      <div class="pbtns">
        <button class="go" data-act="goplan" data-city="${c.name}">规划行程</button>
      </div></div>`;
  }
  // ★ 省份弹窗：同理，非足迹版块不显示「已点亮 n 个城市」。
  function provPop(p, litN) {
    if (curTab !== 'foot') litN = 0;
    return `<div class="pop-card"><h4>${p.name}</h4>
      <div class="pinfo">${litN ? '已点亮 ' + litN + ' 个城市' : '点击下方按钮查看全省城市'}</div>
      <div class="pbtns"><button class="go" data-act="zoomin" data-lng="${p.center[0]}" data-lat="${p.center[1]}">查看城市</button></div></div>`;
  }

  /* 卡片自动收起时长（毫秒）：用户要求 3 秒太短、来不及看文字介绍，2026-10-02 改为 6 秒。
     鼠标 / 触摸停在卡片上会暂停计时，移开重新计时。 */
  const POPUP_MS = 6000;
  /* 圆点闪烁时长：与卡片自动收起同步（用户 2026-10-02 要求「弹窗跟着闪的标志一起走」），
     闪烁动画本身的时长在 css/style.css 的 .spot-marker.flash-spot（.6s × 10 次 = 6 秒）。 */
  const FLASH_MS = 6000;
  /* ★ 全局单一定时器（2026-10-02 修）：原来每次 popupopen 各起一个 setTimeout、互不取消，
     而「动画结束后开卡片 + 二次兜底重开」会连开两次 → 第一张的计时器到点后会把
     第二张（真正给你看的那张）一并关掉，实测最后一张只活了 5.3 秒。
     改成共用一个定时器：新卡片打开即取消上一个，卡片一定完整显示 POPUP_MS。 */
  let popupTimer = null;
  function armPopupTimer() {
    clearTimeout(popupTimer);
    popupTimer = setTimeout(function () { map.closePopup(); }, POPUP_MS);
  }
  map.on('popupopen', function (e) {
    const el = e.popup.getElement();
    el.querySelectorAll('[data-act]').forEach(b => {
      b.addEventListener('click', function () {
        const act = b.dataset.act;
        // 注：原 'done'（标记去过）与 'lcity'（点亮城市）两个分支已随按钮一并移除 ——
        // 点亮入口统一在「👣 足迹」版块（见 doToggleCity / doToggleSpot）。
        if (act === 'goplan') {
          switchTab('plan');
          document.getElementById('planCity').value = b.dataset.city;
          map.closePopup();
          if (window.innerWidth <= 768) document.getElementById('panel').classList.add('open');
        } else if (act === 'zoomin') {
          map.flyTo(disp(+b.dataset.lat, +b.dataset.lng), 7, { duration: .6 });
        }
      });
    });
    /* 卡片 6 秒自动收起；鼠标/触摸停留在卡片上则暂停计时，避免来不及点按钮 */
    armPopupTimer();
    var pStop = function(){ clearTimeout(popupTimer); };
    var pGo = function(){
      // 若是已被新卡片取代的旧元素（还在做淡出动画），其事件不得影响新卡片的计时
      if (el !== document.querySelector('.leaflet-popup')) return;
      armPopupTimer();
    };
    el.addEventListener('mouseenter', pStop);
    el.addEventListener('mouseleave', pGo);
    el.addEventListener('touchstart', pStop);
    el.addEventListener('touchend', pGo);
  });
  map.on('moveend', refreshMarkers);   // 缩放/拖动结束才重建（视野裁剪后开销小）

  /* ★ 统一的「开景点卡片」入口（2026-10-02 新增）——
     ① 卡片挂在「地图」而不是标记上：标记每次 moveend 都会被整层重建，挂在标记上的卡片会一并被销毁；
     ② 坐标一律取「手动校正后」的坐标（spotLat/spotLng + disp 换算），与圆点、闪烁位置完全一致；
     ③ data-sid 去重：同一景点的卡片已经开着就不再重开，避免兜底重试把它闪一下；
     ④ 卡片要跟着闪烁的圆点一起出现（用户 2026-10-02 要求），所以二次点击与首次点击都走这里。 */
  function openSpotCard(s, makeHtml) {
    if (!s) return;
    const cur = document.querySelector('.leaflet-popup .pop-card');
    if (cur && cur.dataset && String(cur.dataset.sid) === String(s.id)) return;   // 同一张已开着
    const fn = makeHtml || (typeof spotPop === 'function' ? spotPop : null);
    if (!fn) return;
    try {
      L.popup({ offset: [0, -140], autoPan: false })
        .setLatLng(disp(spotLat(s), spotLng(s)))
        .setContent(fn(s)).openOn(map);
    } catch (e) { /* 忽略瞬时异常，调用方的兜底重试会再来一次 */ }
  }
  // 等视图动画结束后再开卡片：提前开会立刻被 moveend → refreshMarkers → closePopup 关掉。
  // 若视图本来就在该点（不触发 moveend），靠定时器兜底；重复调用会被 openSpotCard 的 data-sid 去重。
  function openSpotCardAfterMove(s, makeHtml) {
    const t0 = Date.now();
    // 加 1.5 秒时效：万一动画没触发 moveend，监听器不能一直挂着 —— 否则等到下一次
    // 用户随意拖动地图时才突然弹出这张早就过期的卡片
    map.once('moveend', () => {
      if (Date.now() - t0 < 1500) setTimeout(() => openSpotCard(s, makeHtml), 60);
    });
    setTimeout(() => openSpotCard(s, makeHtml), 900);
  }
  function flySpot(s) {
    const b = PROV_BOUNDS[s.province];
    if (b) {
      map.fitBounds([[b.minLat, b.minLng], [b.maxLat, b.maxLng]], { padding: [50, 50], duration: .6 });
      // 动画结束后打开景点卡片；若中途被视图刷新关闭则二次兜底重开
      setTimeout(() => openSpotCard(s), 800);
      setTimeout(() => openSpotCard(s), 1700);
    } else if (map.getZoom() < 10) {
      map.flyTo(disp(spotLat(s), spotLng(s)), 10, { duration: .6 });
      setTimeout(() => openSpotCard(s), 800);
    } else {
      map.flyTo(disp(spotLat(s), spotLng(s)), map.getZoom(), { duration: .5 });
      setTimeout(() => openSpotCard(s), 550);
    }
  }
  function flyCity(name) {
    let c = CITIES.find(x => x.name === name);
    let z = 9;
    if (!c) { c = COUNTIES.find(x => x.name === name); z = 10; }
    if (c) map.flyTo(disp(c.center[1], c.center[0]), z, { duration: .6 });
  }

  /* ---------- Tab ---------- */
  const mapHint = document.getElementById('mapHint');
  let curTab = 'spots';
  function showMapHint(html) { mapHint.innerHTML = html; mapHint.classList.add('show'); }
  function hideMapHint() { mapHint.classList.remove('show'); }

  function syncMapToTab(t) {
    hideMapHint();
    var _bs = document.getElementById('btnSat'); if (_bs) _bs.style.display = '';   // 🛰 按钮默认显示
    if (t === 'spots') {
      routeLayer.clearLayers();
      document.getElementById('mapLegend').classList.remove('show');
      refreshMarkers();
    } else if (t === 'plan') {
      let plan = lastPlan;
      if (!plan && state.savedTrips.length) {
        const t0 = state.savedTrips[state.savedTrips.length - 1];
        plan = { city: t0.city, days: t0.days, prefs: t0.prefs, res: t0.res };
      }
      if (plan) {
        // ★ 先按当前版块重绘一次景点 / 城市点（非足迹版块 → 中性外观）。
        //   路线画在独立图层 routeLayer 上，原先这里只清路线层，
        //   从「足迹」版块切过来时，上一次画的红飞机 / 红三角会整片残留。
        refreshMarkers();
        drawRoutes(plan.res);
      } else {
        routeLayer.clearLayers();
        document.getElementById('mapLegend').classList.remove('show');
        refreshMarkers();
        showMapHint('还没有行程<br>请在左侧输入<b>目的地城市</b><br>再点击「自动安排行程」');
      }
    } else if (t === 'foot') {
      routeLayer.clearLayers();
      document.getElementById('mapLegend').classList.remove('show');
      // 全国点亮分布：回到全国省级视图，省级标记会显示点亮城市数
      const c = map.getCenter();
      if (map.getZoom() > 5 || Math.abs(c.lng - 105.5) > 8 || Math.abs(c.lat - 35.6) > 6) {
        map.flyTo([35.6, 105.5], 4, { duration: .6 });  // zoomend 会触发 refreshMarkers
      } else {
        refreshMarkers();
      }
    } else if (t === 'world') {
      /* 🌍世界：行程 / 足迹图层不进（路线层清空、点亮自动失效 FP_ON=false）；
         双模式底图（🛰 按钮切换）**完全独立不叠底**：🗺 地图 = 高德中文路网
         worldMap（境外 z9+ 无数据瓦片退 z8 放大，不掺卫星），🛰 卫星 = 纯影像
         osmTile；两模式零英文。境内 GCJ / 境外 WGS 与存储约定一致，换算同国内。
         fitBounds + 分数级缩放实现「全球一屏」；
         国名/境外首都/城市两模式都由我们画（高德境外不印国名，实测）。 */
      routeLayer.clearLayers();
      litLayer.clearLayers();
      document.getElementById('mapLegend').classList.remove('show');
      if (satOn) map.removeLayer(satTile);   // 国内卫星态进世界：影像改由 osmTile 承担（同一张图）
      map.removeLayer(baseTile);
      if (satOn) {
        if (!map.hasLayer(osmTile)) osmTile.addTo(map);             // 卫星模式
      } else if (!map.hasLayer(worldMap)) {
        worldMap.addTo(map);                                        // 默认地图模式
      }
      map.options.zoomSnap = 0;
      map.setMinZoom(2);
      map.fitBounds([[-70, -179], [78, 179]], { animate: false });
      map.options.zoomSnap = 1;
      // fitBounds 结束触发 moveend → refreshMarkers → renderWorld
    }
  }

  function switchTab(t) {
    const prev = curTab;
    curTab = t;
    if (prev === 'world' && t && t !== 'world') leaveWorld();   // 离开世界：清注记 + 恢复 minZoom
    document.querySelectorAll('#tabs .tab').forEach(x => x.classList.toggle('active', x.dataset.tab === t));
    document.querySelectorAll('.pane').forEach(x => x.classList.toggle('active', x.id === 'pane-' + t));
    setTimeout(() => map.invalidateSize(), 50);
    syncMapToTab(t);
  }
  document.querySelectorAll('#tabs .tab').forEach(t => t.addEventListener('click', () => {
    switchTab(t.dataset.tab);
    if (window.innerWidth <= 768 && t.dataset.tab !== 'plan') document.getElementById('panel').classList.remove('open');
  }));

  /* ---------- 景点列表 + 分类 ---------- */
  function spotScore(s) {
    let v = s.rating * 10;
    if (s.level === '5A') v += 10; else if (s.level === '4A') v += 3;
    return v;
  }
  function levelRank(s) {
    if (s.level === '5A') return 0;
    if (s.level === '4A') return 1;
    if (s.level === '3A') return 2;
    return 3;                       // 未评A（含当地知名景点）排最后
  }
  function spotOrder(a, b) {
    const ra = levelRank(a), rb = levelRank(b);
    if (ra !== rb) return ra - rb;
    return (b.rating || 0) - (a.rating || 0);
  }
  function levelBadge(s) {
    if (s.level === '5A') return '<span class="badge a5">5A</span>';
    if (s.level === '4A') return '<span class="badge">4A</span>';
    if (s.level === '3A') return '<span class="badge b3">3A</span>';
    if (s.level === 'hot' || s.cat === 'hot') return '<span class="badge hot">景</span>';  // 热门：白底紫边紫字，与地图紫圈「景」一致
    if (s.cat === 11) return '<span class="badge mtb">名山</span>';  // 名山：与弹窗徽标同款棕字，列表徽标统一
    return '';
  }
  // 十大高峰：海拔徽标（列表与地图标记同款绿字，一看就是高度）
  // 8848.86 这类小数保留原值（四舍五入成 8849 会失准），整数则不带小数点
  function fmtAlt(a) {
    const v = Math.round(a * 100) / 100;
    return String(v);
  }
  function altBadge(s) {
    return s.alt ? '<span class="badge altb">' + fmtAlt(s.alt) + '米</span>' : '';
  }
  function renderSpotList() {
    let arr = AT.concat(mySpots.map(s => Object.assign({}, s, { my: true, province: mySpotProv(s) })));
    const provMode = state.provMode && state.provMode.length;
    if (provMode) {
      arr = arr.filter(s => state.provMode.includes(s.province));
    } else {
      if (state.curCat) arr = arr.filter(s => s.cat === state.curCat);
      if (state.curQ) arr = arr.filter(s => s.name.includes(state.curQ) || Footprint.normCity(s.city).includes(state.curQ) || s.province.includes(state.curQ) || (s.county || '').includes(state.curQ));
    }
    arr = [...arr].sort(spotOrder);
    const box = document.getElementById('spotList');
    // 重绘前记录「已展开的省份」与滚动位置，重绘后原样恢复。
    // （此前每次改名/新增都重建列表并把所有分组收起、滚动归零，导致看着像"左侧没变"、
    //   并且原位置的卡片消失，用户再点同一处自然没有反应——表现为"第二次改不了"）
    const openProvs = Array.from(box.querySelectorAll('.prov-group')).filter(g => {
      const it = g.querySelector('.prov-items');
      return it && it.style.display !== 'none';
    }).map(g => g.dataset.prov);
    const keepScroll = box.scrollTop;
    const head = provMode ? `<div class="prov-head">🗺 ${state.provMode.join(' · ')} 全部景点 ${arr.length} 个</div>` : '';
    // 按省份分组
    const byProv = {};
    arr.forEach(s => { (byProv[s.province] = byProv[s.province] || []).push(s); });
    const provKeys = Object.keys(byProv).sort();
    let html = head;
    provKeys.forEach(pk => {
      const list = byProv[pk];
      const n5 = list.filter(s=>s.level==='5A').length;
      // 热门「景」与自建「景」分开计数（此前合并成一个 景(n)，无法分辨颜色含义）
      const nHot = list.filter(s=>(s.level==='hot'||s.cat==='hot') && !s.my).length;
      const nMy  = list.filter(s=>s.my).length;
      // 省份标题行配色与地图标记一致：5A 数量洋红、热门数字紫、自建数字蓝；
      // 数量为 0 的标签不显示；两个「景」写成 景(热门+自建)，数字各自上色。
      const n5Tag = n5 ? ' <small class="p5">('+n5+')</small>' : '';
      let jTag = '';
      if (nHot || nMy) {
        const parts = (nHot ? '<i class="jh">'+nHot+'</i>' : '') +
                      ((nHot && nMy) ? '<i class="jp">+</i>' : '') +
                      (nMy ? '<i class="jm">'+nMy+'</i>' : '');
        jTag = ' <small class="pj">景('+parts+')</small>';
      }
      html += '<div class="prov-group" data-prov="'+pk+'"><div class="prov-toggle" style="padding:8px 12px;font-weight:700;background:#f0f0f0;cursor:pointer;margin-top:4px;white-space:nowrap;"><span class="prov-arrow">▸ </span>'+pk+n5Tag+jTag+'</div><div class="prov-items" style="display:none;">' +
        list.map(s => {
          if (s.my) return '<div class="card" data-id="'+s.id+'"><div class="t"><span class="sp-name my-nm"><span class="badge my">景</span>'+s.name+'</span><button class="my-edit" data-edit="'+s.id+'" title="改名">✏️</button><button class="my-del" data-del="'+s.id+'" title="删除此景点">✕</button></div><div class="d">手动添加 · 拖拽标记可移位 · 右键可编辑</div></div>';
          return '<div class="card" data-id="'+s.id+'"><div class="t"><span class="sp-name">'+levelBadge(s)+dispName(s)+altBadge(s)+'</span>'+(s.ticket?'<span class="sp-ticket">'+ticketTxt(s)+'</span>':'')+'<button class="sp-edit" data-sedit="'+s.id+'" title="改名（右键卡片也可）">✏️</button><button class="sp-edit sp-del" data-sdel="'+s.id+'" title="从列表删除（重复项等）">🗑</button></div><div class="d">'+Footprint.normCity(s.city)+' · '+(CATS[s.cat]||'')+' · 点 ✏️ 改名 · 点 🗑 删除</div></div>';
        }).join('') +
        '</div></div>';
    });
    box.innerHTML = html || '<div class="empty">没有找到相关景点，换个关键词试试。</div>';
    // 恢复重绘前的展开状态与滚动位置
    openProvs.forEach(pk => {
      const g = box.querySelector('.prov-group[data-prov="' + pk + '"]');
      if (!g) return;
      const it = g.querySelector('.prov-items');
      const ar = g.querySelector('.prov-arrow');
      if (it) it.style.display = 'block';
      if (ar) ar.textContent = '▾ ';
    });
    box.scrollTop = keepScroll;
    box.querySelectorAll('.prov-toggle').forEach(t => t.addEventListener('click', () => {
      const items = t.nextElementSibling;
      const open = items.style.display !== 'none';
      // Close all
      box.querySelectorAll('.prov-items').forEach(i => i.style.display = 'none');
      box.querySelectorAll('.prov-arrow').forEach(a => a.textContent = '▸ ');
      // Open this one
      if (!open) {
        // 落点锚 = 列表最上端时「第三行省份」（现为内蒙）所在的位置，其第一个景点自然从下一行开始。
        // ★ 必须用「内容坐标」（rect 差值 + scrollTop）来量：用屏幕坐标的话，
        //   列表一旦滚到下方，锚点行跑到屏幕外，落点就会被算到视野上方（曾经的 bug）。
        const boxTop = box.getBoundingClientRect().top;
        const contentY = el => el.getBoundingClientRect().top - boxTop + box.scrollTop;
        const rows = box.querySelectorAll('.prov-toggle');
        const anchorEl = rows[Math.min(2, rows.length - 1)];
        const anchorC = anchorEl ? contentY(anchorEl) : 0;
        items.style.display = 'block';
        var arrow = t.querySelector('.prov-arrow');
        if (arrow) arrow.textContent = '▾ ';
        // 把被点省份标题钉到锚点行（不足时自动钳到 0，即保持原行：前两个省不受影响）
        autoScrollAt = Date.now();
        box.scrollTop = Math.max(0, contentY(t) - anchorC);
      }
    }));
    // 删除按钮：点 ✕ 从列表和地图同时移除（双向联动）
    box.querySelectorAll('.my-del').forEach(b => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = b.dataset.del;
      const sp = mySpots.find(x => x.id === id);
      uiPrompt('删除「' + (sp ? sp.name : '') + '」？', '', (ok) => {
        if (ok) {
          mySpots = mySpots.filter(x => x.id !== id);
          renderMySpots(); renderSpotList(); saveMyData();
        }
      });
    }));
    // 改名按钮：点 ✏️ 修改名称（我的景点）
    box.querySelectorAll('.my-edit').forEach(b => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const sp = mySpots.find(x => x.id === b.dataset.edit);
      if (!sp) return;
      uiPrompt('改名「' + sp.name + '」：', sp.name, (ok, val) => {
        if (!ok || !val) return;
        sp.name = val;
        renderMySpots(); renderSpotList(); saveMyData(); revealSpotCard(sp.id);
      });
    }));
    // 改名按钮：点 ✏️ 修改名称（官方景点 → 存显示别名）
    box.querySelectorAll('.sp-edit').forEach(b => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = b.dataset.sedit;
      const sp = byId[id];
      if (!sp) return;
      const cur = nameOverrides[id] || sp.name;
      uiPrompt('改名「' + cur + '」：', cur, (ok, val) => {
        if (!ok || !val) return;
        if (val !== sp.name) { nameOverrides[id] = val; }
        else { delete nameOverrides[id]; }
        renderSpotList(); refreshMarkers(); saveMyData(); revealSpotCard(id);
      });
    }));
    // 删除按钮：点 🗑 从列表与地图同时移除官方景点（存 store.json，重启不复活）
    box.querySelectorAll('.sp-del').forEach(b => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const id = b.dataset.sdel;
      const sp = byId[id];
      if (!sp) return;
      uiPrompt('从列表删除「' + (nameOverrides[id] || sp.name) + '」？', '', (ok) => {
        if (!ok) return;
        deletedSpots.push(id);
        const c = Footprint.normCity(sp.city);
        AT.splice(AT.indexOf(sp), 1);
        delete byId[id];
        const arr2 = byCity[c];
        if (arr2) { const j = arr2.indexOf(sp); if (j >= 0) arr2.splice(j, 1); }
        Object.keys(byCityAll).forEach(k => {
          const arr3 = byCityAll[k];
          const j3 = arr3.indexOf(sp);
          if (j3 >= 0) arr3.splice(j3, 1);
        });
        renderSpotList(); refreshMarkers(); saveMyData();
      });
    }));
    box.querySelectorAll('.card').forEach(c => c.addEventListener('click', () => {
      // 我的景点：与官方景点完全同一套「两次点击」规则
      //   第一次点击 → 清除其他选中、本卡标记为选中、居中定位到该点并打开标记弹窗
      //   第二次点击同一张 → 地图放大到 13 级，圆圈闪烁提示
      //   （此前每次点击行为完全相同，无第一次/第二次之分）
      const mine = mySpots.find(x => x.id === c.dataset.id);
      if (mine) {
        if (c.dataset.selected === '1') {
          // 第二次点击同一张：放大到该自建景点 + 圆圈闪烁 + 卡片跟着圆点一起出现
          map.setView(disp(mine.lat, mine.lng), 13, { animate: true });
          markFlash(mine.id);
          flashMySpot(mine);
          openSpotCardAfterMove(mine, mySpotPop);
        } else {
          // 第一次点击：正常定位到该自建景点 + 开弹窗
          box.querySelectorAll('.card').forEach(x => { delete x.dataset.selected; x.classList.remove('sel'); });
          c.dataset.selected = '1';
          c.classList.add('sel');
          // 第一次点击定位到 8 级（自建景点开始显示的级别，相当于「先看它在哪一片」）
          // 不沿用当前级别：地图本来就在 13 级以上时，沿用会让第一次点击看起来直接到 13 级
          map.setView(disp(mine.lat, mine.lng), 8, { animate: true });
          // 视图动画结束会触发 moveend 重绘标记，故延后打开并二次兜底（与官方景点同样的做法）
          setTimeout(() => openMySpotPopup(mine), 400);
          setTimeout(() => openMySpotPopup(mine), 1100);
        }
        if (window.innerWidth <= 768) document.getElementById('panel').classList.remove('open');
        return;
      }
      const s = byId[c.dataset.id];
      if (c.dataset.selected === '1') {
        // 第二次点击同一张：地图放大到该景点 + 圆点闪烁
        // ★ 必须用「手动校正后」的坐标（posOverrides，经 spotLat/spotLng 取）：
        //   原先写的是 disp(s.lat, s.lng)（景点库原始坐标），凡是你在图上拖拽校正过位置的景点，
        //   二次点击后会以「旧坐标」为中心 → 圆点闪在屏幕外、甚至根本不渲染（用户 2026-10-02 反馈）。
        //   标记本身一直画在 disp(spotLat,spotLng) 上（见下方 addLayer 处），两处现在统一。
        const dp = disp(spotLat(s), spotLng(s));
        map.setView(dp, 13, { animate: true });
        markFlash(s.id);   // 视图变了会重绘标记，重建时按此补闪
        spotLayer.eachLayer(m => {
          const ll = m.getLatLng && m.getLatLng();
          // 比对基准必须与标记实际坐标完全一致（同一 disp 换算），否则卫星图下差 300~500 米会找不到
          if (ll && Math.abs(ll.lat - dp[0]) < 1e-6 && Math.abs(ll.lng - dp[1]) < 1e-6) {
            const el = m.getElement();
            if (el) {
              const inner = el.querySelector('.spot-marker') || el;
              inner.classList.remove('flash-spot');
              void inner.offsetWidth;
              inner.classList.add('flash-spot');
              setTimeout(() => inner.classList.remove('flash-spot'), FLASH_MS + 200);
            }
          }
        });
        // 卡片跟着闪烁的圆点一起出现（用户 2026-10-02 要求）
        openSpotCardAfterMove(s);
      } else {
        // 第一次点击：正常飞到+开popup
        box.querySelectorAll('.card').forEach(x => { delete x.dataset.selected; x.classList.remove('sel'); });
        c.dataset.selected = '1';
        c.classList.add('sel');
        flySpot(s);
      }
      if (window.innerWidth <= 768) document.getElementById('panel').classList.remove('open');
    }));
  }
  // 重绘后把某张卡片展开、滚动到可视区并高亮（改名/新增后让用户立刻看到结果）
  function revealSpotCard(id) {
    const box = document.getElementById('spotList');
    const card = box && box.querySelector('.card[data-id="' + id + '"]');
    if (!card) return;
    const items = card.parentElement;
    if (items && items.classList.contains('prov-items')) {
      items.style.display = 'block';
      const ar = items.parentElement.querySelector('.prov-arrow');
      if (ar) ar.textContent = '▾ ';
    }
    flashCard(card);
  }
  // 列表滚动：把已滚出视野的分组自动收起（只绑定一次，避免每次重绘叠加监听）
  // 注意：我们自己改 scrollTop（展开省份钉落点、右侧联动居中高亮）不算用户滚动，跳过本次判断，
  // 否则刚展开的省份可能被立刻误收起。
  document.getElementById('spotList').addEventListener('scroll', function () {
    const box = this;
    if (Date.now() - autoScrollAt < 400) return;
    box.querySelectorAll('.prov-items').forEach(items => {
      if (items.style.display === 'none') return;
      const rect = items.getBoundingClientRect();
      const boxRect = box.getBoundingClientRect();
      if (rect.bottom < boxRect.top || rect.top > boxRect.bottom) {
        items.style.display = 'none';
        const t = items.parentElement.querySelector('.prov-arrow');
        if (t) t.textContent = '▸ ';
      }
    });
  });
  function renderCatFilter() {}

  /* ---------- 顶部搜索 ---------- */
  const topInput = document.getElementById('topInput'), topSuggest = document.getElementById('topSuggest');
  topInput.addEventListener('input', () => {
    const q = topInput.value.trim();
    if (!q) { topSuggest.classList.remove('show'); return; }
    const pvs = PROVS.filter(p => p.name.includes(q)).slice(0, 3)
      .map(p => `<div class="sg" data-type="prov" data-name="${p.name}"><span>🗺 ${p.name}</span><small>省份</small></div>`);
    const cs = CITIES.filter(c => c.name.includes(q)).slice(0, 4)
      .map(c => `<div class="sg" data-type="city" data-name="${c.name}"><span>🏙 ${c.name}</span><small>${c.province}</small></div>`);
    const cts = COUNTIES.filter(c => c.name.includes(q)).slice(0, 3)
      .map(c => `<div class="sg" data-type="city" data-name="${c.name}"><span>▸ ${c.name}</span><small>${c.province} · ${c.city || ''}</small></div>`);
    const ss = AT.filter(s => s.name.includes(q)).slice(0, 6)
      .map(s => `<div class="sg" data-type="spot" data-id="${s.id}"><span>${s.level === '5A' ? '⭐' : '📍'} ${s.name}</span><small>${Footprint.normCity(s.city)}</small></div>`);
    topSuggest.innerHTML = pvs.concat(cs, cts, ss).join('');
    topSuggest.classList.toggle('show', !!(pvs.length + cs.length + cts.length + ss.length));
    topSuggest.querySelectorAll('.sg').forEach(g => g.addEventListener('mousedown', () => {
      if (g.dataset.type === 'prov') { topInput.value = g.dataset.name; doTopSearch(); }
      else if (g.dataset.type === 'spot') {
        state.curQ = byId[g.dataset.id].name; renderSpotList(); switchTab('spots');
        flySpot(byId[g.dataset.id]);
      } else {
        switchTab('spots'); state.curQ = g.dataset.name; renderSpotList(); flyCity(g.dataset.name);
      }
      topInput.value = ''; topSuggest.classList.remove('show');
      if (window.innerWidth <= 768) document.getElementById('panel').classList.remove('open');
    }));
  });
  topInput.addEventListener('blur', () => setTimeout(() => topSuggest.classList.remove('show'), 150));
  topInput.addEventListener('keydown', e => { if (e.key === 'Enter') doTopSearch(); });
  document.getElementById('btnTopSearch').addEventListener('click', doTopSearch);
  function doTopSearch() {
    const q = topInput.value.trim();
    if (!q) return;
    // 省份搜索：一次最多一个省份（输入省名如"河南"→左侧全省景点+地图定位）
    const provHit = PROVS.find(p => p.name === q || shortProv(p.name) === q);
    if (provHit) {
      state.provMode = [provHit.name]; state.curQ = ''; state.curCat = 0;
      switchTab('spots'); renderSpotList();
      map.flyTo(disp(provHit.center[1], provHit.center[0]), 6, { duration: .6 });
      topInput.value = ''; topSuggest.classList.remove('show');
      if (window.innerWidth <= 768) document.getElementById('panel').classList.remove('open');
      return;
    }
    state.provMode = [];
    // 先匹配城市（含县级），再匹配景点
    const cc = CITIES.find(c => c.name === q) || COUNTIES.find(c => c.name === q)
      || CITIES.find(c => c.name.includes(q)) || COUNTIES.find(c => c.name.includes(q));
    const ss = AT.filter(s => s.name.includes(q)).slice(0, 6);
    if (cc) {
      switchTab('spots'); state.curQ = ''; state.provMode = []; renderSpotList(); flyCity(cc.name);
    } else if (ss.length) {
      switchTab('spots'); state.curQ = q; renderSpotList(); flySpot(ss[0]);
    } else {
      switchTab('spots'); state.curQ = q; renderSpotList(); refreshMarkers();
    }
    topInput.value = ''; topSuggest.classList.remove('show');
    if (window.innerWidth <= 768) document.getElementById('panel').classList.remove('open');
  }

  /* ---------- 行程 ---------- */
  const cityList = document.getElementById('cityList');
  const planCityNames = Object.keys(byCityAll).sort((a, b) => byCityAll[b].length - byCityAll[a].length);
  cityList.innerHTML = planCityNames.map(n => `<option value="${n}">`).join('');
  let days = state.days;
  let planMode = 'transit';
  const dayNum = document.getElementById('dayNum');
  document.getElementById('dayMinus').addEventListener('click', () => { days = Math.max(1, days - 1); dayNum.textContent = days; state.days = days; save(); });
  document.getElementById('dayPlus').addEventListener('click', () => { days = Math.min(20, days + 1); dayNum.textContent = days; state.days = days; save(); });
  function setPlanMode(m) {
    planMode = m;
    document.getElementById('modeTransit').classList.toggle('on', m === 'transit');
    document.getElementById('modeDrive').classList.toggle('on', m === 'drive');
  }
  document.getElementById('modeTransit').addEventListener('click', () => setPlanMode('transit'));
  document.getElementById('modeDrive').addEventListener('click', () => setPlanMode('drive'));

  /* ---------- 行程：人群主题 + 地域分区 ---------- */
  let planTheme = 'all';      // 人群主题（全部主题 / 经典全景 / 自然山水 / …）
  let planRegion = 'all';     // 地域分区（全省 / 北部 / 中部 / 南部 …）
  let lastPlans = [];         // 本次枚举出的全部方案
  let planIdx = 0;
  let planCtx = null;         // { label, days, prefs }

  function planChipHtml(list, cur, attr, extra) {
    return list.map(it => {
      const on = cur === it.key ? ' on' : '';
      const tail = it.count ? ' ' + it.count : '';
      return `<button class="chip${on}" data-${attr}="${it.key}"${extra ? ' title="' + (it.note || '') + '"' : ''}>${it.label}${tail}</button>`;
    }).join('');
  }

  function renderPlanChips(provName, cands) {
    const tbox = document.getElementById('prefsTheme');
    const rbox = document.getElementById('prefsRegion');
    if (!tbox || !rbox) return;
    // 主题
    // 主题：默认项就是"经典全景"（key='all' 等价于不设偏好），不再单列一个"全部主题"——
    // 两者结果完全相同，并排放会让用户以为点了没反应（真实窗口实测发现）。
    const themes = [{ key: 'all', label: '经典全景', note: '评分优先，名山大川与经典地标兼顾（默认）' }]
      .concat(Planner.variants.filter(v => v.id !== 'classic').map(v => ({ key: v.id, label: v.name, note: v.note })));
    tbox.innerHTML = planChipHtml(themes, planTheme, 'theme', true);
    tbox.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => { planTheme = b.dataset.theme; runPlan(); }));
    // 分区（仅省份模式）
    const regs = provName ? (Planner.geoRegions(cands) || []) : [];
    if (!regs.length) {
      rbox.innerHTML = '<span style="font-size:12px;color:#8b8b8b">输入省份名（如"四川"）即可按北部/中部/南部等地域分区排程</span>';
      planRegion = 'all';
      return;
    }
    const items = [{ key: 'all', label: '全省' }].concat(regs.map(r => ({ key: r.key, label: r.label, count: r.spots.length })));
    rbox.innerHTML = planChipHtml(items, planRegion, 'region');
    rbox.querySelectorAll('.chip').forEach(b => b.addEventListener('click', () => { planRegion = b.dataset.region; runPlan(); }));
  }

  function showPlan(k) {
    if (!lastPlans.length) return;
    planIdx = ((k % lastPlans.length) + lastPlans.length) % lastPlans.length;
    const res = lastPlans[planIdx];
    lastPlan = { city: planCtx.label, days: planCtx.days, prefs: planCtx.prefs, res: res };
    renderPlan(lastPlan, false);
    drawRoutes(res);
  }

  function matchCity(q) {
    q = Footprint.normCity(q);
    let c = CITIES.find(x => x.name === q);
    if (!c) c = CITIES.find(x => x.name.includes(q) || q.includes(x.name));
    if (!c) c = COUNTIES.find(x => x.name === q);
    return c;
  }

  // 行程候选池原则：左侧列表有的景点（官方 + 自建）全部可排。
  // 自建景点补齐 planner 需要的字段（省市借 60km 内最近官方景点，时长/评分给默认值）
  // ★ 区域约束（2026-10-01 修复）：mySpots 是全库自建景点（可能横跨十来个省），
  //   必须按「候选池所在区域」过滤后再并入，否则外省自建点会混进本地行程
  //   （真实事故：山西南部线路里排出了厦门大学、苍山、洞庭湖）。
  function withMySpots(base) {
    if (!base || !base.length || !mySpots.length) return base;
    const ids = new Set(base.map(s => s.id));
    const pool = mySpots.filter(ms => !ids.has(ms.id));
    if (!pool.length) return base;
    // 候选池的省份集合 + 地理包围盒（用于判定自建点是否属于本区域）
    const provs = new Set(base.map(s => s.province).filter(Boolean));
    const lngs = base.map(s => s.lng), lats = base.map(s => s.lat);
    const minLng = Math.min.apply(null, lngs), maxLng = Math.max.apply(null, lngs);
    const minLat = Math.min.apply(null, lats), maxLat = Math.max.apply(null, lats);
    const cLng = (minLng + maxLng) / 2, cLat = (minLat + maxLat) / 2;
    const spanKm = Math.max(maxLat - minLat,
      (maxLng - minLng) * Math.cos(cLat * Math.PI / 180)) * 111;
    const radius = Math.max(300, spanKm / 2 + 100);   // 全省游放宽，城市游收紧
    const extra = pool.map(ms => {
      const reg = mySpotRegion(ms) || {};
      return { ms: ms, reg: reg, d: Planner.hav({ lng: cLng, lat: cLat }, { lng: ms.lng, lat: ms.lat }) };
    }).filter(o => {
      if (o.reg.province && provs.has(o.reg.province)) return o.d <= radius;  // 同省且在活动半径内
      return o.d <= 120;                                                     // 省份未知：仅收近邻
    }).map(o => Object.assign({}, o.ms, {
      dur: 3, rating: 4.2, level: 'hot', province: o.reg.province, city: o.reg.city
    }));
    return extra.length ? base.concat(extra) : base;
  }

  // 排程入口：省份模式支持地域分区，主题/分区切换后重排
  function runPlan() {
    const q = document.getElementById('planCity').value;
    const c = matchCity(q);
    let provName = null, candidates = null, center = null, label = null;
    if (!c) {
      const prov = PROVS.find(p => p.name === q || shortProv(p.name) === q);
      if (prov) {
        provName = prov.name;
        label = prov.name;
        candidates = withMySpots(AT.filter(s => s.province === prov.name));
        center = { lng: prov.center[0], lat: prov.center[1] };
      }
    }
    if (!provName) {
      if (!c) { document.getElementById('planResult').innerHTML = '<div class="empty">请输入有效的城市或省份名称，如：成都市、四川。</div>'; return; }
      const list = byCityAll[c.name] || byCity[c.name];
      if (!list || !list.length) { document.getElementById('planResult').innerHTML = '<div class="empty">请输入有效的城市或省份名称，如：成都市、四川。</div>'; return; }
      label = c.name;
      candidates = withMySpots(list);
      const ctr = cityCenter[c.name] || [candidates.reduce((a, s) => a + s.lng, 0) / candidates.length, candidates.reduce((a, s) => a + s.lat, 0) / candidates.length];
      center = { lng: ctr[0], lat: ctr[1] };
      planRegion = 'all';   // 城市模式不做地域分区
    }
    if (!candidates.length) { document.getElementById('planResult').innerHTML = '<div class="empty">该区域暂无景点数据。</div>'; return; }
    renderPlanChips(provName, candidates);
    lastPlans = Planner.planAll(candidates, days, new Set(state.prefs), center, planMode, { region: planRegion, variant: planTheme });
    planCtx = { label: label, days: days, prefs: [...state.prefs] };
    if (!lastPlans.length) { document.getElementById('planResult').innerHTML = '<div class="empty">暂无可用方案。</div>'; return; }
    showPlan(0);
  }
  document.getElementById('btnPlan').addEventListener('click', runPlan);

  function renderPlan(plan, saved) {
    const { city, days, res } = plan;
    let html = '';
    if (res.warnings.length) html += `<div class="card" style="background:#fdf6ea;border-color:#eedcb8"><div class="d">${res.warnings.join('<br>')}</div></div>`;
    if (res.totalPlans && res.totalPlans > 1) {
      const tagTxt = res.__tag ? ' · ' + res.__tag : '';
      html += `<div style="margin:8px 0;text-align:center"><button data-act="nextplan" style="padding:6px 18px;background:#4a7cf7;color:#fff;border:none;border-radius:16px;cursor:pointer;font-size:14px">🔄 换一套方案（第 ${(res.planIndex || 0) + 1}/${res.totalPlans} 套${tagTxt}）</button></div>`;
    }
    if (!res.days.length) { html += '<div class="empty">暂无数据。</div>'; }
    res.days.forEach(d => {
      const dc = DAY_COLORS[(d.day - 1) % DAY_COLORS.length];
      const modeTxt = res.mode === 'drive' ? '🚗 自驾' : '🚆 公共交通';
      html += `<div class="day-head" data-d="${d.day}" style="border-left:6px solid ${dc}">第 ${d.day} 天 · ${d.route.length} 个景点 · ${modeTxt}</div>`;
      d.items.forEach(it => {
        if (it.type === 'spot') {
          html += `<div class="plan-item"><div class="plan-time">${it.start}<br>${it.end}</div>
            <div class="plan-body"><div class="pn">${it.spot.name}${it.spot.level === '5A' ? ' ⭐' : ''}</div>
            <div class="pe">${it.note || ''}　${it.spot.ticket === '免费' ? '免费' : ''}</div></div></div>`;
        } else if (it.type === 'meal') {
          html += `<div class="plan-item plan-meal"><div class="plan-time">${it.start}<br>${it.end || ''}</div>
            <div class="plan-body"><div class="pn">🍜 ${it.text}</div></div></div>`;
        } else {
          html += `<div class="plan-item"><div class="plan-time">${it.start}</div><div class="plan-body"><div class="pe">${it.text}</div></div></div>`;
        }
      });
    });
    if (res.days.length) {
      html += `<div class="plan-actions">
        <button class="save" data-act="saveplan">💾 保存此行程</button>
        <button data-act="viewroute">🗺 地图看路线</button></div>`;
    }
    const box = document.getElementById('planResult');
    box.innerHTML = html;
    const sv = box.querySelector('[data-act="saveplan"]');
    if (sv) sv.addEventListener('click', () => {
      if (!state.savedTrips.some(t => t.city === city && t.days === days)) {
        state.savedTrips.push({ id: 't' + Date.now(), city: city, days: days, prefs: plan.prefs, res: res });
        save(); renderSavedTrips();
        sv.textContent = '✓ 已保存';
      } else sv.textContent = '✓ 此前已保存';
    });
    const vr = box.querySelector('[data-act="viewroute"]');
    if (vr) vr.addEventListener('click', () => { drawRoutes(res); if (window.innerWidth <= 768) document.getElementById('panel').classList.remove('open'); });
  }

  function drawRoutes(res, keepView) {
    routeLayer.clearLayers();
    window.__routeMarkers = {};
    lastRouteRes = res;
    const all = [];
    // 图钉名称防重叠：缩放≥8才显示名称（放大后可看清），矩形碰撞检测——名称互不重叠就都显示
    const zoomOK = map.getZoom() >= 8;
    const shownRects = [];
    const nmShow = (lat, lng, text) => {
      const p = map.latLngToContainerPoint(disp(lat, lng));
      const w = Math.max(34, text.length * 13 + 14);
      const h = 20, x = p.x - w / 2, y = p.y + 24;
      for (const r of shownRects) {
        if (x < r.x + r.w + 5 && x + w + 5 > r.x && y < r.y + r.h + 5 && y + h + 5 > r.y) return false;
      }
      shownRects.push({ x: x, y: y, w: w, h: h });
      return true;
    };
    res.days.forEach((d, di) => {
      const color = DAY_COLORS[di % DAY_COLORS.length];
      const latlngs = d.route.map(s => disp(s.lat, s.lng));
      all.push(...latlngs);
      routeLayer.addLayer(L.polyline(latlngs, { color: color, weight: 4, opacity: .95, dashArray: '6 5' }));
      d.route.forEach(s => {
        const showNm = zoomOK && nmShow(s.lat, s.lng, s.name);
        const mk = L.marker(disp(s.lat, s.lng), {
          icon: L.divIcon({ className: '', html: `<div class="route-pin" style="--pc:${color}"><span style="background:${color}"><b>${d.day}</b></span>${showNm ? `<div class="mk-name">${s.name}</div>` : ''}</div>`, iconSize: [48, 62], iconAnchor: [24, 54], popupAnchor: [0, -50] })
        });
        routeLayer.addLayer(mk);
        (window.__routeMarkers = window.__routeMarkers || {})[d.day] = (window.__routeMarkers[d.day] || []).concat([mk]);
      });
    });
    if (all.length) {
      hideMapHint();
      if (!keepView) {
        map.flyToBounds(L.latLngBounds(all).pad(.25), { duration: .7, maxZoom: 12 });
      }
      document.getElementById('mapLegend').innerHTML =
        res.days.map((d, i) => `<div class="lg"><span class="dotmini" style="background:${DAY_COLORS[i % 8]}"></span>第 ${i + 1} 天</div>`).join('');
      document.getElementById('mapLegend').classList.add('show');
    }
  }
  // 行程路线图钉：缩放变化时按当前级别重绘名称（保留视野），放大后名称更多更清晰
  map.on('zoomend', function () {
    if (lastRouteRes && routeLayer.getLayers().length) drawRoutes(lastRouteRes, true);
  });

  function renderSavedTrips() {
    const sel = document.getElementById('savedTripSel');
    sel.innerHTML = '<option value="">载入已保存行程…</option>' +
      state.savedTrips.map((t, i) => `<option value="${i}">${t.city} · ${t.days}天</option>`).join('');
  }
  // 点击"第X天"标题 → 地图上当天标记闪烁
  document.getElementById('planResult').addEventListener('click', function (e) {
    const np = e.target.closest('[data-act=nextplan]');
    if (np) {
      if (lastPlans.length > 1) showPlan(planIdx + 1);                       // 已枚举好的方案直接切换
      else { window.__tplIdx = (window.__tplIdx || 0) + 1; document.getElementById('btnPlan').click(); }
      return;
    }
    const hd = e.target.closest('.day-head');
    if (!hd) return;
    const day = +hd.dataset.d;
    document.querySelectorAll('.route-pin.flash').forEach(el => el.classList.remove('flash'));
    const mks = (window.__routeMarkers || {})[day] || [];
    mks.forEach(mk => {
      const el = mk.getElement();
      if (el) {
        const pin = el.querySelector('.route-pin');
        if (pin) {
          pin.classList.remove('flash');
          void pin.offsetWidth;  // 重置动画
          pin.classList.add('flash');
        }
      }
    });
  });

  document.getElementById('savedTripSel').addEventListener('change', function () {
    if (this.value === '') return;
    const t = state.savedTrips[+this.value];
    lastPlans = []; planIdx = 0;   // 载入已存行程：清掉上一次的方案列表，避免"换一套"串到别的行程
    lastPlan = { city: t.city, days: t.days, prefs: t.prefs, res: t.res };
    renderPlan(lastPlan, true); drawRoutes(t.res);
  });
  document.getElementById('btnDelTrip').addEventListener('click', () => {
    const sel = document.getElementById('savedTripSel');
    if (sel.value === '') return;
    state.savedTrips.splice(+sel.value, 1); save(); renderSavedTrips();
    document.getElementById('planResult').innerHTML = '<div class="empty">已删除。</div>';
  });

  /* ---------- 足迹 ---------- */
  // 统计基数：有景点的市级 + 有景点的县级（景点归属县）
  const FOOT_TOTAL = CITIES.filter(c => byCity[c.name]).concat(COUNTIES.filter(c => byCity[c.name]));
  // 足迹搜索命中项（地名数组），由 renderFoot 填充，供回车点亮使用
  let footHits = [];
  function renderFoot() {
    const st = state.footprint;
    // ★ 第三个参数 cityProv 是「全量行政区名 → 省份」字典（CITIES + COUNTIES）。
    //   省份归属必须用它，不能只靠 FOOT_TOTAL（有景点的市/县）：包头市自己没有景点、
    //   不在 FOOT_TOTAL 里，点亮后内蒙古自治区会数不进去 —— 这正是「地图 15 / 面板 14」的原因。
    const s = Footprint.stats(st, FOOT_TOTAL, cityProv);
    document.getElementById('footStat').innerHTML = `
      <div class="stat-box"><b>${s.cities}</b><span>点亮城市</span></div>
      <div class="stat-box"><b>${s.provinces}</b><span>覆盖省份</span></div>
      <div class="stat-box"><b>${Math.round(s.cities / s.totalCities * 1000) / 10}%</b><span>城市覆盖率</span></div>`;

    document.getElementById('memberChips').innerHTML = st.members.map(m =>
      `<button class="mchip ${st.active === m.id ? 'active' : ''}" data-mid="${m.id}">
        <span class="mdot" style="background:${m.color}"></span>${m.name}${st.active === m.id ? ' ✎' : ''}<span class="mx" data-del="${m.id}">✕</span></button>`).join('');
    document.querySelectorAll('#memberChips .mchip').forEach(c => c.addEventListener('click', e => {
      const mid = c.dataset.mid;
      if (e.target.dataset.del) {
        Footprint.removeMember(st, mid); save(); renderFoot(); refreshMarkers();
      } else {
        // 点击成员 = 切换查看该成员，地图红色只显示其足迹
        Footprint.setActive(st, mid);
        save(); renderFoot(); refreshMarkers();
      }
    }));

    // 城市足迹：按省份归类（省级 → 市级/县级）
    const lit = Footprint.litMap(st);
    const byProv = {};
    function pushProv(pr, n) {
      pr = pr || '其他';
      (byProv[pr] = byProv[pr] || []);
      if (!byProv[pr].includes(n)) byProv[pr].push(n);
    }
    CITIES.forEach(c => pushProv(c.province, c.name));
    COUNTIES.forEach(c => { if (!isDistrictName(c.name)) pushProv(c.province, c.name); });
    const provHasLit = pr => byProv[pr].some(n => !!lit[n]);
    const provOrder = PROVS.map(pr => pr.name).filter(n => byProv[n]);
    const box = document.getElementById('cityFootList');

    // ★ 搜索：2200+ 行地名里找一个小县城，没有搜索框只能展开省份用肉眼扫。
    //   输入即过滤（省名命中则整省列出），回车直接点亮（唯一命中，或完全同名的那一个）。
    const q = (document.getElementById('footSearch') || { value: '' }).value.trim().toLowerCase();
    footHits = [];
    const provShown = [];
    const rowsByProv = {};
    provOrder.forEach(pr => {
      let items = byProv[pr];
      if (q && pr.toLowerCase().indexOf(q) < 0) {
        items = items.filter(n => n.toLowerCase().indexOf(q) >= 0);
        if (!items.length) return;
      }
      provShown.push(pr);
      rowsByProv[pr] = items;
      items.forEach(n => footHits.push(n));
    });
    if (q) footHits.sort((a, b) => {   // 完全同名优先 → 县级优先 → 名字短的优先
      const ea = a.toLowerCase() === q ? 0 : 1, eb = b.toLowerCase() === q ? 0 : 1;
      if (ea !== eb) return ea - eb;
      const ca = countySet.has(a) ? 0 : 1, cb = countySet.has(b) ? 0 : 1;
      if (ca !== cb) return ca - cb;
      return a.length - b.length;
    });

    box.innerHTML = provShown.map(pr => {
      const items = rowsByProv[pr]
        .map(n => {
          const litN = (lit[n] || []).length;
          const mine = Footprint.isCityLit(st, n);
          const isCounty = countySet.has(n);
          const nSp = (byCity[n] || []).length;
          const tag = litN ? '👣' + litN + '人' : (nSp ? nSp + '景' : '无景点');
          return `<div class="card city-row${q ? ' hit' : ''}" data-city="${n}">
            <div class="t">${isCounty ? '▸ ' : ''}${n}</div>
            <span class="lit">${tag}</span>
            <div class="toggle ${mine ? 'on' : ''}"></div></div>`;
        }).join('');
      // 搜索时全部展开，否则只在「本省有点亮」时展开
      const collapsed = q ? '' : (provHasLit(pr) ? '' : ' collapsed');
      return `<div class="prov-group${collapsed}${q ? ' q' : ''}"><div class="prov-title">${pr}</div>${items}</div>`;
    }).join('');
    const sn = document.getElementById('footSearchN');
    if (sn) sn.innerHTML = q ? (footHits.length ? `找到 <b>${footHits.length}</b> 个` : '<b>没有匹配</b>') : '';
    box.querySelectorAll('.city-row').forEach(r => r.addEventListener('click', () => doToggleCity(r.dataset.city)));
    box.querySelectorAll('.prov-title').forEach(t => t.addEventListener('click', () => {
      t.parentElement.classList.toggle('collapsed');
    }));
  }
  /* ---------- 足迹搜索框 ---------- */
  // 输入即过滤（防抖 120ms），回车直接点亮（唯一命中，或完全同名的那一个）
  (function bindFootSearch() {
    const el = document.getElementById('footSearch');
    if (!el) return;
    let timer = 0;
    el.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(renderFoot, 120);
    });
    el.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const kw = el.value.trim().toLowerCase();
      const exact = footHits.filter(n => n.toLowerCase() === kw);
      const target = exact.length ? exact[0] : (footHits.length === 1 ? footHits[0] : null);
      if (target) { doToggleCity(target); el.select(); }
    });
  })();

  document.getElementById('btnAddMember').addEventListener('click', function () {
    const inp = document.getElementById('newMember');
    if (Footprint.addMember(state.footprint, inp.value)) { inp.value = ''; save(); renderFoot(); refreshMarkers(); }
  });
  document.getElementById('newMember').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btnAddMember').click(); });
  document.getElementById('btnClearFoot').addEventListener('click', function () {
    const st = state.footprint;
    const rec = st.members.find(m => m.id === st.active);
    const nm = rec ? rec.name : '当前成员';
    uiPrompt('确定要清除「' + nm + '」的全部足迹吗？此操作不可恢复。', '', (ok) => {
      if (!ok) return;
      Footprint.clearVisits(st, st.active);
      save(); renderFoot(); refreshMarkers();
    });
  });

  /* ---------- 面板 / 复位 ---------- */
  // 收起/展开左侧面板（手机端用滑动 .open，电脑端用 display 切换）
  document.getElementById('panelHide').addEventListener('click', () => {
    var p = document.getElementById('panel');
    if (window.innerWidth <= 768) {
      p.classList.remove('open');
    } else {
      p.style.display = 'none';
    }
    document.getElementById('panelToggle').classList.add('show');
    map.invalidateSize();
  });
  document.getElementById('panelToggle').addEventListener('click', () => {
    var p = document.getElementById('panel');
    p.style.display = 'flex';
    if (window.innerWidth <= 768) {
      p.classList.add('open');
    }
    document.getElementById('panelToggle').classList.remove('show');
    map.invalidateSize();
  });
  window.addEventListener('resize', () => map.invalidateSize());

  /* ---------- 我的景点 & 重命名 ---------- */
  let nameOverrides = {};   // {spotId: "自定义名"}（官方景点显示别名）
  let deletedSpots = [];    // [spotId] 用户从列表删除的官方景点（重复项等），存 store.json，重启不复活
  let showTextOverrides = {}; // {spotId:1} 极个别底图上没字的景点：右键「补文字」后我方才显示名称
  let mySpots = [];         // [{id,name,lat,lng}]
  let posOverrides = {};    // {spotId: {lat,lng}} 官方景点手动调整后的位置
  const mySpotLayer = L.layerGroup().addTo(map);

  // 坐标 → 省份（最近县级中心点，纯本地计算）
  function provOfLatLng(lat, lng) {
    let best = null, bd = Infinity;
    COUNTIES.forEach(c => {
      if (!c.center) return;
      const d = (c.center[1] - lat) * (c.center[1] - lat) + (c.center[0] - lng) * (c.center[0] - lng);
      if (d < bd) { bd = d; best = c; }
    });
    return best ? best.province : '未归类';
  }
  function mySpotProv(sp) { return sp.prov || (sp.prov = provOfLatLng(sp.lat, sp.lng)); }
  // 自建景点弹窗内容（标记点击与列表点击共用同一份）
  // 自建景点没有省市字段：借最近官方景点的省市（60km 内才算同域，避免借错）
  function mySpotRegion(sp) {
    let best = null, bd = 1e18;
    AT.forEach(s => {
      if (s.lat == null || s.lng == null) return;
      const dx = (s.lng - sp.lng) * Math.cos(sp.lat * Math.PI / 180) * 111320;
      const dy = (s.lat - sp.lat) * 110540;
      const d2 = dx * dx + dy * dy;
      if (d2 < bd) { bd = d2; best = s; }
    });
    if (best && Math.sqrt(bd) <= 60000) return { province: best.province || '', city: best.city || '' };
    return { province: '', city: '' };
  }
  // 自建景点弹窗：与官方景点（5/景）完全同一套模板 spotPop——标题、位置、海拔、天气、按钮全部一致
  function mySpotPop(sp) {
    const reg = mySpotRegion(sp);
    return spotPop(Object.assign({}, sp, { province: reg.province, city: reg.city, level: 'hot' }));
  }
  // 把 flash-spot 打到标记元素上（官方景点闪的是内层 .spot-marker，自建景点闪的是根节点内第一个 div）
  // 标记重建时元素可能尚未挂到 DOM（addLayer 之前调用），故未命中就下一帧重试
  function paintFlash(m) {
    if (!m || !m.getElement) return;
    const apply = () => {
      const el = m.getElement();
      if (!el) return false;
      const t = el.querySelector('.spot-marker') || el;
      t.classList.remove('flash-spot');
      void t.offsetWidth;
      t.classList.add('flash-spot');
      setTimeout(() => t.classList.remove('flash-spot'), FLASH_MS + 200);
      return true;
    };
    if (!apply()) requestAnimationFrame(() => { if (!apply()) requestAnimationFrame(apply); });
  }
  // 自建景点标记定位（不能用 sp._m 挂载：mySpots 会被 JSON 序列化保存，挂 Leaflet 对象会成环）
  function mySpotMarker(sp) {
    const p = disp(sp.lat, sp.lng);   // 标记显示位置已做坐标换算，比对基准必须一致（否则卫星图下查找失效）
    let found = null;
    mySpotLayer.eachLayer(m => {
      const ll = m.getLatLng && m.getLatLng();
      if (ll && Math.abs(ll.lat - p[0]) < 1e-6 && Math.abs(ll.lng - p[1]) < 1e-6) found = m;
    });
    return found;
  }
  // 闪烁：标记会被 moveend 重绘销毁，故先登记 pendingFlash，重绘时自动补上；同时立刻试一次
  let pendingFlash = null;   // {id, until}：在此时间窗内的每次重绘都补 flash-spot
  function markFlash(id) {
    pendingFlash = { id: id, until: Date.now() + FLASH_MS };   // 二次点击定位：圆圈闪到卡片收起为止
    setTimeout(() => { if (pendingFlash && pendingFlash.id === id) pendingFlash = null; }, FLASH_MS + 100);
  }
  function flashMySpot(sp) {
    paintFlash(mySpotMarker(sp));
  }
  function openMySpotPopup(sp) {
    // 与官方景点同一入口 openSpotCard：卡片挂到「地图」而不是标记上
    // （否则 moveend 触发的标记重绘会把挂在标记上的卡片一并销毁），并共用 data-sid 去重
    openSpotCard(sp, mySpotPop);
  }
  // 官方景点实际坐标（含手动调整）
  function spotLat(sp) { const o = posOverrides[sp.id]; return o ? o.lat : sp.lat; }
  function spotLng(sp) { const o = posOverrides[sp.id]; return o ? o.lng : sp.lng; }

  function saveMyData() {
    Store.get(Store.KEY).then(saved => {
      saved = saved || {};
      saved.nameOverrides = nameOverrides;
      saved.mySpots = mySpots;
      saved.posOverrides = posOverrides;
      saved.deletedSpots = deletedSpots;
      saved.showTextOverrides = showTextOverrides;
      Store.set(Store.KEY, saved);
    });
  }
  function dispName(sp) {
    return nameOverrides[sp.id] || sp.name;
  }
  // 把已删除的官方景点从全局索引里摘除（列表与地图所有渲染都走这些索引）
  function applyDeleted() {
    if (!deletedSpots.length) return;
    const dead = new Set(deletedSpots);
    for (let i = AT.length - 1; i >= 0; i--) {
      const s = AT[i];
      if (!dead.has(s.id)) continue;
      AT.splice(i, 1);
      delete byId[s.id];
      const c = Footprint.normCity(s.city);
      const arr2 = byCity[c];
      if (arr2) { const j = arr2.indexOf(s); if (j >= 0) arr2.splice(j, 1); }
    }
    Object.keys(byCityAll).forEach(k => {
      const arr3 = byCityAll[k];
      for (let i = arr3.length - 1; i >= 0; i--) { if (dead.has(arr3[i].id)) arr3.splice(i, 1); }
    });
  }
  function renderMySpots() {
    mySpotLayer.clearLayers();
    const RO = (curTab === 'world');   // 🌍世界板块只读：不可拖拽 / 右键 / 弹卡
    // 自建景点与 5A / 热门保持同一显示级别：8 级及以上才出现（此前无限制，3 级全国视图就露出）
    if (map.getZoom() < 8) return;
    mySpots.forEach(sp => {
      const txt = showTextOverrides[sp.id] ? '<div class="mynm" style="text-align:center;font-size:11px;color:#1e40af;margin-top:2px;white-space:nowrap;">'+sp.name+'</div>' : '';
      const icon = L.divIcon({
        className: '',
        html: '<div class="mydot" style="width:22px;height:22px;border-radius:50%;background:#fff;border:2.5px solid #3b82f6;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#3b82f6;">景</div>'+txt,
        iconSize: [22, 22], iconAnchor: [11, 11 + ICON_LIFT],   // 圆圈悬在底图文字上方
        popupAnchor: [0, -11 - ICON_LIFT - POPUP_LIFT]          // 弹窗在圆圈上方约 3 厘米处
      });
      const m = L.marker(disp(sp.lat, sp.lng), { icon: icon, title: sp.name, draggable: !RO }).addTo(mySpotLayer);
      if (!RO) {
        m.bindPopup(mySpotPop(sp), { autoPan: false });
        // 注意：bindPopup 自带点击开窗，这里绝不能再手动 openPopup——双开会导致按钮监听器绑定失效
        m.on('contextmenu', (e) => openMkMenu(e, sp, true));
        m.on('dragend', () => {
          const ll = m.getLatLng();
          const g = toStore(ll.lat, ll.lng);   // 卫星图上拖拽得到的是 WGS-84，须反算回 GCJ-02 再存
          uiPrompt('把「' + sp.name + '」保存到新位置？', '', (ok) => {
            if (!ok) { renderMySpots(); return; }   // 取消：弹回原位
            sp.lat = g[0]; sp.lng = g[1];
            delete sp.prov;                         // 位置变了，省份重新判定
            renderMySpots(); renderSpotList(); saveMyData();
          });
        });
      }
      // 第二次点击列表卡片触发的闪烁：重绘后自动补上（元素刚加入地图，必要时下一帧再试）
      if (pendingFlash && pendingFlash.id === sp.id && Date.now() < pendingFlash.until) {
        paintFlash(m);
        requestAnimationFrame(() => paintFlash(m));
      }
    });
  }

  // 供桌面端Qt调用：在指定屏幕坐标添加景点
  window.__addSpotAt = function(px, py, name) {
    if (!name) return;
    var pt = map.containerPointToLatLng([px, py]);
    var g = toStore(pt.lat, pt.lng);   // 卫星图上取的是 WGS-84，反算回 GCJ-02 再存
    var id = 'my' + Date.now();
    mySpots.push({ id: id, name: name, lat: g[0], lng: g[1] });
    renderMySpots(); renderSpotList(); saveMyData(); revealSpotCard(id);
  };

  // 网页内通用弹窗（替代prompt/confirm，兼容QWebEngineView）
  function uiPrompt(title, defaultVal, cb) {
      let box = document.getElementById('__ui_prompt');
      if (box) box.remove();
      box = document.createElement('div');
      box.id = '__ui_prompt';
      box.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,.4);z-index:10000;display:flex;align-items:center;justify-content:center;';
      box.innerHTML = '<div style="background:#fff;border-radius:10px;padding:20px;width:340px;box-shadow:0 4px 20px rgba(0,0,0,.3);">' +
        '<div style="font-size:15px;font-weight:600;margin-bottom:12px;">' + title + '</div>' +
        '<input type="text" id="__ui_input" value="' + (defaultVal||'') + '" style="width:100%;padding:8px 10px;border:1px solid #ccc;border-radius:6px;font-size:14px;box-sizing:border-box;outline:none;">' +
        '<div style="text-align:right;margin-top:14px;">' +
        '<button id="__ui_cancel" style="padding:6px 16px;margin-right:8px;border:1px solid #ccc;background:#fff;border-radius:6px;cursor:pointer;font-size:13px;">取消</button>' +
        '<button id="__ui_ok" style="padding:6px 16px;border:none;background:#2563eb;color:#fff;border-radius:6px;cursor:pointer;font-size:13px;">确定</button>' +
        '</div></div>';
      document.body.appendChild(box);
      const input = box.querySelector('#__ui_input');
      input.focus(); input.select();
      const close = (ok) => { box.remove(); cb(ok, input.value.trim()); };
      box.querySelector('#__ui_ok').onclick = () => close(true);
      box.querySelector('#__ui_cancel').onclick = () => close(false);
      box.onclick = (e) => { if (e.target === box) close(false); };
      input.onkeydown = (e) => { if (e.key === 'Enter') close(true); if (e.key === 'Escape') close(false); };
  }

  // 右键地图 = 自定义中文菜单（替代浏览器默认英文菜单）
  const ctxMenu = document.createElement('div');
  ctxMenu.id = '__ctx_menu';
  ctxMenu.style.cssText = 'position:fixed;z-index:10001;display:none;background:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);padding:4px 0;min-width:160px;';
  ctxMenu.innerHTML = '<div data-act="add">📍 在此添加景点</div>';
  document.body.appendChild(ctxMenu);
  let ctxLL = null;
  document.getElementById('map').addEventListener('contextmenu', (e) => e.preventDefault());
  map.on('contextmenu', function(e) {
    if (e.originalEvent) e.originalEvent.preventDefault();
    ctxLL = e.latlng;
    ctxMenu.style.left = Math.min(e.originalEvent.clientX, window.innerWidth - 175) + 'px';
    ctxMenu.style.top = Math.min(e.originalEvent.clientY, window.innerHeight - 56) + 'px';
    ctxMenu.style.display = 'block';
  });
  ctxMenu.addEventListener('click', (ev) => {
    ctxMenu.style.display = 'none';
    if (ev.target.dataset.act !== 'add' || !ctxLL) return;
    uiPrompt('给这个地点起个名字：', '', (ok, name) => {
        if (!ok || !name) return;
        var id = 'my' + Date.now();
        var g = toStore(ctxLL.lat, ctxLL.lng);   // 卫星图上取的是 WGS-84，反算回 GCJ-02 再存
        mySpots.push({ id: id, name: name, lat: g[0], lng: g[1] });
        renderMySpots(); renderSpotList(); saveMyData(); revealSpotCard(id);
    });
  });
  document.addEventListener('click', () => { ctxMenu.style.display = 'none'; });

  // 标记右键菜单：改名 / 删除（官方景点仅改名；移动位置用拖拽）
  const mkMenu = document.createElement('div');
  mkMenu.id = '__mk_menu';
  mkMenu.style.cssText = 'position:fixed;z-index:10001;display:none;background:#fff;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.25);padding:4px 0;min-width:140px;';
  document.body.appendChild(mkMenu);
  let mkTarget = null;
  function openMkMenu(e, sp, mine) {
    if (e.originalEvent) e.originalEvent.preventDefault();
    mkTarget = { sp: sp, mine: mine };
    mkMenu.innerHTML = '<div data-act="ren">✏️ 改名</div>'
      + '<div data-act="txt">🔤 ' + (showTextOverrides[sp.id] ? '去掉文字' : '补文字') + '</div>'
      + (mine ? '<div data-act="del">🗑 删除</div>' : '');
    mkMenu.style.left = Math.min(e.originalEvent.clientX, window.innerWidth - 155) + 'px';
    mkMenu.style.top = Math.min(e.originalEvent.clientY, window.innerHeight - 80) + 'px';
    mkMenu.style.display = 'block';
  }
  mkMenu.addEventListener('click', (ev) => {
    const act = ev.target.dataset.act;
    mkMenu.style.display = 'none';
    if (!mkTarget || !act) return;
    const sp = mkTarget.sp;
    if (act === 'ren') {
      const isMine = mkTarget.mine;
      const cur = isMine ? sp.name : (nameOverrides[sp.id] || sp.name);
      uiPrompt('改名「' + cur + '」：', cur, (ok, val) => {
        if (!ok || !val) return;
        if (isMine) { sp.name = val; }
        else if (val !== sp.name) { nameOverrides[sp.id] = val; }
        renderMySpots(); renderSpotList(); refreshMarkers(); saveMyData(); revealSpotCard(sp.id);
      });
    } else if (act === 'txt') {
      // 补文字 / 去掉文字：底图上没字的景点才需要（选择持久化，重启不丢）
      if (showTextOverrides[sp.id]) delete showTextOverrides[sp.id];
      else showTextOverrides[sp.id] = 1;
      saveMyData(); refreshMarkers();
      if (mkTarget.mine) renderMySpots();
    } else if (act === 'del' && mkTarget.mine) {
      uiPrompt('删除「' + sp.name + '」？', '', (ok) => {
        if (!ok) return;
        mySpots = mySpots.filter(x => x.id !== sp.id);
        renderMySpots(); renderSpotList(); saveMyData();
      });
    }
  });
  document.addEventListener('click', () => { mkMenu.style.display = 'none'; });
  const btnAnnotate = document.getElementById('btnAnnotate');
  let annotateOn = false;
  const annotateHandler = function(e) {
    setAnnotate(false);
    uiPrompt('给这个地点起个名字：', '', (ok, name) => {
        if (!ok || !name) return;
        var id = 'my' + Date.now();
        var g = toStore(e.latlng.lat, e.latlng.lng);   // 卫星图上取的是 WGS-84，反算回 GCJ-02 再存
        mySpots.push({ id: id, name: name, lat: g[0], lng: g[1] });
        renderMySpots(); renderSpotList(); saveMyData(); revealSpotCard(id);
    });
  };
  function setAnnotate(on) {
    annotateOn = on;
    window.__annotate = on ? annotateHandler : null;   // 仅标注模式开启时拦截左键，平时左键仍查海拔
    if (btnAnnotate) btnAnnotate.classList.toggle('on', on);
    const hint = document.getElementById('mapHint');
    if (hint) {
      hint.innerHTML = on ? '<b>📍 标注模式</b><br>在地图上点击要标注的位置' : '';
      hint.classList.toggle('show', !!on);
    }
  }
  window.__annotate = null;
  if (btnAnnotate) btnAnnotate.addEventListener('click', () => setAnnotate(!annotateOn));

  // 左侧列表右键 = 重命名（官方景点存别名；我的景点直接改名）
  document.getElementById('spotList').addEventListener('contextmenu', function(e) {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    const id = card.dataset.id;
    const mine = mySpots.find(x => x.id === id);
    if (mine) {
      uiPrompt('改名「' + mine.name + '」：', mine.name, (ok, val) => {
          if (!ok || !val) return;
          mine.name = val;
          renderMySpots(); renderSpotList(); saveMyData();
      });
      return;
    }
    const sp = byId[id];
    if (!sp) return;
    const cur = nameOverrides[id] || sp.name;
    uiPrompt('重命名「' + sp.name + '」：', cur, (ok, val) => {
        if (!ok) return;
        if (val && val !== sp.name) {
            nameOverrides[id] = val;
        } else {
            delete nameOverrides[id];
        }
        renderSpotList(); refreshMarkers(); saveMyData();
    });
  });


  /* ---------- 数据装载（启动时、以及一键恢复之后都会调用） ---------- */
  function renderEverything() {
    // ★ 2026-10-02 修复：这里原本还调了 renderPrefs()，但该函数的定义在 10-01 那轮改动中
    //   被删掉（它的 UI 早已改由 prefsTheme / prefsRegion 承担），只留下这个调用。
    //   于是 renderEverything 每次都在这一句抛 ReferenceError（在 Promise.then 里，
    //   表现为静默的 unhandledrejection）→ **renderFoot() 与 refreshMarkers() 全被跳过**：
    //   启动后足迹面板一片空白、地图标记要等第一次拖动/缩放才出现。
    //   删掉这个调用即可，后面每一步都正常执行。
    renderMySpots(); renderCatFilter(); renderSpotList(); renderSavedTrips(); renderFoot(); refreshMarkers();
    setTimeout(() => map.invalidateSize(), 200);
  }

  function loadAllFromStore() {
    Store.get(Store.KEY).then(saved => {
      // 先复位为默认值：恢复较旧的备份时，缺失字段不会残留本次会话的旧内容
      state = { footprint: Footprint.defaultState(), savedTrips: [], days: 2, prefs: [], curCat: 0, curQ: '' };
      mySpots = []; nameOverrides = {}; posOverrides = {}; deletedSpots = []; showTextOverrides = {};
      days = state.days;
      document.getElementById('dayNum').textContent = days;
      if (saved) {
        if (saved.footprint) state.footprint = Object.assign(Footprint.defaultState(), saved.footprint);
        if (saved.savedTrips) state.savedTrips = saved.savedTrips;
        if (saved.days) { days = saved.days; document.getElementById('dayNum').textContent = days; }
        if (saved.prefs) state.prefs = saved.prefs;
        // 恢复"我的景点"与自定义名称（此前未加载，重启即丢）
        if (Array.isArray(saved.mySpots)) mySpots = saved.mySpots;
        if (saved.nameOverrides) nameOverrides = saved.nameOverrides;
        if (saved.posOverrides) posOverrides = saved.posOverrides;
        if (Array.isArray(saved.deletedSpots)) deletedSpots = saved.deletedSpots;
        if (saved.showTextOverrides) showTextOverrides = saved.showTextOverrides;
      }
      // 迁移：市辖区统一归并到所属市（区不单独点亮）
      let mig = false;
      Object.keys(state.footprint.visits).forEach(mid => {
        const rec = state.footprint.visits[mid];
        const oldC = rec.cities || [];
        const cs = Array.from(new Set(oldC.map(cn => isDistrictName(cn) ? (districtCity[cn] || cn) : cn)));
        if (cs.join('|') !== oldC.join('|')) mig = true;
        rec.cities = cs;
      });
      if (mig) save();
      // 迁移：成员颜色去重（旧版按成员数取模取色，删过成员会撞色 —— 超/英同为蓝的根因）
      if (Footprint.dedupeColors(state.footprint)) save();
      applyDeleted();          // 恢复用户删除的景点：从列表与地图同时摘除
      renderEverything();
    });
  }

  /* ---------- 一键备份 / 一键恢复（按钮在顶部搜索框右侧） ---------- */
  let bkTimer = null;
  function bkToast(html, ms) {
    const t = document.getElementById('bkToast');
    if (!t) return;
    t.innerHTML = html;
    t.classList.add('show');
    clearTimeout(bkTimer);
    bkTimer = setTimeout(() => t.classList.remove('show'), ms || 4800);
  }
  function bkResult(m, what) {
    if (!m) { bkToast('「' + what + '」仅桌面版可用（当前运行环境不支持读写本地文件）。', 6500); return false; }
    const i = m.indexOf('|');
    const code = i < 0 ? 'OK' : m.slice(0, i);
    const body = (i < 0 ? m : m.slice(i + 1)).replace(/\n/g, '<br>');
    bkToast(body, code === 'OK' ? 6000 : 7500);
    return code === 'OK';
  }
  /* 备份 / 恢复 / 存档 的统一入口。
     ★ 顺序不能反：先把当前内存状态推到存储槽、等它送达（flushStore），再执行后端动作。
       否则「刚点亮的最后一条」会不在快照里 —— 备份、存档、以及「恢复」时自动存的那份
       保命快照，读的都是同一个槽，三处一起被这个顺序保护。 */
  function bkRun(btn, action, what, after) {
    btn.disabled = true;
    flushStore().catch(function () { /* 送达失败也继续，至少不比旧行为差 */ })
      .then(function () { return Store.backup(action); })
      .then(function (m) {
        btn.disabled = false;
        const ok = bkResult(m, what);
        if (after) after(ok);
      }, function () {
        btn.disabled = false;
        bkResult('', what);
      });
  }
  const _bkBtn = document.getElementById('btnBackup');
  if (_bkBtn) _bkBtn.addEventListener('click', function () { bkRun(_bkBtn, 'export', '备份'); });
  const _rsBtn = document.getElementById('btnRestore');
  if (_rsBtn) _rsBtn.addEventListener('click', function () {
    bkRun(_rsBtn, 'import', '恢复', function (ok) {
      if (ok) loadAllFromStore();   // 恢复后立即刷新左右两侧显示
    });
  });
  /* 一键存档：把当前全部数据写进应用目录的「永久存档」文件夹。
     与「备份」的区别是它不做滚动清理，一份份累加、长期保留 —— 用于重要节点留底。 */
  const _arBtn = document.getElementById('btnArchive');
  if (_arBtn) _arBtn.addEventListener('click', function () { bkRun(_arBtn, 'archive', '存档'); });

  /* ---------- 照片图层：右侧滑出面板 + 顶栏开关与扫描 ---------- */
  /* 面板缩略图网格：格子要做成正方形。
     注意 QtWebEngine 用的是 Chromium 87：既没有 aspect-ratio，网格项上的
     百分比 padding 也解析异常（会把格子高度压成 0.06px，显示成一片横条纹）。
     因此这里不靠 CSS 撑高，而是直接量出 CSS(auto-fill + 1fr) 排好后的真实列宽，
     把它写进 grid-auto-rows —— 列宽由浏览器算，行高由我们同步，必然 1:1。
     列宽只取决于网格容器宽度（与图片是否加载无关），所以量得准、也不用等图片。 */
  function fitPhotoGrid() {
    const b = document.getElementById('ppBody');
    if (!b) return;
    const first = b.querySelector('.pp-item');
    if (!first) return;
    // 列宽由 CSS(auto-fill + 1fr)排定，只取决于容器宽度，与图片是否加载无关。
    // 不要在这里先复位 gridAutoRows —— 复位会让内容瞬间「变矮」而令滚动条消失，
    // 列宽随之跳大，量到的就是偏大的旧尺度，反复触发形成振荡。
    const w = first.getBoundingClientRect().width;
    if (w > 0) b.style.gridAutoRows = w.toFixed(2) + 'px';
  }
  (function () {                                      // 面板宽度随窗口变，需跟着重算
    const b = document.getElementById('ppBody');
    if (!b || !window.ResizeObserver) return;
    try { new ResizeObserver(function () { fitPhotoGrid(); }).observe(b); } catch (e) { /* 忽略 */ }
  })();
  function closePhotoPanel() {
    const p = document.getElementById('photoPanel');
    if (p) p.classList.remove('open');
    const v = document.getElementById('ppViewer');
    if (v) v.classList.remove('show');
    photoUnit = '';
    photoList = [];
    viewerIdx = -1;
  }
  function openPhotoPanel(unit) {
    const p = document.getElementById('photoPanel');
    const b = document.getElementById('ppBody');
    const t = document.getElementById('ppTitle');
    const s = document.getElementById('ppSub');
    if (!p || !b) return;
    photoUnit = unit;
    const info = photoUnits[unit] || {};
    if (t) t.textContent = unit;
    if (s) s.textContent = info.n ? '共 ' + info.n + ' 张' : '';
    b.innerHTML = '<div class="pp-empty">正在读取…</div>';
    p.classList.add('open');
    Store.photos('list', unit).then(function (m) {
      let d = null;
      try { d = m ? JSON.parse(m) : null; } catch (e) { d = null; }
      if (photoUnit !== unit) return;                       // 已切到别的地方，丢弃
      if (!d || !d.ok) { b.innerHTML = '<div class="pp-empty">读取失败</div>'; return; }
      photoList = d.photos || [];
      b.scrollTop = 0;
      renderPhotoGrid();
    });
  }
  /* 渲染面板格子（抽成函数：删除照片后要就地重绘）。
     注意：th 是后端已做过 URL 编码的 file:// 地址，不能再 encodeURI
     （会把 %E6 变成 %25E6，导致文件找不到）。 */
  function renderPhotoGrid() {
    const b = document.getElementById('ppBody');
    if (!b) return;
    if (!photoList.length) {
      b.innerHTML = '<div class="pp-empty">这里没有可显示的照片</div>';
      fitPhotoGrid();
      return;
    }
    b.innerHTML = photoList.map(function (ph, i) {
      const u = ph.th;
      const day = (ph.t || '').slice(0, 10);
      // e=1：EXIF 无经纬度，地点按拍摄时间最接近的照片推断（角标 ≈）
      // m=1：EXIF 无经纬度，地点由用户按拍摄时段指定（角标 📍）
      const est = ph.m
        ? '<i class="est man" title="此照片没有定位信息，地点由你按拍摄时段指定">📍</i>'
        : (ph.e ? '<i class="est" title="此照片没有定位信息，地点按拍摄时间最接近的照片推断">≈</i>' : '');
      return '<div class="pp-item" data-idx="' + i + '" data-full="' + u + '" data-orig="' + (ph.full || '') + '">'
           + '<img loading="lazy" src="' + u + '" alt="">'
           + est
           + (day ? '<div class="d">' + day + '</div>' : '') + '</div>';
    }).join('');
    fitPhotoGrid();                       // 量列宽 → 定行高，保证格子是正方形
  }
  const _ppClose = document.getElementById('ppClose');
  if (_ppClose) _ppClose.addEventListener('click', closePhotoPanel);
  const _viewer = document.getElementById('ppViewer');
  const _viewerImg = document.getElementById('ppViewerImg');
  const _viewerCnt = document.getElementById('ppCount');
  /* 大图取图：不再使用原始大图（4000px 级、数 MB，解码+渲染会让翻页明显卡顿），
     统一走后端按需生成的 1440px 预览图；生成在后台线程，这里用短轮询等结果。
     取到过的地址记进 viewCache，同一张再看直接秒开。 */
  const viewCache = {};
  function fetchView(rel, cb) {
    if (!rel) { cb(''); return; }
    if (viewCache[rel]) { cb(viewCache[rel]); return; }
    let tries = 0;
    (function ask() {
      Store.photos('view', rel).then(function (m) {
        let d = null;
        try { d = JSON.parse(m); } catch (e) { d = null; }
        if (d && d.ok && d.url) { viewCache[rel] = d.url; cb(d.url); return; }
        if (d && d.pending && tries++ < 40) { setTimeout(ask, 250); return; }   // 最多等 10 秒
        cb('');
      });
    })();
  }
  function viewerShow(i) {
    const ph = photoList[i] || {};
    fetchView(ph.f || '', function (url) {
      if (!url || viewerIdx !== i) return;               // 已翻到别张，丢弃
      const img = new Image();
      img.onload = function () {
        if (viewerIdx === i && _viewer && _viewer.classList.contains('show')) _viewerImg.src = url;
      };
      img.src = url;
    });
  }
  function viewerPreload(i) {                            // 预热前后各一张，翻页更跟手
    const n = photoList.length;
    if (n < 2) return;
    [1, -1].forEach(function (k) {
      const j = (((i + k) % n) + n) % n;
      const rel = (photoList[j] || {}).f || '';
      if (!rel) return;
      fetchView(rel, function (url) {
        if (url) { const im = new Image(); im.src = url; }   // 让浏览器先读进内存
      });
    });
  }
  function viewerOpen(i) {
    if (!photoList.length || !_viewerImg) return;
    const n = photoList.length;
    i = ((i % n) + n) % n;                       // 首尾循环
    viewerIdx = i;
    const ph = photoList[i] || {};
    _viewerImg.src = ph.th || '';                // 缩略图已在内存，先秒显占位
    if (_viewerCnt) {
      _viewerCnt.textContent = (i + 1) + ' / ' + n
        + (ph.t ? '　· ' + String(ph.t).slice(0, 10) : '')
        + (ph.m ? '　· 定位按拍摄时段指定' : (ph.e ? '　· 定位按时间推断' : ''));
    }
    if (_viewer) _viewer.classList.add('show');
    viewerShow(i);
    viewerPreload(i);
  }
  if (_viewer) _viewer.addEventListener('click', function (e) {
    if (e.target && e.target.closest && e.target.closest('.pp-nav')) return;  // 点箭头不关闭
    _viewer.classList.remove('show');
  });
  const _pvPrev = document.getElementById('ppPrev');
  const _pvNext = document.getElementById('ppNext');
  if (_pvPrev) _pvPrev.addEventListener('click', function (e) { e.stopPropagation(); viewerOpen(viewerIdx - 1); });
  if (_pvNext) _pvNext.addEventListener('click', function (e) { e.stopPropagation(); viewerOpen(viewerIdx + 1); });
  document.addEventListener('keydown', function (e) {
    if (!_viewer || !_viewer.classList.contains('show')) return;
    if (e.key === 'ArrowLeft') { e.preventDefault(); viewerOpen(viewerIdx - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); viewerOpen(viewerIdx + 1); }
    else if (e.key === 'Escape') { _viewer.classList.remove('show'); }
  });
  document.addEventListener('click', function (e) {
    const it = (e.target && e.target.closest) ? e.target.closest('.pp-item') : null;
    if (!it || !_viewer) return;
    const idx = parseInt(it.getAttribute('data-idx'), 10);
    viewerOpen(isNaN(idx) ? 0 : idx);
  });

  /* ---------- 缩略图右键菜单（中文）＋ 删除照片 ---------- */
  /* QtWebEngine 自带的是英文菜单（「图片另存为」等），在照片面板里一律拦掉，
     换成中文菜单。删除只把**原图送进系统回收站**（可还原），并清理缩略图缓存。 */
  const ppMenu = document.createElement('div');
  ppMenu.id = '__pp_menu';
  ppMenu.style.cssText = 'position:fixed;z-index:21000;display:none;background:#fff;border-radius:8px;'
    + 'box-shadow:0 4px 16px rgba(0,0,0,.25);padding:4px 0;min-width:150px;';
  document.body.appendChild(ppMenu);
  let ppMenuIdx = -1;
  function showPpMenu(e, idx) {
    ppMenuIdx = idx;
    ppMenu.innerHTML = '<div data-act="view">🔍 查看大图</div>'
      + '<div class="sep"></div>'
      + '<div data-act="del" class="danger">🗑 删除这张照片</div>';
    ppMenu.style.display = 'block';
    const w = ppMenu.offsetWidth || 150, h = ppMenu.offsetHeight || 84;
    ppMenu.style.left = Math.max(4, Math.min(e.clientX, window.innerWidth - w - 6)) + 'px';
    ppMenu.style.top = Math.max(4, Math.min(e.clientY, window.innerHeight - h - 6)) + 'px';
  }
  const _ppBodyEl = document.getElementById('ppBody');
  if (_ppBodyEl) _ppBodyEl.addEventListener('contextmenu', function (e) {
    e.preventDefault();                                  // 拦掉英文菜单
    const it = (e.target && e.target.closest) ? e.target.closest('.pp-item') : null;
    if (!it) { ppMenu.style.display = 'none'; return; }
    showPpMenu(e, parseInt(it.getAttribute('data-idx'), 10));
  });
  const _ppPanelEl = document.getElementById('photoPanel');
  if (_ppPanelEl) _ppPanelEl.addEventListener('contextmenu', function (e) {
    if (!(e.target && e.target.closest && e.target.closest('.pp-item'))) e.preventDefault();
  });
  if (_viewer) _viewer.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  document.addEventListener('click', function () { ppMenu.style.display = 'none'; });
  ppMenu.addEventListener('click', function (ev) {
    const act = ev.target && ev.target.dataset ? ev.target.dataset.act : '';
    ppMenu.style.display = 'none';
    if (!act || ppMenuIdx < 0) return;
    if (act === 'view') { viewerOpen(ppMenuIdx); return; }
    if (act === 'del') { confirmDeletePhoto(ppMenuIdx); }
  });

  /* 照片模块专用中文确认框（删除这类操作不能草率） */
  function ppConfirm(title, msg, okText, cb) {
    const box = document.createElement('div');
    box.id = '__pp_confirm';
    box.style.cssText = 'position:fixed;left:0;right:0;top:0;bottom:0;background:rgba(0,0,0,.45);'
      + 'z-index:22000;display:flex;align-items:center;justify-content:center;';
    box.innerHTML =
      '<div style="background:#fff;border-radius:12px;padding:20px 22px;min-width:330px;max-width:78%;'
      + 'box-shadow:0 10px 40px rgba(0,0,0,.35);">'
      + '<div class="cf-t">' + title + '</div>'
      + '<div class="cf-m">' + msg + '</div>'
      + '<div style="display:flex;gap:10px;justify-content:flex-end;">'
      + '<button id="__cf_no" style="background:#eef0f2;color:#374151;">取消</button>'
      + '<button id="__cf_yes" style="background:#c1121f;color:#fff;">' + okText + '</button>'
      + '</div></div>';
    document.body.appendChild(box);
    let done = false;
    function close(v) {
      if (done) return;
      done = true;
      try { document.body.removeChild(box); } catch (e) { /* 忽略 */ }
      document.removeEventListener('keydown', onKey);
      cb(!!v);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      else if (e.key === 'Enter') { e.preventDefault(); close(true); }
    }
    box.querySelector('#__cf_no').onclick = function () { close(false); };
    box.querySelector('#__cf_yes').onclick = function () { close(true); };
    box.onclick = function (e) { if (e.target === box) close(false); };
    document.addEventListener('keydown', onKey);
  }

  function confirmDeletePhoto(idx) {
    const ph = photoList[idx];
    if (!ph) return;
    const name = (ph.f || '').split('/').pop();
    const t = ph.t ? String(ph.t).slice(0, 19) : '未知';
    ppConfirm('删除这张照片？',
      '文件：' + name + '<br>拍摄时间：' + t
      + '<br><br>原图会被移入 <b>系统回收站</b>（可还原），同时从地图上移除。',
      '删除', function (ok) {
        if (!ok) return;
        Store.photos('delete', ph.f).then(function (m) {
          let d = null;
          try { d = JSON.parse(m); } catch (e) { d = null; }
          if (!d || !d.ok) {
            bkToast('删除失败：' + ((d && d.reason) || '未知原因'), 7000);
            return;
          }
          photoList.splice(idx, 1);
          if (viewerIdx >= photoList.length) viewerIdx = photoList.length - 1;
          delete viewCache[ph.f || ''];
          renderPhotoGrid();
          const s = document.getElementById('ppSub');
          if (s) s.textContent = photoList.length ? '共 ' + photoList.length + ' 张' : '';
          bkToast('已删除（可在系统回收站还原）：' + name, 6000);
          if (!photoList.length) { closePhotoPanel(); }
          Store.photos('payload').then(function (m2) {          // 地图上的数字同步
            let d2 = null;
            try { d2 = m2 ? JSON.parse(m2) : null; } catch (e) { d2 = null; }
            if (d2 && d2.ok) applyPhotoPayload(d2);
          });
        });
      });
  }

  const _phBtn = document.getElementById('btnPhotos');
  function applyPhotoPayload(d) {
    photoUnits = {};
    (d.units || []).forEach(function (u) { photoUnits[u.name] = u; });
    photoOn = true;
    if (_phBtn) _phBtn.classList.add('on');
    refreshMarkers();
  }
  if (_phBtn) _phBtn.addEventListener('click', function () {
    if (photoOn) {                                  // 关闭：地图上照片相关内容立刻消失
      photoOn = false; photoUnits = {};
      _phBtn.classList.remove('on');
      closePhotoPanel();
      refreshMarkers();
      return;
    }
    Store.photos('payload').then(function (m) {
      let d = null;
      try { d = m ? JSON.parse(m) : null; } catch (e) { d = null; }
      if (!d || !d.ok) { bkToast('照片功能仅桌面版可用。', 5000); return; }
      if (!d.units || !d.units.length) {
        bkToast('还没有照片索引。请点顶栏的「🔄 扫描」先扫描一次相册。', 7000); return;
      }
      applyPhotoPayload(d);
      bkToast('已显示照片：' + d.units.length + ' 个县市 · ' + d.total + ' 张<br>'
        + '<span style="font-size:12px;opacity:.85">把地图放大到第 8 级以上，县市名后面会出现 (张数)，点它看照片</span>', 7500);
    });
  });

  const _psBtn = document.getElementById('btnPhotoScan');
  function pollScan() {
    clearTimeout(photoPollTimer);
    Store.photos('status').then(function (m) {
      let s = null;
      try { s = m ? JSON.parse(m) : null; } catch (e) { s = null; }
      if (!s || !s.ok) { if (_psBtn) _psBtn.classList.remove('busy'); return; }
      if (s.status === 'scanning') {
        bkToast('正在扫描相册　' + s.done + ' / ' + s.total + '<br>'
          + '<span style="font-size:12px;opacity:.85">' + (s.phase || '') + '（只读，不会改动原照片）</span>', 2500);
        photoPollTimer = setTimeout(pollScan, 800);
        return;
      }
      if (_psBtn) _psBtn.classList.remove('busy');
      if (s.status === 'done') {
        bkToast('扫描完成：' + s.msg + '<br><span style="font-size:12px;opacity:.85">已自动打开照片图层</span>', 8000);
        Store.photos('payload').then(function (m2) {
          let d = null;
          try { d = m2 ? JSON.parse(m2) : null; } catch (e) { d = null; }
          if (d && d.ok && d.units && d.units.length) applyPhotoPayload(d);
        });
      } else if (s.status === 'error') {
        bkToast('扫描出错：' + (s.msg || '未知错误'), 8000);
      }
    });
  }
  if (_psBtn) _psBtn.addEventListener('click', function () {
    if (_psBtn.classList.contains('busy')) return;
    Store.photos('scan', '').then(function (m) {
      let d = null;
      try { d = m ? JSON.parse(m) : null; } catch (e) { d = null; }
      if (!d || !d.ok) { bkToast('照片功能仅桌面版可用。', 5000); return; }
      if (!d.started) { bkToast(d.reason || '正在扫描中…', 3500); return; }
      _psBtn.classList.add('busy');
      bkToast('开始扫描相册（只读，不会改动原照片）…', 3500);
      pollScan();
    });
  });

  /* ---------- 启动 ---------- */
  loadAllFromStore();
})();
