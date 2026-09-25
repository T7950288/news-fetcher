/* ============================================================
 * 围棋引擎 go_engine.js
 * 移植自本地「豆包围棋人机对弈」源码（GoGame 2026-09-14 版）
 * 包含：GoBoard 规则引擎 / FastBoard AI 快速棋盘 / MCTS+RAVE 智能
 * 页面与 Web Worker 共用此文件
 * ============================================================ */

/* ---------- 规则引擎（移植自 game/board.py） ---------- */
class GoBoard {
  constructor(size = 19) {
    this.size = size;
    this.grid = [];
    for (let r = 0; r < size; r++) {
      const row = [];
      for (let c = 0; c < size; c++) row.push(0);
      this.grid.push(row);
    }
    this.lastMove = null;       // [row, col]
    this.koPoint = null;        // [row, col]
    this.captures = { 1: 0, 2: 0 };
    this.moveHistory = [];      // {color, row, col, captured:[...]}
    this.passCount = 0;
  }

  copy() {
    const b = new GoBoard(this.size);
    b.grid = this.grid.map(r => r.slice());
    b.lastMove = this.lastMove ? this.lastMove.slice() : null;
    b.koPoint = this.koPoint ? this.koPoint.slice() : null;
    b.captures = { 1: this.captures[1], 2: this.captures[2] };
    b.moveHistory = this.moveHistory.map(m => ({ color: m.color, row: m.row, col: m.col, captured: m.captured.slice() }));
    b.passCount = this.passCount;
    return b;
  }

  _neighbors(row, col) {
    const res = [];
    if (row > 0) res.push([row - 1, col]);
    if (row < this.size - 1) res.push([row + 1, col]);
    if (col > 0) res.push([row, col - 1]);
    if (col < this.size - 1) res.push([row, col + 1]);
    return res;
  }

  _getGroup(row, col) {
    const color = this.grid[row][col];
    if (color === 0) return { group: [], libs: 0 };
    const group = [];
    const libSet = new Set();
    const visited = new Set();
    const queue = [[row, col]];
    visited.add(row * this.size + col);
    while (queue.length) {
      const [r, c] = queue.shift();
      group.push([r, c]);
      for (const [nr, nc] of this._neighbors(r, c)) {
        const key = nr * this.size + nc;
        if (this.grid[nr][nc] === 0) libSet.add(key);
        else if (this.grid[nr][nc] === color && !visited.has(key)) {
          visited.add(key);
          queue.push([nr, nc]);
        }
      }
    }
    return { group, libs: libSet.size };
  }

  _removeGroup(group) {
    for (const [r, c] of group) this.grid[r][c] = 0;
  }

  isValidMove(row, col, color) {
    if (row < 0 || row >= this.size || col < 0 || col >= this.size) return { valid: false, err: "超出棋盘范围" };
    if (this.grid[row][col] !== 0) return { valid: false, err: "该位置已有棋子" };
    if (this.koPoint && this.koPoint[0] === row && this.koPoint[1] === col) return { valid: false, err: "打劫禁入点" };

    this.grid[row][col] = color;
    const opponent = 3 - color;
    const captured = [];

    for (const [nr, nc] of this._neighbors(row, col)) {
      if (this.grid[nr][nc] === opponent) {
        const { group, libs } = this._getGroup(nr, nc);
        if (libs === 0) {
          captured.push(...group);
          this._removeGroup(group);
        }
      }
    }

    const { libs: myLibs } = this._getGroup(row, col);
    const valid = myLibs > 0;

    for (const [r, c] of captured) this.grid[r][c] = opponent;
    this.grid[row][col] = 0;

    if (!valid) return { valid: false, err: "禁止自杀" };
    return { valid: true, err: "" };
  }

  play(row, col, color) {
    const { valid, err } = this.isValidMove(row, col, color);
    if (!valid) return { ok: false, captured: [], err };

    this.grid[row][col] = color;
    const opponent = 3 - color;
    const captured = [];

    for (const [nr, nc] of this._neighbors(row, col)) {
      if (this.grid[nr][nc] === opponent) {
        const { group, libs } = this._getGroup(nr, nc);
        if (libs === 0) {
          captured.push(...group);
          this._removeGroup(group);
        }
      }
    }

    this.captures[color] += captured.length;

    let newKo = null;
    if (captured.length === 1) {
      const { libs: myLibs } = this._getGroup(row, col);
      if (myLibs === 1) {
        for (const [nr, nc] of this._neighbors(row, col)) {
          if (this.grid[nr][nc] === 0) { newKo = [nr, nc]; break; }
        }
      }
    }
    this.koPoint = newKo;
    this.lastMove = [row, col];
    this.moveHistory.push({ color, row, col, captured });
    this.passCount = 0;
    return { ok: true, captured, err: "" };
  }

