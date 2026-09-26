"use strict";
/*
 * 皮卡鱼（Pikafish）WASM 引擎 Worker
 * UCI 协议：position / go / bestmove
 */
importScripts("pikafish.js");

let engine = null;
let buffer = "";

function handleChunk(chunk) {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).replace(/\r$/, "").trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    if (line.indexOf("bestmove") === 0) {
      const parts = line.split(/\s+/);
      if (parts.length >= 2 && parts[1] !== "(none)") {
        self.postMessage({ type: "move", uci: parts[1], ponder: parts.length >= 4 ? parts[3] : null });
      }
    }
  }
}

self.onmessage = function (e) {
  const msg = e.data;
  if (!msg) return;
  if (msg.type === "init") {
    if (engine) { self.postMessage({ type: "ready" }); return; }
    self.Pikafish({
      locateFile: function (f) {
        if (f === "pikafish.data") return "data/pikafish.data";
        return f;
      },
      setStatus: function (s) { self.postMessage({ type: "status", status: s }); },
      print: function (t) { handleChunk(t + "\n"); },
      printErr: function (t) { /* 引擎错误流，忽略 */ }
    }).then(function (inst) {
      engine = inst;
      engine.read_stdout = function (t) { handleChunk(t); };
      self.postMessage({ type: "ready" });
      engine.send_command("uci");
    }).catch(function (err) {
      self.postMessage({ type: "error", error: String(err) });
    });
  } else if (msg.type === "go") {
    if (!engine) return;
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
