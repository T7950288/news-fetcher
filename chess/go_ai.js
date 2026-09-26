/* ============================================================
 * go_ai.js —— 围棋 AI 引擎（KataGo b10c128 神经网络 + MCTS）
 * 模型：KataGo b10c128（TensorFlow.js graph model，来自 zengo 开源项目，
 *       模型权重为 KataGo 官方 kata1-b10c128 系列）
 * 输入：bin_inputs [1,361,22]（22 通道）+ global_inputs [1,19]
 * 输出：policy[1,2,362]  value[1,3]  miscvalues[1,10]  ownership[1,19,19]
 * 编码参考 kata-model-js（maksimKorzh）的 KataGo 输入实现
 * ============================================================ */

class MCTSNode {
  constructor(parent, move, prior) {
    this.parent = parent;
    this.move = move;        // {r,c} 或 {pass:true}
    this.prior = prior;
    this.N = 0;
    this.W = 0;
    this.Q = 0;
    this.children = null;    // Map，首次展开时创建
  }
}

class GoAI {
  constructor() {
    this.model = null;
    this.ready = false;
    this.backend = "cpu";
    this.c_puct = 1.2;
    this._passKey = "pass";
    this._key = (r, c) => r * 19 + c;
  }

  /* ---------- 模型加载 ---------- */
  async load(modelUrl) {
    try { await tf.setBackend("webgl"); } catch (e) { /* 无 WebGL 时回退 */ }
    if (tf.getBackend() === "webgl") this.backend = "webgl";
    this.model = await tf.loadGraphModel(modelUrl);
    this.ready = true;
    return this.backend;
  }

  /* ---------- KataGo 输入编码（22 通道 + 19 全局） ---------- */
  // board: GoBoard；sideToMove: 当前行棋方（1黑/2白）；komi: 贴目
  encodePosition(board, sideToMove, komi) {
    const N = 19, CH = 22;
    const bin = new Float32Array(N * N * CH);
    const global = new Float32Array(19);
    const cur = sideToMove;          // KataGo 视角 = 当前行棋方
    const opp = 3 - cur;
    const hist = board.moveHistory;

    // 预计算黑白双方各点的气数（组气）
    const libsMap = this._computeLibertyMap(board, cur, opp);

    for (let r = 0; r < N; r++) {
      for (let c = 0; c < N; c++) {
        const cell = board.grid[r][c];
        const base = (r * N + c) * CH;
        bin[base + 0] = 1.0;                       // ch0: 在棋盘上
        if (cell === cur)  bin[base + 1] = 1.0;    // ch1: 当前方石
        if (cell === opp)  bin[base + 2] = 1.0;    // ch2: 对方石
        if (cell !== 0) {
          const lb = libsMap[r][c];
          if (lb === 1) bin[base + 3] = 1.0;
          if (lb === 2) bin[base + 4] = 1.0;
          if (lb === 3) bin[base + 5] = 1.0;
        }
      }
    }
    // ch6: ko 点
    if (board.koPoint) {
      const [kr, kc] = board.koPoint;
      bin[(kr * N + kc) * CH + 6] = 1.0;
    }
    // ch9-13: 最近 5 手（交替：最近一手是对方，接着是当前方……）
    // global[0-4]: 最近 5 手是否 pass
    let idx = hist.length - 1;
    const expected = [opp, cur, opp, cur, opp];    // 最近一手是对方下的
    for (let ch = 0; ch < 5; ch++) {
      if (idx < 0) break;
      const mv = hist[idx];
      if (mv.color !== expected[ch]) break;
      if (mv.row < 0 || mv.col < 0) {
        global[ch] = 1.0;                          // pass 标记
      } else {
        bin[(mv.row * N + mv.col) * CH + (9 + ch)] = 1.0;
      }
      idx--;
    }
    // global[5]: komi（当前方视角）
    const selfKomi = (cur === 2) ? (komi + 1) : (-komi);
    global[5] = selfKomi / 20.0;

    return {
      bin: tf.tensor(bin, [1, N * N, CH], "float32"),
      glob: tf.tensor(global, [1, 19], "float32")
    };
  }

  _computeLibertyMap(board, cur, opp) {
    const N = 19;
    const libs = [];
    for (let r = 0; r < N; r++) libs.push(new Int32Array(N));
    const visited = [];
    for (let r = 0; r < N; r++) visited.push(new Uint8Array(N));
    for (const color of [cur, opp]) {
      for (let r = 0; r < N; r++) {
        for (let c = 0; c < N; c++) {
          if (board.grid[r][c] !== color || visited[r][c]) continue;
          // BFS 找组 + 气
          const group = [];
          const libSet = new Set();
          const queue = [[r, c]];
          visited[r][c] = 1;
          let qi = 0;
          while (qi < queue.length) {
            const [cr, cc] = queue[qi]; qi++;
            group.push([cr, cc]);
            const nbs = this._nbrs(cr, cc, N);
            for (const [nr, nc] of nbs) {
              if (board.grid[nr][nc] === 0) libSet.add(nr * N + nc);
              else if (board.grid[nr][nc] === color && !visited[nr][nc]) {
                visited[nr][nc] = 1;
                queue.push([nr, nc]);
              }
            }
          }
          const lb = libSet.size;
          for (const [gr, gc] of group) libs[gr][gc] = lb;
        }
      }
    }
    return libs;
  }