  passMove(color) {
    this.passCount += 1;
    this.lastMove = null;
    this.koPoint = null;
    this.moveHistory.push({ color, row: -1, col: -1, captured: [] });
  }

  undo() {
    if (!this.moveHistory.length) return false;
    const m = this.moveHistory.pop();
    if (m.row >= 0 && m.col >= 0) {
      this.grid[m.row][m.col] = 0;
      const opponent = 3 - m.color;
      for (const [r, c] of m.captured) this.grid[r][c] = opponent;
      this.captures[m.color] -= m.captured.length;
    }
    if (this.moveHistory.length) {
      const prev = this.moveHistory[this.moveHistory.length - 1];
      this.lastMove = (prev.row >= 0) ? [prev.row, prev.col] : null;
    } else {
      this.lastMove = null;
    }
    this.koPoint = null;
    return true;
  }

  getLegalMoves(color) {
    const moves = [];
    for (let r = 0; r < this.size; r++) {
      for (let c = 0; c < this.size; c++) {
        if (this.grid[r][c] === 0) {
          const { valid } = this.isValidMove(r, c, color);
          if (valid) moves.push([r, c]);
        }
      }
    }
    return moves;
  }

  /* 数子：返回 {territoryMap, blackScore, whiteScore} */
  countTerritory() {
    const size = this.size;
    const visited = [];
    for (let r = 0; r < size; r++) { visited.push(new Array(size).fill(false)); }
    const territoryMap = [];
    for (let r = 0; r < size; r++) { territoryMap.push(new Array(size).fill(0)); }
    let blackTerritory = 0, whiteTerritory = 0;

    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (this.grid[r][c] === 0 && !visited[r][c]) {
          const region = [];
          const borders = new Set();
          const queue = [[r, c]];
          visited[r][c] = true;
          while (queue.length) {
            const [cr, cc] = queue.shift();
            region.push([cr, cc]);
            for (const [nr, nc] of this._neighbors(cr, cc)) {
              if (this.grid[nr][nc] === 0 && !visited[nr][nc]) {
                visited[nr][nc] = true;
                queue.push([nr, nc]);
              } else if (this.grid[nr][nc] !== 0) {
                borders.add(this.grid[nr][nc]);
              }
            }
          }
          if (borders.size === 1) {
            const owner = [...borders][0];
            for (const [tr, tc] of region) territoryMap[tr][tc] = owner;
            if (owner === 1) blackTerritory += region.length;
            else whiteTerritory += region.length;
          }
        }
      }
    }

    let blackStones = 0, whiteStones = 0;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (this.grid[r][c] === 1) blackStones++;
        else if (this.grid[r][c] === 2) whiteStones++;
      }
    }
    return {
      territoryMap,
      blackScore: blackTerritory + blackStones,
      whiteScore: whiteTerritory + whiteStones
    };
  }
}

