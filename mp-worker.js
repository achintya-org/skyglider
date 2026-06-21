/*
 * Sky Glider — multiplayer worker. ALL networking happens here, off the render
 * thread. Uses the Realtime Database REST *streaming* endpoint (Server-Sent
 * Events): the server pushes changes to us — we never poll. Writes are
 * throttled and driven by the player actually moving (plus a slow presence
 * heartbeat). Started only when the player opts in; terminated when they opt out.
 */
"use strict";

let base = "", uid = "", name = "";
let selfState = {};
let peers = {};
let reader = null, alive = false;
let lastWrite = 0, writeTimer = null;

onmessage = (e) => {
  const m = e.data || {};
  if (m.type === "start") {
    base = m.base; uid = m.uid; name = m.name; alive = true;
    startStream();
    heartbeat();
  } else if (m.type === "state") {
    selfState = m.s;
    writeSelf();
  } else if (m.type === "chat") {
    selfState.msg = (m.text || "").slice(0, 140); selfState.msgAt = Date.now();
    writeSelf();
  } else if (m.type === "stop") {
    stop();
  }
};

// ---- Presence writes (throttled, trailing) -----------------------------
function writeSelf() {
  if (!alive) return;
  const now = Date.now();
  if (now - lastWrite < 600) { schedule(); return; }
  lastWrite = now;
  selfState.name = name; selfState.t = now;
  fetch(base + "/players/" + uid + ".json?print=silent", { method: "PUT", body: JSON.stringify(selfState) }).catch(() => {});
}
function schedule() { if (!writeTimer) writeTimer = setTimeout(() => { writeTimer = null; writeSelf(); }, 650); }
function heartbeat() {
  if (!alive) return;
  if (selfState && typeof selfState.x === "number") writeSelf();
  setTimeout(heartbeat, 12000);   // refresh presence so we don't go stale when idle
}

// ---- Server-push stream (SSE), no polling ------------------------------
async function startStream() {
  try {
    const res = await fetch(base + "/players.json", { headers: { Accept: "text/event-stream" } });
    reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (alive) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let i;
      while ((i = buf.indexOf("\n\n")) >= 0) { handleEvent(buf.slice(0, i)); buf = buf.slice(i + 2); }
    }
  } catch (e) { /* connection dropped */ }
  if (alive) setTimeout(startStream, 3000);   // reconnect (still push, not polling)
}

function handleEvent(chunk) {
  let ev = null, data = null;
  for (const line of chunk.split("\n")) {
    if (line.indexOf("event:") === 0) ev = line.slice(6).trim();
    else if (line.indexOf("data:") === 0) data = line.slice(5).trim();
  }
  if ((ev !== "put" && ev !== "patch") || !data) return;
  let json; try { json = JSON.parse(data); } catch (e) { return; }
  const path = json.path || "/";
  if (ev === "put") {
    if (path === "/") peers = json.data || {};
    else { const id = path.slice(1); if (json.data === null) delete peers[id]; else peers[id] = json.data; }
  } else { // patch
    const id = path.slice(1); peers[id] = Object.assign(peers[id] || {}, json.data || {});
  }
  emit();
}

function emit() {
  const now = Date.now(), out = {};
  for (const k in peers) {
    if (k === uid) continue;
    const d = peers[k];
    if (d && typeof d.x === "number" && (!d.t || now - d.t < 20000)) out[k] = d;
  }
  postMessage({ type: "players", players: out });
}

function stop() {
  alive = false;
  try { if (reader) reader.cancel(); } catch (e) {}
  try { fetch(base + "/players/" + uid + ".json", { method: "DELETE", keepalive: true }); } catch (e) {}
}
