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

  let worker = null, scene = null, skinMat = null, bodyColor = null;
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
    worker = new Worker("./mp-worker.js?v=mp3");
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

  // ---- Remote avatars (built lazily on first peer) -----------------------
  function attach(s) { scene = s; }   // store scene only; no allocations yet
  function ensureMats() {
    if (skinMat) return;
    skinMat = new BABYLON.StandardMaterial("rSkin", scene);
    skinMat.diffuseColor = new BABYLON.Color3(0.86, 0.66, 0.52);
    bodyColor = new BABYLON.Color3(0.3, 0.6, 0.85);
  }
  function makeAvatar() {
    ensureMats();
    const root = new BABYLON.TransformNode("rp", scene);
    const mat = new BABYLON.StandardMaterial("rBody", scene);
    mat.diffuseColor = bodyColor.clone();
    const body = BABYLON.MeshBuilder.CreateCapsule("rb", { radius: 0.38, height: 1.7 }, scene);
    body.material = mat; body.parent = root; body.position.y = 0.9; body.isPickable = false;
    const head = BABYLON.MeshBuilder.CreateSphere("rh", { diameter: 0.34, segments: 6 }, scene);
    head.material = skinMat; head.parent = root; head.position.y = 1.78; head.isPickable = false;
    const namePlane = label(root, 256, 64, 3.4, 2.45);
    const bubblePlane = label(root, 512, 140, 6, 3.35);
    bubblePlane.setEnabled(false);
    return { root, namePlane, nameTex: namePlane._tex, bubblePlane, bubbleTex: bubblePlane._tex, lastName: "", lastMsg: "" };
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
  function drawLabel(tex, text, accent) {
    const w = tex.getSize().width, h = tex.getSize().height, c = tex.getContext();
    c.clearRect(0, 0, w, h);
    c.fillStyle = accent ? "rgba(8,14,26,0.82)" : "rgba(8,14,26,0.6)";
    roundRect(c, 6, 6, w - 12, h - 12, 16); c.fill();
    if (accent) { c.strokeStyle = "rgba(90,209,255,0.7)"; c.lineWidth = 3; c.stroke(); }
    c.fillStyle = accent ? "#eaf6ff" : "#bfe6ff";
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
    for (const uid in avatars) if (!players[uid]) { avatars[uid].root.dispose(false, true); delete avatars[uid]; }
    for (const uid in players) {
      const d = players[uid];
      if (typeof d.x !== "number") continue;
      const a = avatars[uid] || (avatars[uid] = makeAvatar());
      const tgt = new BABYLON.Vector3(d.x, typeof d.y === "number" ? d.y : 1, d.z);
      a.root.position = BABYLON.Vector3.Lerp(a.root.position, tgt, Math.min(1, 4 * dt));
      a.root.rotation.y = d.h || 0;
      const dist = BABYLON.Vector3.Distance(a.root.position, localPos);
      a.root.setEnabled(dist < 500);
      const emoji = d.mode === "drive" ? " 🚗" : d.mode === "heli" ? " 🚁" : d.mode === "fly" ? " 🪂" : "";
      const nm = (d.name || "Player") + emoji;
      if (nm !== a.lastName) { a.lastName = nm; drawLabel(a.nameTex, nm, false); }
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