/* ---------- AI 快速棋盘（移植自 engine/fast_board.py） ---------- */
class FastBoard {
  constructor(size = 19) {
    this.size = size;
    this.n = size * size;
    this.board = new Array(this.n).fill(0);
    this.lastMove = -1;
    this.koPoint = -1;
    this.passCount = 0;
    this.moveCount = 0;

    this.neighbors = new Array(this.n);
    this.neighbors8 = new Array(this.n);
    for (let idx = 0; idx < this.n; idx++) {
      const r = Math.floor(idx / size), c = idx % size;
      const n4 = [], n8 = [];
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < size && nc >= 0 && nc < size) {
            const nidx = nr * size + nc;
            n8.push(nidx);
            if (dr === 0 || dc === 0) n4.push(nidx);
          }
        }
      }
      this.neighbors[idx] = n4;
      this.neighbors8[idx] = n8;
    }

    this.starPoints = this._computeStarPoints();
  }

  _computeStarPoints() {
    const n = this.size;
    if (n === 19) {
      const pts = [3, 9, 15];
      const res = [];
      for (const r of pts) for (const c of pts) res.push(r * n + c);
      return res;
    } else if (n === 13) {
      return [3 * n + 3, 3 * n + 9, 6 * n + 6, 9 * n + 3, 9 * n + 9];
    } else if (n === 9) {
      return [2 * n + 2, 2 * n + 6, 4 * n + 4, 6 * n + 2, 6 * n + 6];
    }
    return [];
  }

  copy() {
    const b = new FastBoard(this.size);
    b.board = this.board.slice();
    b.lastMove = this.lastMove;
    b.koPoint = this.koPoint;
    b.passCount = this.passCount;
    b.moveCount = this.moveCount;
    return b;
  }

  _getGroupAndLibs(idx) {
    const color = this.board[idx];
    if (color === 0) return { group: [], libs: 0 };
    const group = [];
    let libs = 0;
    const seen = new Set([idx]);
    const stack = [idx];
    while (stack.length) {
      const cur = stack.pop();
      group.push(cur);
      for (const nb of this.neighbors[cur]) {
        const v = this.board[nb];
        if (v === 0) {
          if (!seen.has(nb)) { seen.add(nb); libs++; }
        } else if (v === color && !seen.has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    return { group, libs };
  }

  isLegal(idx, color) {
    if (idx < 0 || idx >= this.n) return false;
    if (this.board[idx] !== 0) return false;
    if (idx === this.koPoint) return false;

    this.board[idx] = color;
    const opponent = 3 - color;
    const captured = [];

    for (const nb of this.neighbors[idx]) {
      if (this.board[nb] === opponent) {
        const { group, libs } = this._getGroupAndLibs(nb);
        if (libs === 0) {
          for (const g of group) { this.board[g] = 0; captured.push(g); }
        }
      }
    }

    const { libs: myLibs } = this._getGroupAndLibs(idx);
    const legal = myLibs > 0;

    this.board[idx] = 0;
    for (const g of captured) this.board[g] = opponent;
    return legal;
  }

  play(idx, color) {
    if (idx === -1) {
      this.passCount += 1;
      this.lastMove = -1;
      this.koPoint = -1;
      this.moveCount += 1;
      return true;
    }
    if (!this.isLegal(idx, color)) return false;

    this.board[idx] = color;
    const opponent = 3 - color;
    let capturedSingle = -1;

    for (const nb of this.neighbors[idx]) {
      if (this.board[nb] === opponent) {
        const { group, libs } = this._getGroupAndLibs(nb);
        if (libs === 0) {
          if (group.length === 1) capturedSingle = group[0];
          for (const g of group) this.board[g] = 0;
        }
      }
    }

    let newKo = -1;
    if (capturedSingle >= 0) {
      const { libs: myLibs } = this._getGroupAndLibs(idx);
      if (myLibs === 1) {
        for (const nb of this.neighbors[idx]) {
          if (this.board[nb] === 0) { newKo = nb; break; }
        }
      }
    }
    this.koPoint = newKo;
    this.lastMove = idx;
    this.passCount = 0;
    this.moveCount += 1;
    return true;
  }

  getCandidateMoves(color, maxCandidates = 25) {
    const candidates = new Set();
    const size = this.size;

    if (this.lastMove >= 0) {
      const r = Math.floor(this.lastMove / size), c = this.lastMove % size;
      for (let dr = -3; dr <= 3; dr++) {
        for (let dc = -3; dc <= 3; dc++) {
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < size && nc >= 0 && nc < size) candidates.add(nr * size + nc);
        }
      }
    }

    for (let idx = 0; idx < this.n; idx++) {
      if (this.board[idx] !== 0) {
        for (const nb of this.neighbors8[idx]) {
          candidates.add(nb);
          const r = Math.floor(nb / size), c = nb % size;
          for (const [dr, dc] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
            const nr = r + dr, nc = c + dc;
            if (nr >= 0 && nr < size && nc >= 0 && nc < size) candidates.add(nr * size + nc);
          }
        }
      }
    }

    if (this.moveCount < 12) {
      for (const sp of this.starPoints) candidates.add(sp);
      if (size >= 13) {
        for (const r of [2, size - 3]) for (const c of [2, size - 3]) candidates.add(r * size + c);
      }
    }

    const scored = [];
    for (const idx of candidates) {
      if (idx >= 0 && idx < this.n && this.board[idx] === 0 && this.isLegal(idx, color)) {
        scored.push([idx, this._movePriority(idx, color)]);
      }
    }
    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, maxCandidates).map(x => x[0]);
  }

  _movePriority(idx, color) {
    let score = 0;
    const opponent = 3 - color;

    this.board[idx] = color;
    for (const nb of this.neighbors[idx]) {
      if (this.board[nb] === opponent) {
        const { group, libs } = this._getGroupAndLibs(nb);
        if (libs === 0) score += group.length * 5;
        else if (libs === 1) score += 2;
      }
    }
    this.board[idx] = 0;

    for (const nb of this.neighbors[idx]) {
      if (this.board[nb] === color) {
        const { libs } = this._getGroupAndLibs(nb);
        if (libs === 1) score += 3;
        else if (libs === 2) score += 1;
      }
    }

    if (this.lastMove >= 0) {
      const lr = Math.floor(this.lastMove / this.size), lc = this.lastMove % this.size;
      const r = Math.floor(idx / this.size), c = idx % this.size;
      const dist = Math.abs(r - lr) + Math.abs(c - lc);
      if (dist <= 2) score += 1.5;
      else if (dist <= 4) score += 0.5;
    }

    if (this.moveCount < 10) {
      const r = Math.floor(idx / this.size), c = idx % this.size;
      const center = Math.floor(this.size / 2);
      const distToCenter = Math.abs(r - center) + Math.abs(c - center);
      if (distToCenter > Math.floor(this.size / 3)) score += 1;
      if (this.moveCount === 0 && idx === center * this.size + center && this.size >= 13) score -= 2;
    }

    let ownNeighbors = 0;
    for (const nb of this.neighbors[idx]) {
      if (this.board[nb] === color) ownNeighbors++;
    }
    if (ownNeighbors >= 3) score -= 1;

    return score;
  }

  countScore() {
    const visited = new Array(this.n).fill(false);
    let black = 0, white = 0;
    for (let idx = 0; idx < this.n; idx++) {
      if (this.board[idx] === 1) black++;
      else if (this.board[idx] === 2) white++;
      else if (!visited[idx]) {
        const region = [];
        const borders = new Set();
        const stack = [idx];
        visited[idx] = true;
        while (stack.length) {
          const cur = stack.pop();
          region.push(cur);
          for (const nb of this.neighbors[cur]) {
            if (this.board[nb] === 0 && !visited[nb]) { visited[nb] = true; stack.push(nb); }
            else if (this.board[nb] !== 0) borders.add(this.board[nb]);
          }
        }
        if (borders.size === 1) {
          if (borders.has(1)) black += region.length;
          else white += region.length;
        }
      }
    }
    return { black, white };
  }
}

