/*
 * Sky Glider — online layer (main thread). OPT-IN and off by default.
 *
 * Performance contract: while disabled it does literally nothing (the game loop
 * skips it via MP.enabled === false). When enabled, ALL networking runs in a
 * Web Worker over a server-push stream (no polling, never on the render thread).
 * The render thread only nudges avatar transforms, and only when a peer exists —
 * when you're alone, sync() is a no-op over an empty set. Materials/avatars are
 * built lazily on the first peer, so being online-but-alone costs ~0.
 *
 * Dormant unless window.FIREBASE_CONFIG has apiKey + databaseURL.
 */
(function () {
  "use strict";

  const cfg = window.FIREBASE_CONFIG || {};
  const BASE = (cfg.databaseURL || "").replace(/\/+$/, "");
  const available = !!(cfg.apiKey && BASE);

  const MP = (window.MP = {
    available, enabled: false, ready: false, chatting: false, uid: null, name: null,
    players: {}, onChatToggle: null,
    attach, setName, connect, disconnect, toggle, update, sync, openChat, closeChat,
  });

  let worker = null, scene = null, B = {};
  const avatars = {};
  let lastPostX = 1e9, lastPostZ = 1e9;

  function uidGen() {
    try {
      let id = localStorage.getItem("sg_uid");
      if (!id) { id = "u" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); localStorage.setItem("sg_uid", id); }
      return id;
    } catch (e) { return "u" + Math.random().toString(36).slice(2, 12); }
  }
  function setName(name) { MP.name = (name || "").slice(0, 16) || ("Pilot-" + Math.floor(1000 + Math.random() * 9000)); }

  function toggle(on) { if (on) connect(); else disconnect(); return MP.enabled; }

  function connect() {
    if (!available || MP.enabled) return;
    if (!MP.name) setName("");
    MP.uid = uidGen();
    worker = new Worker("./mp-worker.js?v=mp4");
    worker.onmessage = (e) => { if (e.data && e.data.type === "players") MP.players = e.data.players || {}; };
    worker.postMessage({ type: "start", base: BASE, uid: MP.uid, name: MP.name });
    lastPostX = lastPostZ = 1e9;
    MP.enabled = true; MP.ready = true;
    window.addEventListener("pagehide", onLeave);
  }
  function disconnect() {
    if (!MP.enabled) return;
    try { worker.postMessage({ type: "stop" }); } catch (e) {}
    const w = worker; setTimeout(() => { try { w.terminate(); } catch (e) {} }, 80);
    worker = null;
    MP.enabled = false; MP.ready = false; MP.players = {};
    for (const k in avatars) { avatars[k].root.dispose(false, true); delete avatars[k]; }
    window.removeEventListener("pagehide", onLeave);
  }
  function onLeave() { try { worker && worker.postMessage({ type: "stop" }); } catch (e) {} }

  // Per frame while connected: post our state to the worker only when we've
  // actually moved (>2 m). The worker throttles the network write + heartbeats.
  function update(state) {
    if (!MP.ready || !worker) return;
    const dx = state.x - lastPostX, dz = state.z - lastPostZ;
    if (dx * dx + dz * dz > 4) {
      lastPostX = state.x; lastPostZ = state.z;
      worker.postMessage({ type: "state", s: { x: state.x, y: state.y, z: state.z, h: state.h, mode: state.mode, name: MP.name } });
    }
  }
  function doSendChat(text) { if (MP.ready && text && worker) worker.postMessage({ type: "chat", text: text }); }

  // ---- Remote avatars: rendered in the peer's CURRENT shape (human / car /
  // heli) using the game's own builders, tinted a distinct per-player colour so
  // players are easy to tell apart. Built lazily on the first peer.
  function attach(s, builders) { scene = s; B = builders || {}; }

  function hashColor(uid) {
    let h = 0;
    for (let i = 0; i < uid.length; i++) h = (h * 31 + uid.charCodeAt(i)) >>> 0;
    return hslToRgb((h % 360) / 360, 0.62, 0.56);   // deterministic → everyone sees the same colour for a player
  }
  function hslToRgb(h, s, l) {
    const k = (n) => (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)];
  }

  function makeAvatar(uid) {
    const root = new BABYLON.TransformNode("rp", scene);
    const namePlane = label(root, 256, 64, 3.4, 1.9);
    const bubblePlane = label(root, 512, 140, 6, 2.7);
    bubblePlane.setEnabled(false);
    return { root, body: null, shape: null, rotor: null, color: hashColor(uid),
      namePlane, nameTex: namePlane._tex, bubblePlane, bubbleTex: bubblePlane._tex, lastName: "", lastMsg: "" };
  }
  // (Re)build the body to match the peer's mode. Only rebuilds when the shape
  // category changes (human↔car↔heli), so it costs nothing frame-to-frame.
  function buildBody(a, mode) {
    const shape = mode === "drive" ? "car" : mode === "heli" ? "heli" : "human";
    if (a.shape === shape) return;
    if (a.body) { a.body.dispose(false, false); a.body = null; a.rotor = null; }
    a.shape = shape;
    if (shape === "human") {
      a.body = B.human ? B.human(a.color) : fallbackBody();
      a.body.parent = a.root; a.body.position.y = -0.95;   // feet, matching the local hero model
      a.namePlane.position.y = 1.7; a.bubblePlane.position.y = 2.5;
    } else {
      a.body = B.vehicle ? B.vehicle(shape, 0, 0, 0, a.color) : fallbackBody();
      a.body.position.set(0, 0, 0); a.body.rotation.y = 0; a.body.parent = a.root;
      if (a.body.metadata && a.body.metadata.rotor) a.rotor = a.body.metadata.rotor;
      a.namePlane.position.y = shape === "heli" ? 3.0 : 2.1;
      a.bubblePlane.position.y = shape === "heli" ? 3.8 : 2.9;
    }
  }
  function fallbackBody() {
    const n = new BABYLON.TransformNode("rp0", scene);
    const b = BABYLON.MeshBuilder.CreateCapsule("rb", { radius: 0.38, height: 1.7 }, scene);
    b.parent = n; b.position.y = 0.85; b.isPickable = false;
    return n;
  }
  function label(parent, tw, th, w, y) {
    const tex = new BABYLON.DynamicTexture("lt", { width: tw, height: th }, scene, true);
    tex.hasAlpha = true;
    const m = new BABYLON.StandardMaterial("lm", scene);
    m.diffuseTexture = tex; m.useAlphaFromDiffuseTexture = true; m.opacityTexture = tex;
    m.emissiveColor = new BABYLON.Color3(1, 1, 1); m.disableLighting = true; m.backFaceCulling = false;
    const plane = BABYLON.MeshBuilder.CreatePlane("lp", { width: w, height: w * th / tw }, scene);
    plane.material = m; plane.parent = parent; plane.position.y = y; plane.isPickable = false;
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    plane._tex = tex;
    return plane;
  }
  function rgbCss(c) { return "rgb(" + Math.round(c[0] * 255) + "," + Math.round(c[1] * 255) + "," + Math.round(c[2] * 255) + ")"; }
  function drawLabel(tex, text, accent, rgb) {
    const w = tex.getSize().width, h = tex.getSize().height, c = tex.getContext();
    c.clearRect(0, 0, w, h);
    c.fillStyle = accent ? "rgba(8,14,26,0.82)" : "rgba(8,14,26,0.62)";
    roundRect(c, 6, 6, w - 12, h - 12, 16); c.fill();
    c.strokeStyle = rgb ? rgbCss(rgb) : "rgba(90,209,255,0.7)"; c.lineWidth = 3; c.stroke();
    c.fillStyle = rgb ? rgbCss(rgb) : (accent ? "#eaf6ff" : "#bfe6ff");
    c.font = "bold " + Math.floor(h * 0.42) + "px system-ui, sans-serif";
    c.textAlign = "center"; c.textBaseline = "middle";
    c.fillText(clip(text, accent ? 30 : 18), w / 2, h / 2);
    tex.update();
  }
  function roundRect(c, x, y, w, h, r) {
    c.beginPath(); c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r); c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r); c.arcTo(x, y, x + w, y, r); c.closePath();
  }
  function clip(s, n) { return s.length > n ? s.slice(0, n - 1) + "…" : s; }

  function sync(dt, localPos) {
    if (!scene || !MP.enabled) return;
    const players = MP.players;
    for (const uid in avatars) if (!players[uid]) { avatars[uid].root.dispose(false, false); delete avatars[uid]; }
    for (const uid in players) {
      const d = players[uid];
      if (typeof d.x !== "number") continue;
      const a = avatars[uid] || (avatars[uid] = makeAvatar(uid));
      buildBody(a, d.mode);                                   // match their current shape
      const tgt = new BABYLON.Vector3(d.x, typeof d.y === "number" ? d.y : 1, d.z);
      a.root.position = BABYLON.Vector3.Lerp(a.root.position, tgt, Math.min(1, 6 * dt));
      a.root.rotation.y = d.h || 0;
      if (a.shape === "human" && a.body) a.body.rotation.x = d.mode === "fly" ? -1.0 : 0;
      if (a.rotor) a.rotor.rotation.y += dt * 30;             // spin remote heli rotor
      const dist = BABYLON.Vector3.Distance(a.root.position, localPos);
      a.root.setEnabled(dist < 600);
      const nm = d.name || "Player";
      if (nm !== a.lastName) { a.lastName = nm; drawLabel(a.nameTex, nm, false, a.color); }
      const fresh = d.msgAt && Date.now() - d.msgAt < 7000;
      if (fresh && d.msg) {
        if (d.msg !== a.lastMsg) { a.lastMsg = d.msg; drawLabel(a.bubbleTex, d.msg, true); }
        a.bubblePlane.setEnabled(dist < 180);
      } else { a.bubblePlane.setEnabled(false); a.lastMsg = ""; }
    }
  }

  // ---- Chat input --------------------------------------------------------
  function openChat() {
    if (!MP.enabled || MP.chatting) return;
    const el = document.getElementById("chat-input");
    if (!el) return;
    MP.chatting = true; el.value = ""; el.classList.remove("hidden"); el.focus();
    if (MP.onChatToggle) MP.onChatToggle(true);
  }
  function closeChat() {
    const el = document.getElementById("chat-input");
    MP.chatting = false;
    if (el) { el.classList.add("hidden"); el.blur(); }
    if (MP.onChatToggle) MP.onChatToggle(false);
  }
  document.addEventListener("DOMContentLoaded", () => {
    const el = document.getElementById("chat-input");
    if (!el) return;
    el.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.code === "Enter") { doSendChat(el.value.trim()); closeChat(); }
      else if (e.code === "Escape") { closeChat(); }
    });
  });
})();
