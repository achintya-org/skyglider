/*
 * Sky Glider — online multiplayer layer (proximity presence + quick chat).
 *
 * Fully dormant unless window.FIREBASE_CONFIG is filled in AND the Firebase
 * compat SDK loaded. Everything is guarded so single-player is never affected.
 *
 * Data model (Realtime Database):
 *   players/{uid} = { x, y, z, h, mode, name, msg, msgAt, t }
 *   - position/heading broadcast ~11Hz; onDisconnect removes the node
 *   - msg/msgAt carry the latest quick chat line (shown as a timed bubble)
 */
(function () {
  "use strict";

  const cfg = window.FIREBASE_CONFIG || {};
  const hasSDK = typeof window.firebase !== "undefined";
  const enabled = !!(cfg.apiKey && cfg.databaseURL && hasSDK);

  const MP = (window.MP = {
    enabled, ready: false, chatting: false, uid: null, name: null,
    players: {}, onChatToggle: null,
    attach, init, update, sync, openChat, closeChat,
  });

  let scene, skinMat, bodyMatBase;
  const avatars = {};            // uid -> avatar meshes
  let db = null, selfRef = null, lastWrite = 0;

  // ---- Firebase plumbing -------------------------------------------------
  function init(name) {
    MP.name = name || ("Pilot-" + Math.floor(1000 + Math.random() * 9000));
    if (!enabled) return;
    try {
      firebase.initializeApp(cfg);
      db = firebase.database();
      firebase.auth().signInAnonymously()
        .then((cred) => {
          MP.uid = cred.user.uid;
          selfRef = db.ref("players/" + MP.uid);
          selfRef.onDisconnect().remove();
          db.ref("players").on("value", (snap) => {
            const val = snap.val() || {};
            const out = {};
            for (const k in val) if (k !== MP.uid) out[k] = val[k];
            MP.players = out;
          });
          MP.ready = true;
        })
        .catch((e) => { console.warn("[MP] auth failed — staying single-player:", e.code || e.message); MP.enabled = false; });
    } catch (e) {
      console.warn("[MP] init failed — staying single-player:", e.message);
      MP.enabled = false;
    }
  }

  function update(state) {
    if (!MP.ready) return;
    const now = performance.now();
    if (now - lastWrite < 90) return;
    lastWrite = now;
    state.name = MP.name;
    state.t = firebase.database.ServerValue.TIMESTAMP;
    selfRef.update(state).catch(() => {});
  }

  function doSendChat(text) {
    if (!MP.ready || !text) return;
    selfRef.update({ msg: text.slice(0, 140), msgAt: Date.now() }).catch(() => {});
  }

  // ---- Remote avatars ----------------------------------------------------
  function attach(s) {
    scene = s;
    skinMat = new BABYLON.StandardMaterial("rSkin", scene);
    skinMat.diffuseColor = new BABYLON.Color3(0.86, 0.66, 0.52);
    bodyMatBase = new BABYLON.Color3(0.3, 0.6, 0.85);
  }

  function makeAvatar() {
    const root = new BABYLON.TransformNode("rp", scene);
    const mat = new BABYLON.StandardMaterial("rBody", scene);
    mat.diffuseColor = bodyMatBase.clone();
    const body = BABYLON.MeshBuilder.CreateCapsule("rb", { radius: 0.38, height: 1.7 }, scene);
    body.material = mat; body.parent = root; body.position.y = 0.9; body.isPickable = false;
    const head = BABYLON.MeshBuilder.CreateSphere("rh", { diameter: 0.34, segments: 6 }, scene);
    head.material = skinMat; head.parent = root; head.position.y = 1.78; head.isPickable = false;

    const namePlane = label(root, 256, 64, 3.4, 2.45);
    const bubblePlane = label(root, 512, 140, 6, 3.35);
    bubblePlane.setEnabled(false);
    return { root, body, namePlane, nameTex: namePlane._tex, bubblePlane, bubbleTex: bubblePlane._tex, lastName: "", lastMsg: "", pos: new BABYLON.Vector3() };
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
    const w = tex.getSize().width, h = tex.getSize().height;
    const c = tex.getContext();
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

  // Called each frame from the game with the local player's world position.
  function sync(dt, localPos) {
    if (!scene) return;
    for (const uid in avatars) {
      if (!MP.players[uid]) { avatars[uid].root.dispose(false, true); delete avatars[uid]; }
    }
    for (const uid in MP.players) {
      const d = MP.players[uid];
      if (typeof d.x !== "number") continue;
      let a = avatars[uid] || (avatars[uid] = makeAvatar());
      const tgt = new BABYLON.Vector3(d.x, typeof d.y === "number" ? d.y : 1, d.z);
      a.root.position = BABYLON.Vector3.Lerp(a.root.position, tgt, Math.min(1, 10 * dt));
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
    MP.chatting = true;
    el.value = "";
    el.classList.remove("hidden");
    el.focus();
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