/* ---------- MCTS AI（移植自 engine/mcts_ai.py，RAVE 增强） ---------- */
class MCTSNode {
  constructor(move, color, parent = null, prior = 0) {
    this.move = move;         // -1 表示 pass
    this.color = color;
    this.parent = parent;
    this.children = [];
    this.visits = 0;
    this.wins = 0;
    this.raveVisits = 0;
    this.raveWins = 0;
    this.untriedMoves = null; // [[idx, priority], ...]
    this.prior = prior;
  }

  ucbRave(exploration = 1.41, raveWeight = 0.5) {
    if (this.visits === 0) return Infinity + this.prior * 10;
    const ucbValue = this.wins / this.visits;
    let value;
    if (this.raveVisits > 0) {
      const raveValue = this.raveWins / this.raveVisits;
      let beta = this.raveVisits / (this.visits + this.raveVisits + 1e-6);
      beta = Math.min(beta, raveWeight);
      value = (1 - beta) * ucbValue + beta * raveValue;
    } else {
      value = ucbValue;
    }
    const explore = exploration * Math.sqrt(Math.log(this.parent.visits) / this.visits);
    const priorBonus = this.prior * 0.5 / (1 + this.visits * 0.1);
    return value + explore + priorBonus;
  }

  bestChild(exploration = 1.41) {
    let best = null, bestV = -Infinity;
    for (const c of this.children) {
      const v = c.ucbRave(exploration);
      if (v > bestV) { bestV = v; best = c; }
    }
    return best;
  }

  mostVisitedChild() {
    let best = null, bestV = -1;
    for (const c of this.children) {
      if (c.visits > bestV) { bestV = c.visits; best = c; }
    }
    return best;
  }
}

class MCTSAI {
  constructor(boardSize = 19, komi = 7.5) {
    this.boardSize = boardSize;
    this.komi = komi;
    this.currentDifficulty = "高级";
    this.difficultyConfig = {
      "入门": { sims: 300,   time: 3 },
      "初级": { sims: 1500,  time: 6 },
      "中级": { sims: 5000,  time: 12 },
      "高级": { sims: 15000, time: 20 },
      "职业": { sims: 40000, time: 30 },
      "最强": { sims: 90000, time: 45 }
    };
  }

