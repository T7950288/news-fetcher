"use strict";
/*
 * 象棋 AI Worker 适配层
 * 引擎：xqwlight（象棋巫师精简版）https://github.com/xqbase/xqwlight  GPL-2.0
 * 界面棋盘坐标：board[r][c]，r=0 顶部（黑方），r=9 底部（红方），c=0..8 从左到右
 *   棋子编码：正=红（1帅 2仕 3相 4马 5车 6炮 7兵），负=黑（-1将 -2士 -3象 -4马 -5车 -6炮 -7卒）
 */
importScripts("xqwlight/position.js", "xqwlight/search.js", "xqwlight/book.js", "xqwlight/cchess.js");

var PC_MAP = { 1: "K", 2: "A", 3: "B", 4: "N", 5: "R", 6: "C", 7: "P",
               "-1": "k", "-2": "a", "-3": "b", "-4": "n", "-5": "r", "-6": "c", "-7": "p" };

/* board（我的坐标）-> FEN（黑方在顶小写、红方在底大写，与 xqwlight 一致） */
function boardToFen(board, side) {
  var rows = [];
  for (var r = 0; r < 10; r++) {
    var row = "", k = 0;
    for (var c = 0; c < 9; c++) {
      var p = board[r][c];
      if (p === 0) {
        k++;
      } else {
        if (k > 0) { row += k; k = 0; }
        row += PC_MAP[p];
      }
    }
    if (k > 0) row += k;
    rows.push(row);
  }
  return rows.join("/") + " " + (side === 1 ? "w" : "b");
}

/* 引擎走法编码 -> 我的坐标 */
function mvToBoard(mv) {
  var s = SRC(mv), d = DST(mv);
  return { fr: RANK_Y(s) - RANK_TOP, fc: FILE_X(s) - FILE_LEFT,
           tr: RANK_Y(d) - RANK_TOP, tc: FILE_X(d) - FILE_LEFT };
}

self.onmessage = function (e) {
  var msg = e.data;
  if (!msg || msg.type !== "genmove") return;
  try {
    var pos = new Position();
    pos.fromFen(boardToFen(msg.board, msg.side));
    var sr = new Search(pos);
    var depth = (msg.cfg && msg.cfg.depth) || 4;
    var millis = (msg.cfg && msg.cfg.timeMs) || 3000;
    var mv = sr.searchMain(depth, millis);
    var mvObj = mvToBoard(mv);
    var target = msg.board[mvObj.tr][mvObj.tc];
    mvObj.cap = target !== 0 ? 1 : 0;
    mvObj.capScore = mvObj.cap ? Math.abs(target) : 0;
    mvObj.score = sr.mvResult > 0 ? sr.allNodes : 0;
    self.postMessage({ type: "move", id: msg.id, mv: mvObj, score: 0, mate: false });
  } catch (err) {
    self.postMessage({ type: "error", id: msg.id, error: String(err) });
  }
};