  _nbrs(r, c, N) {
    const res = [];
    if (r > 0) res.push([r - 1, c]);
    if (r < N - 1) res.push([r + 1, c]);
    if (c > 0) res.push([r, c - 1]);
    if (c < N - 1) res.push([r, c + 1]);
    return res;
  }

  /* ---------- 神经网络前向 ---------- */
  async predict(board, sideToMove, komi) {
    const { bin, glob } = this.encodePosition(board, sideToMove, komi);
    try {
      const res = await this.model.executeAsync({
        "swa_model/bin_inputs": bin,
        "swa_model/global_inputs": glob
      });
      // 输出顺序：0=ownership 1=policy 2=miscvalues 3=value
      const policyFlat = await res[1].data();
      const valueFlat = await res[3].data();
      const miscFlat = await res[2].data();
      // 当前方 policy：前 362（361 点 + pass）
      const policy = new Float32Array(362);
      for (let i = 0; i < 362; i++) policy[i] = policyFlat[i];
      // value：win/loss/no-result 的 softmax 差值（当前方视角）
      const a = Math.exp(valueFlat[0]), b = Math.exp(valueFlat[1]), c = Math.exp(valueFlat[2] || 0);
      const v = (a - b) / (a + b + c);
      const scoreLead = miscFlat.length > 2 ? miscFlat[2] * 20.0 : 0;
      bin.dispose(); glob.dispose();
      for (const t of res) if (t && t.dispose) t.dispose();
      return { policy, value: v, scoreLead };
    } catch (e) {
      bin.dispose(); glob.dispose();
      throw e;
    }
  }

  /* ---------- MCTS 搜索 ---------- */
  async search(board, komi, playouts, onProgress) {
    const side = (board.moveHistory.length % 2 === 0) ? 1 : 2; // 黑先，pass 也计一手
    const root = new MCTSNode(null, null, 0);
    const initBoard = board.copy();

    // 根评估
    const rootEval = await this.predict(initBoard, side, komi);
    root.children = this._expand(initBoard, side, komi, rootEval.policy);
    root.isExpanded = true;

    let done = 0;
    for (let i = 0; i < playouts; i++) {
      await this._simulate(root, initBoard.copy(), side, komi);
      done++;
      if (onProgress && (i % 16 === 0)) onProgress(done, playouts);
    }

    // 选子：子节点访问数最多
    let best = null, bestN = -1;
    for (const child of root.children.values()) {
      if (child.N > bestN) { bestN = child.N; best = child; }
    }
    const move = best ? { r: best.move.r, c: best.move.c, pass: !!best.move.pass } : { pass: true };
    // 胜率（根视角）
    const wr = 1 / (1 + Math.exp(-root.Q * 3.0));
    return { move, winrate: wr, playouts: done, rootQ: root.Q, scoreLead: rootEval.scoreLead };
  }

  _expand(board, side, komi, policy) {
    const children = new Map();
    const moves = board.getLegalMoves(side);
    for (const [r, c] of moves) {
      const p = Math.max(policy[r * 19 + c], 1e-6);
      children.set(this._key(r, c), new MCTSNode(null, { r, c }, p));
    }
    const pp = Math.max(policy[361], 1e-6);
    children.set(this._passKey, new MCTSNode(null, { pass: true }, pp));
    return children;
  }

  async _simulate(root, board, side, komi) {
    let node = root, b = board, s = side;
    const path = [root];
    while (node.isExpanded && node.children.size > 0) {
      const child = this._select(node);
      path.push(child);
      if (child.move.pass) b.passMove(s);
      else b.play(child.move.r, child.move.c, s);
      s = 3 - s;
      node = child;
    }
    let value;
    if (!node.isExpanded) {
      const evalR = await this.predict(b, s, komi);
      node.children = this._expand(b, s, komi, evalR.policy);
      node.isExpanded = true;
      value = evalR.value;
    } else {
      value = 0; // 无可走分支（罕见）
    }
    for (let i = path.length - 1; i >= 0; i--) {
      const n = path[i];
      n.N++;
      n.W += value;
      n.Q = n.W / n.N;
      value = -value;
    }
    return value;
  }

  _select(node) {
    let best = null, bestVal = -Infinity;
    const sq = Math.sqrt(node.N + 1);
    for (const child of node.children.values()) {
      const u = this.c_puct * child.prior * sq / (1 + child.N);
      const val = child.Q + u;
      if (val > bestVal) { bestVal = val; best = child; }
    }
    return best;
  }
}