  setDifficulty(level) { if (this.difficultyConfig[level]) this.currentDifficulty = level; }
  setBoardSize(size) { this.boardSize = size; }
  setKomi(komi) { this.komi = komi; }

  genmove(color, boardState) {
    const fast = this._toFastBoard(boardState);
    const { sims: maxSims, time: maxTime } = this.difficultyConfig[this.currentDifficulty];

    const candidates = fast.getCandidateMoves(color, 30);
    if (!candidates.length) return { pass: true };
    if (candidates.length === 1) {
      const idx = candidates[0];
      return { row: Math.floor(idx / this.boardSize), col: idx % this.boardSize };
    }

    const root = new MCTSNode(-1, 3 - color);
    root.untriedMoves = candidates.map(idx => [idx, fast._movePriority(idx, color)]);

    const startTime = Date.now();
    let simulations = 0;

    while (simulations < maxSims && (Date.now() - startTime) / 1000 < maxTime) {
      const { node, board } = this._selectAndExpand(root, fast);
      const { winner, movesPlayed } = this._simulate(board, node.color);
      this._backpropagate(node, winner, movesPlayed);
      simulations++;
    }

    if (root.children.length) {
      const best = root.mostVisitedChild();
      if (best.move === -1) return { pass: true };
      return { row: Math.floor(best.move / this.boardSize), col: best.move % this.boardSize };
    }
    return { pass: true };
  }

  _toFastBoard(boardState) {
    const fast = new FastBoard(this.boardSize);
    if (boardState.gridFlat) {
      fast.board = boardState.gridFlat.slice();
    } else if (boardState.grid) {
      for (let r = 0; r < this.boardSize; r++) {
        for (let c = 0; c < this.boardSize; c++) {
          fast.board[r * this.boardSize + c] = boardState.grid[r][c];
        }
      }
    }
    if (boardState.lastMove) fast.lastMove = boardState.lastMove[0] * this.boardSize + boardState.lastMove[1];
    if (boardState.koPoint) fast.koPoint = boardState.koPoint[0] * this.boardSize + boardState.koPoint[1];
    fast.passCount = boardState.passCount || 0;
    fast.moveCount = boardState.moveCount || 0;
    return fast;
  }

  _selectAndExpand(root, fastBoard) {
    let node = root;
    const board = fastBoard.copy();

    while (node.children.length && !node.untriedMoves) {
      node = node.bestChild();
      if (node.move >= 0) board.play(node.move, node.color);
      else board.play(-1, node.color);
    }

    if (node.untriedMoves && node.untriedMoves.length) {
      let totalPriority = 0;
      for (const [, p] of node.untriedMoves) totalPriority += p;
      totalPriority += 1e-6;
      const r = Math.random() * totalPriority;
      let cum = 0, chosenIdx = 0;
      for (let i = 0; i < node.untriedMoves.length; i++) {
        cum += node.untriedMoves[i][1] + 0.1;
        if (cum >= r) { chosenIdx = i; break; }
      }
      const [move, priority] = node.untriedMoves.splice(chosenIdx, 1)[0];
      const childColor = 3 - node.color;
      const child = new MCTSNode(move, childColor, node, priority / 10.0);
      node.children.push(child);

      if (move >= 0) board.play(move, childColor);
      else board.play(-1, childColor);

      const nextColor = 3 - childColor;
      const nextCandidates = board.getCandidateMoves(nextColor, 25);
      child.untriedMoves = nextCandidates.map(idx => [idx, board._movePriority(idx, nextColor)]);
      node = child;
    }

    return { node, board };
  }

  _simulate(board, lastColor) {
    let current = 3 - lastColor;
    const movesPlayed = [];
    let consecutivePasses = 0;
    const maxMoves = this.boardSize * this.boardSize * 2;

    for (let i = 0; i < maxMoves; i++) {
      if (consecutivePasses >= 2) break;
      const candidates = board.getCandidateMoves(current, 20);
      if (!candidates.length || Math.random() < 0.03) {
        board.play(-1, current);
        movesPlayed.push([current, -1]);
        consecutivePasses++;
        current = 3 - current;
        continue;
      }
      const move = this._chooseHeuristicMove(board, candidates, current);
      board.play(move, current);
      movesPlayed.push([current, move]);
      consecutivePasses = 0;
      current = 3 - current;
    }

    const { black, white } = board.countScore();
    const whiteTotal = white + this.komi;
    const winner = black > whiteTotal ? 1 : 2;
    return { winner, movesPlayed };
  }

