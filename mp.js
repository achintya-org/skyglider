/*
 * Sky Glider — online layer (proximity presence + quick chat).
 *
 * Zero bundle cost: NO Firebase SDK is loaded. We talk to the Realtime
 * Database over plain REST (fetch), and only when actually in the world with a
 * config present. Polling is adaptive — slow when you're alone, faster when
 * other players are nearby — so being online stays cheap and on-demand.
 *
 * Dormant unless window.FIREBASE_CONFIG has apiKey + databaseURL.
 */
(function () {
  "use strict";

  const cfg = window.FIREBASE_CONFIG || {};
  const BASE = (cfg.databaseURL || "").replace(/\/+$/, "");
  const enabled = !!(cfg.apiKey && BASE);

  const MP = (window.MP = {
    enabled, ready: false, chatting: false, uid: null, name: null,
    players: {}, onChatToggle: null,
    attach, init, update, sync, openChat, closeChat,
  });

  let scene, skinMat, bodyColor;
  const avatars = {};
  let self = null, lastWrite = 0, lastRead = 0, reading = false;

  function uidGen() {
    try {
      let id = localStorage.getItem("sg_uid");
      if (!id) { id = "u" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4); localStorage.setItem("sg_uid", id); }
      return id;
    } catch (e) { return "u" + Math.random().toString(36).slice(2, 12); }
  }

  function init(name) {
    MP.name = (name || "").slice(0, 16) || ("Pilot-" + Math.floor(1000 + Math.random() * 9000));
    if (!enabled) return;
    MP.uid = uidGen();
    self = { name: MP.name, t: Date.now() };
    MP.ready = true;
    const bye = () => { try { fetch(BASE + "/players/" + MP.uid + ".json", { method: "DELETE", keepalive: true }); } catch (e) {} };
    window.addEventListener("pagehide", bye);
    window.addEventListener("beforeunload", bye);
  }

  // Called by the game each frame; throttles REST writes/reads internally.
  function update(state) {
    if (!MP.ready) return;
    self.x = state.x; self.y = state.y; self.z = state.z; self.h = state.h; self.mode = state.mode;
    self.name = MP.name; self.t = Date.now();
    const now = performance.now();
    if (now - lastWrite > 1200) { lastWrite = now; writeSelf(); }
    const others = Object.keys(MP.players).length;
    if (now - lastRead > (others > 0 ? 1500 : 4000) && !reading) { lastRead = now; readPlayers(); }
  }

  function writeSelf() {
    fetch(BASE + "/players/" + MP.uid + ".json?print=silent", { method: "PUT", body: JSON.stringify(self) }).catch(() => {});
  }
  function readPlayers() {
    reading = true;
    fetch(BASE + "/players.json").then((r) => r.json()).then((val) => {
      const out = {}, now = Date.now();
      if (val) for (const k in val) {
        if (k === MP.uid) continue;
        const d = val[k];
        if (d && typeof d.x === "number" && (!d.t || now - d.t < 15000)) out[k] = d;
      }
      MP.players = out;
    }).catch(() => {}).finally(() => { reading = false; });
  }
  function doSendChat(text) {
    if (!MP.ready || !text) return;
    self.msg = text.slice(0, 140); self.msgAt = Date.now(); self.t = Date.now();
    writeSelf();
  }

  // ---- Remote avatars ----------------------------------------------------
  function attach(s) {
    scene = s;
    skinMat = new BABYLON.StandardMaterial("rSkin", scene);
    skinMat.diffuseColor = new BABYLON.Color3(0.86, 0.66, 0.52);
    bodyColor = new BABYLON.Color3(0.3, 0.6, 0.85);
  }

  function makeAvatar() {
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
    if (!scene) return;
    for (const uid in avatars) if (!MP.players[uid]) { avatars[uid].root.dispose(false, true); delete avatars[uid]; }
    for (const uid in MP.players) {
      const d = MP.players[uid];
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
