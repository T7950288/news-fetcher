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
  function addMember(st, name) {
    name = name.trim();
    if (!name) return false;
    if (st.members.some(m => m.name === name)) return false;
    const id = 'm' + Math.random().toString(36).slice(2, 7);
    const color = COLORS[st.members.length % COLORS.length];
    st.members.push({ id: id, name: name, color: color });
    st.visits[id] = { cities: [], spots: [] };
    st.selected.push(id);
    st.active = id;
    return true;
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
  function markSpot(st, spot) {
    const rec = v(st, st.active);
    if (rec.spots.includes(spot.id)) {
      rec.spots = rec.spots.filter(x => x !== spot.id);
      return false;
    }
    rec.spots.push(spot.id);
    // 点亮景点 → 带动它直接所在的县/市（优先县级归属，没有则市级）
    const c = normCity(spot.county || spot.city);
    if (c && !rec.cities.includes(c)) rec.cities.push(c);
    return true;
  }
  function isSpotDone(st, spot, memberId) {
    const mid = memberId || st.active;
    return !!(st.visits[mid] && st.visits[mid].spots.includes(spot.id));
  }
  // 整城点亮 / 取消（取消时连带移除该成员在该城市的景点记录）
  function toggleCity(st, cityName) {
    const rec = v(st, st.active);
    cityName = normCity(cityName);
    const i = rec.cities.indexOf(cityName);
    if (i >= 0) { rec.cities.splice(i, 1); return false; }
    rec.cities.push(cityName);
    return true;
  }
  // 地级市/直辖市整体点亮 / 取消（含所有下属县景点）
  function togglePrefecture(st, cityName, countyNames) {
    const rec = v(st, st.active);
    cityName = normCity(cityName);
    const subs = countyNames || [];
    if (rec.cities.includes(cityName)) {
      // 完整点亮 → 取消市及归并的下属县（不影响使用者自行点亮的景点）
      rec.cities = rec.cities.filter(c => c !== cityName && !subs.includes(c));
      return false;
    }
    // 点亮整个市：下属县归并到市；景点不自动点亮，由使用者自行选择
    subs.forEach(c => { rec.cities = rec.cities.filter(x => x !== c); });
    if (!rec.cities.includes(cityName)) rec.cities.push(cityName);
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
  function stats(st, allCities) {
    const citySet = new Set(), provSet = new Set();
    const rec = st.visits[st.active];
    if (rec) rec.cities.forEach(c => citySet.add(c));
    const c2p = {};
    (allCities || []).forEach(c => { c2p[c.name] = c.province; });
    citySet.forEach(c => { if (c2p[c]) provSet.add(c2p[c]); });
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
    markSpot, isSpotDone, toggleCity, togglePrefecture, isCityLit, clearVisits, litMap, stats, COLORS
  };
})();
