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
    // 24h 保护：时间轴此前无收工上限，曾排出 25:30 / 26:00 / 28:30 这类不存在的时间
    m = Math.max(0, Math.min(Math.round(m), 23 * 60 + 59));
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

  // 景点类型识别：行程内同类稀释用（文化类同类型最多 1 个，自然类最多 2 个）
  // 例：王家大院/乔家大院 → 「大院」同类；平遥古城/忻州古城 → 「古城」同类
  function typeKey(s) {
    const n = normName(s.name || '');
    const CULT = /(大院|庄园|古城|古镇|古村|石窟|寺|庙|塔|陵|宫|祠|府|宅|博物馆|纪念馆|故居|遗址|老街|古街|城堡|关)$/;
    const NAT = /(山|湖|海|瀑布|峡谷|峡|森林|公园|草原|沙漠|河|泉|洞|湾|滩|林)$/;
    const mc = n.match(CULT), mn = n.match(NAT);
    if (mc) return { key: mc[1], cultural: true };
    if (mn) return { key: mn[1], cultural: false };
    return { key: '', cultural: false };
  }
  const typeCap = t => t.cultural ? 1 : 2;

  // 全国省会（交通枢纽）
  const CAPITALS = {
    '河北':'石家庄','山西':'太原','辽宁':'沈阳','吉林':'长春','黑龙江':'哈尔滨','江苏':'南京',
    '浙江':'杭州','安徽':'合肥','福建':'福州','江西':'南昌','山东':'济南','河南':'郑州',
    '湖北':'武汉','湖南':'长沙','广东':'广州','海南':'海口','四川':'成都','贵州':'贵阳',
    '云南':'昆明','陕西':'西安','甘肃':'兰州','青海':'西宁','内蒙古':'呼和浩特',
    '广西':'南宁','西藏':'拉萨','宁夏':'银川','新疆':'乌鲁木齐'
  };
  // 直辖市：市中心即枢纽（数据里 province 为「北京市」等）
  Object.assign(CAPITALS, { '北京':'北京', '上海':'上海', '天津':'天津', '重庆':'重庆' });

  // ★ 取省会：数据里的 province 是全称（山西省 / 新疆维吾尔自治区），而 CAPITALS 键是简称。
  // 不做归一化直接查表会 31 个省全部 miss → hub 恒 undefined → 「首末天锚定大城市」整块失效。
  function hubOf(prov) {
    if (!prov) return null;
    const s = String(prov);
    if (CAPITALS[s]) return CAPITALS[s];
    const bare = s
      .replace(/(维吾尔|壮族|回族|藏族|彝族|布依族|苗族|土家族|白族|傣族|哈尼族|蒙古族|朝鲜族)/g, '')
      .replace(/(特别行政区|自治区|省|市)$/g, '');
    return CAPITALS[bare] || null;
  }

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
    const droppedLast = [];
    segs.forEach((g, gi) => {
      const isLast = gi === segs.length - 1;
      const items = [{ type: 'note', start: '08:30', text: gi === 0 ? '从市区出发，开始自驾行程' : '从昨日住宿地出发，继续自驾行程' }];
      let m = 8.5 * 60;
      const visited = [];
      g.forEach((s, k) => {
        // 末日只排上午：13:00 前排不完的景点一律跳过（下午和晚上留给返程）
        if (isLast && (m >= 12 * 60 || m + s.dur * 60 > 13 * 60)) {
          droppedLast.push(s.name);
          return;
        }
        const from = k === 0 ? (gi === 0 ? center : prevDayEnd) : visited[visited.length - 1];
        const legMin = Math.max(15, Math.round(hav(from, s) / SP * 60));
        m += legMin;
        const long = s.dur >= 4;
        if (!long && m < 12 * 60 && m + s.dur * 60 > 12.3 * 60) {
          items.push({ type: 'meal', start: '12:00', end: '13:00', text: '午餐，品尝当地特色美食' });
          m = 13 * 60;
        }
        const start = m, end = m + s.dur * 60;
        const where = (visited.length === 0 && gi > 0) ? '从昨日住宿地自驾约 ' : (visited.length === 0 ? '从市区自驾约 ' : '自驾约 ');
        let note = where + legMin + ' 分钟';
        if (long && start < 12 * 60 && end > 13 * 60) note += '；午餐可在景区内解决';
        items.push({ type: 'spot', spot: s, start: fmt(start), end: fmt(end), note: note });
        m = end;
        visited.push(s);
        prevDayEnd = { lat: s.lat, lng: s.lng };
      });
      if (isLast) {
        // 末日：无晚餐，注记改为下午自驾返程
        const lastStop = visited.length ? visited[visited.length - 1] : null;
        const backMin = Math.max(15, Math.round(hav(lastStop || { lat: center.lat, lng: center.lng }, center) / SP * 60));
        items.push({ type: 'note', start: fmt(Math.max(m, 13 * 60)), text: '下午自驾返程约 ' + backMin + ' 分钟，回到市区' });
      } else {
        const ds = Math.max(m, 18 * 60);
        items.push({ type: 'meal', start: fmt(ds), end: fmt(ds + 60), text: '晚餐' });
        items.push({ type: 'note', start: fmt(Math.max(m, 20 * 60)), text: '入住当地酒店（明日继续自驾）' });
      }
      dayPlans.push({ day: gi + 1, route: visited, items });
    });
    // 天数不足：补机动日（插在返程日之前，保证末日仍是返程日）
    if (dayPlans.length < days) {
      while (dayPlans.length < days) {
        dayPlans.splice(dayPlans.length - 1, 0, {
          day: 0, route: [],
          items: [{ type: 'note', start: '09:00', text: '机动日，可自由活动、休整或深度游览住宿地周边' }]
        });
      }
      warnings.push('景点库不足以排满 ' + days + ' 天自驾行程，多余天数已安排为机动日（可自由活动或休整）。');
    }
    dayPlans.forEach((d, i) => { d.day = i + 1; });
    if (droppedLast.length) {
      warnings.push('最后一天仅安排上午行程，以下景点因时间不足未排入：' +
        droppedLast.join('、') + '。下午留给返程。');
    }
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
  // 关键词匹配真实景点；带主题时，在"同一匹配档位"的多个候选里挑最契合该人群的一个
  // （classic 无主题 → 取第一个，与历史输出完全一致）
  function findSpotByKeyword(cands, kw, v) {
    if (v && v.id !== 'classic') {
      const tiers = [
        s => s.name === kw,
        s => s.name.indexOf(kw) >= 0,
        s => kw.indexOf(s.name) >= 0 && s.name.length >= 2
      ];
      for (let i = 0; i < tiers.length; i++) {
        const hits = cands.filter(tiers[i]);
        if (!hits.length) continue;
        if (hits.length === 1) return hits[0];
        return hits.reduce((a, b) => varScore(b, v) >= varScore(a, v) ? b : a);
      }
      return null;
    }
    return findSpotByKeywordPlain(cands, kw);
  }
  function findSpotByKeywordPlain(cands, kw) {
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

  // 按"线路内容"给模板线做指纹：模板里存在大量同名不同内容、或异名同内容的重复线，
  // 只有按内容指纹判重才能识别出"真正不同的线路"（原来按 name 判重 → 6 套里 5 套是同一套）
  function tplLineSig(line) {
    return (line.days || []).map(d => (d.spots || []).join('/')).join('|');
  }
  // 同一天数下内容去重后的线路列表
  function uniqLines(n, TPL) {
    const arr = (TPL && TPL[n]) || [];
    const out = [], seen = new Set();
    arr.forEach(ln => {
      const sg = tplLineSig(ln);
      if (!seen.has(sg)) { seen.add(sg); out.push(ln); }
    });
    return out;
  }
  function gcd(a, b) { while (b) { const t = a % b; a = b; b = t; } return a || 1; }

  /* ================= 人群主题（变异生成） ================= */
  // 同一批景点，按不同游客的口味重排与调换，产出"适合不同游客"的多套方案
  const VARIANTS = [
    { id: 'classic', name: '经典全景', note: '评分优先，名山大川与经典地标兼顾' },
    { id: 'nature',  name: '自然山水', note: '山水、湖泊、瀑布、草原等自然风光为主',
      cat: { 2: 18, 11: 14, 8: 10, 5: -10, 6: -10, 9: -6 } },
    { id: 'culture', name: '人文古迹', note: '古城、大院、寺庙、石窟、博物馆为主',
      cat: { 1: 18, 3: 14, 7: 12, 5: 10, 10: 8, 6: -10, 9: -4 } },
    { id: 'family',  name: '亲子休闲', note: '强度低、单日景点少，适合带孩子出行',
      cat: { 6: 22, 4: 14, 5: 14, 8: 10, 9: 6, 11: -8, 3: -6 }, durMax: 4, perDay: 2 },
    { id: 'photo',   name: '摄影出片', note: '雪峰、梯田、峡谷、网红地标等高出片点',
      cat: { 11: 16, 2: 14, 8: 12, 7: 8, 5: -10, 6: -10 },
      kw: /(日出|云海|梯田|雪山|大峡谷|夜景|观景|晨曦|草原|峡谷|天池|盐湖)/, kwBonus: 14 }
  ];
  const VAR_BY_ID = {};
  VARIANTS.forEach(v => { VAR_BY_ID[v.id] = v; });
  // 主题对单个景点的加减分（classic 恒为 0，保证经典模式与历史输出完全一致）
  function varScore(s, v) {
    if (!v || v.id === 'classic') return 0;
    let d = 0;
    if (v.cat) d += (v.cat[s.cat] || 0);
    if (v.kw && v.kw.test(String(s.name || ''))) d += (v.kwBonus || 10);
    if (v.durMax && (s.dur || 3) > v.durMax) d -= 30;   // 亲子：排除耗时长的大景点
    return d;
  }
  function spotScore(s, prefs, v) {
    let val = (s.rating || 4.4) * 10;
    if (s.level === '5A') val += 8; else if (s.level === '4A') val += 3;
    if (prefs && prefs.has && prefs.has(s.cat)) val += 12;
    return val + varScore(s, v);
  }
  // 主题调换：把与主题不契合的景点，换成"同区（60km 内）同类型、主题更契合且评分不降"的未用景点
  // —— 只换内容，不改变天数结构与地理跨度，所以时间轴与收工线不受影响
  function themeSwap(dayDescs, v, pool, usedIds) {
    if (!v || v.id === 'classic') return 0;
    let n = 0;
    dayDescs.forEach(d => {
      if (!d.spots.length) return;
      const c = {
        lng: d.spots.reduce((a, s) => a + s.lng, 0) / d.spots.length,
        lat: d.spots.reduce((a, s) => a + s.lat, 0) / d.spots.length
      };
      d.spots = d.spots.map(s => {
        const cur = varScore(s, v);
        const t = typeKey(s);
        let best = null, bs = cur + 8;   // 至少契合 8 分才值得换
        pool.forEach(x => {
          if (usedIds.has(x.id)) return;
          if (hav(c, x) > 60) return;
          if ((typeKey(x).key || '') !== (t.key || '')) return;
          if ((x.rating || 0) < (s.rating || 0)) return;   // 不能越换越差
          const sc = varScore(x, v);
          if (sc > bs) { bs = sc; best = x; }
        });
        if (best) { usedIds.delete(s.id); usedIds.add(best.id); n++; return best; }
        return s;
      });
    });
    return n;
  }

  /* ================= 地域分区 ================= */
  // 把一省的景点按地理位置切成 2~3 个连续地带（北部/中部/南部 或 西部/东部）
  // 做法：比较东西向与南北向展布(km)选主轴 → 按主轴排序 → 等频断点 + 最大间隙吸附 → 命名
  function geoRegions(cands) {
    const pts = cands.filter(s => typeof s.lat === 'number' && typeof s.lng === 'number');
    if (pts.length < 6) return null;
    const midLat = pts.reduce((a, s) => a + s.lat, 0) / pts.length;
    const kx = Math.cos(midLat * Math.PI / 180) * 111.32;
    const ky = 110.57;
    const lats = pts.map(s => s.lat), lngs = pts.map(s => s.lng);
    const spanY = (Math.max.apply(null, lats) - Math.min.apply(null, lats)) * ky;
    const spanX = (Math.max.apply(null, lngs) - Math.min.apply(null, lngs)) * kx;
    const useLat = spanY >= spanX;
    const span = Math.max(spanX, spanY);
    if (span < 200) return null;                                    // 省域太小，不必分区
    const k = (span >= 750 && pts.length >= 15) ? 3 : 2;
    const ax = s => (useLat ? s.lat : s.lng);
    const sorted = pts.slice().sort((a, b) => ax(a) - ax(b));
    const n = sorted.length;
    const cuts = [];
    for (let i = 1; i < k; i++) {
      const idx = Math.round(n * i / k);
      const lo = Math.max(1, idx - Math.round(n * 0.12));
      const hi = Math.min(n - 1, idx + Math.round(n * 0.12));
      let bi = idx, bg = -1;
      for (let j = lo; j <= hi; j++) {
        const g = ax(sorted[j]) - ax(sorted[j - 1]);
        if (g > bg) { bg = g; bi = j; }
      }
      cuts.push(bi);
    }
    // 坐标小的在前：纬度小=南，经度小=西
    const seq = useLat
      ? (k === 3 ? ['南部', '中部', '北部'] : ['南部', '北部'])
      : (k === 3 ? ['西部', '中部', '东部'] : ['西部', '东部']);
    const out = [];
    let prev = 0;
    for (let i = 0; i <= cuts.length; i++) {
      const end = (i < cuts.length) ? cuts[i] : n;
      const part = sorted.slice(prev, end);
      prev = end;
      if (!part.length) continue;
      out.push({
        key: seq[i], label: seq[i], axis: useLat ? '南北' : '东西', spots: part,
        center: {
          lng: part.reduce((a, s) => a + s.lng, 0) / part.length,
          lat: part.reduce((a, s) => a + s.lat, 0) / part.length
        }
      });
    }
    return out.length >= 2 ? out : null;
  }

  // 名称去重 + 同类稀释（地域排程复用算法分支同规则）
  function dedupeByName(list) {
    const seen = [], out = [];
    list.forEach(s => {
      const k = normName(s.name);
      if (seen.some(x => sameSpot(x, k))) return;
      seen.push(k); out.push(s);
    });
    return out;
  }
  function diluteByType(list) {
    const cnt = {}, out = [];
    list.forEach(s => {
      const t = typeKey(s);
      if (t.key) {
        const c = cnt[t.key] || 0;
        if (c >= typeCap(t)) return;
        cnt[t.key] = c + 1;
      }
      out.push(s);
    });
    return out.length >= 8 ? out : list;
  }
  // 天描述不够请求天数时，用剩余候选就近补齐（与模板分支同规则）
  function fillToDays(dayDescs, days, candidates, usedIds, prov) {
    if (dayDescs.length >= days) return dayDescs;
    const remain = candidates.filter(s => !usedIds.has(s.id));
    let last = null;
    dayDescs.forEach(d => { if (d.spots.length) last = d.spots[d.spots.length - 1]; });
    const typeCount = {};
    dayDescs.forEach(d => d.spots.forEach(s => { const t = typeKey(s); if (t.key) typeCount[t.key] = (typeCount[t.key] || 0) + 1; }));
    while (dayDescs.length < days && remain.length) {
      if (last) remain.sort((a, b) => hav(a, last) - hav(b, last));
      const take = [];
      while (take.length < 3 && remain.length) {
        const s = remain.shift();
        const t = typeKey(s);
        if (t.key) {
          const c = typeCount[t.key] || 0;
          if (c >= typeCap(t)) continue;
          typeCount[t.key] = c + 1;
        }
        take.push(s);
      }
      if (!take.length) break;
      take.forEach(s => usedIds.add(s.id));
      dayDescs.push({ city: take[0].city || prov, spots: take });
      last = take[take.length - 1];
    }
    return dayDescs;
  }

  // ★ 地域线路排程：按区分段 → 天数按区景点数分配（每区至少 1 天）→ 区间沿枢纽最近邻排序 → 同日同区（硬约束）
  function planByRegion(candidates, days, prefs, center, mode, opts) {
    opts = opts || {};
    const warnings = [];
    const v = VAR_BY_ID[opts.variant] || VAR_BY_ID.classic;
    const prov = (candidates[0] || {}).province || '';
    const regs = geoRegions(candidates);
    if (!regs) return null;
    const only = opts.region && opts.region !== 'all' ? regs.filter(r => r.key === opts.region) : regs;
    if (!only.length) return null;

    // 枢纽点：省会景点质心，退化为传入的 center
    const hub = hubOf(prov);
    let hubPt = center && typeof center.lat === 'number' ? { lng: center.lng, lat: center.lat } : null;
    if (hub) {
      const hsp = candidates.filter(s => s.city === hub || s.city === hub + '市' || s.county === hub);
      if (hsp.length) hubPt = {
        lng: hsp.reduce((a, s) => a + s.lng, 0) / hsp.length,
        lat: hsp.reduce((a, s) => a + s.lat, 0) / hsp.length
      };
    }

    // 区间顺序：从枢纽所在区出发，其余区间按质心最近邻串联，避免南北来回折返
    let order = only.slice();
    if (order.length > 2 && hubPt) {
      const start = order.reduce((a, b) => hav(a.center, hubPt) <= hav(b.center, hubPt) ? a : b);
      const rest = order.filter(r => r !== start);
      const seq = [start];
      while (rest.length) {
        const cur = seq[seq.length - 1];
        let bi = 0, bd = Infinity;
        rest.forEach((r, i) => { const dd = hav(cur.center, r.center); if (dd < bd) { bd = dd; bi = i; } });
        seq.push(rest.splice(bi, 1)[0]);
      }
      order = seq;
    } else if (hubPt) {
      order = order.slice().sort((a, b) => hav(a.center, hubPt) - hav(b.center, hubPt));
    }
    if (order.length > days) order = order.slice(0, days);   // 天数少于分区数：只走最近的前几个区

    // 天数按区分配（每区至少 1 天，总和恰为 days）
    const totalSpots = order.reduce((a, r) => a + r.spots.length, 0) || 1;
    const alloc = order.map(r => Math.max(1, Math.round(days * r.spots.length / totalSpots)));
    let guard = 0;
    while (alloc.reduce((a, b) => a + b, 0) > days && guard++ < 50) {
      const i = alloc.indexOf(Math.max.apply(null, alloc));
      if (alloc[i] <= 1) break;
      alloc[i]--;
    }
    guard = 0;
    while (alloc.reduce((a, b) => a + b, 0) < days && guard++ < 50) {
      alloc[alloc.indexOf(Math.max.apply(null, alloc))]++;
    }

    const usedIds = new Set();
    let dayDescs = [];
    order.forEach((r, ri) => {
      const want = alloc[ri];
      let list = r.spots.filter(s => !usedIds.has(s.id))
        .sort((a, b) => spotScore(b, prefs, v) - spotScore(a, prefs, v));
      list = diluteByType(dedupeByName(list));
      const take = list.slice(0, Math.max(want * 3, want + 2));
      take.forEach(s => usedIds.add(s.id));
      const rest = take.slice();
      let made = 0;
      while (rest.length && made < want) {
        const seed = rest.shift();
        const grp = [seed];
        rest.slice().sort((a, b) => hav(seed, a) - hav(seed, b)).forEach(s => {
          if (grp.length < 3 && hav(seed, s) < 60) grp.push(s);
        });
        grp.forEach(s => { const i = rest.indexOf(s); if (i >= 0) rest.splice(i, 1); });
        dayDescs.push({ city: (grp[0].city || grp[0].county || r.label), spots: grp, region: r.label });
        made++;
      }
    });

    dayDescs = fillToDays(dayDescs, days, candidates, usedIds, prov);
    if (dayDescs.length > days) dayDescs = dayDescs.slice(0, days);
    if (!dayDescs.length) return null;
    themeSwap(dayDescs, v, candidates, usedIds);

    const regionPool = [];
    only.forEach(r => r.spots.forEach(s => regionPool.push(s)));
    window.__lastRegionDescs = dayDescs.map(d => ({ city: d.city, region: d.region, spots: d.spots.map(s => s.name) }));
    const asm = assembleDays(dayDescs, days, candidates, prov, warnings, true, regionPool);   // 地域线路：同日同区硬约束 + 补点不出区
    if (!asm.days.length) return null;
    if (order.length > 1) {
      warnings.push('已按地域分 ' + order.length + ' 段排程（' + order.map((r, i) => r.label + alloc[i] + '天').join(' · ') +
        '），区间沿' + (hub || '枢纽') + '方向就近串联，同日景点都在同一地域带内。');
    }
    // 地域线路按设计"不跨带补点"：带内景点分散时会出现空白日，用户容易误以为"排不出景点是 bug"。
    // 判据用"实际排入情况"而非"带内景点总数"——总数够但地理跨度太大的区域照样排不满
    // （真实案例：山西南部 12 个景点 / 6 天，实际只排进 4 个、2 天为机动或返程）。
    const placedN = asm.days.reduce((a, d) => a + (d.route || []).length, 0);
    const blanks = asm.days.filter(d => !(d.route || []).length).length;
    if (blanks > 0) {
      warnings.push('「' + (opts.region && opts.region !== 'all' ? opts.region : '本地域') + '」带内景点较分散：' +
        days + ' 天里排入 ' + placedN + ' 个景点，另有 ' + blanks + ' 天为机动/返程。' +
        '地域线路按设计不跨带补点，想要更饱满可切回「全省」。');
    }
    return {
      days: asm.days, warnings: warnings, mode: mode === 'drive' ? 'drive' : 'transit',
      planName: (opts.region && opts.region !== 'all' ? opts.region + '线路' : '地域分段') + (v.id === 'classic' ? '' : ' · ' + v.name),
      __sig: 'R|' + asm.days.map(d => (d.route || []).map(s => s.id).join(',')).join('|'),
      __rawLines: 1, __rotLen: 1, __idx: 0, __variant: v.id, __region: opts.region || 'all'
    };
  }

  // ★ 共用装配管线：把"天描述 dayDescs"装配成最终逐日行程。
  //   模板排程与地域排程都走这一条，保证质量规则一致：
  //   车程计入时间轴、常规日 20:30 收工、末日 13:30 前结束、首末天锚定枢纽、排不下顺延次日并告警
  function assembleDays(dayDescs, days, candidates, prov, warnings, strictGeo, ownPool) {
    if (!dayDescs.length) return { days: [], spill: [] };

    const DAY_CAP = 20 * 60 + 30;     // 常规日收工线
    const LAST_CAP = 13 * 60 + 30;    // 末日结束线（下午留给返程）
    const GAP = 20;                   // 景点间接驳缓冲（分钟），车程另计
    function buildDayItems(spots, city, di, total, fromPt) {
      const isFirst = di === 0, isLast = di === total - 1;
      const items = [];
      const startM = (isFirst ? 14 : 9) * 60;
      items.push({ type:'note', start: fmt(startM), text: isFirst ? '抵达'+city+'，下午开始游览' : '从酒店出发，开始'+city+'的行程' });
      let m = startM, from = fromPt || null, lunchDone = false;
      const used = [], carry = [];
      spots.forEach(s => {
        const dur = s.dur || 3;
        const leg = from ? travel(from, s) : { min: 0, mode: '' };
        if (leg.min > 240) { carry.push(s); return; }      // 单程超 4 小时，当天往返不现实 → 顺延
        let arrive = m + (leg.min || 0);
        // 午餐：非长景点且时段跨过 12:30 → 先用餐再进景区（末日不安排午餐）
        if (!isLast && !lunchDone && dur < 4 && arrive < 12*60+30 && arrive + dur*60 > 12*60+30) {
          arrive = Math.max(arrive, 12*60) + 60;
          lunchDone = true;
          items.push({ type:'meal', start:'12:00', end:'13:00', text:'午餐，品尝当地特色美食' });
        }
        const start = arrive, end = arrive + dur*60;
        if (end > (isLast ? LAST_CAP : DAY_CAP)) { carry.push(s); return; }
        // 末日还得留得出返程：终点距枢纽 >300km、或结束后赶不回枢纽的，一律不排
        if (isLast && hubPt && (hav(s, hubPt) > 300 || end + travel(s, hubPt).min > 20 * 60)) { carry.push(s); return; }
        let note = leg.min ? '乘' + leg.mode + '约 ' + leg.min + ' 分钟' : (isFirst ? '市区游览' : '继续游览');
        if (!used.length && leg.min) note = '从' + (city || '酒店') + '出发，' + note;
        if (dur >= 4 && start < 12*60 && end > 13*60) note += '；午餐可在景区内解决';
        items.push({ type:'spot', spot:s, start: fmt(start), end: fmt(end), note: note });
        m = end + GAP;
        from = { lat: s.lat, lng: s.lng };
        used.push(s);
      });
      if (isLast) {
        const txt = used.length ? '下午返回交通枢纽城市，乘高铁/飞机返程'
                                : '上午自由活动，下午返回交通枢纽城市，乘高铁/飞机返程';
        items.push({ type:'note', start: fmt(Math.max(m, 13*60)), text: txt });
      } else {
        if (used.length && m <= 19*60+30) {
          const ds = Math.max(m, 18*60);
          items.push({ type:'meal', start: fmt(ds), end: fmt(Math.min(ds+60, DAY_CAP)), text:'晚餐' });
        }
        items.push({ type:'note', start: fmt(Math.min(Math.max(m, 20*60), DAY_CAP)), text: '返回酒店休息' });
      }
      return { items: items, used: used, carry: carry, endPt: from };
    }

    // ★ 进出港锚定：第一天与最后一天要方便往返（省会枢纽 + 末日返程可达）
    const hub = hubOf(prov);
    const hubPt = hub ? (() => {
      const hsp = candidates.filter(s => s.city === hub || s.city === hub + '市' || s.county === hub);
      return hsp.length ? {
        lng: hsp.reduce((a, s) => a + s.lng, 0) / hsp.length,
        lat: hsp.reduce((a, s) => a + s.lat, 0) / hsp.length
      } : null;
    })() : null;
    const usedIds = new Set();
    dayDescs.forEach(d => (d.spots || []).forEach(s => usedIds.add(s.id)));
    // 地域线路只能从"本次行程所属地域"里取补点，否则会出现"晋北线路里塞进太原的景点"
    const pool = ownPool && ownPool.length ? ownPool : candidates;
    if (hub && strictGeo) {
      // 地域线路：只做"首日抵达"补点，不改动末日顺序、更不把末日清空
      const isHub = s => s.city === hub || s.city === hub + '市' || s.county === hub;
      const fi = dayDescs.findIndex(d => d.spots.some(isHub));
      if (fi === -1) {
        const hs = pool.filter(isHub).filter(s => !usedIds.has(s.id));
        const use = hs.filter(s => (s.dur || 3) <= 3).concat(hs).filter((v, i, a) => a.indexOf(v) === i).slice(0, 2);
        // 地域线路：只在"还有空天"时才补抵达日，绝不为塞抵达日而 pop 掉一整天的内容
        if (use.length && dayDescs.length < days) {
          use.forEach(s => usedIds.add(s.id));
          dayDescs.unshift({ city: hub, spots: use });
        }
      } else if (fi > 0) {
        dayDescs.unshift(dayDescs.splice(fi, 1)[0]);
      }
      // 就近收尾：末日末点离枢纽太远 → 把"离枢纽最近的一天"换到最后（只调顺序，不丢内容），
      // 这样末日一定是能顺利返程的一段；④"改造成枢纽日"那步在地域线路里不做（会注入区外景点或清空末日）
      const tailOf = d => (d.spots.length ? d.spots[d.spots.length - 1] : null);
      const distOf = d => { const t = tailOf(d); return (t && hubPt) ? hav(t, hubPt) : Infinity; };
      if (dayDescs.length > 2 && distOf(dayDescs[dayDescs.length - 1]) > 150) {
        let bi = -1, bd = 1e9;
        for (let i = 1; i < dayDescs.length - 1; i++) {
          const dd = distOf(dayDescs[i]);
          if (dd <= 150 && dd < bd) { bd = dd; bi = i; }
        }
        if (bi > 0) dayDescs.push(dayDescs.splice(bi, 1)[0]);
      }
    } else if (hub) {
      const isHub = s => s.city === hub || s.city === hub + '市' || s.county === hub;
      // 首日：含枢纽景点的天挪到最前；整天没有就用枢纽轻松点造一个抵达日
      const fi = dayDescs.findIndex(d => d.spots.some(isHub));
      if (fi > 0) dayDescs.unshift(dayDescs.splice(fi, 1)[0]);
      if (fi === -1) {
        const hs = candidates.filter(isHub).filter(s => !usedIds.has(s.id));
        const use = hs.filter(s => (s.dur || 3) <= 3).concat(hs).filter((v, i, a) => a.indexOf(v) === i).slice(0, 2);
        use.forEach(s => usedIds.add(s.id));
        dayDescs.unshift({ city: hub, spots: use });
        if (dayDescs.length > days) dayDescs.pop();   // 抵达日挤出一位，保持总天数
      }
      // 末日：① 含枢纽景点的天挪到最后 ② 末日末点本就在枢纽 150km 内（返程约 2h）则原地不动
      //       ③ 否则把"末点离枢纽最近"的天挪到最后（内容不动，只调顺序）
      //       ④ 都不行才改造成枢纽日；枢纽景点也排满了就退化为纯返程日
      let li = -1;
      for (let i = dayDescs.length - 1; i >= 1; i--) if (dayDescs[i].spots.some(isHub)) { li = i; break; }
      if (li > 0 && li !== dayDescs.length - 1) dayDescs.push(dayDescs.splice(li, 1)[0]);
      if (li === -1) {
        const tailOf = d => (d.spots.length ? d.spots[d.spots.length - 1] : null);
        const distOf = d => { const t = tailOf(d); return (t && hubPt) ? hav(t, hubPt) : Infinity; };
        if (distOf(dayDescs[dayDescs.length - 1]) > 150) {
          let bi = -1, bd = 1e9;
          for (let i = 1; i < dayDescs.length - 1; i++) {
            const dd = distOf(dayDescs[i]);
            if (dd <= 150 && dd < bd) { bd = dd; bi = i; }
          }
          if (bi > 0) {
            dayDescs.push(dayDescs.splice(bi, 1)[0]);   // 就近收尾：只调顺序，不丢内容
          } else {
            const last = dayDescs[dayDescs.length - 1];
            const hs = candidates.filter(isHub).filter(s => !usedIds.has(s.id));
            if (last.spots.length) warnings.push('为满足末日返回枢纽城市，以下景点未排入：' + last.spots.map(s => s.name).join('、') + '。');
            last.spots.forEach(s => usedIds.delete(s.id));
            if (hs.length) {
              const use = hs.slice(0, 2);
              use.forEach(s => usedIds.add(s.id));
              dayDescs[dayDescs.length - 1] = { city: hub, spots: use };
            } else {
              dayDescs[dayDescs.length - 1] = { city: hub, spots: [] };   // 纯返程日
            }
          }
        }
      }
    }

    // 请求天数比模板短（如用了 4 天模板排 3 天）：截取前 N 天
    if (dayDescs.length > days) dayDescs = dayDescs.slice(0, days);

    // ★ 逐日装配：车程计入时间轴、20:30 收工；当日排不下的景点顺延次日，末日仍排不下则告警
    const total = dayDescs.length;
    function packDays(descs) {
      const plans = [];
      // ★ 地域线路的首日就是"抵达当天所在的城市"，不该再叠加一段从枢纽出发的跨城车程：
      //   否则首日下午（14:00 起）大半被车程吃掉，当天景点全被顺延并入末日前的余量，
      //   实测山西南部 6 天原 9 个景点只剩 4 个（真实事故）。经典线路保持原行为（首日从枢纽出发）。
      let carried = [], fromPt = strictGeo ? null : hubPt;
      for (let di = 0; di < total; di++) {
        const d = descs[di];
        // ★ 单日地理护栏（仅地域线路启用）：顺延下来的景点若离今天太远（>150km）就不塞进今天，
        //   否则会出现"同一天跨 200~300 公里"的行程 —— 这是地域线路必须守的"同日同区"硬约束。
        //   经典线路不开这道护栏：实测会给长途线路换掉几个景点、甚至把末日清空，得不偿失。
        const anchor = strictGeo && d.spots.length ? d.spots[0] : null;
        const keep = [], hold = [];
        carried.forEach(s => { if (!anchor || hav(anchor, s) <= 150) keep.push(s); else hold.push(s); });
        // 扣下的景点就近安置到后面"顺路且没排满"的天，避免一路拖到最后被丢掉
        if (hold.length) {
          hold.slice().forEach(s => {
            let best = -1, bd = 150;
            for (let j = di + 1; j < total; j++) {
              const dj = descs[j];
              if (!dj.spots.length || dj.spots.length >= 3) continue;
              if (hav(dj.spots[0], s) <= bd) { bd = hav(dj.spots[0], s); best = j; }
            }
            if (best >= 0) {
              descs[best].spots = descs[best].spots.concat([s]);
              const i2 = hold.indexOf(s);
              if (i2 >= 0) hold.splice(i2, 1);
            }
          });
        }
        const queue = keep.concat(d.spots);
        // 日程标题用"当天实际首个景点"所在城市，避免模板城市名与实际行程对不上
        const anchorSpot = queue.find(s => s.city || s.county);
        const cityLabel = anchorSpot
          ? String(anchorSpot.city || anchorSpot.county).replace(/[（(].*$/, '')
          : (d.city || '');
        let r = buildDayItems(queue, cityLabel, di, total, fromPt);
        // 标题城市以"真正排入的首个景点"为准（队列里可能夹着排不下的顺延景点，会误判城市）
        if (r.used.length) {
          const real = String(r.used[0].city || r.used[0].county || '').replace(/[（(].*$/, '');
          if (real && real !== cityLabel) r = buildDayItems(queue, real, di, total, fromPt);
        } else if (di === total - 1 && hub && cityLabel !== hub) {
          r = buildDayItems(queue, hub, di, total, fromPt);   // 末日纯返程日：标题写枢纽城市
        }
        carried = hold.concat(r.carry);
        fromPt = r.endPt;
        if (!r.used.length && di > 0 && di < total - 1) {
          plans.push({ day: di + 1, route: [], items: [
            { type:'note', start:'09:00', text:'机动日，可自由活动、休整或深度游览上一站周边' },
            { type:'note', start:'20:00', text:'返回酒店休息' }
          ] });
          continue;
        }
        plans.push({ day: di + 1, route: r.used, items: r.items });
      }
      return { plans: plans, spill: carried, tailPt: fromPt };
    }

    // 注：「末日翻盘重排」（把最靠近枢纽的一天换到最后）属于 P1 的路由顺序问题——
    // 它需要先保证全程序地理连续，否则会把中间天的内容挤散（实测会整段丢掉大理）。
    // 此处只做安全的「末日不排不可达景点」，排不下就退化为纯返程日并明确告警。
    const packed = packDays(dayDescs);
    const dayPlans = packed.plans;
    const spill = packed.spill;
    if (dayPlans.length && !dayPlans[dayPlans.length - 1].route.length && packed.tailPt && hubPt) {
      const km = hav(packed.tailPt, hubPt);
      if (km > 250) warnings.push('末日所在地距枢纽城市约 ' + Math.round(km) + ' 公里，已安排为纯返程日（上午出发赶高铁/飞机，不再排景点）。');
    }
    if (spill.length) {
      warnings.push('受每日游览与车程时长限制（每天 20:30 收工、末日只排上午），以下景点未排入：' +
        spill.map(s => s.name).join('、') + '。建议增加天数。');
    }
    return { days: dayPlans, spill: spill };
  }

  // 套用成熟旅行社模板；8~20 天时自动拼接多条模板线（跨线路去重），缺口天数用剩余景点就近补排
  // idx = 方案轮换序号（0 为第一套），由外层 planFromTemplate 传入
  function planFromTemplateOnce(candidates, days, mode, idx, opts) {
    idx = idx || 0;
    const v = VAR_BY_ID[(opts && opts.variant) || 'classic'] || VAR_BY_ID.classic;
    const warnings = [];
    if (!candidates.length) return null;
    if (mode === 'drive') return null;   // 自驾模式不走旅行社模板，由 planDrive 连续路径接管
    const prov = candidates[0].province || '';
    const TPL = (typeof TRIP_TEMPLATES !== 'undefined') ? TRIP_TEMPLATES[prov] : null;
    if (!TPL) return null;
    const availDays = Object.keys(TPL).map(Number).sort((a,b)=>a-b);
    const allSpots = window.APP_DATA.attractions;
    const provPool = allSpots.filter(x => x.province === prov);

    // 把一条模板线展开成天描述（关键词匹配→真实景点，usedIds 全程共享去重 + 同类稀释）
    function expandLine(tpl, usedIds, typeCount) {
      const out = [];
      tpl.days.forEach(td => {
        const spots = [];
        td.spots.forEach(kw => {
          let s = findSpotByKeyword(candidates, kw, v);
          if (!s) s = findSpotByKeyword(provPool, kw, v);
          if (!s || usedIds.has(s.id)) return;
          const t = typeKey(s);
          if (t.key) {
            const c = typeCount[t.key] || 0;
            if (c >= typeCap(t)) return;   // 同类型景点本行程已排过，跳过
            typeCount[t.key] = c + 1;
          }
          spots.push(s); usedIds.add(s.id);
        });
        out.push({ city: td.city, spots: spots });
      });
      return out;
    }

    // DP：用可用天数组合恰好凑出 target（段数最少；凑不出返回 null）
    function composeDays(target, avail) {
      const dp = [ { parts: [] } ];
      for (let n = 1; n <= target; n++) {
        let best = null;
        avail.forEach(a => {
          if (n - a < 0 || !dp[n - a]) return;
          const cand = dp[n - a].parts.concat(a);
          if (!best || cand.length < best.length) best = cand;
        });
        dp[n] = best ? { parts: best } : null;
      }
      return dp[target] ? dp[target].parts : null;
    }

    // 段计划：每个天数段用一条该天数的模板线
    let segPlan = null;
    if (TPL[days]) segPlan = [days];
    else if (days < availDays[0]) segPlan = [availDays[0]];   // 请求比最短模板还短：用最短模板
    else if (days <= availDays[availDays.length - 1]) {
      const smaller = availDays.filter(d => d <= days);
      segPlan = [smaller[smaller.length - 1]];                // 原逻辑：不超请求的最接近模板
    } else {
      segPlan = composeDays(days, availDays);                 // 8~20：多条模板拼接
      if (!segPlan) segPlan = [availDays[availDays.length - 1]];   // 兜底：最大模板 + 补排
    }
    if (!segPlan) return null;

    // ★ 轮换周期：每段按"内容去重后"的线路数取最小公倍数（各段共用同一个 idx 偏移）
    const segPeriods = segPlan.map(n => Math.max(1, uniqLines(n, TPL).length));
    let rotLen = 1;
    segPeriods.forEach(p => { rotLen = rotLen * p / gcd(rotLen, p); });
    window.__tplPeriods = { prov: prov, days: days, L: rotLen, segs: segPlan.slice(), periods: segPeriods };

    const usedIds = new Set();
    const usedLines = new Set();   // 存线路"内容指纹"，不再按 name 判重
    const typeCount = {};   // 行程级同类稀释计数
    let dayDescs = [];
    let maxLineCount = 1;      // 内容去重后的线路数（用于首轮候选枚举）
    let rawLineCount = 1;      // 去重前的原始线路条数（用于解释"为何无方案可换"）
    segPlan.forEach(n => {
      const uniq = uniqLines(n, TPL);
      if (!uniq.length) return;
      maxLineCount = Math.max(maxLineCount, uniq.length);
      rawLineCount = Math.max(rawLineCount, ((TPL[n] || []).length));
      let line = uniq[((idx % uniq.length) + uniq.length) % uniq.length];
      // 同一次行程里不同段不要撞上同一条线
      for (let g = 0; g < uniq.length && usedLines.has(tplLineSig(line)); g++) {
        idx++;
        line = uniq[((idx % uniq.length) + uniq.length) % uniq.length];
      }
      usedLines.add(tplLineSig(line));
      dayDescs = dayDescs.concat(expandLine(line, usedIds, typeCount));
    });
    // 整天一个景点都没匹配上的（关键词全被去重/查无）：丢弃
    dayDescs = dayDescs.filter(d => d.spots.length);
    if (!dayDescs.length) return null;

    // 拼接后不足请求天数：用剩余候选景点就近补排（每天 2~3 个）；实在没有就排机动日
    let lastSpot = null;
    dayDescs.forEach(d => { if (d.spots.length) lastSpot = d.spots[d.spots.length - 1]; });
    const remain = candidates.filter(s => !usedIds.has(s.id));
    let fillerNote = false;
    while (dayDescs.length < days) {
      if (remain.length) {
        if (lastSpot) remain.sort((a, b) => hav(a, lastSpot) - hav(b, lastSpot));
        const take = [];
        while (take.length < 3 && remain.length) {
          const s = remain.shift();
          const t = typeKey(s);
          if (t.key) {
            const c = typeCount[t.key] || 0;
            if (c >= typeCap(t)) continue;   // 同类型已排满，跳过
            typeCount[t.key] = c + 1;
          }
          take.push(s);
        }
        if (!take.length) { dayDescs.push({ city: '机动日', spots: [] }); continue; }
        take.forEach(s => usedIds.add(s.id));
        dayDescs.push({ city: take[0].city || prov, spots: take });
        lastSpot = take[take.length - 1];
      } else {
        dayDescs.push({ city: '机动日', spots: [] });
        if (!fillerNote) {
          warnings.push('景点库不足以排满 ' + days + ' 天，多余天数已安排为机动日（可自由活动或休整）。');
          fillerNote = true;
        }
      }
    }

    // ★ 主题调换：按人群口味把景点换成"同区同类型、更契合主题"的替代项（天数结构与地理跨度不变）
    const swapped = themeSwap(dayDescs, v, candidates.concat(provPool), usedIds);

    // ★ 交给共用装配管线：车程计入时间轴、20:30 收工、末日只排上午、首末枢纽锚定、排不下顺延并告警
    const asm = assembleDays(dayDescs, days, candidates, prov, warnings);
    const dayPlans = asm.days;
    const spill = asm.spill;
    const total = dayPlans.length;

    if (segPlan.length > 1) {
      warnings.push('行程较长，已按 ' + segPlan.slice().sort((a,b)=>b-a).join(' + ') + ' 天经典旅行社线路分段拼接，跨线路重复景点已自动去重。');
    }
    warnings.push('本行程参考' + prov.replace(/省|市|自治区|壮族|回族|维吾尔|藏族|彝族|布依族/g,'') + '经典旅行社线路模板。');
    window.__lastTplProv = prov;
    window.__lastTplDays = total;
    window.__lastTplTotal = maxLineCount;
    // 方案指纹：用于识别"连点换方案是否真的换了内容"
    const __sig = dayPlans.map(d => (d.route || []).map(s => s.id).join(',')).join('|');
    return {
      days: dayPlans, warnings: warnings, mode: mode === 'drive' ? 'drive' : 'transit',
      totalPlans: maxLineCount,
      planName: (usedLines.size > 1 ? '多线路拼接' : (dayPlans.length + '日游')) + (v.id === 'classic' ? '' : ' · ' + v.name),
      __sig: __sig, __idx: idx, __rotLen: rotLen, __rawLines: rawLineCount,
      __variant: v.id, __region: 'all', __swapped: swapped
    };
  }

  // ★ 多方案封装：把"模板原始线路条数"换成"真实可达方案数"，并保证每次点击都换出不同的内容
  //   —— 原来 totalPlans = 原始条数，且不同线路经首末锚定/去重后可能收敛成同一套，
  //      于是出现"按钮写着 6 套、连点 6 次都是同一套"的虚标问题
  function planFromTemplate(candidates, days, mode, opts) {
    if (!candidates.length) return null;
    if (mode === 'drive') return null;
    const prov = candidates[0].province || '';
    const TPL = (typeof TRIP_TEMPLATES !== 'undefined') ? TRIP_TEMPLATES[prov] : null;
    if (!TPL) return null;
    // 换省份/换城市池/换天数/换交通方式/换主题 → 方案轮换归零，避免串场
    const ctxKey = prov + '#' + days + '#' + mode + '#' + candidates.length + '#' + ((opts && opts.variant) || 'classic');
    if (window.__tplCtxKey !== ctxKey) {
      window.__tplCtxKey = ctxKey;
      window.__tplIdx = 0;
      window.__tplSigShown = '';
      window.__tplShownSigs = new Set();
      window.__tplCycled = false;
    }
    const base = window.__tplIdx || 0;
    const MAXPROBE = 16;   // 单次点击最多试算的候选数（防多段拼接时的组合爆炸）
    let L = 1;
    const cache = window.__tplPeriods;
    if (cache && cache.prov === prov && cache.days === days) L = Math.min(MAXPROBE, Math.max(1, cache.L));
    const results = [];
    for (let t = 0; t < Math.min(L, MAXPROBE); t++) {
      const r = planFromTemplateOnce(candidates, days, mode, base + t, opts);
      if (t === 0 && window.__tplPeriods && window.__tplPeriods.prov === prov && window.__tplPeriods.days === days) {
        L = Math.min(MAXPROBE, Math.max(1, window.__tplPeriods.L));   // 首轮后拿到真实周期，扩大枚举
      }
      if (!r || !r.days || !r.days.length) continue;
      if (!results.some(x => x.__sig === r.__sig)) results.push(r);
    }
    if (!results.length) return null;
    // 优先给出与"当前已显示"不同的一套
    const pick = results.find(r => r.__sig !== window.__tplSigShown) || results[0];
    // 用"已浏览过的方案集合"判断是否已轮完一圈
    if (!(window.__tplShownSigs instanceof Set)) window.__tplShownSigs = new Set();
    const cycled = window.__tplShownSigs.has(pick.__sig);
    if (cycled) window.__tplShownSigs = new Set([pick.__sig]);   // 开新一轮
    else window.__tplShownSigs.add(pick.__sig);
    window.__tplSigShown = pick.__sig;
    window.__tplCycled = cycled;
    pick.totalPlans = results.length;                    // ★ 真实（去重后）方案数
    window.__lastTplTotal = results.length;
    if (results.length === 1) {
      if ((pick.__rawLines || 0) > 1) pick.warnings = pick.warnings.concat(['本省 ' + days + ' 日游的线路模板经内容去重后只有 1 套可行方案，暂无其它方案可换。']);
    } else if (cycled) {
      pick.warnings = pick.warnings.concat(['已浏览完所有 ' + results.length + ' 套方案，回到第 1 套。']);
    }
    return pick;
  }

  function plan(candidates, days, prefs, center, mode, opts) {
    const warnings = [];
    if (!candidates.length) return { days: [], warnings: ['该区域暂未收录景点，试试输入周边城市。'] };
    days = Math.max(1, Math.min(20, days | 0));
    prefs = prefs || new Set();
    mode = mode === 'drive' ? 'drive' : 'transit';

    // 长行程（≥8 天）：把全省景点并入候选池，避免单个城市池排不满
    if (days >= 8) {
      const prov0 = (candidates[0] || {}).province;
      if (prov0) {
        const ids0 = new Set(candidates.map(s => s.id));
        const extra = (window.APP_DATA ? window.APP_DATA.attractions : []).filter(s => s.province === prov0 && !ids0.has(s.id));
        if (extra.length) {
          candidates = candidates.concat(extra);
          warnings.push('行程较长，已将' + prov0 + '全省景点纳入安排范围。');
        }
      }
    }

    // 指定了地域分区 → 直接走地域线路排程
    const opt = opts || {};
    if (opt.region && opt.region !== 'all') {
      const rg = planByRegion(candidates, days, prefs, center, mode, opt);
      if (rg && rg.days.length) return rg;
    }
    // 经典模式优先套用成熟旅行社模板（指定主题时跳过，交由算法排程做变异）
    if (!opt.variant || opt.variant === 'classic') {
      const tplResult = planFromTemplate(candidates, days, mode, opt);
      if (tplResult && tplResult.days.length) return tplResult;
    }
    return planByAlgorithm(candidates, days, prefs, center, mode, opt, warnings);
  }

  // ★ 算法排程（不走旅行社模板）：评分选点 → 按距枢纽分层 → 分组 → 最近邻路线 → 时间轴
  function planByAlgorithm(candidates, days, prefs, center, mode, opts, warnings) {
    warnings = warnings || [];
    const variant = VAR_BY_ID[(opts && opts.variant) || 'classic'] || VAR_BY_ID.classic;

    // 1) 打分（叠加人群主题权重）
    const score = s => spotScore(s, prefs, variant);
    const sorted0 = [...candidates].sort((a, b) => score(b) - score(a));

    // 2) 名称去重（归一化+前缀包含判重，保留评分高者）
    const seenN = [];
    const sorted = [];
    for (const s of sorted0) {
      const k = normName(s.name);
      if (seenN.some(x => sameSpot(x, k))) continue;
      seenN.push(k); sorted.push(s);
    }

    // 2.5) 类型稀释：文化同类型（大院/古城/寺庙等）最多 1 个，自然类最多 2 个；池子太薄（<8）则放宽
    {
      const tCount = {};
      const pruned = [];
      for (const s of sorted) {
        const t = typeKey(s);
        if (t.key) {
          const c = tCount[t.key] || 0;
          if (c >= typeCap(t)) continue;
          tCount[t.key] = c + 1;
        }
        pruned.push(s);
      }
      if (pruned.length >= 8) { sorted.length = 0; sorted.push(...pruned); }
    }

    // 3) 推断交通枢纽：候选所属省的省会；城市模式则用 city 字段
    const prov = sorted[0].province || '';
    const hubName = hubOf(prov);
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

    // 高强度景点各自单独一天（优先排在中间段，最后一天回枢纽）
    // 附近若有小景点则带 1 个，确保每天至少 2 个景点
    const bigLeft = bigs.filter(s => !usedIds.has(s.id));
    bigLeft.forEach(big => {
      if (groups.filter(g => g.length).length >= days) return;
      const bigDay = [big];
      usedIds.add(big.id);
      const nearBig = smalls.filter(s => !usedIds.has(s.id))
        .sort((a,b) => hav(big, a) - hav(big, b));
      if (nearBig.length && hav(big, nearBig[0]) < 80) {
        bigDay.push(nearBig[0]);
        usedIds.add(nearBig[0].id);
      }
      groups.push(bigDay);
    });

    // 天数多时：剩余小景点就近继续组团（每天 2~3 个、同区域 60km 内），直到排满或排完
    let rest = sel.filter(s => !usedIds.has(s.id) && !isBig(s));
    while (groups.filter(g => g.length).length < days && rest.length) {
      rest.sort((a, b) => score(b) - score(a));
      const seed = rest.shift();
      const grp = [seed];
      usedIds.add(seed.id);
      rest.slice().sort((a, b) => hav(seed, a) - hav(seed, b)).forEach(s => {
        if (grp.length < 3 && hav(seed, s) < 60) grp.push(s);
      });
      grp.forEach(s => { const i = rest.indexOf(s); if (i >= 0) rest.splice(i, 1); });
      groups.push(grp);
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
        const s0 = m, e0 = m + s.dur * 60;
        if (isLast && (s0 >= 12 * 60 || e0 > 13 * 60)) { dropped.push(s.name + '（末日仅上午）'); return; }   // ★ 末日只排上午
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
      // 晚餐：首日晚 18:00；末日只排上午，不排晚餐
      if (!isLast && m <= 19.5 * 60) {
        const ds = Math.max(m, 18 * 60);
        items.push({ type: 'meal', start: fmt(ds), end: fmt(ds + 60), text: '晚餐' });
        m = ds + 60;
      }
      if (isLast) {
        items.push({ type: 'note', start: fmt(Math.max(m, 13 * 60)), text: '下午返回交通枢纽城市，乘高铁/飞机返程' });
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

    return {
      days: dayPlans, warnings: warnings, mode: 'transit',
      planName: '算法排程' + (variant.id === 'classic' ? '' : ' · ' + variant.name),
      __variant: variant.id, __region: 'all'
    };
  }

  // ★ 多方案枚举：主题（人群口味）× 模板线路 × 地域分段，按最终行程指纹去重，诚实计数
  //   返回按优先级排序的方案数组；app.js 的「换一套方案」按键逐套切换
  function planAll(candidates, days, prefs, center, mode, opts) {
    const opt = opts || {};
    days = Math.max(1, Math.min(20, days | 0));
    prefs = prefs || new Set();
    mode = mode === 'drive' ? 'drive' : 'transit';
    if (!candidates || !candidates.length) return [];
    if (days >= 8) {   // 与 plan() 一致：长行程并入全省池
      const p0 = (candidates[0] || {}).province;
      if (p0) {
        const ids0 = new Set(candidates.map(s => s.id));
        const extra = (window.APP_DATA ? window.APP_DATA.attractions : []).filter(s => s.province === p0 && !ids0.has(s.id));
        if (extra.length) candidates = candidates.concat(extra);
      }
    }
    const prov = candidates[0].province || '';
    const hasTpl = mode !== 'drive' && (typeof TRIP_TEMPLATES !== 'undefined') && !!TRIP_TEMPLATES[prov];
    const region = opt.region || 'all';
    const out = [], seen = new Set();
    const CAP = 12;
    const add = (r, tag) => {
      if (!r || !r.days || !r.days.length) return;
      const sig = r.days.map(d => (d.route || []).map(s => s.id).join(',')).join('|');
      if (seen.has(sig)) return;
      seen.add(sig);
      r.__tag = tag;
      out.push(r);
    };

    const onlyV = (opt.variant && opt.variant !== 'classic') ? (VAR_BY_ID[opt.variant] || null) : null;
    const themes = onlyV ? [onlyV] : VARIANTS;
    const wantClassic = !onlyV;

    if (region === 'all' && hasTpl) {
      if (wantClassic) {
        // ① 经典线路（旅行社模板的多条线路）
        const cache = window.__tplPeriods;
        const ROT = Math.min(3, Math.max(1, (cache && cache.prov === prov && cache.days === days) ? cache.L : 3));
        for (let t = 0; t < ROT && out.length < CAP; t++) {
          add(planFromTemplateOnce(candidates, days, mode, t, { variant: 'classic' }), '经典线路');
        }
        // ② 按地域分段（经典）
        add(planByRegion(candidates, days, prefs, center, mode, { variant: 'classic', region: 'all' }), '按地域分段');
      }
      // ③ 各人群主题：模板线一组 + 地域分段一组
      themes.filter(v => v.id !== 'classic').forEach(vv => {
        if (out.length >= CAP) return;
        add(planFromTemplateOnce(candidates, days, mode, 0, { variant: vv.id }), '经典线路 · ' + vv.name);
        if (out.length < CAP) add(planByRegion(candidates, days, prefs, center, mode, { variant: vv.id, region: 'all' }), '按地域分段 · ' + vv.name);
      });
      // ④ 只挑主题时，再给一套算法排程（不套模板）
      if (onlyV && out.length < CAP) {
        add(plan(candidates, days, prefs, center, mode, { variant: onlyV.id }), '算法排程 · ' + onlyV.name);
      }
    } else {
      themes.forEach(vv => {
        if (out.length >= CAP) return;
        const tail = vv.id === 'classic' ? '' : ' · ' + vv.name;
        if (region !== 'all') {
          add(planByRegion(candidates, days, prefs, center, mode, { variant: vv.id, region: region }), region + '线路' + tail);
        } else {
          add(planByRegion(candidates, days, prefs, center, mode, { variant: vv.id, region: 'all' }), '按地域分段' + tail);
          if (out.length < CAP) add(plan(candidates, days, prefs, center, mode, { variant: vv.id }), '算法排程' + tail);
        }
      });
    }
    if (!out.length) {
      const r = plan(candidates, days, prefs, center, mode, opt);
      if (r && r.days && r.days.length) out.push(r);
    }
    out.forEach((p, i) => { p.totalPlans = out.length; p.planIndex = i; });
    return out;
  }

  return { plan: plan, planAll: planAll, geoRegions: geoRegions, variants: VARIANTS, hav: hav };
})();
