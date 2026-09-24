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

  /* 全量景点去重：同一地点的多种称呼（如"华清宫景区"/"陕西华清宫文化旅游景区"）合并为一个，
     保留名称最简洁、评分最高者。 */
  (function dedupAttractions() {
    const CITY_PREFIX = /^(北京|上海|天津|重庆|陕西|四川|云南|贵州|甘肃|青海|宁夏|新疆|西藏|山西|山东|河南|河北|湖北|湖南|江苏|浙江|安徽|福建|江西|广东|广西|海南|辽宁|吉林|黑龙江|内蒙古|西安|成都|广州|杭州|南京|武汉|长沙|昆明|丽江|大理|贵阳|兰州|乌鲁木齐|哈尔滨|沈阳|长春|石家庄|太原|郑州|合肥|福州|厦门|南昌|济南|青岛|南宁|海口|三亚|拉萨|银川|西宁|呼和浩特|秦皇岛|苏州|无锡|宁波|温州|桂林|泉州|洛阳|开封|延安|宝鸡|汉中|渭南|华阴|临潼|曲江)/g;
    function normName(n) {
      let s = String(n)
        .replace(/[（(][^)）]*[)）]/g, '')
        .replace(/[-·—–\s]/g, '')
        .replace(CITY_PREFIX, '');
      const SUF = /(国家遗址|遗址|文化旅游|旅游区|旅游景区|景区|风景名胜区|风景名胜|度假区|风景区|公园)$/g;
      let prev = '';
      while (prev !== s) { prev = s; s = s.replace(SUF, ''); }
      return s.trim();
    }
    function sameSpot(a, b) {
      if (!a || !b) return false;
      if (a === b) return true;
      if (a.length >= 3 && b.length >= 3) {
        if (b.startsWith(a) || a.startsWith(b)) return true;
      }
      return false;
    }
    const byProv = {};
    AT.forEach(s => { (byProv[s.province] = byProv[s.province] || []).push(s); });
    const keepIds = new Set();
    Object.keys(byProv).forEach(p => {
      const list = byProv[p];
      list.sort((a, b) => (b.rating * 10 + (b.level === '5A' ? 8 : b.level === '4A' ? 3 : 0)) -
                          (a.rating * 10 + (a.level === '5A' ? 8 : a.level === '4A' ? 3 : 0)));
      const seen = [];
      list.forEach(s => {
        const k = normName(s.name);
        const dup = seen.find(x => {
          const d = x.sp;
          return sameSpot(k, x.k) ||
            (Math.abs(d.lat - s.lat) < 0.01 && Math.abs(d.lng - s.lng) < 0.01);
        });
        if (dup) {
          if (s.name.length < dup.sp.name.length) {
            keepIds.delete(dup.sp.id);
            keepIds.add(s.id);
            dup.k = k; dup.sp = s;
          }
        } else {
          seen.push({ k: k, sp: s });
          keepIds.add(s.id);
        }
      });
    });
    for (let i = AT.length - 1; i >= 0; i--) {
      if (!keepIds.has(AT[i].id)) AT.splice(i, 1);
    }
    console.log('[dedup] 景点去重后剩余', AT.length, '个');
  })();

  /* 补全缺失的5A景区（在去重后追加，避免被去重逻辑误删） */
  (function addMissing5A() {
    const list = [
      {id:92000,name:'天津古文化街旅游区',province:'天津市',city:'天津市',county:'南开区',lat:39.14,lng:117.19,level:'5A',rating:4.8,dur:2,cat:'文化古迹',ticket:0},
      {id:92001,name:'衡水湖旅游景区',province:'河北省',city:'衡水市',county:'衡水市',lat:37.54,lng:115.66,level:'5A',rating:4.6,dur:3,cat:'自然景观',ticket:60},
      {id:92002,name:'唐山南湖开滦旅游景区',province:'河北省',city:'唐山市',county:'唐山市',lat:39.63,lng:118.18,level:'5A',rating:4.6,dur:3,cat:'自然景观',ticket:0},
      {id:92003,name:'中共一大二大四大纪念馆景区',province:'上海市',city:'上海市',county:'黄浦区',lat:31.23,lng:121.47,level:'5A',rating:4.8,dur:2,cat:'文化古迹',ticket:0},
      {id:92004,name:'福州三坊七巷景区',province:'福建省',city:'福州市',county:'福州市',lat:26.08,lng:119.30,level:'5A',rating:4.7,dur:3,cat:'文化古迹',ticket:0},
      {id:92005,name:'泰宁风景旅游区',province:'福建省',city:'三明市',county:'泰宁县',lat:26.91,lng:117.18,level:'5A',rating:4.6,dur:3,cat:'自然景观',ticket:100},
      {id:92006,name:'武夷山风景名胜区',province:'福建省',city:'南平市',county:'武夷山市',lat:27.73,lng:117.99,level:'5A',rating:4.8,dur:4,cat:'自然景观',ticket:140},
      {id:92007,name:'连州地下河旅游景区',province:'广东省',city:'清远市',county:'连州市',lat:24.78,lng:112.37,level:'5A',rating:4.6,dur:2,cat:'自然景观',ticket:120},
      {id:92008,name:'百色起义纪念园景区',province:'广西壮族自治区',city:'百色市',county:'百色市',lat:23.90,lng:106.62,level:'5A',rating:4.6,dur:2,cat:'文化古迹',ticket:0},
      {id:92009,name:'两江四湖象山景区',province:'广西壮族自治区',city:'桂林市',county:'桂林市',lat:25.26,lng:110.29,level:'5A',rating:4.7,dur:3,cat:'自然景观',ticket:115},
      {id:92010,name:'独秀峰靖江王城景区',province:'广西壮族自治区',city:'桂林市',county:'桂林市',lat:25.27,lng:110.29,level:'5A',rating:4.6,dur:2,cat:'文化古迹',ticket:100},
      {id:92011,name:'延安革命纪念地景区',province:'陕西省',city:'延安市',county:'延安市',lat:36.59,lng:109.49,level:'5A',rating:4.7,dur:3,cat:'文化古迹',ticket:0},
      {id:92012,name:'城墙碑林历史文化景区',province:'陕西省',city:'西安市',county:'西安市',lat:34.26,lng:108.94,level:'5A',rating:4.7,dur:3,cat:'文化古迹',ticket:54},
      {id:92013,name:'六盘山红军长征旅游区',province:'宁夏回族自治区',city:'固原市',county:'泾源县',lat:35.45,lng:106.30,level:'5A',rating:4.6,dur:2,cat:'文化古迹',ticket:0},
      {id:92014,name:'东方明珠广播电视塔',province:'上海市',city:'上海市',county:'浦东新区',lat:31.24,lng:121.50,level:'5A',rating:4.7,dur:2,cat:'现代人文',ticket:220},
    ];
    list.forEach(s => { if (!AT.find(x => x.id === s.id)) AT.push(s); });
    /* 升级已有景点为5A（data_bundle里可能是4A，但官方是5A） */
    var upgradeNames = ['万绿湖','惠州西湖','罗浮山','丹霞山','涠洲岛','乾陵','互助土族故土园','厦门园林植物园','东方明珠','塔尔寺','青海湖','沙坡头','镇北堡','水洞沟','青铜峡','沙湖','六盘山国家森林公园'];
    upgradeNames.forEach(function(nm){
      AT.forEach(function(s){
        if (s.name.indexOf(nm) >= 0 && s.level !== '5A') { s.level = '5A'; }
      });
    });
    console.log('[add5A] 补全5A后总计', AT.length, '个景点, 其中5A', AT.filter(x=>x.level==='5A').length, '个');
  })();

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

  const CATS = { 1: '历史古迹', 2: '自然风光', 3: '宗教文化', 4: '园林公园', 5: '博物馆/科教', 6: '主题乐园', 7: '古城古镇', 8: '海滨/水域', 9: '都市地标', 10: '民俗文化' };
  const CAT_COLORS = { 1: '#b07643', 2: '#3fa66d', 3: '#9b6dd7', 4: '#4caf8a', 5: '#4e9af1', 6: '#e05d6b', 7: '#d98a4b', 8: '#3fb8c4', 9: '#7a869a', 10: '#c9674a' };
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

  function save() { Store.set(Store.KEY, state); }

  /* ---------- 地图 ---------- */
  const map = L.map('map', { attributionControl: false, zoomControl: false }).setView([35.6, 105.5], 4);
  window.__map = map;
  window.__fly = function (name) {
    const c = CITIES.find(x => x.name === name) || COUNTIES.find(x => x.name === name);
    if (c) map.setView([c.center[1], c.center[0]], COUNTIES.some(x => x.name === name) ? 10 : 9, { animate: false });
  };
  L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}',
    { subdomains: ['1', '2', '3', '4'], maxZoom: 18, minZoom: 3 }).addTo(map);
  L.control.zoom({ position: 'bottomright' }).addTo(map);

  const provLayer = L.layerGroup().addTo(map);
  const cityLayer = L.layerGroup().addTo(map);
  const spotLayer = L.layerGroup().addTo(map);
  const routeLayer = L.layerGroup().addTo(map);
  const litLayer = L.layerGroup().addTo(map);

  function shortProv(n) {
    return n.replace('壮族自治区', '').replace('回族自治区', '').replace('维吾尔自治区', '').replace(/省|市|自治区|特别行政区/g, '');
  }
  function divIcon(html, size) {
    return L.divIcon({ className: '', html: html, iconSize: [size, size], iconAnchor: [size / 2, size / 2], popupAnchor: [0, -size / 2] });
  }

  // 单击直接点亮（不飞行、地图保持，便于连续点亮）
  function doToggleCity(name) {
    const fp = state.footprint;
    const pref = CITIES.find(c => c.name === name);
    if (pref) {
      // 地级市 / 直辖市：整体点亮或取消（不带动景点）
      const subs = countyOfCity[name] || [];
      Footprint.togglePrefecture(fp, name, subs);
    } else {
      // 县 / 县级市：所属市已整体点亮则不单独操作
      const cr = COUNTIES.find(c => c.name === name);
      const parent = cr && (cr.city || (MUNI.includes(cr.province) ? cr.province : null));
      if (parent && Footprint.isCityLit(fp, parent)) return;
      Footprint.toggleCity(fp, name);
    }
    save(); refreshMarkers(); renderFoot();
  }
  function doToggleSpot(sp) {
    Footprint.markSpot(state.footprint, sp);
    save(); refreshMarkers(); renderFoot();
  }
  function refreshMarkers() {
    map.closePopup();
    provLayer.clearLayers(); cityLayer.clearLayers(); spotLayer.clearLayers();
    const z = map.getZoom();
    const vb = map.getBounds().pad(0.5);   // 视野裁剪盒（含缓冲），只渲染可见区域
    const lit = Footprint.litMap(state.footprint);
    const footMode = (curTab === 'foot');   // 足迹 tab：单击即点亮
    const HIT = 30;                              // 统一命中区，视觉再小也容易点中
    const hitWrap = inner => `<div style="width:${HIT}px;height:${HIT}px;display:flex;align-items:center;justify-content:center">${inner}</div>`;
    const PLANE = px => `<svg class="plane" width="${px}" height="${px}" viewBox="0 0 24 24"><path fill="#fff" d="M21 16v-2l-8-5V3.5C13 2.67 12.33 2 11.5 2S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5L21 16z"/></svg>`;
    function bindCity(m, c, isLit, vis) {
      if (footMode) m.on('click', function () { doToggleCity(c.name); linkToLeft('city', c.name); });
      else { m.bindPopup(cityPop(c, isLit, vis)); m.on('click', function () { linkToLeft('city', c.name); }); }
    }

    if (z <= 5) {
      PROVS.forEach(pr => {
        const litN = countProvLit(pr.name, lit);
        const m = L.marker([pr.center[1], pr.center[0]], {
          icon: divIcon(`<div class="city-marker prov-marker ${litN ? 'lit' : 'normal'}" style="width:46px;height:46px;font-size:13px">${shortProv(pr.name)}${litN ? `<br><small style="font-size:9px;opacity:.95">${litN}城</small>` : ''}</div>`, 50)
        });
        m.bindPopup(provPop(pr, litN));
        m.on('click', function () { linkToLeft('prov', pr.name); });
        provLayer.addLayer(m);
      });
    } else if (z <= 7) {
      CITIES.forEach(c => {
        if (!vb.contains([c.center[1], c.center[0]])) return;
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
        const m = L.marker([c.center[1], c.center[0]], { icon: divIcon(hitWrap(inner), HIT), zIndexOffset: 1000 });
        bindCity(m, c, isLit, vis);
        cityLayer.addLayer(m);
      });
    } else if (z <= 9) {
      CITIES.forEach(c => {
        if (!vb.contains([c.center[1], c.center[0]])) return;
        const fullLit = !!lit[c.name];
        const subN = (countyOfCity[c.name] || []).filter(n => lit[n]).length;
        const isLit = fullLit;
        const vis = isLit ? memberName(lit[c.name][0]) : (subN > 0 ? `下属 ${subN} 个县/市有足迹` : '');
        const inner = isLit
          ? `<div class="city-marker lit" style="width:30px;height:30px;position:relative">${PLANE(17)}<div class="mk-name">${c.name}</div></div>`
          : (subN > 0
            ? `<div class="city-marker partial" style="width:30px;height:30px;position:relative">${PLANE(17)}<div class="mk-name w" style="display:none">${c.name}</div></div>`
            : `<div class="city-marker normal" style="width:15px;height:15px"><div class="mk-name w" style="display:none">${c.name}</div></div>`);
        const m = L.marker([c.center[1], c.center[0]], { icon: divIcon(hitWrap(inner), HIT), zIndexOffset: 1000 });
        bindCity(m, c, isLit, vis);
        cityLayer.addLayer(m);
      });
      const NAME_GRID2 = 130;
      const usedNm2 = new Set();
      COUNTIES.forEach(c => {
        if (isDistrictName(c.name)) return;
        if (!vb.contains([c.center[1], c.center[0]])) return;
        const isLit = !!lit[c.name];
        const n = (byCity[c.name] || []).length;
        const base = isLit ? 28 : (n ? 12 : 9);
        let litNm = false;
        if (isLit) {
          const pp = map.latLngToContainerPoint([c.center[1], c.center[0]]);
          const k = Math.floor(pp.x / NAME_GRID2) + ',' + Math.floor(pp.y / NAME_GRID2);
          if (!usedNm2.has(k)) { usedNm2.add(k); litNm = true; }
        }
        const inner = isLit
          ? `<div class="city-marker lit" style="width:28px;height:28px;position:relative">${PLANE(16)}<div class="mk-name" ${litNm ? '' : 'style="display:none"'}>${c.name}</div></div>`
          : `<div class="city-marker normal" style="width:${base}px;height:${base}px">${n ? '·' : ''}<div class="mk-name w" style="display:none">${c.name}</div></div>`;
        const m = L.marker([c.center[1], c.center[0]], { icon: divIcon(hitWrap(inner), HIT) });
        bindCity(m, c, isLit, isLit ? lit[c.name].map(id => memberName(id)).join('、') : '');
        cityLayer.addLayer(m);
      });
    } else {
      // 名称防重叠：高分/点亮优先占网格，每个网格只显示一个名称；缩放越大显示越多
      const NAME_GRID = z >= 12 ? 120 : z >= 11 ? 150 : 190;
      const usedNm = new Set();
      const spots = AT.filter(sp => vb.contains([sp.lat, sp.lng]));
      spots.sort((x, y) => {
        const rx = (x.level === '5A' ? 4 : x.level === '4A' ? 3 : x.level === '3A' ? 2 : 1) * 10 + (Footprint.isSpotDone(state.footprint, x) ? 100 : 0);
        const ry = (y.level === '5A' ? 4 : y.level === '4A' ? 3 : y.level === '3A' ? 2 : 1) * 10 + (Footprint.isSpotDone(state.footprint, y) ? 100 : 0);
        return ry - rx;
      });
      spots.forEach(sp => {
        const done = Footprint.isSpotDone(state.footprint, sp);
        const lv = sp.level;
        const is5 = lv === '5A', is4 = lv === '4A', is3 = lv === '3A';
        // 圆点 1.5 倍，级别数字清晰：5A 27px / 4A 24px / 3A 21px / 普通 18px
        const sz = is5 ? 27 : is4 ? 24 : is3 ? 21 : 18;
        const cls = (is5 ? 'a5' : is4 ? 'a4' : is3 ? 'a3' : (done ? 'lit' : 'normal')) + (done ? ' done' : '');
        const rank = is5 ? 4 : sp.level === '4A' ? 3 : sp.level === '3A' ? 2 : 1;
        const wantNm = done || z >= 12 || (z >= 11 && rank >= 3) || (z >= 10 && rank >= 4);
        let showNm = false;
        if (wantNm) {
          const pp = map.latLngToContainerPoint([sp.lat, sp.lng]);
          const k = Math.floor(pp.x / NAME_GRID) + ',' + Math.floor(pp.y / NAME_GRID);
          if (!usedNm.has(k)) { usedNm.add(k); showNm = true; }
        }
        const nm = showNm ? `<div class="mk-name ${done ? '' : 'w'}">${sp.name}</div>` : '';
        const lvNum = is5 ? '<b>5</b>' : is4 ? '<b>4</b>' : is3 ? '<b>3</b>' : '';
        const inner = `<div class="spot-marker ${cls}" style="width:${sz}px;height:${sz}px">${done ? PLANE(is5 ? 17 : is4 ? 14 : 12) : lvNum}${nm}</div>`;
        const m = L.marker([sp.lat, sp.lng], { icon: divIcon(hitWrap(inner), Math.max(HIT, sz + 2)) });
        if (footMode) m.on('click', function () {
          doToggleSpot(sp);
          linkToLeft('city', Footprint.normCity(sp.county || sp.city));
        });
        else { m.bindPopup(spotPop(sp)); m.on('click', function () { linkToLeft('spot', sp.id); }); }
        spotLayer.addLayer(m);
      });
    }
    // 高缩放兜底：无景点的点亮县（如固始县）红飞机
    litLayer.clearLayers();
    if (z >= 10) {
      const fp = state.footprint;
      const rec = fp.visits[fp.active];
      if (rec) rec.cities.forEach(cn => {
        const ctr = cityCenter[cn];
        if (!ctr) return;
        if (!vb.contains([ctr[1], ctr[0]])) return;
        if ((byCity[cn] || []).length) return;   // 有景点的已由景点 marker 显示，避免重叠
        const inner = `<div class="city-marker lit" style="width:28px;height:28px;position:relative">${PLANE(16)}<div class="mk-name">${cn}</div></div>`;
        const m = L.marker([ctr[1], ctr[0]], { icon: divIcon(hitWrap(inner), HIT) });
        if (footMode) m.on('click', function () { doToggleCity(cn); linkToLeft('city', cn); });
        else { m.bindPopup(cityPop({ name: cn }, true, memberName(fp.active))); m.on('click', function () { linkToLeft('city', cn); }); }
        litLayer.addLayer(m);
      });
    }
  }
  /* ---------- 地图与左侧双向联动 ---------- */
  function flashCard(el) {
    if (!el) return;
    const box = el.closest('.list');
    el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash');
    if (box) box.scrollTop = el.offsetTop - box.clientHeight / 2 + el.clientHeight / 2;
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
    if (pr) map.flyTo([pr.center[1], pr.center[0]], 6, { duration: .7 });
  }
  function memberName(id) { const m = state.footprint.members.find(x => x.id === id); return m ? m.name : ''; }
  function countProvLit(provName, lit) {
    let n = 0;
    CITIES.filter(c => c.province === provName).forEach(c => { if (cityLit(lit, c.name)) n++; });
    COUNTIES.filter(c => c.province === provName).forEach(c => { if (lit[c.name]) n++; });
    return n;
  }

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
  function spotPop(s) {
    const done = Footprint.isSpotDone(state.footprint, s);
    const active = state.footprint.members.find(m => m.id === state.footprint.active);
    return `<div class="pop-card">
      <h4>${s.name}${s.level === '5A' ? '<span class="badge a5">5A</span>' : (s.level === '4A' ? '<span class="badge">4A</span>' : '')}</h4>
      <div class="pinfo">📍 ${s.province} · ${Footprint.normCity(s.city)}<br>🎫 ${ticketTxt(s)}　🕘 ${s.open || ''}<br>⏱ 建议游玩 ${s.dur || 3} 小时　⭐ ${s.rating || 4.5}</div>
      <div class="pintro">${s.intro || ''}</div>
      <div class="ptags">${(s.tags || []).map(t => `<span>${t}</span>`).join('')}</div>
      <div class="pbtns">
        <button class="go" data-act="goplan" data-city="${Footprint.normCity(s.city)}">规划此城行程</button>
        <button class="done" data-act="done" data-id="${s.id}">${done ? '取消去过' : '标记去过(' + active.name + ')'}</button>
      </div></div>`;
  }
  function cityPop(c, isLit, vis) {
    const n = (byCity[c.name] || []).length;
    return `<div class="pop-card"><h4>${c.name}${isLit ? '<span class="badge a5">已点亮</span>' : ''}</h4>
      <div class="pinfo">收录景点 ${n} 个${isLit ? '<br>去过的成员：' + vis : ''}</div>
      <div class="pbtns">
        <button class="go" data-act="goplan" data-city="${c.name}">规划行程</button>
        <button class="done" data-act="lcity" data-city="${c.name}">${isLit ? '取消点亮' : '点亮城市'}</button>
      </div></div>`;
  }
  function provPop(p, litN) {
    return `<div class="pop-card"><h4>${p.name}</h4>
      <div class="pinfo">${litN ? '已点亮 ' + litN + ' 个城市' : '点击下方按钮查看全省城市'}</div>
      <div class="pbtns"><button class="go" data-act="zoomin" data-lng="${p.center[0]}" data-lat="${p.center[1]}">查看城市</button></div></div>`;
  }

  map.on('popupopen', function (e) {
    const el = e.popup.getElement();
    el.querySelectorAll('[data-act]').forEach(b => {
      b.addEventListener('click', function () {
        const act = b.dataset.act;
        if (act === 'done') {
          Footprint.markSpot(state.footprint, byId[b.dataset.id]);
          save(); refreshMarkers(); renderFoot();
        } else if (act === 'lcity') {
          const ids = (byCity[b.dataset.city] || []).map(x => x.id);
          Footprint.toggleCity(state.footprint, b.dataset.city, ids);
          save(); refreshMarkers(); renderFoot();
        } else if (act === 'goplan') {
          switchTab('plan');
          document.getElementById('planCity').value = b.dataset.city;
          map.closePopup();
          if (window.innerWidth <= 768) document.getElementById('panel').classList.add('open');
        } else if (act === 'zoomin') {
          map.flyTo([+b.dataset.lat, +b.dataset.lng], 7, { duration: .6 });
        }
      });
    });
  });
  map.on('moveend', refreshMarkers);   // 缩放/拖动结束才重建（视野裁剪后开销小）

  function flySpot(s) {
    let done = false;
    function tryOpen() {
      if (done) return;
      let found = null;
      spotLayer.eachLayer(m => {
        if (!m.getLatLng) return;
        const ll = m.getLatLng();
        if (Math.abs(ll.lat - s.lat) < .002 && Math.abs(ll.lng - s.lng) < .002) found = m;
      });
      if (found) { done = true; found.openPopup(); }
    }
    const b = PROV_BOUNDS[s.province];
    if (b) {
      map.fitBounds([[b.minLat, b.minLng], [b.maxLat, b.maxLng]], { padding: [50, 50], duration: .6 });
      // 动画结束后打开景点信息窗；若中途被视图刷新关闭则二次兜底重开
      const openPop = () => {
        if (typeof spotPop !== 'function') return;
        try { L.popup().setLatLng([s.lat, s.lng]).setContent(spotPop(s)).openOn(map); }
        catch (e) { /* 忽略瞬时异常，下次重试 */ }
      };
      setTimeout(openPop, 800);
      setTimeout(openPop, 1700);
    } else if (map.getZoom() < 10) {
      map.once('zoomend', () => setTimeout(tryOpen, 80));
      map.flyTo([s.lat, s.lng], 10, { duration: .6 });
      setTimeout(tryOpen, 800);
    } else {
      map.flyTo([s.lat, s.lng], map.getZoom(), { duration: .5 });
      setTimeout(tryOpen, 550);
    }
  }
  function flyCity(name) {
    let c = CITIES.find(x => x.name === name);
    let z = 9;
    if (!c) { c = COUNTIES.find(x => x.name === name); z = 10; }
    if (c) map.flyTo([c.center[1], c.center[0]], z, { duration: .6 });
  }

  /* ---------- Tab ---------- */
  const mapHint = document.getElementById('mapHint');
  let curTab = 'spots';
  function showMapHint(html) { mapHint.innerHTML = html; mapHint.classList.add('show'); }
  function hideMapHint() { mapHint.classList.remove('show'); }

  function syncMapToTab(t) {
    hideMapHint();
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
    }
  }

  function switchTab(t) {
    curTab = t;
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
    return '';
  }
  function renderSpotList() {
    let arr = AT;
    const provMode = state.provMode && state.provMode.length;
    if (provMode) {
      arr = arr.filter(s => state.provMode.includes(s.province));
    } else {
      if (state.curCat) arr = arr.filter(s => s.cat === state.curCat);
      if (state.curQ) arr = arr.filter(s => s.name.includes(state.curQ) || Footprint.normCity(s.city).includes(state.curQ) || s.province.includes(state.curQ) || (s.county || '').includes(state.curQ));
    }
    arr = [...arr].sort(spotOrder);
    if (!provMode && !state.curQ) arr = arr.slice(0, 80);
    if (!provMode) arr = arr.slice(0, 200);
    const box = document.getElementById('spotList');
    const head = provMode ? `<div class="prov-head">🗺 ${state.provMode.join(' · ')} 全部景点 ${arr.length} 个</div>` : '';
    box.scrollTop = 0;
    box.innerHTML = head + (arr.length ? arr.map(s => `<div class="card" data-id="${s.id}">
      <div class="t"><span class="sp-name">${levelBadge(s)}${s.name}</span>${s.ticket ? `<span class="sp-ticket">${ticketTxt(s)}</span>` : ''}</div>
      <div class="d">${provMode ? s.province + ' · ' : ''}${Footprint.normCity(s.city)} · ${CATS[s.cat]}<br>${(s.intro || '').slice(0, 46)}…</div></div>`).join('')
      : '<div class="empty">没有找到相关景点，换个关键词试试。</div>');
    box.querySelectorAll('.card').forEach(c => c.addEventListener('click', () => {
      const s = byId[c.dataset.id];
      if (c.dataset.selected === '1') {
        // 第二次点击同一张：地图放大到该景点 + 圆点闪烁
        map.setView([s.lat, s.lng], 13, { animate: true });
        spotLayer.eachLayer(m => {
          const ll = m.getLatLng && m.getLatLng();
          if (ll && Math.abs(ll.lat - s.lat) < 0.001 && Math.abs(ll.lng - s.lng) < 0.001) {
            const el = m.getElement();
            if (el) {
              const inner = el.querySelector('.spot-marker') || el;
              inner.classList.remove('flash-spot');
              void inner.offsetWidth;
              inner.classList.add('flash-spot');
              setTimeout(() => inner.classList.remove('flash-spot'), 3200);
            }
          }
        });
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
  function renderCatFilter() {
    const all = `<button class="chip ${!state.curCat ? 'on' : ''}" data-cat="0">全部</button>`;
    const chips = Object.keys(CATS).map(k => `<button class="chip ${state.curCat == k ? 'on' : ''}" data-cat="${k}"><span class="dotmini" style="background:${CAT_COLORS[k]}"></span>${CATS[k]}</button>`).join('');
    document.getElementById('catFilter').innerHTML = all + chips;
    document.getElementById('catFilter').querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
      state.curCat = +c.dataset.cat; save(); renderCatFilter(); renderSpotList();
    }));
  }

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
      map.flyTo([provHit.center[1], provHit.center[0]], 6, { duration: .6 });
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
      switchTab('spots'); state.curQ = cc.name; renderSpotList(); flyCity(cc.name);
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
  document.getElementById('dayPlus').addEventListener('click', () => { days = Math.min(8, days + 1); dayNum.textContent = days; state.days = days; save(); });
  function setPlanMode(m) {
    planMode = m;
    document.getElementById('modeTransit').classList.toggle('on', m === 'transit');
    document.getElementById('modeDrive').classList.toggle('on', m === 'drive');
  }
  document.getElementById('modeTransit').addEventListener('click', () => setPlanMode('transit'));
  document.getElementById('modeDrive').addEventListener('click', () => setPlanMode('drive'));

  function renderPrefs() {
    document.getElementById('prefs').innerHTML = Object.keys(CATS).map(k =>
      `<button class="chip ${state.prefs.includes(+k) ? 'on' : ''}" data-cat="${k}">${CATS[k]}</button>`).join('');
    document.getElementById('prefs').querySelectorAll('.chip').forEach(c => c.addEventListener('click', () => {
      const k = +c.dataset.cat, i = state.prefs.indexOf(k);
      if (i >= 0) state.prefs.splice(i, 1); else state.prefs.push(k);
      save(); renderPrefs();
    }));
  }

  function matchCity(q) {
    q = Footprint.normCity(q);
    let c = CITIES.find(x => x.name === q);
    if (!c) c = CITIES.find(x => x.name.includes(q) || q.includes(x.name));
    if (!c) c = COUNTIES.find(x => x.name === q);
    return c;
  }

  document.getElementById('btnPlan').addEventListener('click', function () {
    const q = document.getElementById('planCity').value;
    let c = matchCity(q);
    // 省份模式：输入省名（如"四川"）→ 全省景点排程
    if (!c) {
      const prov = PROVS.find(p => p.name === q || shortProv(p.name) === q);
      if (prov) {
        const candidates = AT.filter(s => s.province === prov.name);
        if (!candidates.length) {
          document.getElementById('planResult').innerHTML = '<div class="empty">该省暂无景点数据。</div>';
          return;
        }
        const res = Planner.plan(candidates, days, new Set(state.prefs), { lng: prov.center[0], lat: prov.center[1] }, planMode);
        lastPlan = { city: prov.name, days: days, prefs: [...state.prefs], res: res };
        renderPlan(lastPlan, false);
        drawRoutes(res);
        return;
      }
    }
    const candKey = c ? c.name : q;
    const candidates = byCityAll[candKey] || byCity[candKey];
    if (!c || !candidates || !candidates.length) {
      document.getElementById('planResult').innerHTML = '<div class="empty">请输入有效的城市或省份名称，如：成都市、四川。</div>';
      return;
    }
    const center = cityCenter[c.name] || [candidates.reduce((a, s) => a + s.lng, 0) / candidates.length, candidates.reduce((a, s) => a + s.lat, 0) / candidates.length];
    const res = Planner.plan(candidates, days, new Set(state.prefs), { lng: center[0], lat: center[1] }, planMode);
    lastPlan = { city: c.name, days: days, prefs: [...state.prefs], res: res };
    renderPlan(lastPlan, false);
    drawRoutes(res);
  });

  function renderPlan(plan, saved) {
    const { city, days, res } = plan;
    let html = '';
    if (res.warnings.length) html += `<div class="card" style="background:#fdf6ea;border-color:#eedcb8"><div class="d">${res.warnings.join('<br>')}</div></div>`;
    if (res.totalPlans && res.totalPlans > 1) html += `<div style="margin:8px 0;text-align:center"><button data-act="nextplan" style="padding:6px 18px;background:#4a7cf7;color:#fff;border:none;border-radius:16px;cursor:pointer;font-size:14px">🔄 换一套方案（当前共${res.totalPlans}套）</button></div>`;
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
      const p = map.latLngToContainerPoint([lat, lng]);
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
      const latlngs = d.route.map(s => [s.lat, s.lng]);
      all.push(...latlngs);
      routeLayer.addLayer(L.polyline(latlngs, { color: color, weight: 4, opacity: .95, dashArray: '6 5' }));
      d.route.forEach(s => {
        const showNm = zoomOK && nmShow(s.lat, s.lng, s.name);
        const mk = L.marker([s.lat, s.lng], {
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
    if (np) { window.__tplIdx = (window.__tplIdx || 0) + 1; document.getElementById('btnPlan').click(); return; }
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
  function renderFoot() {
    const st = state.footprint;
    const s = Footprint.stats(st, FOOT_TOTAL);
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
    box.innerHTML = provOrder.map(pr => {
      const items = byProv[pr]
        .map(n => {
          const litN = (lit[n] || []).length;
          const mine = Footprint.isCityLit(st, n);
          const isCounty = COUNTIES.some(c => c.name === n);
          const nSp = (byCity[n] || []).length;
          const tag = litN ? '👣' + litN + '人' : (nSp ? nSp + '景' : '无景点');
          return `<div class="card city-row" data-city="${n}">
            <div class="t">${isCounty ? '▸ ' : ''}${n}</div>
            <span class="lit">${tag}</span>
            <div class="toggle ${mine ? 'on' : ''}"></div></div>`;
        }).join('');
      const collapsed = provHasLit(pr) ? '' : ' collapsed';
      return `<div class="prov-group${collapsed}"><div class="prov-title">${pr}</div>${items}</div>`;
    }).join('');
    box.querySelectorAll('.city-row').forEach(r => r.addEventListener('click', () => doToggleCity(r.dataset.city)));
    box.querySelectorAll('.prov-title').forEach(t => t.addEventListener('click', () => {
      t.parentElement.classList.toggle('collapsed');
    }));
  }
  document.getElementById('btnAddMember').addEventListener('click', function () {
    const inp = document.getElementById('newMember');
    if (Footprint.addMember(state.footprint, inp.value)) { inp.value = ''; save(); renderFoot(); refreshMarkers(); }
  });
  document.getElementById('newMember').addEventListener('keydown', e => { if (e.key === 'Enter') document.getElementById('btnAddMember').click(); });
  document.getElementById('btnClearFoot').addEventListener('click', function () {
    const st = state.footprint;
    const rec = st.members.find(m => m.id === st.active);
    const nm = rec ? rec.name : '当前成员';
    if (confirm('确定要清除「' + nm + '」的全部足迹吗？此操作不可恢复。')) {
      Footprint.clearVisits(st, st.active);
      save(); renderFoot(); refreshMarkers();
    }
  });

  /* ---------- 全屏 / 面板 / 复位 ---------- */
  document.getElementById('btnFull').addEventListener('click', () => {
    const wrap = document.getElementById('mapWrap');
    if (!document.fullscreenElement) {
      (wrap.requestFullscreen || wrap.webkitRequestFullscreen).call(wrap);
    } else document.exitFullscreen();
  });
  document.addEventListener('fullscreenchange', () => {
    const on = !!document.fullscreenElement;
    document.getElementById('mapWrap').classList.toggle('fullscreen', on);
    document.body.classList.toggle('fs', on);
    setTimeout(() => map.invalidateSize(), 100);
  });
  document.getElementById('panelToggle').addEventListener('click', () => {
    document.getElementById('panel').classList.toggle('open');
  });
  document.getElementById('btnLocate').addEventListener('click', () => {
    map.flyTo([35.6, 105.5], 4, { duration: .7 });
    routeLayer.clearLayers(); document.getElementById('mapLegend').classList.remove('show');
  });
  window.addEventListener('resize', () => map.invalidateSize());

  /* ---------- 启动 ---------- */
  Store.get(Store.KEY).then(saved => {
    if (saved) {
      if (saved.footprint) state.footprint = Object.assign(Footprint.defaultState(), saved.footprint);
      if (saved.savedTrips) state.savedTrips = saved.savedTrips;
      if (saved.days) { days = saved.days; document.getElementById('dayNum').textContent = days; }
      if (saved.prefs) state.prefs = saved.prefs;
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
    renderCatFilter(); renderSpotList(); renderPrefs(); renderSavedTrips(); renderFoot(); refreshMarkers();
    setTimeout(() => map.invalidateSize(), 200);
  });
})();
