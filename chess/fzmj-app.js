/* Work福州麻将 · 联机房间与牌桌控制
 * 方案 A：公共 MQTT over WSS 中继；房主浏览器持有权威状态，客户端只发操作、收专属视图。
 * 本轮为本地试做，不写入线上仓库。
 */
(function () {
  'use strict';

  var F = window.FZMJ;
  /* 2026-11-04 两次实测 MQTT CONNECT 握手结果（本机网络）：
     两个 EMQX 节点稳定 CONNACK=0；HiveMQ 首次超时、复测可用（时好时坏）；
     test.mosquitto.org 两次均不可达。因此按「EMQX → HiveMQ → mosquitto」排序，后两者仅作兜底。 */
  var BROKERS = [
    'wss://broker.emqx.io:8084/mqtt',
    'wss://broker-cn.emqx.io:8084/mqtt',
    'wss://broker.hivemq.com:8884/mqtt',
    'wss://test.mosquitto.org:8081/mqtt'
  ];
  var TOPIC_PREFIX = 'workbuddy/fzmj/v1/';
  var SEAT_LABEL = ['自己（南）', '右家（西）', '对家（北）', '左家（东）'];
  /* 联机库按需加载：jsdelivr 优先（国内可达性通常好于 unpkg），unpkg 兜底，各 6 秒超时。
     首屏与本地试玩完全不触发，因此进页面不再被外部 CDN 阻塞。 */
  var MQTT_CDNS = [
    'https://cdn.jsdelivr.net/npm/mqtt@5.10.1/dist/mqtt.min.js',
    'https://unpkg.com/mqtt@5.10.1/dist/mqtt.min.js'
  ];

  var S = {
    mode: 'idle',            // idle | local | host | client
    room: '', cid: '', name: '',
    seat: -1, game: null, view: null,
    client: null, brokerIdx: 0, connected: false, stopping: false,
    seats: [null, null, null, null],
    names: ['', '', '', ''],
    control: ['human', 'human', 'human', 'human'],
    seq: -1, lastMsgAt: 0,
    timers: {}, switchTimer: null,
    botFill: true,
    preview: false,         // 首屏静态预览桌：只摆牌、不自动推进机器人
    mqttWaiters: null,      // 按需加载期间的回调队列
    toastTimer: null
  };

  /* ---------- 基础工具 ---------- */
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === undefined || s === null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function T(p) { return TOPIC_PREFIX + S.room + '/' + p; }
  function status(text, kind) {
    var el = $('connStatus');
    el.textContent = text;
    el.className = 'badge ' + (kind || 'muted');
  }
  function toast(text) {
    var el = $('toast');
    el.textContent = text;
    el.classList.add('show');
    clearTimeout(S.toastTimer);
    S.toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
  }
  function randRoom() {
    var chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', s = '';
    for (var i = 0; i < 6; i++) s += chars[Math.floor(Math.random() * chars.length)];
    return s;
  }
  function randCid() {
    return 'c' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  }
  function inviteURL(room) {
    return location.origin + location.pathname + '?room=' + encodeURIComponent(room);
  }

  /* ---------- 牌面渲染 ---------- */
  function tileHTML(t, opts) {
    opts = opts || {};
    if (opts.back) return '<span class="tile back"></span>';
    if (F.isFlower(t)) {
      return '<span class="tile flower' + (opts.small ? ' small' : '') + '">' + esc(F.tileName(t)) + '</span>';
    }
    var suit = Math.floor(t / 9), rank = t % 9 + 1;
    var isGold = S.view && t === S.view.gold;
    var cls = 'tile s' + suit + (isGold ? ' gold' : '') + (opts.small ? ' small' : '') +
              (opts.selected ? ' selected' : '') + (opts.clickable ? ' clickable' : '');
    return '<span class="' + cls + '"' + (opts.clickable ? ' data-tile="' + t + '"' : '') +
           ' title="' + esc(F.tileName(t)) + (isGold ? '（金）' : '') + '">' +
           '<b>' + rank + '</b><i>' + F.SUITS[suit] + '</i>' +
           (isGold ? '<em>金</em>' : '') + '</span>';
  }
  function meldHTML(m) {
    var label = { chi: '吃', pong: '碰', kong: '杠', ankong: '暗杠' }[m.type] || m.type;
    return '<span class="meld">' + m.tiles.map(function (t) { return tileHTML(t, { small: true }); }).join('') +
           '<u>' + label + '</u></span>';
  }
  function flowerHTML(list) {
    if (!list || !list.length) return '<span class="dim">无花</span>';
    return list.map(function (t) { return tileHTML(t, { small: true }); }).join('');
  }

  /* 中央骰子（场景装饰，固定点数；不参与判定，避免影响既有状态机） */
  var DICE_PIPS = {
    1: [[50, 50]],
    2: [[27, 27], [73, 73]],
    3: [[27, 27], [50, 50], [73, 73]],
    4: [[27, 27], [73, 27], [27, 73], [73, 73]],
    5: [[27, 27], [73, 27], [50, 50], [27, 73], [73, 73]],
    6: [[27, 25], [73, 25], [27, 50], [73, 50], [27, 75], [73, 75]]
  };
  function dieHTML(n) {
    return '<span class="die">' + DICE_PIPS[n].map(function (p) {
      return '<i style="left:' + p[0] + '%;top:' + p[1] + '%"></i>';
    }).join('') + '</span>';
  }
  function diceHTML(a, b) {
    return '<span class="diceTray"><span class="cap">骰</span>' +
           dieHTML(a || 3) + dieHTML(b || 5) + '</span>';
  }

  function seatPanel(s) {
    var v = S.view, isMe = (s === v.seat);
    var name = S.names[s] || (isMe ? '你' : (s + 1) + ' 号位');
    var ctrl = S.control[s];
    var tag = ctrl === 'bot' ? '机器人' : (ctrl === 'remote' ? '在线' : (isMe ? '本机' : '空位'));
    var hand;
    if (isMe) {
      hand = '<span class="dim">手牌见下方</span>';
    } else {
      var n = v.handsCount[s] || 0, backs = '';
      for (var i = 0; i < Math.min(n, 16); i++) backs += tileHTML(0, { back: true, small: true });
      hand = backs || '<span class="dim">—</span>';
    }
    return '<div class="seatPanel pos' + s + (v.turn === s && v.phase !== 'end' ? ' active' : '') + '">' +
      '<div class="seatHead"><span class="dot d' + s + '"></span><strong>' + esc(name) + '</strong>' +
      (v.dealer === s ? '<span class="chip dealer">庄</span>' : '') +
      '<span class="chip">' + esc(tag) + '</span>' +
      '<span class="score">' + (v.scores[s] >= 0 ? '+' : '') + v.scores[s] + '</span></div>' +
      '<div class="seatLine handmini">' + hand +
        '<span class="dim">' + (v.handsCount[s] || 0) + ' 张</span></div>' +
      '<div class="seatLine"><span class="lbl">花</span>' + flowerHTML(v.flowers[s]) +
        (v.melds[s].length ? v.melds[s].map(meldHTML).join('') : '') + '</div>' +
      '</div>';
  }

  function riverHTML() {
    var v = S.view, all = [];
    v.discards.forEach(function (d, s) {
      d.forEach(function (t, i) { all.push({ s: s, t: t, i: i }); });
    });
    if (!all.length) return '<span class="dim">牌河为空</span>';
    return all.map(function (x) {
      return '<span class="riverTile d' + x.s + '">' + tileHTML(x.t, { small: true }) + '</span>';
    }).join('');
  }

  function actionsHTML() {
    var v = S.view, out = [], i;
    if (!v || v.phase === 'end') {
      if (S.mode === 'local' || S.mode === 'host') {
        out.push('<button class="btn primary" data-act="next">开始下一局</button>');
      } else {
        out.push('<span class="dim">等待房主开始下一局</span>');
      }
      return out.join('');
    }
    var isClaim = (v.phase === 'claim');
    var opts = isClaim ? (v.claimOptions || []) : [];
    if (isClaim) {
      opts.forEach(function (o, idx) {
        var label = { hu: '胡', pong: '碰', kong: '杠', chi: '吃' }[o.type] || o.type;
        if (o.type === 'chi' && o.tiles) label = '吃 ' + o.tiles.map(F.tileName).join('');
        out.push('<button class="btn ' + (o.type === 'hu' ? 'win' : '') + '" data-claim="' + idx + '">' + esc(label) + '</button>');
      });
      out.push('<button class="btn ghost" data-act="pass">过</button>');
      out.push('<span class="hint">有人打出 <b>' + esc(F.tileName(v.claimTile)) + '</b>，请选择</span>');
      return out.join('');
    }
    (v.actions || []).forEach(function (a) {
      if (a.type === 'discard') return; // 出牌改为点击手牌
      var label = {
        zimo: '自摸', sanjindao: '三头金（三金倒）', tianhu: '天胡', qiangjin: '抢金',
        ankong: '暗杠 ' + F.tileName(a.tile), addkong: '加杠 ' + F.tileName(a.tile)
      }[a.type] || a.type;
      out.push('<button class="btn ' + (/hu|zimo|jin|tian/.test(a.type) ? 'win' : '') +
               '" data-act="' + a.type + '" data-tile="' + (a.tile === undefined ? '' : a.tile) + '">' +
               esc(label) + '</button>');
    });
    var canDiscard = (v.actions || []).some(function (a) { return a.type === 'discard'; });
    if (canDiscard) out.unshift('<span class="hint">点击手牌打出</span>');
    else if (v.phase === 'opening') out.push('<span class="hint">等待庄家出首张，或抢金</span>');
    else if (!out.length) out.push('<span class="dim">等待其他玩家…</span>');
    return out.join('');
  }

  function render() {
    var v = S.view;
    if (!v) return;
    $('tableWrap').classList.remove('hidden');
    $('seat0').innerHTML = seatPanel(0);
    $('seat1').innerHTML = seatPanel(1);
    $('seat2').innerHTML = seatPanel(2);
    $('seat3').innerHTML = seatPanel(3);

    var phaseText = {
      idle: '未开局', opening: '开局 / 抢金', play: '行牌', claim: '等待应答', end: '本局结束'
    }[v.phase] || v.phase;
    var goldTile = (v.gold === null || v.gold === undefined)
      ? '<span class="dim">—</span>' : tileHTML(v.gold);
    $('centerInfo').innerHTML =
      '<div class="hudItem"><span>本局金</span>' + goldTile +
        '<small>金可替代任意牌</small></div>' +
      '<div class="hudItem"><span>阶段</span><b>' + esc(phaseText) + '</b></div>' +
      '<div class="hudItem"><span>局数</span><b>第 ' + v.round + ' 局</b></div>' +
      '<div class="hudItem"><span>牌墙</span><b>' + v.wallLeft + ' 张</b></div>' +
      '<div class="hudItem"><span>连庄</span><b>' + v.lianzhuang +
        (v.dealerWins === 1 ? '（站顶）' : '') + '</b></div>' +
      '<div class="hudItem"><span>轮到</span><b>' + (v.turn + 1) + ' 号位</b></div>' +
      '<div class="hudItem"><span>计分</span><b class="' + (F.getScoring().ready ? 'ok' : 'pending') + '">' +
        (F.getScoring().ready ? '已启用' : '待定·不计分') + '</b></div>';
    $('goldStand').innerHTML = '<span class="cap">本局金</span>' + goldTile + diceHTML();
    $('river').innerHTML = riverHTML();
    $('actionBar').innerHTML = actionsHTML();

    var canDiscard = (v.actions || []).some(function (a) { return a.type === 'discard'; });
    $('myHand').innerHTML = (v.hand || []).map(function (t) {
      return tileHTML(t, { clickable: canDiscard });
    }).join('') || '<span class="dim">暂无手牌</span>';

    $('logList').innerHTML = (v.log || []).slice().reverse().map(function (x) {
      return '<li>' + esc(x) + '</li>';
    }).join('') || '<li class="dim">暂无记录</li>';

    renderRoomPanel();
    if (v.result) showResult(v.result);
    else hideResult();
  }

  function renderRoomPanel() {
    $('roomCode').textContent = S.room || '—';
    // 本地演示/预览不生成假邀请链接，避免用户误以为已联机
    $('inviteLink').value = (S.room && S.mode !== 'local') ? inviteURL(S.room) : '';
    var rows = [];
    for (var s = 0; s < 4; s++) {
      var nm = S.names[s] || (S.control[s] === 'bot' ? '机器人托管' : '空位');
      rows.push('<li><span class="dot d' + s + '"></span>' + (s + 1) + ' 号位 · ' + esc(nm) +
                (S.seat === s ? '<b class="me">你</b>' : '') +
                '<span class="dim">' + esc(SEAT_LABEL[s]) + '</span></li>');
    }
    $('seatList').innerHTML = rows.join('');
    $('modeText').textContent = {
      idle: '未连接', local: '本地演示', host: '房主（权威端）', client: '已加入房间'
    }[S.mode] || S.mode;
  }

  function showResult(res) {
    var box = $('resultBox');
    box.classList.remove('hidden');
    var body = '';
    if (res.kind === 'draw') {
      body = '<h3>和局</h3><p>' + esc(res.text) + '</p>';
    } else {
      var ev = res.eval;
      body = '<h3>' + (res.winner + 1) + ' 号位 ' + esc(ev.categoryName) + '</h3>' +
        '<p>' + esc(res.text) + '</p>' +
        '<div class="resultGrid">' +
          '<div><span>类别</span><b>' + esc(ev.categoryName) + '</b></div>' +
          '<div><span>奖励档位</span><b>' + esc(ev.rewardName) + '</b></div>' +
          '<div><span>有效花</span><b>' + ev.effectiveFlowers + ' 朵</b></div>' +
          '<div><span>花牌</span><b>' + ev.flower.count + ' 张 / ' + ev.flower.sets + ' 套</b></div>' +
          '<div><span>金</span><b>' + ev.goldCount + ' 张</b></div>' +
          '<div><span>标记</span><b>' + esc(ev.flags.length ? ev.flags.join(' / ') : '—') + '</b></div>' +
          '<div><span>牌面分（基础+奖励+花）</span><b>' + ev.base + ' + ' + ev.reward + ' + ' + ev.flowerPoints + ' = ' + ev.raw + '</b></div>' +
          '<div><span>先翻倍（自摸 ×' + ev.multiplier + '）</span><b>' + ev.raw + ' × ' + ev.multiplier + ' = ' + ev.doubled + '</b></div>' +
          '<div><span>再往上整 ' + ev.roundTo + '</span><b>' + ev.doubled + ' → ' + ev.rounded + '</b></div>' +
          '<div><span>每家</span><b>' + ev.unit + '</b></div>' +
          '<div><span>合计（' + ev.payerCount + ' 家各付）</span><b>' + ev.total + '</b></div>' +
        '</div>' +
        '<div class="resultHand">' + (res.hand || []).map(function (t) { return tileHTML(t, { small: true }); }).join('') + '</div>';
    }
    box.querySelector('.resultBody').innerHTML = body;
    box.querySelector('.resultFoot').innerHTML =
      (S.mode === 'local' || S.mode === 'host')
        ? '<button class="btn primary" data-act="next">开始下一局</button>'
        : '<span class="dim">等待房主开始下一局</span>';
  }
  function hideResult() { $('resultBox').classList.add('hidden'); }

  /* ---------- 机器人 / 托管推进 ---------- */
  function pickDiscard(hand, gold) {
    var c = F.counts(hand), best = null, bestScore = 1e9;
    hand.forEach(function (t) {
      if (t === gold) return;
      var score = c[t] * 10 + (t % 9 === 0 || t % 9 === 8 ? 2 : 0);
      if (score < bestScore) { bestScore = score; best = t; }
    });
    if (best === null) best = hand.find(function (t) { return t !== gold; });
    return best === undefined || best === null ? hand[0] : best;
  }
  function isBot(s) { return S.control[s] === 'bot'; }

  function pump() {
    var g = S.game;
    if (!g) return;
    var guard = 0;
    while (g.phase !== 'end' && guard++ < 240) {
      var did = false, s, a;
      if (g.phase === 'opening') {
        for (s = 0; s < 4 && !did; s++) {
          if (!isBot(s)) continue;
          a = F.available(g, s);
          if (a.some(function (x) { return x.type === 'qiangjin'; })) {
            F.act(g, s, { type: 'qiangjin' }); did = true;
          }
        }
        if (did) continue;
        if (isBot(g.dealer)) {
          a = F.available(g, g.dealer);
          var th = a.find(function (x) { return x.type === 'tianhu'; });
          var qj = a.find(function (x) { return x.type === 'qiangjin'; });
          if (th) { F.act(g, g.dealer, { type: 'tianhu' }); did = true; }
          else if (qj) { F.act(g, g.dealer, { type: 'qiangjin' }); did = true; }
          else {
            var d = pickDiscard(g.hands[g.dealer], g.gold);
            if (d !== undefined) { F.act(g, g.dealer, { type: 'discard', tile: d }); did = true; }
          }
          if (did) continue;
        }
        break;
      }
      if (g.phase === 'claim') {
        for (s = 0; s < 4; s++) {
          if (!isBot(s)) continue;
          var o = F.available(g, s);
          if (!o.length) continue;
          var pick = o.find(function (x) { return x.type === 'hu'; });
          if (!pick && Math.random() < 0.25) {
            pick = o.find(function (x) { return x.type === 'pong'; }) ||
                   o.find(function (x) { return x.type === 'chi'; });
          }
          if (!pick) pick = { type: 'pass' };
          F.act(g, s, { type: pick.type, tile: pick.tile, use: pick.use });
          did = true;
        }
        if (did) continue;
        break;
      }
      if (g.phase === 'play') {
        if (!isBot(g.turn)) break;
        a = F.available(g, g.turn);
        var win = a.find(function (x) { return x.type === 'zimo'; }) ||
                  a.find(function (x) { return x.type === 'sanjindao'; });
        if (win) F.act(g, g.turn, { type: win.type });
        else {
          var d2 = pickDiscard(g.hands[g.turn], g.gold);
          if (d2 === undefined) break;
          F.act(g, g.turn, { type: 'discard', tile: d2 });
        }
        did = true;
        continue;
      }
      break;
    }
  }

  /* ---------- 权威端状态同步 ---------- */
  function publish(topic, obj) {
    if (!S.client || !S.connected) return;
    try { S.client.publish(topic, JSON.stringify(obj), { qos: 0, retain: false }); } catch (e) { /* ignore */ }
  }
  function syncControl() {
    for (var s = 0; s < 4; s++) {
      if (S.mode === 'local') S.control[s] = (s === 0 ? 'human' : 'bot');
      else if (S.mode === 'host') {
        if (s === S.seat) S.control[s] = 'human';
        else if (S.seats[s]) S.control[s] = 'remote';
        else S.control[s] = S.botFill ? 'bot' : 'human';
      } else S.control[s] = (s === S.seat ? 'human' : 'remote');
    }
  }
  function broadcast() {
    if (!S.game || !S.connected) return;
    for (var s = 0; s < 4; s++) {
      publish(T('state/' + s), { seq: S.game.seq, view: F.view(S.game, s) });
    }
    publish(T('state/meta'), {
      seq: S.game.seq, seats: S.seats.slice(), names: S.names.slice(),
      host: S.cid, scoring: F.getScoring(), round: S.game.round
    });
  }
  function hostRefresh() {
    syncControl();
    pump();
    S.view = F.view(S.game, S.seat);
    render();
    broadcast();
  }
  function localRefresh() {
    syncControl();
    S.view = F.view(S.game, S.seat);
    render();
  }

  /* ---------- 动作入口 ---------- */
  function doAction(a) {
    // 客户端没有本地 game（权威状态只在房主端），必须优先放行，否则非房主玩家无法操作
    if (S.mode === 'client') {
      publish(T('ctrl/action'), { cid: S.cid, action: a });
      return;
    }
    if (!S.game || S.game.phase === 'end') return;
    if (S.mode === 'local') {
      var r = F.act(S.game, S.seat, a);
      if (!r.ok) { toast(r.error); return; }
      localRefresh();
      if (S.game.phase !== 'end') setTimeout(function () { pump(); localRefresh(); }, 260);
      return;
    }
    if (S.mode === 'host') {
      var r2 = F.act(S.game, S.seat, a);
      if (!r2.ok) { toast(r2.error); return; }
      hostRefresh();
      return;
    }
  }
  function nextRound() {
    if (S.mode === 'client') { publish(T('ctrl/next'), { cid: S.cid }); return; }
    if (!S.game) return;
    F.startRound(S.game);
    S.seq = -1;
    if (S.mode === 'local') { localRefresh(); setTimeout(function () { pump(); localRefresh(); }, 200); }
    else hostRefresh();
  }

  /* ---------- MQTT 库按需加载（仅在用户真正要联机时才触发） ---------- */
  function loadMqtt(cb) {
    if (window.mqtt) { cb(true); return; }
    if (S.mqttWaiters) { S.mqttWaiters.push(cb); return; }
    S.mqttWaiters = [cb];
    var idx = 0, done = false;
    function finish(okFlag) {
      if (done) return;
      done = true;
      var list = S.mqttWaiters || [];
      S.mqttWaiters = null;
      list.forEach(function (fn) { fn(okFlag); });
    }
    function tryNext() {
      if (idx >= MQTT_CDNS.length) {
        status('联机组件加载失败', 'bad');
        toast('联机组件加载失败，请检查网络后重试');
        finish(false);
        return;
      }
      var url = MQTT_CDNS[idx++];
      var sc = document.createElement('script');
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true; sc.onload = sc.onerror = null; tryNext();
      }, 6000);
      sc.onload = function () {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (window.mqtt) finish(true); else tryNext();
      };
      sc.onerror = function () {
        if (settled) return;
        settled = true; clearTimeout(timer); tryNext();
      };
      sc.async = true;
      sc.src = url;
      document.head.appendChild(sc);
    }
    status('正在加载联机组件…', 'muted');
    tryNext();
  }

  /* ---------- MQTT 连接 ---------- */
  function connectBroker(idx, onReady) {
    if (!window.mqtt) { status('MQTT 库未加载', 'bad'); toast('MQTT 库加载失败，请检查网络'); return; }
    S.stopping = false;
    if (S.client) {
      S.client.__retired = true;
      try { S.client.end(true); } catch (e) { /* ignore */ }
    }
    S.connected = false;
    var url = BROKERS[idx % BROKERS.length];
    status('连接中继 ' + (idx % BROKERS.length + 1) + '/' + BROKERS.length + '…', 'muted');
    var c;
    try {
      c = window.mqtt.connect(url, {
        clientId: 'wfzmj_' + S.cid, clean: true, connectTimeout: 9000,
        reconnectPeriod: 0, protocolVersion: 4, keepalive: 20
      });
    } catch (e) { switchBroker(); return; }
    S.client = c;
    c.__retired = false;
    c.on('connect', function () {
      if (c.__retired) return;
      S.connected = true;
      S.lastMsgAt = Date.now();
      status('中继已连接', 'ok');
      var subs = S.mode === 'host'
        ? [T('ctrl/#')]
        : [T('state/meta'), T('welcome/' + S.cid), T('notice/' + S.cid)];
      c.subscribe(subs, { qos: 0 }, function (err) {
        if (err) { status('订阅失败', 'bad'); return; }
        if (onReady) onReady();
      });
      startHeartbeat();
    });
    c.on('message', function (topic, buf) {
      if (c.__retired) return;
      S.lastMsgAt = Date.now();
      var msg;
      try { msg = JSON.parse(buf.toString()); } catch (e) { return; }
      onMessage(topic, msg);
    });
    c.on('error', function () {
      if (c.__retired) return;
      status('中继异常，尝试切换', 'bad'); switchBroker();
    });
    c.on('close', function () {
      if (c.__retired || S.stopping) return;
      S.connected = false;
      status('连接中断，尝试切换', 'bad'); switchBroker();
    });
  }
  function switchBroker() {
    if (S.mode === 'idle' || S.mode === 'local' || S.stopping) return;
    if (S.switchTimer) return;
    S.switchTimer = setTimeout(function () {
      S.switchTimer = null;
      S.brokerIdx++;
      connectBroker(S.brokerIdx, function () {
        if (S.mode === 'client') publish(T('ctrl/join'), { cid: S.cid, name: S.name });
        else if (S.mode === 'host') broadcast();
      });
    }, 1200);
  }
  function startHeartbeat() {
    clearInterval(S.timers.hb);
    S.timers.hb = setInterval(function () {
      if (S.mode === 'host') broadcast();
      if (S.mode === 'client' && Date.now() - S.lastMsgAt > 16000) {
        toast('长时间未收到房主消息，正在切换中继');
        switchBroker();
      }
    }, 5000);
  }

  /* ---------- 消息分发 ---------- */
  function onMessage(topic, msg) {
    var pfx = TOPIC_PREFIX + S.room + '/';
    if (topic.indexOf(pfx) !== 0) return;
    var sub = topic.slice(pfx.length);

    if (S.mode === 'host' && sub.indexOf('ctrl/') === 0) {
      hostCtrl(sub.slice(5), msg);
      return;
    }
    if (S.mode === 'client') {
      if (sub === 'notice/' + S.cid) { toast(msg.text || '操作未被接受'); return; }
      if (sub === 'state/meta') {
        S.seats = msg.seats || S.seats;
        S.names = msg.names || S.names;
        if (msg.scoring) { F.setScoring(msg.scoring); syncScorePanel(msg.scoring); }
        syncControl();
        renderRoomPanel();
        return;
      }
      if (sub === 'welcome/' + S.cid) {
        S.seat = msg.seat;
        S.names = msg.names || S.names;
        if (msg.scoring) { F.setScoring(msg.scoring); syncScorePanel(msg.scoring); }
        syncControl();
        S.client.subscribe(T('state/' + S.seat), { qos: 0 }, function () {
          publish(T('ctrl/sync'), { cid: S.cid });
        });
        renderRoomPanel();
        toast('已入座 ' + (S.seat + 1) + ' 号位');
        return;
      }
      if (sub === 'state/' + S.seat) {
        if (msg.seq !== undefined && msg.seq < S.seq) return; // 丢弃乱序旧包
        S.seq = msg.seq;
        S.view = msg.view;
        render();
      }
    }
  }

  function findSeatOf(cid) {
    for (var s = 0; s < 4; s++) if (S.seats[s] === cid) return s;
    return -1;
  }
  function hostCtrl(type, msg) {
    if (type === 'join') {
      var cid = msg.cid;
      if (!cid) return;
      var s = findSeatOf(cid);
      if (s < 0) {
        for (var i = 0; i < 4; i++) {
          if (!S.seats[i]) { s = i; break; }
        }
      }
      if (s < 0) { publish(T('welcome/' + cid), { seat: -1, full: true }); return; }
      S.seats[s] = cid;
      S.names[s] = String(msg.name || ('玩家' + (s + 1))).slice(0, 16);
      publish(T('welcome/' + cid), { seat: s, names: S.names.slice(), scoring: F.getScoring() });
      hostRefresh();
      return;
    }
    var seat = findSeatOf(msg.cid);
    if (type === 'action') {
      if (seat < 0 || !msg.action || !S.game) return;
      var r = F.act(S.game, seat, msg.action);
      if (!r.ok) { publish(T('notice/' + msg.cid), { text: r.error }); return; }
      hostRefresh();
      return;
    }
    if (type === 'next') {
      if (S.game && S.game.phase === 'end') { F.startRound(S.game); hostRefresh(); }
      return;
    }
    if (type === 'sync') {
      if (seat >= 0 && S.game) publish(T('state/' + seat), { seq: S.game.seq, view: F.view(S.game, seat) });
      return;
    }
    if (type === 'score') {
      if (msg.cfg) { F.setScoring(msg.cfg); hostRefresh(); }
    }
  }

  /* ---------- 模式启动 ---------- */
  function startLocal(preview) {
    stopAll();
    S.preview = !!preview;
    S.mode = 'local'; S.room = '本地演示'; S.seat = 0;
    S.seats = [S.cid, null, null, null];
    S.names = ['你', '机器人 2', '机器人 3', '机器人 4'];
    S.game = F.createGame();
    F.startRound(S.game);
    syncControl();
    status(preview ? '牌桌预览（未联网）' : '本地演示（无需联网）', preview ? 'muted' : 'ok');
    localRefresh();
    if (!preview) setTimeout(function () { pump(); localRefresh(); }, 240);
  }
  function startHost() {
    stopAll();
    S.preview = false;
    S.room = randRoom();
    S.mode = 'host'; S.seat = 0;
    S.seats = [S.cid, null, null, null];
    S.names = [S.name || '房主', '', '', ''];
    S.game = F.createGame();
    F.startRound(S.game);
    syncControl();
    $('roomCode').textContent = S.room;
    history.replaceState(null, '', inviteURL(S.room));
    var hostRoom = S.room;
    loadMqtt(function (okFlag) {
      if (!okFlag || S.mode !== 'host' || S.room !== hostRoom) return;
      connectBroker(S.brokerIdx, function () {
        hostRefresh();
        toast('房间已创建，把邀请链接发给另外三人');
      });
    });
  }
  function startClient(room) {
    stopAll();
    S.room = room.toUpperCase();
    S.mode = 'client'; S.seat = -1; S.seq = -1;
    S.seats = [null, null, null, null];
    S.names = ['', '', '', ''];
    S.view = null;
    renderRoomPanel();
    history.replaceState(null, '', inviteURL(S.room));
    var clientRoom = S.room;
    loadMqtt(function (okFlag) {
      if (!okFlag || S.mode !== 'client' || S.room !== clientRoom) return;
      connectBroker(S.brokerIdx, function () {
        publish(T('ctrl/join'), { cid: S.cid, name: S.name });
        status('已连接，等待房主分配座位', 'muted');
      });
    });
  }
  function stopAll() {
    S.stopping = true;
    clearInterval(S.timers.hb);
    clearTimeout(S.switchTimer); S.switchTimer = null;
    if (S.client) {
      S.client.__retired = true;
      try { S.client.end(true); } catch (e) { /* ignore */ }
    }
    S.client = null; S.connected = false;
    setTimeout(function () { S.stopping = false; }, 50);
    hideResult();
  }

  /* ---------- 计分设置 ----------
     2026-11-04 21:48 给齐、22:01 定稿：基础分 1 / 每朵花 1 / 自摸 ×2 /
     先翻倍再往上整 10；点炮与自摸一律三家各付。默认启用。
     其余为口述已给定的固定奖励分与花折算，默认值来自引擎。 */
  var SCORE_FIELDS = [
    ['normalHu', '普通胡牌基础分'], ['perFlower', '每朵花'],
    ['zimoMultiplier', '自摸倍数'], ['roundTo', '往上整到'],
    ['noFlower', '无花无杠'], ['oneFlower', '一张花'],
    ['tianhu', '天胡'], ['qiangjin', '抢金'],
    ['sanjindao', '三头金'], ['jinjiang', '金将 / 金雀'],
    ['flowerSetAs', '一套按几朵'], ['mingKongAs', '明杠折几朵'], ['anKongAs', '暗杠折几朵']
  ];
  function buildScorePanel() {
    var d = F.defaultScoring();
    $('scoreFields').innerHTML = SCORE_FIELDS.map(function (f) {
      return '<label><span>' + f[1] + '</span><input type="number" step="1" min="0" data-score="' +
             f[0] + '" value="' + (d[f[0]] || 0) + '"></label>';
    }).join('');
  }
  function readScorePanel() {
    var cfg = { ready: $('scoreReady').checked };
    SCORE_FIELDS.forEach(function (f) {
      var el = document.querySelector('[data-score="' + f[0] + '"]');
      cfg[f[0]] = el && el.value !== '' ? Number(el.value) : 0;
    });
    return cfg;
  }
  function applyScoring(silent) {
    var cfg = readScorePanel();
    F.setScoring(cfg);
    if (S.mode === 'client') { publish(T('ctrl/score'), { cid: S.cid, cfg: cfg }); }
    else if (S.mode === 'host') broadcast();
    else if (S.view) render();
    if (!silent) toast(cfg.ready ? '计分已启用' : '已切换为「只判定胜负、不计分」');
  }
  function syncScorePanel(cfg) {
    $('scoreReady').checked = !!cfg.ready;
    SCORE_FIELDS.forEach(function (f) {
      var el = document.querySelector('[data-score="' + f[0] + '"]');
      if (el) el.value = cfg[f[0]] || 0;
    });
  }

  /* ---------- 事件绑定 ---------- */
  function bind() {
    $('btnLocal').addEventListener('click', function () { startLocal(false); });
    $('btnCreate').addEventListener('click', function () {
      S.name = $('playerName').value.trim() || '房主';
      startHost();
    });
    $('btnJoin').addEventListener('click', function () {
      var room = $('joinRoom').value.trim();
      if (!/^[A-Za-z0-9]{4,10}$/.test(room)) { toast('请输入 4–10 位房间码'); return; }
      S.name = $('playerName').value.trim() || '玩家';
      startClient(room);
    });
    $('btnCopy').addEventListener('click', function () {
      var url = $('inviteLink').value;
      if (!url) { toast('请先创建房间'); return; }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(url).then(function () { toast('邀请链接已复制'); },
          function () { $('inviteLink').select(); toast('请手动复制链接'); });
      } else { $('inviteLink').select(); toast('请手动复制链接'); }
    });
    $('scoreReady').addEventListener('change', function () { applyScoring(); });
    $('scoreFields').addEventListener('change', function () { applyScoring(true); });
    $('btnScoreReset').addEventListener('click', function () {
      var cfg = F.setScoring({ reset: true });
      syncScorePanel(cfg);
      applyScoring(true);
      toast('已恢复默认值（基础 1 / 花 1 / 自摸 ×2 / 先翻倍再整 10 / 三家各付）');
    });

    $('myHand').addEventListener('click', function (e) {
      var el = e.target.closest('[data-tile]');
      if (!el || !S.view) return;
      doAction({ type: 'discard', tile: Number(el.getAttribute('data-tile')) });
    });
    $('actionBar').addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      if (b.hasAttribute('data-claim')) {
        var idx = Number(b.getAttribute('data-claim'));
        var o = (S.view.claimOptions || [])[idx];
        if (o) doAction({ type: o.type, tile: o.tile, use: o.use });
        return;
      }
      var act = b.getAttribute('data-act');
      if (!act) return;
      if (act === 'next') { nextRound(); return; }
      if (act === 'pass') { doAction({ type: 'pass' }); return; }
      var tile = b.getAttribute('data-tile');
      doAction(tile === '' || tile === null ? { type: act } : { type: act, tile: Number(tile) });
    });
    $('resultBox').addEventListener('click', function (e) {
      if (e.target.closest('[data-act="next"]')) nextRound();
    });
    document.querySelectorAll('[data-toggle]').forEach(function (el) {
      el.addEventListener('click', function () {
        var t = $(el.getAttribute('data-toggle'));
        t.classList.toggle('hidden');
      });
    });
  }

  function init() {
    S.cid = localStorage.getItem('wfzmj_cid') || randCid();
    localStorage.setItem('wfzmj_cid', S.cid);
    S.name = localStorage.getItem('wfzmj_name') || '';
    $('playerName').value = S.name;
    $('playerName').addEventListener('change', function () {
      S.name = this.value.trim() || '玩家';
      localStorage.setItem('wfzmj_name', S.name);
    });
    buildScorePanel();
    syncScorePanel(F.getScoring());
    bind();
    renderRoomPanel();
    var q = new URLSearchParams(location.search).get('room');
    if (q) { $('joinRoom').value = q.toUpperCase(); toast('检测到邀请房间 ' + q.toUpperCase() + '，点「加入房间」即可'); }
    // 首屏直接摆好一张静态预览牌桌：进页面立刻可见绿绒桌面 / 四家围坐 / 牌河 / 金牌，
    // 全部为本地计算，不请求任何外部库，因此不再有「点进去半天白屏」的问题。
    startLocal(true);
    // 本地演示定时推进（预览桌保持静止），避免真人未操作卡住
    clearInterval(S.timers.demo);
    S.timers.demo = setInterval(function () {
      if (S.preview) return;
      if (S.mode !== 'local' || !S.game || S.game.phase === 'end') return;
      var v = S.view;
      if (!v) return;
      if (v.phase === 'claim' && (v.claimOptions || []).length) return; // 等真人应答
      if (v.phase === 'play' && v.turn === S.seat && (v.actions || []).some(function (a) { return a.type === 'discard'; })) return;
      if (v.phase === 'opening' && S.seat === v.dealer && (v.actions || []).some(function (a) { return a.type === 'discard'; })) return;
      pump(); localRefresh();
    }, 900);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
