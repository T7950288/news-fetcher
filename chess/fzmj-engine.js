/* 福州麻将规则引擎（十六张麻将 / 5 面子 + 1 将 = 17 张胡牌）
 * 纯逻辑、无 DOM；浏览器 <script> 暴露 window.FZMJ，Node 通过 require 加载。
 *
 * 【福州话词表】用户 2026-11-04 口述：
 *   坎门       四家拿完牌后，庄家多摸的那一张（庄 17 张、闲 16 张）
 *   补花       起手花牌从牌尾补等量牌；补进新花要等四家补完再补第二轮，直到手里全是万筒条
 *   开金 / 金  补花完翻牌尾第一张为「金」，可替任意牌；翻出花牌归庄家并重翻
 *   三头金     即「三金倒」：手里 3 张金不看牌型直接胡，通常只能自摸
 *   金雀/金将  两张金做将（雀头）——用户明确二者同义，均指双金作将
 *   企顶/站庄  庄家胡牌继续做庄；第一次胡叫「站顶」，通常不计连庄数
 *
 * 【牌具】144 张：万/饼/条 108 张参与组牌；东南西北中发白 28 张 + 春夏秋冬梅兰竹菊 8 张
 *   共 36 张花牌，只记分、不参与牌型组合。凑齐 4 张一样的花（4 个东 / 春夏秋冬一套）
 *   按 6 朵算；胡牌者的明杠算 1 朵花、暗杠算 2 朵花。
 *
 * 【已给定奖励分】一张花 20 / 无花无杠 40 / 天胡·抢金 40 / 三头金 50 / 金将 60。
 *
 * 【计分口径】用户 2026-11-04 21:48 给齐、22:01 定稿，默认启用：
 *   普通胡牌（点炮）基础分 = 1、每朵花 = 1 分；
 *   牌面分 = 基础 1 + 最高一项奖励 + 有效花数 × 1；
 *   ★ 先翻倍、再【往上整到 10 的倍数】（5→10、11→20、整 10 不变）：
 *     每家支付额 = ceil10(牌面分 × 倍数)，倍数 = 自摸 2 / 普通胡牌 1。
 *   ★ 普通胡牌也是赢三家：不论自摸还是点炮，一律除赢家外三家各付一份，
 *     放炮者不再独付；赢家合计 = 每家支付额 × 3。
 *   例：点炮 花 4 朵无奖励：5×1 = 5 → 10 / 家 × 3 = 30。
 *      自摸 花 4 朵无奖励：5×2 = 10 → 10 / 家 × 3 = 30。
 *      点炮 花 10 朵无奖励：11×1 = 11 → 20 / 家 × 3 = 60。
 *      自摸 金将 60 + 花 1 朵：62×2 = 124 → 130 / 家 × 3 = 390。
 *
 * ★ 口径冲突已解决：用户 2026-11-04 21:48 再确认「十六张麻将，闲 16 / 庄 17」，
 *   故保留胡牌 5 副面子 + 1 对将 = 17 张；上一轮口述里的「四副顺子/刻子 = 14 张」不采用。
 *
 * 【占位 · 待确认】多项奖励是否叠加（现按取最高一项）、抢金是否也算自摸倍数、
 *   和局是否计连庄数、留 18 张与杠后加留牌。
 *   「先翻倍再整 10」「点炮也赢三家」两条已由用户 22:01 确认，不再是待确认项。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FZMJ = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var SUITS = ['万', '饼', '条'];
  var FLOWER_CHARS = ['东', '南', '西', '北', '中', '发', '白'];
  var SEASONS = ['春', '夏', '秋', '冬', '梅', '兰', '竹', '菊'];
  var CATEGORY_NAME = {
    zimo: '自摸', normalHu: '普通胡牌', qiangjin: '抢金', jinjiang: '金将（金雀）',
    tianhu: '天胡', sanjindao: '三头金（三金倒）'
  };

  /* 计分配置：判定层完全不依赖这张表。
     ready=false 时 evaluate 仍给出奖励档位判定，但 unit / delta 全为 0。
     2026-11-04 21:48 用户已给齐分值，故 ready 默认 true。 */
  var DEFAULT_SCORING = {
    ready: true,
    normalHu: 1,        // 普通胡牌（点炮）基础分 = 1
    perFlower: 1,       // 每朵花 = 1 分
    zimoMultiplier: 2,  // 自摸直接翻倍（没有独立的自摸基础分）
    roundTo: 10,        // 往上整到 10 的倍数：5→10、11→20
    roundBeforeDouble: false, // 用户 22:01 定稿：false=先翻倍再整10（默认）；true=先整10再翻倍（备用）
    noFlower: 40,       // 无花无杠
    oneFlower: 20,      // 一张花（含「只有 1 个明杠没花」）
    tianhu: 40,         // 天胡
    qiangjin: 40,       // 抢金
    sanjindao: 50,      // 三头金 / 三金倒
    jinjiang: 60,       // 金将 / 金雀（2 张金做将）
    flowerSetAs: 6,     // 凑齐一套按 6 朵算（4 张本身 + 2 朵加成）
    mingKongAs: 1,      // 胡牌者明杠折算 1 朵
    anKongAs: 2,        // 胡牌者暗杠折算 2 朵
    combine: 'max'      // 多项奖励同时成立：'max' 取最高一项 / 'sum' 叠加
  };
  var SCORING = {};
  function resetScoring() { SCORING = {}; for (var k in DEFAULT_SCORING) SCORING[k] = DEFAULT_SCORING[k]; }
  resetScoring();
  function setScoring(patch) {
    if (patch) {
      if (patch.reset) resetScoring();
      for (var k in patch) {
        if (k !== 'reset' && Object.prototype.hasOwnProperty.call(patch, k)) SCORING[k] = patch[k];
      }
    }
    return getScoring();
  }
  function getScoring() {
    var o = {};
    for (var k in SCORING) if (Object.prototype.hasOwnProperty.call(SCORING, k)) o[k] = SCORING[k];
    return o;
  }
  function defaultScoring() {
    var o = {};
    for (var k in DEFAULT_SCORING) if (Object.prototype.hasOwnProperty.call(DEFAULT_SCORING, k)) o[k] = DEFAULT_SCORING[k];
    return o;
  }

  function isFlower(t) { return t >= 100; }
  function tileName(t) {
    if (isFlower(t)) {
      var i = t - 100;
      return i < 28 ? FLOWER_CHARS[Math.floor(i / 4)] : SEASONS[i - 28];
    }
    return (t % 9 + 1) + SUITS[Math.floor(t / 9)];
  }
  function tileSuit(t) { return Math.floor(t / 9); }
  function tileRank(t) { return t % 9; }

  function mulberry32(a) {
    return function () {
      a |= 0; a = a + 0x6D2B79F5 | 0;
      var t = Math.imul(a ^ a >>> 15, 1 | a);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, rnd) {
    for (var i = arr.length - 1; i > 0; i--) {
      var j = Math.floor(rnd() * (i + 1));
      var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
    }
    return arr;
  }
  function makeWall(rnd) {
    var a = [], i, k;
    for (i = 0; i < 27; i++) for (k = 0; k < 4; k++) a.push(i);
    for (i = 0; i < 36; i++) a.push(100 + i);
    return shuffle(a, rnd);
  }

  function counts(tiles) {
    var c = new Array(27).fill(0);
    for (var i = 0; i < tiles.length; i++) if (tiles[i] < 100) c[tiles[i]]++;
    return c;
  }
  function cloneCounts(c) { return c.slice(); }
  function countGold(tiles, gold) {
    if (gold === null || gold === undefined) return 0;
    var n = 0;
    for (var i = 0; i < tiles.length; i++) if (!isFlower(tiles[i]) && tiles[i] === gold) n++;
    return n;
  }

  /* —— 面子拆解：金可替代任意牌，也可三张金自成一刻 —— */
  function formMelds(c, g, need, style) {
    if (need === 0) {
      for (var z = 0; z < 27; z++) if (c[z] !== 0) return false;
      return g === 0;
    }
    if (g < 0) return false;
    if (g >= 3) {
      var s2 = cloneCounts(c);
      if (formMelds(s2, g - 3, need - 1, style)) {
        if (style) style.goldTriple = true;
        return true;
      }
    }
    var i = -1;
    for (var k = 0; k < 27; k++) if (c[k] > 0) { i = k; break; }
    if (i < 0) return false;

    var have = c[i];
    if (have >= 3) {
      var c1 = cloneCounts(c); c1[i] -= 3;
      if (formMelds(c1, g, need - 1, style)) return true;
    } else if (g >= 3 - have) {
      var c2 = cloneCounts(c); c2[i] = 0;
      if (formMelds(c2, g - (3 - have), need - 1, style)) return true;
    }

    if (tileRank(i) <= 6) {
      var a = i + 1, b = i + 2;
      var needGold = (c[a] > 0 ? 0 : 1) + (c[b] > 0 ? 0 : 1);
      if (g >= needGold) {
        var c3 = cloneCounts(c);
        c3[i] -= 1;
        var used = 0;
        if (c3[a] > 0) c3[a] -= 1; else used++;
        if (c3[b] > 0) c3[b] -= 1; else used++;
        if (formMelds(c3, g - used, need - 1, style)) return true;
      }
    }
    return false;
  }

  /* 将牌枚举：真对子(pg=0) / 一真一金(pg=1) / 双金(pg=2)。
     金将（金雀）= 两张金做将，即 pairGold===2；「1 真 + 1 金」不再是金将。 */
  function classify(tiles, gold, meldCount) {
    meldCount = meldCount || 0;
    var need = 5 - meldCount;
    var res = {
      win: false, g: 0, goldPair: false, goldTriple: false,
      pairGold: 0, jinjiang: false
    };
    if (!tiles || need < 0 || tiles.length + 3 * meldCount !== 17 ||
        gold === null || gold === undefined) return res;
    var real = [], g = 0;
    for (var i = 0; i < tiles.length; i++) {
      if (isFlower(tiles[i])) return res;
      if (tiles[i] === gold) g++; else real.push(tiles[i]);
    }
    res.g = g;
    var c = counts(real);

    var trials = [], p;
    for (p = 0; p < 27; p++) {
      if (c[p] >= 2) {
        var c0 = cloneCounts(c); c0[p] -= 2;
        trials.push({ c: c0, g: g, pg: 0 });
      }
      if (c[p] >= 1 && g >= 1) {
        var c1 = cloneCounts(c); c1[p] -= 1;
        trials.push({ c: c1, g: g - 1, pg: 1 });
      }
    }
    if (g >= 2) trials.push({ c: cloneCounts(c), g: g - 2, pg: 2 });

    var maxPg = -1, winning = [];
    for (var k = 0; k < trials.length; k++) {
      var t = trials[k];
      if (formMelds(cloneCounts(t.c), t.g, need, null)) {
        res.win = true;
        winning.push(t);
        if (t.pg > maxPg) maxPg = t.pg;
      }
    }
    res.pairGold = maxPg < 0 ? 0 : maxPg;
    res.goldPair = maxPg === 2;
    res.jinjiang = maxPg === 2;   // 金雀 / 金将：必须两张金做将

    // 三金自作刻子：只在已成立的将牌拆法上探测，仅作事实标记，不参与计分
    if (res.win && g >= 3) {
      for (var m = 0; m < winning.length && !res.goldTriple; m++) {
        var st = { goldTriple: false };
        if (formMelds(cloneCounts(winning[m].c), winning[m].g, need, st) && st.goldTriple) {
          res.goldTriple = true;
        }
      }
    }
    return res;
  }

  function canWin(tiles, gold, meldCount) {
    if (countGold(tiles, gold) >= 3) return true; // 三头金：抓到 3 张金即成胡，不看牌型（通常只能自摸）
    return classify(tiles, gold, meldCount).win;
  }

  /* —— 花 / 杠 统计：全部折算成「有效朵数」，不含任何硬编码分值 ——
     花牌张数 + 每套按 6 朵算（即每套加成 2 朵）+ 明杠 1 朵 + 暗杠 2 朵。 */
  function flowerStats(flowers, melds, cfg) {
    cfg = cfg || SCORING;
    var cnt = {}, i, k, c;
    for (i = 0; i < flowers.length; i++) cnt[flowers[i]] = (cnt[flowers[i]] || 0) + 1;
    var sets = 0;
    // 4 张一样的花（4 个东 / 4 个南 …）
    for (k = 0; k < 7; k++) {
      c = 0;
      for (i = 0; i < 4; i++) c += cnt[100 + k * 4 + i] || 0;
      sets += Math.floor(c / 4);
    }
    // 春夏秋冬 / 梅兰竹菊 各一套
    [[28, 29, 30, 31], [32, 33, 34, 35]].forEach(function (grp) {
      c = 0;
      grp.forEach(function (x) { c += cnt[100 + x] || 0; });
      if (c === 4) sets += 1;
    });
    var mingKong = 0, anKong = 0;
    (melds || []).forEach(function (m) {
      if (m.type === 'kong') mingKong++;
      else if (m.type === 'ankong') anKong++;
    });
    var setBonus = Math.max(0, (cfg.flowerSetAs || 0) - 4);
    var effective = flowers.length + sets * setBonus
                  + mingKong * (cfg.mingKongAs || 0) + anKong * (cfg.anKongAs || 0);
    return {
      count: flowers.length, sets: sets, mingKong: mingKong, anKong: anKong,
      effective: effective, setBonus: setBonus, detail: cnt
    };
  }
  function flowerScore(stats, cfg) {
    cfg = cfg || SCORING;
    return (stats.effective === undefined ? stats.count : stats.effective) * (cfg.perFlower || 0);
  }

  /* —— 副露组合（金不参与吃碰杠） —— */
  function chiOptions(hand, tile, gold) {
    var out = [], r = tileRank(tile), s = tileSuit(tile), need, ok;
    for (var shift = -2; shift <= 0; shift++) {
      var t0 = tile + shift, t1 = tile + shift + 1, t2 = tile + shift + 2;
      if (t0 < 0 || t2 > 26) continue;
      if (tileSuit(t0) !== s || tileSuit(t2) !== s) continue;
      need = [t0, t1, t2].filter(function (x) { return x !== tile; });
      if (need.indexOf(gold) !== -1) continue;
      ok = need.every(function (x) { return x !== gold && hand.indexOf(x) !== -1; });
      if (ok) out.push({ type: 'chi', tiles: [t0, t1, t2], use: need });
    }
    return out;
  }
  function pongOption(hand, tile, gold) {
    if (tile === gold) return null;
    var n = 0;
    for (var i = 0; i < hand.length; i++) if (hand[i] === tile) n++;
    return n >= 2 ? { type: 'pong', tiles: [tile, tile, tile], use: [tile, tile] } : null;
  }
  function kongOption(hand, tile, gold) {
    if (tile === gold) return null;
    var n = 0;
    for (var i = 0; i < hand.length; i++) if (hand[i] === tile) n++;
    return n >= 3 ? { type: 'kong', tiles: [tile, tile, tile, tile], use: [tile, tile, tile] } : null;
  }
  function removeTiles(hand, use) {
    var h = hand.slice();
    use.forEach(function (t) {
      var i = h.indexOf(t);
      if (i >= 0) h.splice(i, 1);
    });
    return h;
  }

  /* —— 游戏状态 —— */
  function createGame() {
    return {
      seed: 1, rnd: null,
      wall: [], gold: null, goldIndicator: null,
      hands: [[], [], [], []],
      flowers: [[], [], [], []],
      melds: [[], [], [], []],
      discards: [[], [], [], []],
      scores: [0, 0, 0, 0],
      dealer: 0, lianzhuang: 0, dealerWins: 0, turn: 0,
      phase: 'idle', seq: 0, round: 0,
      claim: null, lastDiscard: null, drawn: null,
      noHu: [false, false, false, false],
      result: null, log: [],
      reserve: 18
    };
  }

  function log(g, text) {
    g.log.push(text);
    if (g.log.length > 60) g.log.shift();
  }
  function drawFront(g) { return g.wall.shift(); }
  function drawBack(g) { return g.wall.pop(); }

  function startRound(g, seed) {
    seed = (seed === undefined) ? (Date.now() ^ Math.floor(Math.random() * 0x7fffffff)) : seed;
    g.seed = seed >>> 0;
    g.rnd = mulberry32(g.seed);
    g.wall = makeWall(g.rnd);
    g.hands = [[], [], [], []];
    g.flowers = [[], [], [], []];
    g.melds = [[], [], [], []];
    g.discards = [[], [], [], []];
    g.claim = null; g.lastDiscard = null; g.drawn = null;
    g.noHu = [false, false, false, false];
    g.result = null; g.gold = null; g.goldIndicator = null;
    g.reserve = 18; g.round++;

    // 发牌：每家 16 张，庄家再多拿 1 张（坎门）
    for (var i = 0; i < 16; i++) {
      for (var s = 0; s < 4; s++) g.hands[s].push(drawFront(g));
    }
    g.hands[g.dealer].push(drawFront(g));
    log(g, '坎门：庄家多摸 1 张（庄 17 / 闲 16）');

    replenishAll(g);   // 补花：四家分轮，补进的新花留到下一轮

    // 开金：牌尾翻第一张；翻出花牌归庄家并重翻
    var guard = 0;
    while (guard++ < 200) {
      var t = drawBack(g);
      if (t === undefined) break;
      if (isFlower(t)) { g.flowers[g.dealer].push(t); log(g, '开金翻出花牌 ' + tileName(t) + '，归庄家并重翻'); continue; }
      g.goldIndicator = t; g.gold = t; break;
    }
    log(g, '开金：本局金为 ' + tileName(g.gold) + '（可替任意牌）');
    g.turn = g.dealer; g.phase = 'opening';
    log(g, '第 ' + g.round + ' 局 · 庄家 ' + (g.dealer + 1) + ' 号位');
    g.seq++;
    return g;
  }

  /* 补花：每一轮四家各把手上的花全部换出、从牌尾补等量牌；
     本轮补进的新花不立即处理，等四家都补完再进行第二轮，直到手上全是万筒条。 */
  function replenishAll(g) {
    var round = 0, guard = 0;
    while (guard++ < 200) {
      var pending = 0;
      for (var s = 0; s < 4; s++) {
        var idx = [], i;
        for (i = 0; i < g.hands[s].length; i++) if (isFlower(g.hands[s][i])) idx.push(i);
        pending += idx.length;
        for (i = idx.length - 1; i >= 0; i--) {
          var f = g.hands[s].splice(idx[i], 1)[0];
          g.flowers[s].push(f);
        }
        for (i = 0; i < idx.length; i++) {
          var t = drawBack(g);
          if (t !== undefined) g.hands[s].push(t);
        }
      }
      if (!pending) break;
      round++;
      log(g, '补花第 ' + round + ' 轮：四家共换出 ' + pending + ' 朵，补进新花留到下一轮');
    }
  }

  // 行牌途中摸到花：从牌尾补一张（单家即时补，不属于开局分轮补花）
  function replenish(g, seat) {
    var guard = 0;
    while (guard++ < 200) {
      var idx = -1;
      for (var i = 0; i < g.hands[seat].length; i++) {
        if (isFlower(g.hands[seat][i])) { idx = i; break; }
      }
      if (idx < 0) break;
      var f = g.hands[seat].splice(idx, 1)[0];
      g.flowers[seat].push(f);
      var t = drawBack(g);
      if (t !== undefined) g.hands[seat].push(t);
    }
  }

  function canQiangJin(g, seat) {
    if (g.phase !== 'opening' || g.gold === null) return false;
    var hand = g.hands[seat];
    if (seat === g.dealer) {
      if (hand.length !== 17) return false;
      for (var i = 0; i < hand.length; i++) {
        var h = hand.slice(); var removed = h.splice(i, 1)[0];
        if (isFlower(removed)) continue;
        h.push(g.gold);
        // 抢金须按牌型成胡；起手两金凑三头金不算抢金
        if (classify(h, g.gold, g.melds[seat].length).win) return true;
      }
      return false;
    }
    var h2 = hand.concat([g.gold]);
    return classify(h2, g.gold, g.melds[seat].length).win;
  }

  function available(g, seat) {
    var a = [], i;
    if (g.phase === 'opening') {
      if (seat === g.dealer) {
        if (classify(g.hands[seat], g.gold, g.melds[seat].length).win) a.push({ type: 'tianhu' });
        if (canQiangJin(g, seat)) a.push({ type: 'qiangjin' });
        var seen = {};
        g.hands[seat].forEach(function (t) {
          if (!seen[t]) { seen[t] = 1; a.push({ type: 'discard', tile: t }); }
        });
      } else if (canQiangJin(g, seat)) {
        a.push({ type: 'qiangjin' });
      }
      return a;
    }
    if (g.phase === 'claim' && g.claim && !g.claim.responses[seat]) {
      var list = g.claim.options[seat] || [];
      return list.concat([{ type: 'pass' }]);
    }
    if (g.phase === 'play' && g.turn === seat) {
      if (!g.noHu[seat]) {
        // 三头金通常只能自摸：只在本家摸牌后的回合提供
        if (countGold(g.hands[seat], g.gold) >= 3) a.push({ type: 'sanjindao' });
        if (classify(g.hands[seat], g.gold, g.melds[seat].length).win) a.push({ type: 'zimo' });
      }
      if (g.drawn !== null) {
        var c = counts(g.hands[seat]);
        for (i = 0; i < 27; i++) {
          if (i === g.gold) continue;
          if (c[i] === 4) a.push({ type: 'ankong', tile: i });
        }
        g.melds[seat].forEach(function (m) {
          if (m.type === 'pong' && c[m.tile] >= 1) a.push({ type: 'addkong', tile: m.tile });
        });
      }
      var seen2 = {};
      g.hands[seat].forEach(function (t) {
        if (!seen2[t]) { seen2[t] = 1; a.push({ type: 'discard', tile: t }); }
      });
    }
    return a;
  }

  function optionsForDiscard(g, from, tile) {
    var opts = {};
    for (var s = 0; s < 4; s++) {
      if (s === from) { opts[s] = []; continue; }
      var list = [];
      // 金牌打出：任何人不能吃碰杠，也不能胡这张金；打金者本圈只能自摸
      if (tile !== g.gold) {
        // 点炮按牌型判定；三头金「通常只能自摸」，故不在此处用 3 金直接成胡
        if (!g.noHu[s]) {
          var h = g.hands[s].concat([tile]);
          if (classify(h, g.gold, g.melds[s].length).win) list.push({ type: 'hu', tile: tile });
        }
        var ko = kongOption(g.hands[s], tile, g.gold);
        if (ko) list.push(ko);
        var po = pongOption(g.hands[s], tile, g.gold);
        if (po) list.push(po);
        // 只能吃上家（逆时针下家 = from+1）
        if (s === (from + 1) % 4) {
          chiOptions(g.hands[s], tile, g.gold).forEach(function (x) { list.push(x); });
        }
      }
      opts[s] = list;
    }
    return opts;
  }

  function reserveCount(g) {
    var extra = 0;
    g.melds.forEach(function (ms) {
      ms.forEach(function (m) {
        if (m.type === 'kong') extra += 1;
        else if (m.type === 'ankong') extra += 2;
      });
    });
    return g.reserve + extra;
  }

  function drawForKong(g, seat) {
    var t = drawBack(g), guard = 0;
    while (t !== undefined && isFlower(t) && guard++ < 200) {
      g.flowers[seat].push(t);
      t = drawBack(g);
    }
    if (t !== undefined) { g.hands[seat].push(t); g.drawn = t; }
  }

  function drawNext(g, seat) {
    if (g.wall.length <= reserveCount(g)) { settleDraw(g); return; }
    var t = drawFront(g), guard = 0;
    while (t !== undefined && isFlower(t) && guard++ < 200) {
      g.flowers[seat].push(t);
      log(g, (seat + 1) + ' 号位补花 ' + tileName(t));
      t = drawBack(g);
    }
    if (t === undefined) { settleDraw(g); return; }
    g.hands[seat].push(t);
    g.drawn = t; g.turn = seat; g.phase = 'play';
    g.seq++;
  }

  function actDiscard(g, seat, tile) {
    var h = g.hands[seat], i = h.indexOf(tile);
    if (i < 0) return false;
    h.splice(i, 1);
    g.discards[seat].push(tile);
    g.lastDiscard = { seat: seat, tile: tile };
    g.drawn = null;
    if (tile === g.gold) {
      g.noHu[seat] = true;
      log(g, (seat + 1) + ' 号位打出金牌，本圈只能自摸');
    } else {
      g.noHu[seat] = false;
    }
    var opts = optionsForDiscard(g, seat, tile);
    var need = false;
    for (var s = 0; s < 4; s++) if (opts[s] && opts[s].length) need = true;
    if (need) {
      g.claim = { from: seat, tile: tile, options: opts, responses: {} };
      g.phase = 'claim';
    } else {
      g.claim = null;
      drawNext(g, (seat + 1) % 4);
    }
    g.seq++;
    return true;
  }

  function distance(from, seat) { return (seat - from + 4) % 4; }

  function resolveClaims(g) {
    var cl = g.claim;
    if (!cl) return;
    var hus = [], kongs = [], pongs = [], chis = [], s;
    for (s = 0; s < 4; s++) {
      var r = cl.responses[s];
      if (!r || r.type === 'pass') continue;
      if (r.type === 'hu') hus.push({ seat: s, r: r });
      else if (r.type === 'kong') kongs.push({ seat: s, r: r });
      else if (r.type === 'pong') pongs.push({ seat: s, r: r });
      else if (r.type === 'chi') chis.push({ seat: s, r: r });
    }
    g.claim = null;
    if (hus.length) {
      hus.sort(function (a, b) {
        var ga = countGold(g.hands[a.seat].concat([cl.tile]), g.gold);
        var gb = countGold(g.hands[b.seat].concat([cl.tile]), g.gold);
        var pa = ga >= 2 ? 1 : 0, pb = gb >= 2 ? 1 : 0;
        if (pa !== pb) return pb - pa;
        return distance(cl.from, a.seat) - distance(cl.from, b.seat);
      });
      var w = hus[0].seat;
      settleWin(g, w, cl.from, 'dianpao', g.hands[w].concat([cl.tile]));
      return;
    }
    // 碰 / 杠 优先于吃（无论座位远近）
    var byDistance = function (a, b) { return distance(cl.from, a.seat) - distance(cl.from, b.seat); };
    kongs.sort(byDistance); pongs.sort(byDistance); chis.sort(byDistance);
    var pick = kongs[0] || pongs[0] || chis[0];
    if (pick) {
      var seat = pick.seat, r2 = pick.r;
      g.hands[seat] = removeTiles(g.hands[seat], r2.use);
      g.melds[seat].push({ type: r2.type, tiles: r2.tiles, tile: cl.tile, from: cl.from });
      g.discards[cl.from].pop();
      g.turn = seat; g.phase = 'play'; g.drawn = null;
      log(g, (seat + 1) + ' 号位 ' + ({ kong: '杠', pong: '碰', chi: '吃' })[r2.type] + ' ' + tileName(cl.tile));
      if (r2.type === 'kong') drawForKong(g, seat);
      g.seq++;
      return;
    }
    drawNext(g, (cl.from + 1) % 4);
  }

  function timeoutClaims(g) {
    if (g.phase !== 'claim' || !g.claim) return false;
    for (var s = 0; s < 4; s++) {
      if (g.claim.options[s] && g.claim.options[s].length && !g.claim.responses[s]) {
        g.claim.responses[s] = { type: 'pass' };
      }
    }
    resolveClaims(g);
    return true;
  }

  /* —— 结算：判定与计分解耦 ——
     牌面分 raw = 基础分 1 + 奖励分（多项取最高一项）+ 有效花数 × 每朵花 1；
     ★ 先翻倍再整 10：每家支付额 = ceil10(raw × 倍数)，倍数 = 自摸 2 / 普通胡牌 1。
     ★ 点炮也赢三家：payerCount 恒为 3，与是否自摸无关。
     ready=false 时 unit 为 0，但奖励档位 / 有效花数 / 取整前后仍完整给出，便于核对判定。 */
  function roundUp(x, step) {
    if (!step || step <= 0) return x;
    return Math.ceil(x / step) * step;
  }
  function evaluate(g, winner, tiles, kind, config) {
    var cfg = config || SCORING;
    var cls = classify(tiles, g.gold, g.melds[winner].length);
    var fs = flowerStats(g.flowers[winner], g.melds[winner], cfg);
    var fp = flowerScore(fs, cfg);
    var gcnt = countGold(tiles, g.gold);

    var isZimo = (kind === 'zimo' || kind === 'tianhu' || kind === 'sanjindao' || kind === 'qiangjin');
    var flags = [];
    if (kind === 'tianhu') flags.push('天胡');
    if (kind === 'qiangjin') flags.push('抢金');
    if (kind === 'sanjindao') flags.push('三头金（三金倒）');
    if (cls.goldTriple) flags.push('三金作刻');
    if (cls.goldPair) flags.push('金将 / 金雀');
    if (fs.effective === 0) flags.push('无花无杠');
    else if (fs.effective === 1) flags.push('一张花');

    // 奖励档位（固定分）；「一张花」含「只有 1 个明杠没花」——明杠折 1 朵后 effective 恰为 1
    var rewards = [];
    if (fs.effective === 0) rewards.push({ name: '无花无杠', value: cfg.noFlower || 0 });
    if (fs.effective === 1) rewards.push({ name: '一张花', value: cfg.oneFlower || 0 });
    if (kind === 'tianhu') rewards.push({ name: '天胡', value: cfg.tianhu || 0 });
    if (kind === 'qiangjin') rewards.push({ name: '抢金', value: cfg.qiangjin || 0 });
    if (kind === 'sanjindao') rewards.push({ name: '三头金 / 三金倒', value: cfg.sanjindao || 0 });
    if (cls.goldPair) rewards.push({ name: '金将 / 金雀', value: cfg.jinjiang || 0 });

    var reward = 0, rewardName = '—', rewardList = [];
    if (cfg.combine === 'sum') {
      rewards.forEach(function (r) { reward += r.value; rewardList.push(r.name + ' ' + r.value); });
      rewardName = rewardList.length ? rewardList.join(' + ') : '—';
    } else {
      rewards.forEach(function (r) { if (r.value > reward) reward = r.value; });
      var top = rewards.filter(function (r) { return r.value === reward; });
      rewardName = top.length ? top.map(function (r) { return r.name; }).join(' / ') + ' ' + reward : '—';
    }

    var base = cfg.normalHu || 0;
    var raw = base + reward + fp;                       // 牌面分
    var multiplier = isZimo ? (cfg.zimoMultiplier || 1) : 1;
    var doubled = raw * multiplier;
    var step = cfg.roundTo || 0;
    var rounded, unit;
    if (cfg.roundBeforeDouble === true) {
      rounded = roundUp(raw, step);                    // 备用：先整 10 再翻倍
      unit = rounded * multiplier;
    } else {
      rounded = roundUp(doubled, step);                // 默认：先翻倍再整 10
      unit = rounded;
    }
    if (!cfg.ready) unit = 0;
    var payers = 3;                                     // 点炮与自摸一律三家各付

    var category;
    if (kind === 'qiangjin') category = 'qiangjin';
    else if (kind === 'sanjindao') category = 'sanjindao';
    else if (kind === 'tianhu') category = 'tianhu';
    else if (cls.goldPair) category = 'jinjiang';
    else if (isZimo) category = 'zimo';
    else category = 'normalHu';

    var formula = cfg.ready
      ? '基础 ' + base + ' + 奖励 ' + reward + ' + 花 ' + fs.effective + '×' + (cfg.perFlower || 0) +
        ' = ' + raw +
        (multiplier !== 1 ? ' → ×' + multiplier + ' 得 ' + doubled : '') +
        (step ? ' → 整 ' + step + ' 得 ' + rounded : '') +
        (unit !== rounded ? ' → ×' + multiplier + ' 得 ' + unit : '') +
        ' / 家 × ' + payers + ' 家 = ' + unit * payers
      : '计分未启用（可在右侧勾选启用）· 已判定 ' + rewardName;

    return {
      pending: !cfg.ready,
      category: category, categoryName: CATEGORY_NAME[category],
      zimo: isZimo, payerCount: payers,
      flower: fs, effectiveFlowers: fs.effective,
      flowerPoints: fp, goldCount: gcnt,
      meldCount: g.melds[winner].length, pairGold: cls.pairGold,
      base: base, reward: reward, rewardName: rewardName,
      raw: raw, doubled: doubled, rounded: rounded, multiplier: multiplier, roundTo: step,
      rewardList: rewards.map(function (r) { return r.name + ' ' + r.value; }),
      flags: flags, unit: unit, total: unit * payers,
      formula: formula
    };
  }

  function settleWin(g, winner, loser, kind, tiles) {
    tiles = tiles || g.hands[winner].slice();
    var ev = evaluate(g, winner, tiles, kind);
    var delta = [0, 0, 0, 0];
    if (!ev.pending) {
      // 普通胡牌也是赢三家：点炮不再由放胡者独付，一律三家各付一份
      for (var s = 0; s < 4; s++) {
        if (s !== winner) { delta[s] -= ev.unit; delta[winner] += ev.unit; }
      }
    }
    for (var i = 0; i < 4; i++) g.scores[i] += delta[i];
    g.result = {
      kind: 'win', winner: winner, loser: ev.zimo ? null : loser,
      hand: tiles.slice(), eval: ev, delta: delta, scores: g.scores.slice(),
      text: (winner + 1) + ' 号位 ' + (ev.zimo ? '自摸' : '胡牌') + ' · ' + ev.categoryName +
            (ev.flags.length ? ' [' + ev.flags.join('/') + ']' : '') + ' · ' + ev.formula
    };
    log(g, g.result.text);
    // 企顶 / 站庄：庄家胡牌继续做庄；第一次胡叫「站顶」，不计连庄数
    if (winner === g.dealer) {
      g.dealerWins += 1;
      if (g.dealerWins === 1) log(g, '企顶（站庄）：首次胡牌称「站顶」，不计连庄数');
      else g.lianzhuang += 1;
    } else {
      g.dealerWins = 0;
      g.dealer = (g.dealer + 1) % 4;
      g.lianzhuang = 0;
    }
    g.phase = 'end'; g.seq++;
    return g.result;
  }

  function settleDraw(g) {
    g.result = { kind: 'draw', text: '牌墙摸完，本局和局，庄家企顶连庄', scores: g.scores.slice() };
    log(g, g.result.text);
    g.lianzhuang += 1;   // 和局是否计连庄数：沿用资料口径，待确认
    g.phase = 'end'; g.seq++;
    return g.result;
  }

  function act(g, seat, action) {
    var allowed = available(g, seat);
    var ok = allowed.some(function (x) {
      if (x.type !== action.type) return false;
      if (action.tile !== undefined && x.tile !== undefined && x.tile !== action.tile) return false;
      if (action.use && x.use && JSON.stringify(action.use.slice().sort()) !== JSON.stringify(x.use.slice().sort())) return false;
      return true;
    });
    if (!ok) return { ok: false, error: '当前不允许该操作：' + action.type };

    switch (action.type) {
      case 'tianhu':
        if (seat !== g.dealer) break;
        return { ok: true, result: settleWin(g, seat, null, 'tianhu', g.hands[seat].slice()) };
      case 'qiangjin': {
        // 开金指示牌本身即为抢到的那张金：把它从「离墙计数」移入手牌，保证 144 张守恒
        var tiles;
        if (seat === g.dealer) {
          var h = g.hands[seat].slice(), found = false, removed = null;
          for (var i = 0; i < h.length && !found; i++) {
            var t = h[i]; if (isFlower(t)) continue;
            var hh = h.slice(); hh.splice(i, 1); hh.push(g.gold);
            if (classify(hh, g.gold, g.melds[seat].length).win) {
              h = hh; removed = t; found = true;
            }
          }
          if (!found) return { ok: false, error: '未找到可换金的牌' };
          g.hands[seat] = h.slice();            // 17 张：打出一张真牌、换进指示牌那张金
          g.discards[seat].push(removed);       // 被换出的真牌进入牌河
          tiles = h.slice();                    // 同一手牌用于结算展示
        } else {
          g.hands[seat] = g.hands[seat].concat([g.gold]);
          tiles = g.hands[seat].slice();
        }
        g.goldIndicator = null;
        return { ok: true, result: settleWin(g, seat, null, 'qiangjin', tiles) };
      }
      case 'zimo':
        return { ok: true, result: settleWin(g, seat, null, 'zimo', g.hands[seat].slice()) };
      case 'sanjindao':
        return { ok: true, result: settleWin(g, seat, null, 'sanjindao', g.hands[seat].slice()) };
      case 'ankong': {
        var c = 0;
        for (var j = g.hands[seat].length - 1; j >= 0; j--) {
          if (g.hands[seat][j] === action.tile && c < 4) { g.hands[seat].splice(j, 1); c++; }
        }
        g.melds[seat].push({ type: 'ankong', tiles: [action.tile, action.tile, action.tile, action.tile], tile: action.tile, from: seat });
        drawForKong(g, seat);
        g.seq++;
        return { ok: true };
      }
      case 'addkong': {
        var m = null;
        g.melds[seat].forEach(function (x) { if (x.type === 'pong' && x.tile === action.tile) m = x; });
        if (!m) return { ok: false, error: '没有可加杠的碰' };
        var ix = g.hands[seat].indexOf(action.tile);
        if (ix < 0) return { ok: false, error: '缺少加杠牌' };
        g.hands[seat].splice(ix, 1);
        m.type = 'kong'; m.tiles = [action.tile, action.tile, action.tile, action.tile];
        drawForKong(g, seat);
        g.seq++;
        return { ok: true };
      }
      case 'discard':
        if (actDiscard(g, seat, action.tile)) return { ok: true };
        return { ok: false, error: '手牌中没有这张牌' };
      case 'pass':
      case 'hu':
      case 'chi':
      case 'pong':
      case 'kong':
        if (g.phase !== 'claim' || !g.claim) return { ok: false, error: '当前不在应答阶段' };
        // 应答对象由权威端从已有选项回填，客户端只需给 type/use；
        // 避免漏传 tiles 造成坏副露，也避免客户端伪造牌面。
        var chosen = { type: 'pass' };
        if (action.type !== 'pass') {
          var cand = g.claim.options[seat] || [], matched = null;
          for (var ci = 0; ci < cand.length && !matched; ci++) {
            var o = cand[ci];
            if (o.type !== action.type) continue;
            if (action.use && o.use &&
                JSON.stringify(action.use.slice().sort()) !== JSON.stringify(o.use.slice().sort())) continue;
            matched = o;
          }
          if (!matched) return { ok: false, error: '该应答选项不存在' };
          chosen = matched;
        }
        g.claim.responses[seat] = chosen;
        var pending = Object.keys(g.claim.options).filter(function (s) {
          return g.claim.options[s].length && !g.claim.responses[s];
        });
        if (!pending.length) resolveClaims(g);
        g.seq++;
        return { ok: true };
    }
    return { ok: false, error: '未处理的操作' };
  }

  function publicView(g) {
    return {
      seq: g.seq, phase: g.phase, turn: g.turn, dealer: g.dealer,
      gold: g.gold, goldIndicator: g.goldIndicator, round: g.round,
      handsCount: g.hands.map(function (h) { return h.length; }),
      flowers: g.flowers.map(function (f) { return f.slice(); }),
      melds: g.melds.map(function (m) { return m.slice(); }),
      discards: g.discards.map(function (d) { return d.slice(); }),
      scores: g.scores.slice(), lianzhuang: g.lianzhuang, dealerWins: g.dealerWins,
      wallLeft: g.wall.length, lastDiscard: g.lastDiscard,
      claimFrom: g.claim ? g.claim.from : null,
      claimTile: g.claim ? g.claim.tile : null,
      result: g.result, log: g.log.slice(-14)
    };
  }
  function view(g, seat) {
    var v = publicView(g);
    v.seat = seat;
    v.hand = g.hands[seat].slice().sort(function (a, b) { return a - b; });
    v.actions = available(g, seat);
    if (g.claim && g.claim.options[seat]) v.claimOptions = g.claim.options[seat];
    return v;
  }

  return {
    SUITS: SUITS, CATEGORY_NAME: CATEGORY_NAME,
    tileName: tileName, isFlower: isFlower,
    counts: counts, countGold: countGold, classify: classify, canWin: canWin,
    flowerStats: flowerStats, flowerScore: flowerScore,
    chiOptions: chiOptions, replenishAll: replenishAll,
    setScoring: setScoring, getScoring: getScoring, defaultScoring: defaultScoring,
    createGame: createGame, startRound: startRound, available: available,
    act: act, resolveClaims: resolveClaims, timeoutClaims: timeoutClaims,
    view: view, publicView: publicView, settleDraw: settleDraw, evaluate: evaluate
  };
});
