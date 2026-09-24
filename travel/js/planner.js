/* 行程自动规划 v2（旅行社方法论）：
   1. 进出港锚定：Day1/最后一天落在交通枢纽城市（省会/主要地级市），方便外省游客往返
   2. 同区域集中、由近及远：枢纽市区→近郊→远郊，不跨区乱串
   3. 每天 1 个核心大景点 + 1~2 个周边小景点（共 2~3 个），高强度景点单独一天
   4. 交通三级：<12km 地铁/公交、12~80km 大巴、>80km 高铁
   5. 名称去重：去括号、连接符、城市前缀、后缀
   6. Day1 从 14:00 开始（游客下午才到），最后一天留返程时间 */
const Planner = (function () {

  function hav(a, b) {
    const R = 6371, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    const s = Math.sin(dLat / 2) ** 2 +
      Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(s), Math.sqrt(1 - s));
  }
  function fmt(m) {
    m = Math.round(m);
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }
  const groupDur = g => g.reduce((a, x) => a + x.dur, 0);

  // 交通三级：距离分级
  function travel(a, b) {
    const km = hav(a, b);
    if (km < 12) {
      return { min: Math.max(15, Math.round(km * 2.5)), mode: '地铁/公交' };
    }
    if (km < 80) {
      return { min: Math.max(20, Math.round(km / 60 * 60)), mode: '大巴' };
    }
    const rail = a.rail !== false && b.rail !== false;
    return { min: Math.round(km / (rail ? 160 : 60) * 60), mode: rail ? '高铁/动车' : '大巴' };
  }

  // 景点名称归一（去括号、连接符、常见城市前缀、后缀）
  const CITY_PREFIX = /^(北京|上海|天津|重庆|陕西|四川|云南|贵州|甘肃|青海|宁夏|新疆|西藏|山西|山东|河南|河北|湖北|湖南|江苏|浙江|安徽|福建|江西|广东|广西|海南|辽宁|吉林|黑龙江|内蒙古|西安|成都|广州|杭州|南京|武汉|长沙|昆明|丽江|大理|贵阳|兰州|乌鲁木齐|哈尔滨|沈阳|长春|石家庄|太原|郑州|合肥|福州|厦门|南昌|济南|青岛|南宁|海口|三亚|拉萨|银川|西宁|呼和浩特|秦皇岛|苏州|无锡|宁波|温州|桂林|泉州|洛阳|开封|延安|宝鸡|汉中|渭南|华阴|临潼|曲江)/g;
  function normName(n) {
    let s = String(n)
      .replace(/[（(][^)）]*[)）]/g, '')
      .replace(/[-·—–\s]/g, '')
      .replace(CITY_PREFIX, '');
    // 循环去后缀直到不变
    const SUF = /(国家遗址|遗址|文化旅游|旅游区|旅游景区|景区|风景名胜区|风景名胜|度假区|风景区|公园)$/g;
    let prev = '';
    while (prev !== s) { prev = s; s = s.replace(SUF, ''); }
    return s.trim();
  }
  // 归一化后判重：A 与 B 互为前缀且长度>=3 视为同一景点
  function sameSpot(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    if (a.length >= 3 && b.length >= 3) {
      if (b.startsWith(a) || a.startsWith(b)) return true;
    }
    return false;
  }

  // 全国省会（交通枢纽）
  const CAPITALS = {
    '河北':'石家庄','山西':'太原','辽宁':'沈阳','吉林':'长春','黑龙江':'哈尔滨','江苏':'南京',
    '浙江':'杭州','安徽':'合肥','福建':'福州','江西':'南昌','山东':'济南','河南':'郑州',
    '湖北':'武汉','湖南':'长沙','广东':'广州','海南':'海口','四川':'成都','贵州':'贵阳',
    '云南':'昆明','陕西':'西安','甘肃':'兰州','青海':'西宁','内蒙古':'呼和浩特',
    '广西':'南宁','西藏':'拉萨','宁夏':'银川','新疆':'乌鲁木齐'
  };

  // 自驾：一条连续路径按天切段，自驾时间计入时间轴，全程不走回头路（保持原逻辑）
  function planDrive(sel, days, center, warnings) {
    const dC = s => hav(s, center);
    const path = [];
    const rem = [...sel];
    let cur = rem.reduce((a, b) => dC(a) <= dC(b) ? a : b);
    path.push(cur); rem.splice(rem.indexOf(cur), 1);
    while (rem.length) {
      let bi = 0, bd = 1e9;
      rem.forEach((s, i) => { const dd = hav(cur, s); if (dd < bd) { bd = dd; bi = i; } });
      cur = rem.splice(bi, 1)[0]; path.push(cur);
    }
    const SP = 80;
    const segs = [];
    let seg = [], acc = 0;
    path.forEach((s, i) => {
      const prev2 = seg.length ? seg[seg.length - 1] : (i === 0 ? center : path[i - 1]);
      const leg = prev2 ? hav(prev2, s) / SP : 0;
      if (seg.length && acc + s.dur + leg > 9.5) { segs.push(seg); seg = []; acc = 0; }
      seg.push(s); acc += s.dur + leg;
    });
    if (seg.length) segs.push(seg);
    const droppedDrv = [];
    while (segs.length > days) {
      const last = segs.pop();
      if (!last.length || !segs.length) continue;
      const prev = segs[segs.length - 1];
      const leg0 = hav(prev[prev.length - 1], last[0]) / SP;
      if (groupDur(prev) + last[0].dur + leg0 <= 9.5) {
        prev.push(...last);
      } else {
        droppedDrv.push(...last);
      }
    }
    if (droppedDrv.length) {
      warnings.push('以下景点因每天自驾+游览超时未排入：' +
        droppedDrv.map(x => x.name).join('、') + '。建议增加天数。');
    }
    segs.forEach((g, gi) => {
      const from = gi === 0 ? center : segs[gi - 1][segs[gi - 1].length - 1];
      const legH = hav(from, g[0]) / SP;
      if (legH > 5) warnings.push('第 ' + (gi + 1) + ' 天前往 ' + g[0].name + ' 需自驾约 ' + Math.round(legH) + ' 小时，路程较长，建议早点出发或中途休息。');
    });
    const dayPlans = [];
    let prevDayEnd = null;
    segs.forEach((g, gi) => {
      const items = [{ type: 'note', start: '08:30', text: gi === 0 ? '从市区出发，开始自驾行程' : '从昨日住宿地出发，继续自驾行程' }];
      let m = 8.5 * 60;
      g.forEach((s, k) => {
        const from = k === 0 ? (gi === 0 ? center : prevDayEnd) : g[k - 1];
        const legMin = Math.max(15, Math.round(hav(from, s) / SP * 60));
        m += legMin;
        const long = s.dur >= 4;
        if (!long && m < 12 * 60 && m + s.dur * 60 > 12.3 * 60) {
          items.push({ type: 'meal', start: '12:00', end: '13:00', text: '午餐，品尝当地特色美食' });
          m = 13 * 60;
        }
        const start = m, end = m + s.dur * 60;
        const where = (k === 0 && gi > 0) ? '从昨日住宿地自驾约 ' : (k === 0 ? '从市区自驾约 ' : '自驾约 ');
        let note = where + legMin + ' 分钟';
        if (long && start < 12 * 60 && end > 13 * 60) note += '；午餐可在景区内解决';
        items.push({ type: 'spot', spot: s, start: fmt(start), end: fmt(end), note: note });
        m = end;
        prevDayEnd = { lat: s.lat, lng: s.lng };
      });
      const ds = Math.max(m, 18 * 60);
      items.push({ type: 'meal', start: fmt(ds), end: fmt(ds + 60), text: '晚餐' });
      if (gi === segs.length - 1) {
        const backMin = Math.max(15, Math.round(hav(g[g.length - 1], center) / SP * 60));
        items.push({ type: 'note', start: fmt(Math.max(m, 20 * 60)), text: '自驾返程约 ' + backMin + ' 分钟，回到市区' });
      } else {
        items.push({ type: 'note', start: fmt(Math.max(m, 20 * 60)), text: '入住当地酒店（明日继续自驾）' });
      }
      dayPlans.push({ day: gi + 1, route: g, items });
    });
    let totalKm = 0;
    for (let i = 0; i < path.length; i++) {
      const from = i === 0 ? center : path[i - 1];
      totalKm += hav(from, path[i]);
    }
    warnings.push('自驾全程约 ' + Math.round(totalKm) + ' 公里，按连续线路推进不走回头路；每日行程已含自驾时间。');
    return { days: dayPlans, warnings: warnings, mode: 'drive' };
  }

  // 景点别名映射：旅行社常用名 → 数据库里的真实名关键词
  const SPOT_ALIAS = {
    "丽江古城": "丽江古城", "四方街": "四方街", "崇圣寺三塔": "崇圣寺三塔",
    "洱海": "洱海", "理想邦": "理想邦", "大理古城": "大理古城",
    "玉龙雪山": "玉龙雪山", "蓝月谷": "蓝月谷", "束河古镇": "束河古镇",
    "泸沽湖": "泸沽湖", "里务比岛": "里务比岛", "情人滩": "情人滩",
    "泸沽湖女神湾": "女神湾", "中查沟": "中查沟", "九寨沟": "九寨沟",
    "九寨沟风景区": "九寨沟", "诺日朗瀑布": "诺日朗", "神仙池风景区": "神仙池",
    "三星堆博物馆": "三星堆", "成都川菜博物馆": "川菜博物馆", "都江堰": "都江堰",
    "熊猫谷": "熊猫谷", "青城山": "青城山", "宽窄巷子": "宽窄巷子",
    "西安城墙": "西安城墙", "钟鼓楼": "钟鼓楼", "秦始皇兵马俑博物馆": "兵马俑",
    "华清宫": "华清宫", "陕西历史博物馆": "陕西历史博物馆", "大雁塔": "大雁塔",
    "大唐不夜城": "大唐不夜城", "华山": "华山", "西安碑林博物馆": "碑林",
    "回民街": "回民街", "天安门广场": "天安门", "故宫博物院": "故宫",
    "八达岭长城": "八达岭", "鸟巢": "鸟巢", "颐和园": "颐和园",
    "圆明园": "圆明园", "天坛公园": "天坛", "雍和宫": "雍和宫",
    "南锣鼓巷": "南锣鼓巷", "什刹海": "什刹海", "西湖": "西湖",
    "灵隐寺": "灵隐寺", "西溪国家湿地公园": "西溪", "宋城": "宋城",
    "千岛湖": "千岛湖", "乌镇": "乌镇", "西塘古镇": "西塘",
    "象鼻山": "象鼻山", "两江四湖": "两江四湖", "漓江": "漓江",
    "阳朔西街": "西街", "遇龙河": "遇龙河", "十里画廊": "十里画廊",
    "龙脊梯田": "龙脊梯田", "七星景区": "七星", "芦笛岩": "芦笛岩",
    "天涯海角": "天涯海角", "南山文化旅游区": "南山", "亚龙湾": "亚龙湾",
    "蜈支洲岛": "蜈支洲岛", "大东海": "大东海", "鹿回头": "鹿回头",
    "呀诺达雨林文化旅游区": "呀诺达", "槟榔谷": "槟榔谷", "西岛": "西岛",
    "三亚湾": "三亚湾", "河南博物院": "河南博物院", "二七纪念塔": "二七纪念塔",
    "龙门石窟": "龙门石窟", "白马寺": "白马寺", "老君山": "老君山",
    "鸡冠洞": "鸡冠洞", "嵩山少林景区": "嵩山少林", "嵩阳书院": "嵩阳书院",
    "清明上河园": "清明上河园", "开封府": "开封府", "山西博物院": "山西博物院",
    "晋祠天龙山景区": "晋祠天龙山", "云冈石窟": "云冈石窟", "华严寺": "华严寺",
    "悬空寺": "悬空寺", "应县木塔": "应县木塔", "五台山": "五台山",
    "双林寺": "双林寺", "王家大院": "王家大院", "乔家大院": "乔家大院",
    "解放碑": "解放碑", "洪崖洞": "洪崖洞", "磁器口古镇": "磁器口",
    "长江索道": "长江索道", "南山一棵树": "南山", "武隆天生三桥": "天生三桥",
    "龙水峡地缝": "龙水峡", "大足石刻": "大足石刻", "昌州古城": "昌州",
    "鹅岭二厂": "鹅岭", "交通茶馆": "交通茶馆", "告庄西双景": "告庄",
    "野象谷": "野象谷", "西双版纳勐泐文化旅游区": "勐泐",
    "中国科学院热带植物园": "热带植物园", "曼听御花园": "曼听",
    "热带花卉园": "花卉园", "星光夜市": "星光夜市", "橘子洲": "橘子洲",
    "岳麓山": "岳麓山", "张家界国家森林公园": "张家界", "金鞭溪": "金鞭溪",
    "天门山国家森林公园": "天门山", "玻璃栈道": "玻璃栈道",
    "凤凰古城": "凤凰古城", "沱江": "沱江", "韶山": "韶山",
    "毛泽东同志故居": "毛泽东故居", "滕王阁": "滕王阁", "八一广场": "八一广场",
    "庐山": "庐山", "含鄱口": "含鄱口", "花径": "花径",
    "景德镇古窑民俗博览区": "古窑", "婺源篁岭": "篁岭", "三清山": "三清山",
    "八一起义纪念馆": "八一起义", "绳金塔": "绳金塔", "趵突泉": "趵突泉",
    "大明湖": "大明湖", "泰山": "泰山", "岱庙": "岱庙", "三孔": "三孔",
    "曲阜明故城": "明故城", "栈桥": "栈桥", "八大关": "八大关",
    "崂山": "崂山", "五四广场": "五四广场", "黄鹤楼": "黄鹤楼",
    "东湖": "东湖", "三峡大坝": "三峡大坝", "三游洞": "三游洞",
    "三峡人家": "三峡人家", "清江画廊": "清江画廊", "神农顶": "神农顶",
    "大九湖": "大九湖", "武当山": "武当山", "归元寺": "归元寺",
    "甲秀楼": "甲秀楼", "黔灵山公园": "黔灵山", "黄果树瀑布": "黄果树",
    "天星桥": "天星桥", "荔波小七孔": "小七孔", "大七孔": "大七孔",
    "西江千户苗寨": "千户苗寨", "青岩古镇": "青岩", "中山桥": "中山桥",
    "甘肃省博物馆": "甘肃省博物馆", "张掖丹霞": "丹霞", "大佛寺": "大佛寺",
    "嘉峪关关城": "嘉峪关", "悬壁长城": "悬壁长城", "莫高窟": "莫高窟",
    "鸣沙山月牙泉": "鸣沙山", "玉门关": "玉门关", "雅丹魔鬼城": "雅丹",
    "国际大巴扎": "大巴扎", "新疆维吾尔自治区博物馆": "新疆博物馆",
    "葡萄沟": "葡萄沟", "火焰山": "火焰山", "坎儿井": "坎儿井",
    "交河故城": "交河故城", "天山天池": "天池", "南山牧场": "南山",
    "呼伦贝尔大草原": "呼伦贝尔", "莫日格勒河": "莫日格勒",
    "额尔古纳湿地": "额尔古纳", "白桦林": "白桦林", "室韦": "室韦",
    "恩和俄罗斯民族乡": "恩和", "黑山头": "黑山头", "186彩带河": "彩带河",
    "满洲里国门": "满洲里", "套娃广场": "套娃", "黄山风景区": "黄山",
    "宏村": "宏村", "西递": "西递", "屯溪老街": "屯溪", "九华山": "九华山",
    "天柱山": "天柱山", "三河古镇": "三河", "包公园": "包公园",
    "鼓浪屿": "鼓浪屿", "南普陀寺": "南普陀", "厦门大学": "厦门大学",
    "曾厝垵": "曾厝垵", "武夷山": "武夷山", "天游峰": "天游峰",
    "九曲溪": "九曲溪", "大红袍景区": "大红袍", "三坊七巷": "三坊七巷",
    "鼓山": "鼓山", "中山陵": "中山陵", "明孝陵": "明孝陵",
    "夫子庙": "夫子庙", "总统府": "总统府", "拙政园": "拙政园",
    "狮子林": "狮子林", "周庄": "周庄", "同里古镇": "同里",
    "太湖鼋头渚": "鼋头渚", "灵山大佛": "灵山大佛", "沈阳故宫": "沈阳故宫",
    "张氏帅府": "张氏帅府", "千山": "千山", "老虎滩海洋公园": "老虎滩",
    "星海广场": "星海广场", "金石滩": "金石滩", "发现王国": "发现王国",
    "鸭绿江断桥": "鸭绿江", "凤凰山": "凤凰山", "伪满皇宫": "伪满皇宫",
    "净月潭": "净月潭", "长白山北坡": "长白山", "天池": "天池",
    "长白瀑布": "长白瀑布", "地下森林": "地下森林", "镜泊湖": "镜泊湖",
    "松花湖": "松花湖", "北大湖滑雪场": "北大湖", "中央大街": "中央大街",
    "圣索菲亚教堂": "索菲亚", "太阳岛": "太阳岛", "松花江": "松花江",
    "五大连池": "五大连池", "雪乡": "雪乡", "东北虎林园": "东北虎",
    "伏尔加庄园": "伏尔加", "古文化街": "古文化街", "天津之眼": "天津之眼",
    "五大道": "五大道", "意式风情区": "意式", "盘山": "盘山",
    "石家大院": "石家大院", "外滩": "外滩", "东方明珠": "东方明珠",
    "豫园": "豫园", "南京路": "南京路", "上海迪士尼乐园": "迪士尼",
    "朱家角": "朱家角", "城隍庙": "城隍庙", "镇北堡西部影城": "镇北堡",
    "西夏王陵": "西夏王陵", "沙坡头": "沙坡头", "黄河宿集": "黄河宿集",
    "青铜峡108塔": "108塔", "沙湖": "沙湖", "贺兰山岩画": "贺兰山",
    "滚钟口": "滚钟口", "黄沙古渡": "黄沙古渡", "水洞沟": "水洞沟",
    "塔尔寺": "塔尔寺", "东关清真大寺": "东关清真", "青海湖": "青海湖",
    "日月山": "日月山", "茶卡盐湖": "茶卡", "祁连草原": "祁连",
    "卓尔山": "卓尔山", "门源油菜花": "门源", "坎布拉": "坎布拉",
    "布达拉宫": "布达拉宫", "大昭寺": "大昭寺", "八廓街": "八廓街",
    "罗布林卡": "罗布林卡", "羊卓雍措": "羊卓雍", "卡若拉冰川": "卡若拉",
    "扎什伦布寺": "扎什伦布", "纳木错": "纳木错",
  };

  // 在候选景点里按关键词找实际景点对象
  function findSpotByKeyword(cands, kw) {
    kw = kw.trim();
    // 别名映射
    const aliasKw = SPOT_ALIAS[kw] || kw;
    // 完全包含
    let hit = cands.find(s => s.name.indexOf(aliasKw) >= 0);
    if (hit) return hit;
    // 反向：景点名是关键词子串（关键词更长时）
    hit = cands.find(s => aliasKw.indexOf(s.name) >= 0 && s.name.length >= 2);
    if (hit) return hit;
    // 用原kw再试
    hit = cands.find(s => s.name.indexOf(kw) >= 0);
    if (hit) return hit;
    hit = cands.find(s => kw.indexOf(s.name) >= 0 && s.name.length >= 2);
    return hit || null;
  }

  // 套用成熟旅行社模板
  function planFromTemplate(candidates, days, mode) {
    const warnings = [];
    if (!candidates.length) return null;
    const prov = candidates[0].province || '';
    const TPL = (typeof TRIP_TEMPLATES !== 'undefined') ? TRIP_TEMPLATES[prov] : null;
    if (!TPL) return null;
    // 找最接近的天数模板（不超过请求天数，优先最接近）
    const availDays = Object.keys(TPL).map(Number).sort((a,b)=>a-b);
    let tplDays = null;
    // 优先精确匹配
    if (TPL[days]) tplDays = days;
    else {
      // 找 <= 请求天数的最大
      const smaller = availDays.filter(d => d <= days);
      if (smaller.length) tplDays = smaller[smaller.length-1];
      else tplDays = availDays[0]; // 比请求少的模板也用
    }
    const tplArr = TPL[tplDays];
    if (!tplArr || !tplArr.length) return null;
    const idx = window.__tplIdx || 0;
    const tpl = tplArr[idx % tplArr.length];
    const tplName = tpl.name || '';
    window.__lastTplProv = prov;
    window.__lastTplDays = tplDays;
    window.__lastTplTotal = tplArr.length;

    const allSpots = window.APP_DATA.attractions;
    // 收集本模板所有天的景点
    const usedIds = new Set();
    const dayPlans = [];
    tpl.days.forEach((td, di) => {
      const spots = [];
      td.spots.forEach(kw => {
        // 先在候选里找，找不到在全省找
        let s = findSpotByKeyword(candidates, kw);
        if (!s) s = findSpotByKeyword(allSpots.filter(x => x.province === prov), kw);
        if (s && !usedIds.has(s.id)) {
          spots.push(s); usedIds.add(s.id);
        }
      });
      // 生成 items
      const isFirst = di === 0;
      const isLast = di === tpl.days.length - 1;
      const items = [];
      if (isFirst) {
        items.push({ type:'note', start:'14:00', text:'抵达'+td.city+'，下午开始游览' });
      }
      let m = isFirst ? 14*60 : 9*60;
      spots.forEach((s, k) => {
        const dur = s.dur || 3;
        if (m < 12*60 && m + dur*60 > 12.3*60) {
          items.push({type:'meal', start:'12:00', end:'13:00', text:'午餐'});
          m = 13*60;
        }
        const start = m, end = m + dur*60;
        items.push({type:'spot', spot:s, start:fmt(start), end:fmt(end), note: k===0? '前往'+td.city : '继续游览'});
        m = end + 30;
      });
      if (m <= 19.5*60) {
        const ds = Math.max(m, 18*60);
        items.push({type:'meal', start:fmt(ds), end:fmt(ds+60), text:'晚餐'});
      }
      items.push({type:'note', start:fmt(Math.max(m,20*60)), text: isLast? '返程' : '返回酒店休息'});
      dayPlans.push({ day: di+1, route: spots, items: items });
    });
    if (dayPlans.length) {
      warnings.push('本行程参考' + prov.replace(/省|市|自治区|壮族|回族|维吾尔|藏族|彝族|布依族/g,'') + '经典旅行社线路模板（' + tplDays + '日·' + tplName + '）。');
      return { days: dayPlans, warnings: warnings, mode: mode === 'drive' ? 'drive' : 'transit', totalPlans: tplArr.length, planName: tplName };
    }
    return null;
  }

  function plan(candidates, days, prefs, center, mode) {
    const warnings = [];
    if (!candidates.length) return { days: [], warnings: ['该区域暂未收录景点，试试输入周边城市。'] };
    days = Math.max(1, Math.min(10, days | 0));
    prefs = prefs || new Set();
    mode = mode === 'drive' ? 'drive' : 'transit';

    // 优先套用成熟旅行社模板
    const tplResult = planFromTemplate(candidates, days, mode);
    if (tplResult && tplResult.days.length) return tplResult;

    // 1) 打分
    const score = s => {
      let v = s.rating * 10;
      if (s.level === '5A') v += 8; else if (s.level === '4A') v += 3;
      if (prefs.has(s.cat)) v += 12;
      return v;
    };
    const sorted0 = [...candidates].sort((a, b) => score(b) - score(a));

    // 2) 名称去重（归一化+前缀包含判重，保留评分高者）
    const seenN = [];
    const sorted = [];
    for (const s of sorted0) {
      const k = normName(s.name);
      if (seenN.some(x => sameSpot(x, k))) continue;
      seenN.push(k); sorted.push(s);
    }

    // 3) 推断交通枢纽：候选所属省的省会；城市模式则用 city 字段
    const prov = sorted[0].province || '';
    const hubName = CAPITALS[prov];
    let hub = center;
    if (hubName) {
      const hubSpots = sorted.filter(s => s.city === hubName || s.city === hubName + '市' || s.county === hubName);
      if (hubSpots.length) {
        hub = {
          lng: hubSpots.reduce((a, s) => a + s.lng, 0) / hubSpots.length,
          lat: hubSpots.reduce((a, s) => a + s.lat, 0) / hubSpots.length
        };
      }
    }
    const dHub = s => hav(s, hub);

    // 4) 按距离枢纽分层：near 枢纽市区(<25km) / mid 近郊(25~150km) / far 远郊单点(150~250km) / veryfar 超远
    const near = [], mid = [], far = [];
    sorted.forEach(s => {
      const d = dHub(s);
      if (d < 25) near.push(s);
      else if (d < 150) mid.push(s);
      else if (d < 250) far.push(s);
    });
    const veryfar = sorted.filter(s => dHub(s) >= 250);

    // 5) 选点：每天 2~3 个，总目标 days*2.5；near 优先，far 高强度单独一天
    const TARGET = Math.round(days * 2.5);
    const sel = [];
    // near 先选（评分排序）
    near.forEach(s => { if (sel.length < TARGET) sel.push(s); });
    // mid 选 1~2 个相邻组团
    const midPick = Math.min(mid.length, Math.max(1, Math.round(days / 2)));
    mid.slice(0, midPick).forEach(s => sel.push(s));
    // far 选 1 个高强度单独一天（如华山/泰山/五台山）
    if (far.length && days >= 3) {
      const big = far.reduce((a, b) => a.dur >= b.dur ? a : b);
      sel.push(big);
    }

    if (mode === 'drive') return planDrive(sel, days, hub, warnings);

    // 超远景点提示
    if (veryfar.length) {
      const topV = veryfar.slice(0, 3).map(s => s.name).join('、');
      warnings.push('以下超远景点（距枢纽 >350km）未排入：' + topV +
        '。若要走该方向，建议单独安排一条线路（如陕北线/汉中线），并增加天数。');
    }

    // 6) 分组：Day1=枢纽市区轻松(下午开始)、Day2=枢纽市区全天、中间天=近郊线、最后一天=远郊或回枢纽
    // 高强度景点（dur>=5h，如华山/长城）单独一天，不与其他景点同组
    const groups = [];
    if (sel.length === 0) return { days: [], warnings: ['候选景点不足。'] };

    const isBig = s => s.dur >= 5;
    const bigs = sel.filter(isBig);
    const smalls = sel.filter(s => !isBig(s));

    // Day1：near 里挑 dur<=2.5h 的轻松点（下午到）
    const day1 = smalls.filter(s => s.city === hubName || s.city === hubName + '市').filter(s => s.dur <= 2.5).slice(0, 2);
    if (!day1.length) {
      const near1 = near.filter(s => !isBig(s)).slice(0, 2);
      day1.push(...near1);
    }
    groups.push(day1);
    const usedIds = new Set(day1.map(s => s.id));

    // Day2：near 剩余小景点
    const day2 = near.filter(s => !usedIds.has(s.id) && !isBig(s)).slice(0, 3);
    groups.push(day2);
    day2.forEach(s => usedIds.add(s.id));

    // 中间天：mid 相邻组团（2~3个）
    let midLeft = mid.filter(s => !usedIds.has(s.id) && !isBig(s));
    if (midLeft.length && days >= 3) {
      const midGroup = [];
      midLeft.forEach(s => {
        if (midGroup.length === 0 || hav(midGroup[midGroup.length - 1], s) < 40) midGroup.push(s);
      });
      if (midGroup.length) {
        groups.push(midGroup);
        midGroup.forEach(s => usedIds.add(s.id));
      }
    }

    // 高强度景点单独一天（优先排在倒数第二天，最后一天回枢纽）
    const bigLeft = bigs.filter(s => !usedIds.has(s.id));
    if (bigLeft.length && days >= 4) {
      // 高强度景点那天，加1个附近的小景点，确保每天至少2个景点
      const bigDay = [bigLeft[0]];
      usedIds.add(bigLeft[0].id);
      const nearBig = smalls.filter(s => !usedIds.has(s.id))
        .sort((a,b) => hav(bigLeft[0], a) - hav(bigLeft[0], b));
      if (nearBig.length) {
        bigDay.push(nearBig[0]);
        usedIds.add(nearBig[0].id);
      }
      groups.push(bigDay);
    }

    // 最后一天：near 剩余（回枢纽，方便返程）
    const last = [...near, ...mid].filter(s => !usedIds.has(s.id) && !isBig(s)).slice(0, 2);
    if (last.length) groups.push(last);

    // 清理空组，并限制为设定天数
    let gs = groups.filter(g => g.length);
    while (gs.length > days) {
      const last = gs.pop();
      gs[gs.length - 1] = gs[gs.length - 1].concat(last);
    }

    // 7) 每天最近邻路线
    function nnRoute(pts, startFromHub) {
      if (pts.length <= 1) return pts;
      const rem = [...pts], out = [];
      let cur;
      if (startFromHub) cur = rem.reduce((a, b) => dHub(a) <= dHub(b) ? a : b);
      else cur = rem[0];
      out.push(cur); rem.splice(rem.indexOf(cur), 1);
      while (rem.length) {
        let bi = 0, bd = 1e9;
        rem.forEach((s, i) => { const dd = hav(cur, s); if (dd < bd) { bd = dd; bi = i; } });
        cur = rem.splice(bi, 1)[0]; out.push(cur);
      }
      return out;
    }

    // 8) 时间轴：Day1 从 14:00 开始（下午到）；景点结束不晚于 20:30；最后一天留返程
    function buildDay(route, dayIdx, totalDays) {
      const isFirst = dayIdx === 0;
      const isLast = dayIdx === totalDays - 1;
      const startH = isFirst ? 14 : 9;
      const items = [{ type: 'note', start: fmt(startH * 60), text: isFirst ? '抵达交通枢纽城市，下午开始市区游览' : '从酒店出发，开始今天的行程' }];
      let m = startH * 60;
      const dropped = [];
      route.forEach((s, k) => {
        const long = s.dur >= 4;
        if (!long && m < 12 * 60 && m + s.dur * 60 > 12.3 * 60) {
          items.push({ type: 'meal', start: '12:00', end: '13:00', text: '午餐，品尝当地特色美食' });
          m = 13 * 60;
        }
        const start = m, end = m + s.dur * 60;
        if (end > 20.5 * 60) { dropped.push(s.name); return; }  // 太晚不排
        let note;
        if (k === 0) {
          const t0 = travel(hub, s);
          note = '首站 · 从' + (hubName || '市区') + '乘' + t0.mode + '约 ' + t0.min + ' 分钟';
        } else {
          const tk = travel(route[k - 1], s);
          note = '乘' + tk.mode + '约 ' + tk.min + ' 分钟';
        }
        if (long && start < 12 * 60 && end > 13 * 60) note += '；午餐可在景区内解决';
        items.push({ type: 'spot', spot: s, start: fmt(start), end: fmt(end), note: note });
        m = end + (k < route.length - 1 ? 30 : 0);
      });
      if (dropped.length) warnings.push('第 ' + (dayIdx + 1) + ' 天时间已排满，以下景点未排入：' + dropped.join('、'));
      // 晚餐：首日晚 18:00；末日视返程时间提前
      if (m <= 19.5 * 60) {
        const ds = Math.max(m, 18 * 60);
        items.push({ type: 'meal', start: fmt(ds), end: fmt(ds + 60), text: '晚餐' });
        m = ds + 60;
      }
      if (isLast) {
        items.push({ type: 'note', start: fmt(Math.max(m, 20 * 60)), text: '回到交通枢纽城市，方便次日乘高铁/飞机返程' });
      } else {
        items.push({ type: 'note', start: fmt(Math.max(m, 20 * 60)), text: '返回酒店休息' });
      }
      return items;
    }

    const dayPlans = gs
      .map((g, i) => {
        const r = nnRoute(g, i === 0);
        const items = buildDay(r, i, gs.length);
        const actualSpots = items.filter(x => x.type === 'spot').length;
        return { day: i + 1, route: r.slice(0, actualSpots), items: items };
      });

    return { days: dayPlans, warnings: warnings, mode: 'transit' };
  }

  return { plan: plan, hav: hav };
})();
