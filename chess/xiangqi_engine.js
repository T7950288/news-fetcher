/* ============================================================
 * 中国象棋引擎（纯前端，最强版）
 * 走法生成 / 规则校验 / 定向将军检测 / 局面评估
 * Alpha-Beta 剪枝 + 迭代加深 + 置换表 + 历史启发 + 将军延伸
 * 可被 Web Worker importScripts 加载，也可在 node 中 require
 * ============================================================ */
(function (global) {
  "use strict";

  const ROWS = 10, COLS = 9;
  const EMPTY = 0;
  const INF = 1e9;
  // 红：1帅 2仕 3相 4马 5车 6炮 7兵   黑：-1将 -2士 -3象 -4马 -5车 -6炮 -7卒

  const XQ = { ROWS: ROWS, COLS: COLS, EMPTY: EMPTY };

  /* ---------- 初始局面：黑上红下 ---------- */
  XQ.initialBoard = function () {
    const b = [];
    for (let r = 0; r < ROWS; r++) {
      const row = [];
      for (let c = 0; c < COLS; c++) row.push(0);
      b.push(row);
    }
    const back = [5, 4, 3, 2, 1, 2, 3, 4, 5];
    for (let c = 0; c < COLS; c++) b[0][c] = -back[c];
    b[2][1] = -6; b[2][7] = -6;
    for (let c = 0; c < COLS; c += 2) b[3][c] = -7;
    for (let c = 0; c < COLS; c++) b[9][c] = back[c];
    b[7][1] = 6; b[7][7] = 6;
    for (let c = 0; c < COLS; c += 2) b[6][c] = 7;
    return b;
  };

  function sideOf(p) { return p > 0 ? 1 : (p < 0 ? -1 : 0); }
  function inBoard(r, c) { return r >= 0 && r < ROWS && c >= 0 && c < COLS; }

  /* ---------- 走法生成（按棋子规则，不含被将军过滤） ---------- */
  function rawMoves(b, r, c, out) {
    const p = b[r][c];
    if (p === 0) return;
    const s = sideOf(p);
    const a = Math.abs(p);
    const push = function (tr, tc) {
      if (!inBoard(tr, tc)) return;
      const t = b[tr][tc];
      if (t !== 0 && sideOf(t) === s) return;
      out.push({ fr: r, fc: c, tr: tr, tc: tc, cap: t !== 0 ? 1 : 0, capScore: t !== 0 ? Math.abs(t) : 0 });
    };

    switch (a) {
      case 5: { /* 车：直线 */
        const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
        for (let i = 0; i < 4; i++) {
          const dr = dirs[i][0], dc = dirs[i][1];
          let nr = r + dr, nc = c + dc;
          while (inBoard(nr, nc)) {
            push(nr, nc);
            if (b[nr][nc] !== 0) break;
            nr += dr; nc += dc;
          }
        }
        break;
      }
      case 6: { /* 炮：直线 + 隔一子吃 */
        const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
        for (let i = 0; i < 4; i++) {
          const dr = dirs[i][0], dc = dirs[i][1];
          let nr = r + dr, nc = c + dc;
          while (inBoard(nr, nc) && b[nr][nc] === 0) { push(nr, nc); nr += dr; nc += dc; }
          if (!inBoard(nr, nc)) continue;
          nr += dr; nc += dc;   /* 越过第一个子 */
          while (inBoard(nr, nc)) {
            if (b[nr][nc] !== 0) { push(nr, nc); break; }
            nr += dr; nc += dc;
          }
        }
        break;
      }
      case 4: { /* 马：日字，蹩马腿 */
        const moves = [
          [-1, 0, -2, -1], [-1, 0, -2, 1], [1, 0, 2, -1], [1, 0, 2, 1],
          [0, -1, -1, -2], [0, -1, 1, -2], [0, 1, -1, 2], [0, 1, 1, 2]
        ];
        for (let i = 0; i < 8; i++) {
          const lr = r + moves[i][0], lc = c + moves[i][1];
          if (inBoard(lr, lc) && b[lr][lc] === 0) push(r + moves[i][2], c + moves[i][3]);
        }
        break;
      }
      case 3: { /* 相/象：田字，塞象眼，不过河 */
        const dirs = [[-2, -2], [-2, 2], [2, -2], [2, 2]];
        for (let i = 0; i < 4; i++) {
          const nr = r + dirs[i][0], nc = c + dirs[i][1];
          if (!inBoard(nr, nc)) continue;
          if (s === 1 && nr < 5) continue;
          if (s === -1 && nr > 4) continue;
          const er = r + dirs[i][0] / 2, ec = c + dirs[i][1] / 2;
          if (b[er][ec] !== 0) continue;
          push(nr, nc);
        }
        break;
      }
      case 2: { /* 仕/士：九宫斜走 */
        const dirs = [[-1, -1], [-1, 1], [1, -1], [1, 1]];
        for (let i = 0; i < 4; i++) {
          const nr = r + dirs[i][0], nc = c + dirs[i][1];
          if (!inBoard(nr, nc) || nc < 3 || nc > 5) continue;
          if (s === 1) { if (nr < 7 || nr > 9) continue; }
          else { if (nr < 0 || nr > 2) continue; }
          push(nr, nc);
        }
        break;
      }
      case 1: { /* 帅/将：九宫直走一步 */
        const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
        for (let i = 0; i < 4; i++) {
          const nr = r + dirs[i][0], nc = c + dirs[i][1];
          if (!inBoard(nr, nc) || nc < 3 || nc > 5) continue;
          if (s === 1) { if (nr < 7 || nr > 9) continue; }
          else { if (nr < 0 || nr > 2) continue; }
          push(nr, nc);
        }
        break;
      }
      case 7: { /* 兵/卒：前进，过河后可横走 */
        const dirs = [];
        if (s === 1) {
          dirs.push([-1, 0]);
          if (r <= 4) dirs.push([0, -1], [0, 1]);
        } else {
          dirs.push([1, 0]);
          if (r >= 5) dirs.push([0, -1], [0, 1]);
        }
        for (let i = 0; i < dirs.length; i++) push(r + dirs[i][0], c + dirs[i][1]);
        break;
      }
    }
  }

  /* 将帅照面 */
  function kingsFace(b) {
    let kr = -1, kc = -1, gr = -1, gc = -1;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (b[r][c] === 1) { kr = r; kc = c; }
        if (b[r][c] === -1) { gr = r; gc = c; }
      }
    }
    if (kr < 0 || gr < 0) return false;
    if (kc !== gc) return false;
    for (let r = Math.min(kr, gr) + 1; r < Math.max(kr, gr); r++) {
      if (b[r][kc] !== 0) return false;
    }
    return true;
  }

  /* ---------- 定向攻击检测（远快于全盘枚举） ---------- */
  /* (r,c) 是否被 bySide 方的棋子攻击 */
  function isAttacked(b, r, c, bySide) {
    /* 车/炮/照面：四个直线方向 */
    const dirs = [[-1, 0], [1, 0], [0, -1], [0, 1]];
    for (let i = 0; i < 4; i++) {
      const dr = dirs[i][0], dc = dirs[i][1];
      let nr = r + dr, nc = c + dc;
      let a = 0; /* 第一个非空子 */
      while (inBoard(nr, nc) && b[nr][nc] === 0) { nr += dr; nc += dc; }
      if (!inBoard(nr, nc)) continue;
      a = b[nr][nc];
      if (bySide === 1) {
        if (a === 5 || a === 1) return true;          /* 红车 / 红帅照面（红方攻击） */
        if (a !== 0) {                               /* 第一个子做隔子，看第二个子是否是炮 */
          nr += dr; nc += dc;
          while (inBoard(nr, nc) && b[nr][nc] === 0) { nr += dr; nc += dc; }
          if (inBoard(nr, nc) && b[nr][nc] === 6) return true;  /* 红炮隔子 */
        }
      } else {
        if (a === -5 || a === -1) return true;        /* 黑车 / 黑将照面（黑方攻击） */
        if (a !== 0) {
          nr += dr; nc += dc;
          while (inBoard(nr, nc) && b[nr][nc] === 0) { nr += dr; nc += dc; }
          if (inBoard(nr, nc) && b[nr][nc] === -6) return true;  /* 黑炮隔子 */
        }
      }
    }
    /* 马 */
    const hm = [[-2, -1], [-2, 1], [2, -1], [2, 1], [-1, -2], [-1, 2], [1, -2], [1, 2]];
    for (let i = 0; i < 8; i++) {
      const nr = r + hm[i][0], nc = c + hm[i][1];
      if (inBoard(nr, nc)) {
        const p = b[nr][nc];
        if ((bySide === 1 && p === 4) || (bySide === -1 && p === -4)) {
          /* 蹩马腿：竖跳2时腿在中间行同列；横跳2时腿在中间列同行 */
          let lr, lc;
          if (hm[i][0] % 2 === 0) { lr = r + hm[i][0] / 2; lc = c + hm[i][1]; }
          else { lr = r + hm[i][0]; lc = c + hm[i][1] / 2; }
          if (inBoard(lr, lc) && b[lr][lc] === 0) return true;
        }
      }
    }
    /* 兵/卒 */
    if (bySide === 1) {
      /* 红兵攻击 (r,c)：正上方 r-1 或横向（过河 r<=4） */
      if (inBoard(r - 1, c) && b[r - 1][c] === 7) return true;
      if (inBoard(r, c - 1) && b[r][c - 1] === 7 && r <= 4) return true;
      if (inBoard(r, c + 1) && b[r][c + 1] === 7 && r <= 4) return true;
    } else {
      /* 黑卒攻击 (r,c)：正下方 r+1 或横向（过河 r>=5） */
      if (inBoard(r + 1, c) && b[r + 1][c] === -7) return true;
      if (inBoard(r, c - 1) && b[r][c - 1] === -7 && r >= 5) return true;
      if (inBoard(r, c + 1) && b[r][c + 1] === -7 && r >= 5) return true;
    }
    return false;
  }

  /* 应用走法，返回新棋盘 */
  XQ.apply = function (b, mv) {
    const nb = [];
    for (let r = 0; r < ROWS; r++) nb.push(b[r].slice());
    nb[mv.tr][mv.tc] = nb[mv.fr][mv.fc];
    nb[mv.fr][mv.fc] = 0;
    return nb;
  };

  /* 是否被将军（含将帅照面） */
  XQ.inCheck = function (b, side) {
    if (kingsFace(b)) return true;
    let kr = -1, kc = -1;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (side === 1 && b[r][c] === 1) { kr = r; kc = c; }
        if (side === -1 && b[r][c] === -1) { kr = r; kc = c; }
      }
    }
    if (kr < 0) return true;
    return isAttacked(b, kr, kc, -side);
  };

  /* 一方全部合法走法 */
  XQ.genLegalMoves = function (b, side) {
    const all = [];
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        if (sideOf(b[r][c]) === side) rawMoves(b, r, c, all);
      }
    }
    const legal = [];
    for (let i = 0; i < all.length; i++) {
      const nb = XQ.apply(b, all[i]);
      if (!XQ.inCheck(nb, side)) legal.push(all[i]);
    }
    return legal;
  };

  /* ---------- 局面评估 ---------- */
  /* 子力：马 470 略重于炮 440（传统中国象棋），兵 120 */
  const PIECE_VAL = [0, 100000, 200, 200, 470, 1000, 440, 120];

  /* 位置表（红方视角，行 0=黑方底线；黑方棋子用 9-r 翻转查表） */
  const PST_M = [  /* 马 */
    [-10, -5, -5, -5, -5, -5, -5, -5, -10],
    [ -5,  0,  0,  0,  0,  0,  0,  0,  -5],
    [ -5,  0,  5, 10, 10, 10,  5,  0,  -5],
    [ -5,  5, 10, 15, 15, 15, 10,  5,  -5],
    [ -5,  5, 10, 15, 15, 15, 10,  5,  -5],
    [ -5,  5, 10, 15, 15, 15, 10,  5,  -5],
    [ -5,  0,  5, 10, 10, 10,  5,  0,  -5],
    [ -5,  0,  0,  0,  0,  0,  0,  0,  -5],
    [ -5,  0,  0,  0,  0,  0,  0,  0,  -5],
    [-10, -5, -5, -5, -5, -5, -5, -5, -10]
  ];
  const PST_P = [  /* 炮：中路强、底线弱 */
    [  0,  0,  0,  0,  0,  0,  0,  0,  0],
    [  0,  0,  0,  0,  0,  0,  0,  0,  0],
    [ -5,  0,  0,  5,  5,  5,  0,  0,  -5],
    [ -5,  0,  5, 10, 15, 10,  5,  0,  -5],
    [  0,  0,  5, 10, 15, 10,  5,  0,  0],
    [  0,  0,  5, 10, 15, 10,  5,  0,  0],
    [  0,  0,  5, 10, 15, 10,  5,  0,  0],
    [ -5,  0,  0,  5,  5,  5,  0,  0,  -5],
    [ -5,  0,  0,  0,  0,  0,  0,  0,  -5],
    [  0,  0,  0,  0,  0,  0,  0,  0,  0]
  ];
  const PST_R = [  /* 车：巡河/占中/通头 */
    [  0, 10, 10, 10, 10, 10, 10, 10,  0],
    [  0, 10, 10, 10, 10, 10, 10, 10,  0],
    [ -5,  5,  5, 10, 10, 10,  5,  5, -5],
    [ -5,  5,  5, 10, 10, 10,  5,  5, -5],
    [  0,  5,  5, 10, 15, 10,  5,  5,  0],
    [  0,  5,  5, 10, 15, 10,  5,  5,  0],
    [ -5,  5,  5, 10, 10, 10,  5,  5, -5],
    [ -5,  5,  5, 10, 10, 10,  5,  5, -5],
    [  0, 10, 10, 10, 10, 10, 10, 10,  0],
    [  0, 10, 10, 10, 10, 10, 10, 10,  0]
  ];
  const PST_B = [  /* 兵/卒：未过河无分，过河递增，中路强（红方视角） */
    [100, 100, 110, 120, 130, 120, 110, 100, 100],
    [ 90,  90, 100, 110, 120, 110, 100,  90,  90],
    [ 80,  80,  90, 100, 110, 100,  90,  80,  80],
    [ 60,  60,  70,  80,  90,  80,  70,  60,  60],
    [ 40,  40,  50,  60,  70,  60,  50,  40,  40],
    [ 20,  20,  20,  25,  30,  25,  20,  20,  20],
    [  0,   0,   0,   0,   0,   0,   0,   0,   0],
    [  0,   0,   0,   0,   0,   0,   0,   0,   0],
    [  0,   0,   0,   0,   0,   0,   0,   0,   0],
    [  0,   0,   0,   0,   0,   0,   0,   0,   0]
  ];

  XQ.evaluate = function (b) {
    let score = 0;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = b[r][c];
        if (p === 0) continue;
        const s = sideOf(p);
        const a = Math.abs(p);
        let v = PIECE_VAL[a];
        const rr = s === 1 ? r : 9 - r;          /* 红方视角行 */
        if (a === 4) v += PST_M[rr][c];
        else if (a === 6) v += PST_P[rr][c];
        else if (a === 5) v += PST_R[rr][c];
        else if (a === 7) v += PST_B[rr][c];
        else if (a === 2 || a === 3) {            /* 仕/相：回防加分，外出减分 */
          if (rr >= 7) v += 15;
          if (rr <= 4) v -= 20;
        } else if (a === 1) {                     /* 帅/将：底线稳，上前危险 */
          if (rr === 0) v += (c === 4 ? 10 : 0);
          if (rr === 1) v -= 15;
        }
        score += s * v;
      }
    }
    return score;
  };

  /* ---------- 搜索：置换表 + 历史启发 + 将军延伸 + Alpha-Beta ---------- */

  /* 静态搜索：叶子节点继续只搜吃子，消除水平线效应 */
  function quiesce(ctx, b, side, alpha, beta) {
    if (ctx.deadline && Date.now() > ctx.deadline) { const e = new Error("timeout"); e.timeout = true; throw e; }
    const stand = XQ.evaluate(b);
    if (stand >= beta) return stand;
    if (stand > alpha) alpha = stand;
    const capMoves = XQ.genLegalMoves(b, side).filter(function (m) { return m.cap; });
    capMoves.sort(function (x, y) { return y.capScore - x.capScore; });
    for (let i = 0; i < capMoves.length && i < 8; i++) {
      const val = -quiesce(ctx, XQ.apply(b, capMoves[i]), -side, -beta, -alpha);
      if (val > alpha) alpha = val;
      if (alpha >= beta) break;
    }
    return alpha;
  }

  /* 开局库：前两手走常见开局，杜绝开局乱走送子 */
  function openingMove(b, n) {
    if (n === 0) return { fr: 7, fc: 7, tr: 7, tc: 4, cap: 0, capScore: 0 };  /* 红先：炮二平五（当头炮） */
    if (n === 1) return { fr: 0, fc: 7, tr: 2, tc: 7, cap: 0, capScore: 0 };   /* 黑应：马8进7（屏风马） */
    return null;
  }
  function boardKey(b, side) {
    let s = "";
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const p = b[r][c];
        s += String.fromCharCode(p + 16);
      }
    }
    return s + (side === 1 ? "r" : "b");
  }

  function alphaBeta(ctx, b, side, depth, alpha, beta) {
    if (ctx.deadline && Date.now() > ctx.deadline) { const e = new Error("timeout"); e.timeout = true; throw e; }
    /* 将军延伸：被将军时多算一层，避免错算杀棋 */
    let ext = 0;
    if (ctx.checkExt && XQ.inCheck(b, side)) ext = 1;
    const d = depth + ext;

    const key = boardKey(b, side);
    const hit = ctx.tt.get(key);
    if (hit && hit.depth >= d) {
      if (hit.flag === 0) return hit.score;            /* exact */
      if (hit.flag === 1 && hit.score <= alpha) return hit.score;  /* lower bound */
      if (hit.flag === 2 && hit.score >= beta) return hit.score;   /* upper bound */
    }

    /* null-move 剪枝：未被将军时让一手仍超 beta 则剪枝（省时，同预算想更深） */
    if (d >= 3 && ctx.nullMove !== false && !XQ.inCheck(b, side)) {
      const nm = -alphaBeta(ctx, b, -side, d - 2, -beta, -beta + 1);
      if (nm >= beta) return nm;
    }

    const moves = XQ.genLegalMoves(b, side);
    if (moves.length === 0) {
      const sc = XQ.inCheck(b, side) ? -INF + (10 - d) : -INF / 2;
      ctx.tt.set(key, { depth: d, score: sc, flag: 0 });
      return sc;
    }
    if (d === 0) return quiesce(ctx, b, side, alpha, beta);

    /* 着法排序：吃子 MVV-LVA + 历史启发 + 杀手着法 */
    const karr = ctx.killers[d];
    for (let i = 0; i < moves.length; i++) {
      const m = moves[i];
      let killer = 0;
      if (karr) {
        for (let k = 0; k < karr.length; k++) {
          if (karr[k].fr === m.fr && karr[k].fc === m.fc && karr[k].tr === m.tr && karr[k].tc === m.tc) { killer = 900; break; }
        }
      }
      m.order = (m.capScore > 0 ? m.capScore * 100 - PIECE_VAL[Math.abs(b[m.fr][m.fc])] : 0) + (ctx.hist.get(m.fr * 90 + m.fc) || 0) * 4 + killer;
    }
    moves.sort(function (x, y) { return y.order - x.order; });

    let best = -INF, flag = 1;   /* 1=lower bound */
    let first = true;
    for (let i = 0; i < moves.length; i++) {
      const mv = moves[i];
      const val = -alphaBeta(ctx, XQ.apply(b, mv), -side, d - 1, -beta, -alpha);
      if (val > best) best = val;
      if (val > alpha) alpha = val;
      if (alpha >= beta) {
        /* 剪枝：历史启发加分 + 记录杀手着法（同级复用） */
        const hk = mv.fr * 90 + mv.fc;
        ctx.hist.set(hk, (ctx.hist.get(hk) || 0) + d * d);
        const kd = (ctx.killers[d] = ctx.killers[d] || []);
        let dup = false;
        for (let k = 0; k < kd.length; k++) {
          if (kd[k].fr === mv.fr && kd[k].fc === mv.fc && kd[k].tr === mv.tr && kd[k].tc === mv.tc) { dup = true; break; }
        }
        if (!dup) { kd.push(mv); if (kd.length > 2) kd.shift(); }
        flag = 2;   /* upper bound */
        break;
      }
      first = false;
    }
    if (first) flag = 0;
    ctx.tt.set(key, { depth: d, score: best, flag: flag });
    return best;
  }

  /* 迭代加深：返回 {mv, score, mate} */
  XQ.search = function (b, side, cfg) {
    const maxDepth = cfg.depth || 3;
    const deadline = Date.now() + (cfg.timeMs || 3000);
    /* 开局库：前两手走常见开局（杜绝开局乱走送子） */
    if (cfg.opening !== undefined) {
      const om = openingMove(b, cfg.opening);
      if (om) return { mv: om, score: 0, mate: false };
    }
    const firstLegal = XQ.genLegalMoves(b, side);
    if (firstLegal.length === 0) return { mv: null, score: -INF, mate: XQ.inCheck(b, side) };
    firstLegal.sort(function (x, y) { return (y.capScore - x.capScore); });

    const ctx = { deadline: deadline, tt: new Map(), hist: new Map(), killers: {}, checkExt: cfg.checkExt !== false };
    let bestMove = firstLegal[0];
    let bestScore = -INF;
    for (let d = 1; d <= maxDepth; d++) {
      let iterBest = null, iterScore = -INF, alpha = -INF, beta = INF;
      try {
        for (let i = 0; i < firstLegal.length; i++) {
          const mv = firstLegal[i];
          const val = -alphaBeta(ctx, XQ.apply(b, mv), -side, d - 1, -beta, -alpha);
          if (val > iterScore) { iterScore = val; iterBest = mv; }
          if (val > alpha) alpha = val;
          if (alpha >= beta) break;
        }
        if (iterBest) { bestMove = iterBest; bestScore = iterScore; }
        if (bestScore >= INF - 1000 || bestScore <= -INF + 1000) break;   /* 必杀/必败提前结束 */
      } catch (e) {
        if (e && e.timeout) break;
        throw e;
      }
    }
    return { mv: bestMove, score: bestScore, mate: Math.abs(bestScore) >= INF - 2000 };
  };

  /* ---------- 导出 ---------- */
  if (typeof module !== "undefined" && module.exports) {
    module.exports = XQ;
  } else {
    global.XQ = XQ;
  }
})(typeof self !== "undefined" ? self : this);


/* Web Worker 消息入口：{type:"genmove", id, board, side, cfg} -> {type:"move", id, mv, score, mate} */
if (typeof self !== "undefined" && typeof importScripts === "function") {
  self.onmessage = function (e) {
    var msg = e.data;
    if (msg && msg.type === "genmove") {
      var res = XQ.search(msg.board, msg.side, msg.cfg);
      self.postMessage({ type: "move", id: msg.id, mv: res.mv, score: res.score, mate: res.mate });
    }
    if (msg && msg.type === "ping") {
      var b = XQ.initialBoard();
      self.postMessage({ type: "pong", moves: XQ.genLegalMoves(b, 1).length, piece: b[9][1] });
    }
  };
}