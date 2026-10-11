/* 足迹：多成员管理、城市点亮、统计。数据由 app.js 统一持久化，本文件提供逻辑。 */
const Footprint = (function () {
  const COLORS = ['#e8a33d', '#4e9af1', '#e05d6b', '#52b788', '#9b6dd7', '#ee8f4a', '#3fb8c4', '#c9674a'];

  function defaultState() {
    return {
      members: [{ id: 'm1', name: '我', color: COLORS[0] }],
      visits: { m1: { cities: [], spots: [] } },
      selected: ['m1'],
      active: 'm1'
    };
  }
  // 城市名规范化（去掉“（与…共有）”等备注）
  function normCity(name) {
    return String(name || '').replace(/（[\s\S]*?）/g, '').replace(/\([\s\S]*?\)/g, '').trim();
  }
  // 新成员取色：优先挑一个**当前没人用的**颜色（全部占满才按下标循环）。
  // ★ 旧逻辑 COLORS[成员数 % 8] 在删过成员后会撞色 —— 「超/英 同为蓝色」的根因。
  function pickColor(st) {
    const used = st.members.map(m => m.color);
    return COLORS.find(c => used.indexOf(c) < 0) || COLORS[st.members.length % COLORS.length];
  }
  function addMember(st, name) {
    name = name.trim();
    if (!name) return false;
    if (st.members.some(m => m.name === name)) return false;
    const id = 'm' + Math.random().toString(36).slice(2, 7);
    const color = pickColor(st);
    st.members.push({ id: id, name: name, color: color });
    st.visits[id] = { cities: [], spots: [] };
    st.selected.push(id);
    st.active = id;
    return true;
  }
  // 成员颜色去重（加载时迁移，改到才返回 true）：先到先得，
  // 撞色者按调色板顺序补第一个未占用的颜色（英 → 橙 #e8a33d，用户 2026-10-06）。
  function dedupeColors(st) {
    const used = [];
    let changed = false;
    st.members.forEach(m => {
      if (used.indexOf(m.color) < 0) { used.push(m.color); return; }
      const c = COLORS.find(x => used.indexOf(x) < 0);
      if (c) { m.color = c; used.push(c); changed = true; }
    });
    return changed;
  }
  function removeMember(st, id) {
    if (st.members.length <= 1) return false;
    st.members = st.members.filter(m => m.id !== id);
    delete st.visits[id];
    st.selected = st.selected.filter(x => x !== id);
    if (st.active === id) st.active = st.members[0].id;
    return true;
  }
  function toggleSelect(st, id) {
    const i = st.selected.indexOf(id);
    if (i >= 0) { if (st.selected.length > 1) st.selected.splice(i, 1); }
    else st.selected.push(id);
    if (!st.selected.includes(st.active)) st.active = st.selected[0];
  }
  function setActive(st, id) { if (st.visits[id]) st.active = id; }

  function v(st, id) { return st.visits[id] || (st.visits[id] = { cities: [], spots: [] }); }

  // 标记景点（对当前 active 成员），再点一次取消
  // unit：调用方算好的「最小所在地」名（市辖区会被归并到所属地级市，见 app.js spotUnitName）
  function markSpot(st, spot, unit) {
    const rec = v(st, st.active);
    if (rec.spots.includes(spot.id)) {
      rec.spots = rec.spots.filter(x => x !== spot.id);
      return false;
    }
    rec.spots.push(spot.id);
    // 点亮景点 → 带动它直接所在的县/市（优先县级归属，没有则市级）；反向不成立
    const c = normCity(unit || spot.county || spot.city);
    if (c && !rec.cities.includes(c)) rec.cities.push(c);
    return true;
  }
  function isSpotDone(st, spot, memberId) {
    const mid = memberId || st.active;
    return !!(st.visits[mid] && st.visits[mid].spots.includes(spot.id));
  }
  // 单点一个地名（县 / 县级市 / 市辖区归并后的市）点亮 / 取消
  function toggleCity(st, cityName) {
    const rec = v(st, st.active);
    cityName = normCity(cityName);
    const i = rec.cities.indexOf(cityName);
    if (i >= 0) { rec.cities.splice(i, 1); return false; }
    rec.cities.push(cityName);
    return true;
  }
  // 地级市 / 直辖市整体点亮 / 取消。
  // ★ 规则（用户明确要求）：小的能带动大的，大的不能带动小的 ——
  //   所以这里既不吞并、也不删除下属县的独立记录：
  //   · 点亮市 → 只把「市」自己记上，下属县若之前单独点亮过，原样保留；
  //   · 取消市 → 也只取消「市」本身，不去动下属县。
  //   （原实现会在点市时把下属县记录一并删掉，等于「大的吞掉小的」，并会
  //     让这些县再也点不动 —— 这是小县城点不亮的原因之一。）
  function togglePrefecture(st, cityName, countyNames) {
    const rec = v(st, st.active);
    cityName = normCity(cityName);
    if (rec.cities.includes(cityName)) {
      rec.cities = rec.cities.filter(c => c !== cityName);
      return false;
    }
    rec.cities.push(cityName);
    return true;
  }
  function isCityLit(st, cityName, memberId) {
    const mid = memberId || st.active;
    return !!(st.visits[mid] && st.visits[mid].cities.includes(normCity(cityName)));
  }
  // 一键清除某成员（默认当前 active）的全部足迹
  function clearVisits(st, memberId) {
    const mid = memberId || st.active;
    const rec = st.visits[mid];
    if (!rec) return false;
    rec.cities = []; rec.spots = [];
    return true;
  }
  // 当前查看成员(active)的点亮城市 → 成员 id 列表（每个成员地图红色各不相同）
  function litMap(st) {
    const map = {};
    const mid = st.active;
    const rec = st.visits[mid];
    if (rec) rec.cities.forEach(c => { map[c] = [mid]; });
    return map;
  }
  // 统计（基于当前查看成员 active）
  // ★ provMap：可选的「地名 → 省份」全量字典（app.js 的 cityProv，来自全部市级+县级行政区）。
  //   必须优先用它解析省份归属 —— 不能用 allCities（= 有景点的市/县子集）当字典：
  //   像「包头市」自己没有景点、不在该子集里，一旦被点亮，内蒙古自治区就数不进「覆盖省份」，
  //   而地图的省级标记判定用的是全量行政区表（countProvLit）→ 出现「地图 15 / 面板 14」。
  function stats(st, allCities, provMap) {
    const citySet = new Set(), provSet = new Set();
    const rec = st.visits[st.active];
    if (rec) rec.cities.forEach(c => citySet.add(c));
    const c2p = {};
    (allCities || []).forEach(c => { c2p[c.name] = c.province; });
    const px = provMap || c2p;
    citySet.forEach(c => { const p = px[c] || (provMap ? c2p[c] : ''); if (p) provSet.add(p); });
    return {
      cities: citySet.size,
      provinces: provSet.size,
      totalCities: (allCities || []).length,
      totalProvinces: 34,
      members: 1
    };
  }
  return {
    defaultState, normCity, addMember, removeMember, toggleSelect, setActive,
    markSpot, isSpotDone, toggleCity, togglePrefecture, isCityLit, clearVisits, litMap, stats, dedupeColors, COLORS
  };
})();