  _chooseHeuristicMove(board, candidates, color) {
    const opponent = 3 - color;

    /* 1. 立即提子 */
    const captureMoves = [];
    for (const idx of candidates) {
      board.board[idx] = color;
      for (const nb of board.neighbors[idx]) {
        if (board.board[nb] === opponent) {
          const { group, libs } = board._getGroupAndLibs(nb);
          if (libs === 0) captureMoves.push([idx, group.length]);
        }
      }
      board.board[idx] = 0;
    }
    if (captureMoves.length) {
      captureMoves.sort((a, b) => b[1] - a[1]);
      return captureMoves[0][0];
    }

    /* 2. 救棋 */
    const saveMoves = [];
    for (const idx of candidates) {
      board.board[idx] = color;
      let safe = true;
      for (const nb of board.neighbors[idx]) {
        if (board.board[nb] === color) {
          const { group, libs } = board._getGroupAndLibs(nb);
          if (libs <= 1 && group.length >= 3) { safe = false; break; }
        }
      }
      board.board[idx] = 0;
      if (!safe) saveMoves.push(idx);
    }
    if (saveMoves.length && Math.random() < 0.7) {
      return saveMoves[Math.floor(Math.random() * saveMoves.length)];
    }

    /* 3. 打吃 */
    const atariMoves = [];
    for (const idx of candidates) {
      board.board[idx] = color;
      for (const nb of board.neighbors[idx]) {
        if (board.board[nb] === opponent) {
          const { group, libs } = board._getGroupAndLibs(nb);
          if (libs === 1 && group.length >= 2) { atariMoves.push(idx); break; }
        }
      }
      board.board[idx] = 0;
    }
    if (atariMoves.length && Math.random() < 0.5) {
      return atariMoves[Math.floor(Math.random() * atariMoves.length)];
    }

    /* 4. 优先级加权随机（从前50%选） */
    const scored = candidates.map(idx => [idx, board._movePriority(idx, color)]);
    scored.sort((a, b) => b[1] - a[1]);
    const topN = Math.max(1, Math.floor(scored.length / 2));
    return scored[Math.floor(Math.random() * topN)][0];
  }

  _backpropagate(node, winner, movesPlayed) {
    const blackMoves = new Set();
    const whiteMoves = new Set();
    for (const [color, idx] of movesPlayed) {
      if (idx >= 0) {
        if (color === 1) blackMoves.add(idx);
        else whiteMoves.add(idx);
      }
    }

    while (node !== null) {
      node.visits += 1;
      if (node.color === winner) node.wins += 1;

      if (node.move >= 0) {
        if (node.color === 1 && blackMoves.has(node.move)) {
          node.raveVisits += 1;
          if (winner === 1) node.raveWins += 1;
        } else if (node.color === 2 && whiteMoves.has(node.move)) {
          node.raveVisits += 1;
          if (winner === 2) node.raveWins += 1;
        }
      }

      if (node.parent) {
        for (const sibling of node.parent.children) {
          if (sibling !== node && sibling.move >= 0) {
            if (sibling.color === 1 && blackMoves.has(sibling.move)) {
              sibling.raveVisits += 1;
              if (winner === 1) sibling.raveWins += 1;
            } else if (sibling.color === 2 && whiteMoves.has(sibling.move)) {
              sibling.raveVisits += 1;
              if (winner === 2) sibling.raveWins += 1;
            }
          }
        }
      }
      node = node.parent;
    }
  }
}

/* ---------- Web Worker 消息处理（仅在 Worker 环境生效） ---------- */
if (typeof importScripts !== "undefined") {
  self.onmessage = function (e) {
    const msg = e.data;
    if (!msg || msg.type !== "genmove") return;
    const ai = new MCTSAI(msg.boardSize, msg.komi);
    ai.setDifficulty(msg.difficulty);
    const boardState = {
      gridFlat: msg.gridFlat,
      lastMove: msg.lastMove,
      koPoint: msg.koPoint,
      passCount: msg.passCount,
      moveCount: msg.moveCount
    };
    const result = ai.genmove(msg.color, boardState);
    self.postMessage({ type: "move", id: msg.id, result: result });
  };
}
