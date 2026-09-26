"use strict";
/*
 * 皮卡鱼（Pikafish）WASM 引擎 Worker
 * UCI 协议：position / go / bestmove
 * 引擎文件走 jsDelivr CDN（国内节点快）；改引擎文件后需清理 CDN 缓存
 */
const CDN = "https://cdn.jsdelivr.net/gh/t7950288/news-fetcher@main/chess/pikafish/";
importScripts(CDN + "pikafish.js");

let engine = null;
let buffer = "";
let currentId = 0;

function handleLine(line) {
  if (!line) return;
  self.postMessage({ type: "stdout", line: line });
  if (line.indexOf("bestmove") === 0) {
    const parts = line.split(/\s+/);
    if (parts.length >= 2 && parts[1] !== "(none)") {
      self.postMessage({ type: "move", id: currentId, uci: parts[1], ponder: parts.length >= 4 ? parts[3] : null });
    }
  }
}

function handleChunk(chunk) {
  let s = buffer + chunk;
  let idx;
  while ((idx = s.indexOf("\n")) >= 0) {
    handleLine(s.slice(0, idx).replace(/\r$/, "").trim());
    s = s.slice(idx + 1);
  }
  buffer = s;
}

self.onmessage = function (e) {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === "init") {
    if (engine) { self.postMessage({ type: "ready" }); return; }
    self.Pikafish({
      locateFile: function (f) {
        if (f === "pikafish.data") return CDN + "data/pikafish.data";
        return CDN + f;
      },
      setStatus: function (s) { self.postMessage({ type: "status", status: s }); },
      print: function (t) { handleChunk(t + "\n"); },
      printErr: function (t) { /* 引擎错误流，忽略 */ },
      _dbg: function (t) { self.postMessage({ type: "dbg", line: t }); }
    }).then(function (inst) {
      engine = inst;
      engine.read_stdout = function (t) { handleLine(String(t).replace(/\r$/, "").trim()); };
      self.postMessage({ type: "ready" });
      engine.send_command("uci");
    }).catch(function (err) {
      self.postMessage({ type: "error", error: String(err) });
    });
  } else if (msg.type === "go") {
    if (!engine) return;
    currentId = msg.id || 0;
    let cmd = "position startpos";
    if (msg.moves && msg.moves.length) cmd += " moves " + msg.moves.join(" ");
    engine.send_command(cmd);
    engine.send_command("go movetime " + (msg.movetime || 1200));
  } else if (msg.type === "stop") {
    if (engine) engine.send_command("stop");
  } else if (msg.type === "quit") {
    if (engine) engine.send_command("quit");
  }
};
