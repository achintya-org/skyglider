/*
 * Sky Glider — 3D winged-superhero flight.
 * Stack: Babylon.js 7 (rendering) + Havok (physics, AAA engine).
 *
 * Physics model: the hero is a real dynamic rigid body. Havok integrates
 * gravity, momentum and collisions; we steer by aiming a thrust vector and
 * clamping speed (drag). Pitch the nose up + thrust to climb, dive to gain
 * speed — full 6-axis control, "least falling" via a reduced gravity factor.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const canvas = $("renderCanvas");

  // ---- DOM refs -----------------------------------------------------------
  const ui = {
    hud: $("hud"), touch: $("touch"), loading: $("loading"), menu: $("menu"),
    gameover: $("gameover"), err: $("err"),
    speed: $("speed"), alt: $("alt"), score: $("score"), time: $("time"),
    boostFill: $("boost-fill"),
    menuBest: $("menu-best"), goBest: $("go-best"),
    finalScore: $("final-score"), finalTime: $("final-time"),
  };

  const BEST_KEY = "skyglider.best3d";
  let best = Number(localStorage.getItem(BEST_KEY) || 0);
  ui.menuBest.textContent = best;

  function fail(msg, e) {
    console.error("[SkyGlider]", msg, e || "");
    ui.loading.classList.add("hidden");
    ui.err.textContent = "⚠ " + msg;
    ui.err.classList.remove("hidden");
  }

  // ---- Tunables (SI-ish units) -------------------------------------------
  const GRAVITY = 9.81;
  const GRAVITY_FACTOR = 0.30;     // "least falling" superhero feel
  const THRUST_ACCEL = 26;         // m/s^2 forward (W)
  const BOOST_ACCEL = 52;          // m/s^2 with boost (Space)
  const VERT_ACCEL = 17;           // m/s^2 (Q/E)
  const DRAG = 0.55;               // passive air drag (per s)
  const BRAKE_DRAG = 3.2;          // extra drag while braking (S)
  const MAX_SPEED = 78;            // ~280 km/h
  const MAX_SPEED_BOOST = 120;     // ~430 km/h
  const MOUSE_SENS = 0.0022;
  const PITCH_LIMIT = 1.45;        // ~83°
  const ROLL_RATE = 2.2;           // rad/s from A/D
  const ROLL_LIMIT = 1.05;
  const BANK_TURN = 0.9;           // bank-to-turn coupling
  const CAM_DIST = 13, CAM_HEIGHT = 4.5, CAM_LERP = 0.10;
  const GROUND_Y = 0;
  const WORLD = 2400;              // half-extent of play area

  // ---- State machine ------------------------------------------------------
  const S = { LOADING: 0, MENU: 1, PLAYING: 2, DEAD: 3 };
  let state = S.LOADING;

  let engine, scene, heroMesh, heroBody, model, cam, glow, shadowGen;
  let towers = [], rings = [];
  let input = { thrust: 0, vert: 0, roll: 0, brake: false, boost: false };
  let yaw = 0, pitch = 0, roll = 0, boostE = 1, score = 0, startT = 0, animT = 0;
  let pointerLocked = false;

  // ========================================================================
  //  Boot
  // ========================================================================
  async function boot() {
    if (typeof BABYLON === "undefined")
      return fail("3D engine didn't load. Hard-refresh (Ctrl/Cmd+Shift+R) to clear an old cache.");
    if (typeof HavokPhysics === "undefined")
      return fail("Physics engine didn't load. Hard-refresh (Ctrl/Cmd+Shift+R) to clear an old cache.");
    if (!BABYLON.Engine.isSupported()) return fail("WebGL is not supported on this device/browser.");

    try {
      engine = new BABYLON.Engine(canvas, true, { stencil: true, preserveDrawingBuffer: false }, true);
    } catch (e) { return fail("Could not start the 3D engine.", e); }

    scene = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color3(0.53, 0.78, 0.92);
    scene.ambientColor = new BABYLON.Color3(0.6, 0.6, 0.6);

    // Physics (Havok) — race against a timeout so a stalled WASM fetch surfaces
    // an error instead of leaving the loading screen up forever.
    let havok;
    try {
      havok = await Promise.race([
        HavokPhysics(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 30000)),
      ]);
    } catch (e) { return fail("Physics engine failed to start. Check your connection and reload.", e); }
    const plugin = new BABYLON.HavokPlugin(true, havok);
    scene.enablePhysics(new BABYLON.Vector3(0, -GRAVITY, 0), plugin);

    buildEnvironment();
    buildHero();
    buildCamera();
    buildWorld();
    setupInput();

    engine.runRenderLoop(() => {
      const dt = Math.min(engine.getDeltaTime() / 1000, 0.05);
      step(dt);
      scene.render();
    });
    window.addEventListener("resize", () => engine.resize());

    // Ready
    state = S.MENU;
    ui.loading.classList.add("hidden");
    ui.menu.classList.remove("hidden");
    if (isTouch()) ui.touch.classList.remove("hidden");
  }

  // ========================================================================
  //  Environment: sky, light, fog, ground
  // ========================================================================
  function buildEnvironment() {
    glow = new BABYLON.GlowLayer("glow", scene);
    glow.intensity = 0.9;

    const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0.2, 1, 0.1), scene);
    hemi.intensity = 0.85;
    hemi.groundColor = new BABYLON.Color3(0.35, 0.45, 0.4);

    const sun = new BABYLON.DirectionalLight("sun", new BABYLON.Vector3(-0.6, -1, -0.4), scene);
    sun.position = new BABYLON.Vector3(400, 700, 300);
    sun.intensity = 1.6;
    shadowGen = new BABYLON.ShadowGenerator(1024, sun);
    shadowGen.useBlurExponentialShadowMap = true;
    shadowGen.blurKernel = 16;

    // Depth fog
    scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
    scene.fogColor = new BABYLON.Color3(0.7, 0.83, 0.92);
    scene.fogDensity = 0.0016;

    // Gradient skydome (self-contained via dynamic texture)
    const sky = BABYLON.MeshBuilder.CreateSphere("sky", { diameter: 6000, sideOrientation: BABYLON.Mesh.BACKSIDE }, scene);
    const tex = new BABYLON.DynamicTexture("skyTex", { width: 16, height: 512 }, scene, false);
    const ctx = tex.getContext();
    const grd = ctx.createLinearGradient(0, 0, 0, 512);
    grd.addColorStop(0.0, "#1f6fd0");
    grd.addColorStop(0.45, "#5aa6e6");
    grd.addColorStop(0.75, "#a9d6f2");
    grd.addColorStop(1.0, "#e8f5fb");
    ctx.fillStyle = grd; ctx.fillRect(0, 0, 16, 512);
    tex.update();
    const skyMat = new BABYLON.StandardMaterial("skyMat", scene);
    skyMat.emissiveTexture = tex;
    skyMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
    skyMat.specularColor = new BABYLON.Color3(0, 0, 0);
    skyMat.backFaceCulling = false;
    skyMat.disableLighting = true;
    sky.material = skyMat;
    sky.infiniteDistance = true;
    sky.applyFog = false;

    // Ground
    const ground = BABYLON.MeshBuilder.CreateGround("ground", { width: 6000, height: 6000, subdivisions: 1 }, scene);
    const gMat = new BABYLON.StandardMaterial("gMat", scene);
    const gTex = new BABYLON.DynamicTexture("gTex", { width: 512, height: 512 }, scene, true);
    const gx = gTex.getContext();
    gx.fillStyle = "#3f7d44"; gx.fillRect(0, 0, 512, 512);
    gx.strokeStyle = "rgba(255,255,255,0.10)"; gx.lineWidth = 2;
    for (let i = 0; i <= 512; i += 32) { gx.beginPath(); gx.moveTo(i, 0); gx.lineTo(i, 512); gx.moveTo(0, i); gx.lineTo(512, i); gx.stroke(); }
    gTex.update();
    gTex.uScale = gTex.vScale = 120;
    gMat.diffuseTexture = gTex;
    gMat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
    ground.material = gMat;
    ground.receiveShadows = true;
    new BABYLON.PhysicsAggregate(ground, BABYLON.PhysicsShapeType.MESH, { mass: 0, friction: 0.6 }, scene);
  }

  // ========================================================================
  //  The winged human
  // ========================================================================
  function buildHero() {
    // Physics body: an upright capsule (we keep it from tumbling and steer the
    // visual model instead). Real gravity + momentum + collisions apply.
    heroMesh = BABYLON.MeshBuilder.CreateCapsule("hero", { radius: 0.5, height: 2 }, scene);
    heroMesh.isVisible = false;
    heroMesh.position = new BABYLON.Vector3(0, 95, -40);

    const agg = new BABYLON.PhysicsAggregate(heroMesh, BABYLON.PhysicsShapeType.CAPSULE,
      { mass: 80, restitution: 0.05, friction: 0.2 }, scene);
    heroBody = agg.body;
    heroBody.setLinearDamping(0.0);            // we manage drag ourselves
    heroBody.setAngularDamping(100);
    heroBody.setMassProperties({ inertia: BABYLON.Vector3.Zero() }); // never spin
    heroBody.setGravityFactor(GRAVITY_FACTOR);
    heroBody.setLinearVelocity(new BABYLON.Vector3(0, 0, 28));

    // Visual model, built facing +Z (forward), superman pose.
    model = new BABYLON.TransformNode("model", scene);
    model.rotationQuaternion = BABYLON.Quaternion.Identity();
    model.parent = heroMesh;
    model.position = BABYLON.Vector3.Zero();

    const suit = mat("suit", new BABYLON.Color3(0.13, 0.32, 0.78));
    const accent = mat("accent", new BABYLON.Color3(0.85, 0.13, 0.20));
    const skin = mat("skin", new BABYLON.Color3(0.95, 0.76, 0.62));
    const wingMat = mat("wing", new BABYLON.Color3(0.92, 0.94, 0.98));
    wingMat.emissiveColor = new BABYLON.Color3(0.25, 0.3, 0.4);
    const capeMat = mat("cape", new BABYLON.Color3(0.78, 0.10, 0.16));
    capeMat.backFaceCulling = false;

    const part = (m, name, opt, mtl, pos, rot) => {
      const x = BABYLON.MeshBuilder["Create" + m](name, opt, scene);
      x.material = mtl; x.parent = model;
      if (pos) x.position.copyFrom(pos);
      if (rot) x.rotation.copyFrom(rot);
      shadowGen.addShadowCaster(x);
      return x;
    };
    const V = (x, y, z) => new BABYLON.Vector3(x, y, z);

    part("Box", "torso", { width: 0.62, height: 0.5, depth: 1.25 }, suit, V(0, 0, 0));
    part("Box", "chest", { width: 0.5, height: 0.42, depth: 0.4 }, accent, V(0, 0.06, 0.45));
    part("Sphere", "head", { diameter: 0.5 }, skin, V(0, 0.12, 0.92));
    part("Sphere", "hair", { diameter: 0.54, slice: 0.55 }, accent, V(0, 0.2, 0.9));
    // arms forward (superman)
    part("Capsule", "armL", { radius: 0.12, height: 0.95 }, suit, V(0.34, 0.05, 0.7), V(Math.PI / 2.1, 0, 0));
    part("Capsule", "armR", { radius: 0.12, height: 0.95 }, suit, V(-0.34, 0.05, 0.7), V(Math.PI / 2.1, 0, 0));
    part("Sphere", "fistL", { diameter: 0.2 }, skin, V(0.34, 0.12, 1.15));
    part("Sphere", "fistR", { diameter: 0.2 }, skin, V(-0.34, 0.12, 1.15));
    // legs back
    part("Capsule", "legL", { radius: 0.15, height: 1.1 }, suit, V(0.18, -0.02, -0.85), V(Math.PI / 2, 0, 0));
    part("Capsule", "legR", { radius: 0.15, height: 1.1 }, suit, V(-0.18, -0.02, -0.85), V(Math.PI / 2, 0, 0));
    part("Box", "bootL", { width: 0.2, height: 0.18, depth: 0.34 }, accent, V(0.18, -0.04, -1.45));
    part("Box", "bootR", { width: 0.2, height: 0.18, depth: 0.34 }, accent, V(-0.18, -0.04, -1.45));

    // wings (animated)
    const wingL = part("Box", "wingL", { width: 1.5, height: 0.04, depth: 0.8 }, wingMat, V(0.85, 0.18, -0.1));
    const wingR = part("Box", "wingR", { width: 1.5, height: 0.04, depth: 0.8 }, wingMat, V(-0.85, 0.18, -0.1));
    wingL.setPivotPoint(V(-0.75, 0, 0)); wingR.setPivotPoint(V(0.75, 0, 0));

    // cape (animated flutter)
    const cape = part("Plane", "cape", { width: 0.9, height: 1.4 }, capeMat, V(0, 0.18, -0.35));
    cape.rotation = V(0.5, 0, 0);

    model._anim = { wingL, wingR, cape };
  }

  function mat(name, color) {
    const m = new BABYLON.StandardMaterial(name, scene);
    m.diffuseColor = color;
    m.specularColor = new BABYLON.Color3(0.15, 0.15, 0.15);
    return m;
  }

  // ========================================================================
  //  Camera (manual chase cam)
  // ========================================================================
  function buildCamera() {
    cam = new BABYLON.UniversalCamera("cam", new BABYLON.Vector3(0, 99.5, -53), scene);
    cam.fov = 1.1;
    cam.minZ = 0.2;
    cam.maxZ = 7000;
    scene.activeCamera = cam;
  }

  // ========================================================================
  //  World: rings to fly through, towers to dodge
  // ========================================================================
  function buildWorld() {
    const ringMat = new BABYLON.StandardMaterial("ringMat", scene);
    ringMat.emissiveColor = new BABYLON.Color3(0.95, 0.7, 0.1);
    ringMat.diffuseColor = new BABYLON.Color3(0.6, 0.4, 0.05);

    for (let i = 0; i < 8; i++) {
      const t = BABYLON.MeshBuilder.CreateTorus("ring" + i, { diameter: 11, thickness: 1.1, tessellation: 28 }, scene);
      t.material = ringMat;
      t.metadata = { radius: 5.5, normal: new BABYLON.Vector3(0, 0, 1), scored: false };
      placeRing(t, true);
      rings.push(t);
    }

    const towerMat = new BABYLON.StandardMaterial("towerMat", scene);
    towerMat.diffuseColor = new BABYLON.Color3(0.45, 0.47, 0.52);
    towerMat.specularColor = new BABYLON.Color3(0.1, 0.1, 0.1);
    for (let i = 0; i < 46; i++) {
      const r = 5 + Math.random() * 9;
      const h = 60 + Math.random() * 220;
      const x = rand(WORLD), z = rand(WORLD);
      const tw = BABYLON.MeshBuilder.CreateCylinder("tower" + i, { diameter: r * 2, height: h, tessellation: 10 }, scene);
      tw.position.set(x, h / 2, z);
      tw.material = towerMat;
      tw.receiveShadows = true;
      shadowGen.addShadowCaster(tw);
      new BABYLON.PhysicsAggregate(tw, BABYLON.PhysicsShapeType.CYLINDER, { mass: 0, friction: 0.4 }, scene);
      towers.push({ x, z, r, h });
    }
  }

  function placeRing(t, initial) {
    const x = rand(WORLD), z = rand(WORLD);
    const y = 35 + Math.random() * 180;
    t.position.set(x, y, z);
    const a = Math.random() * Math.PI * 2;
    t.metadata.normal = new BABYLON.Vector3(Math.sin(a), 0, Math.cos(a)).normalize();
    t.rotation.set(Math.PI / 2, a, 0); // torus axis faces the normal
    t.metadata.scored = false;
    if (initial) { // keep first rings near the start, ahead of the player
      t.position.x = rand(300);
      t.position.z = 40 + Math.random() * 600;
      t.position.y = 80 + rand(40);
    }
  }

  // ========================================================================
  //  Input
  // ========================================================================
  function setupInput() {
    const keys = {};
    const onKey = (e, down) => {
      const k = e.code;
      keys[k] = down;
      if (down && (k === "KeyR") && state === S.DEAD) restart();
      if (down && k === "Space") e.preventDefault();
    };
    window.addEventListener("keydown", (e) => onKey(e, true));
    window.addEventListener("keyup", (e) => onKey(e, false));

    // Pointer lock + mouse look
    canvas.addEventListener("click", () => {
      if (state === S.MENU) return start();
      if (state === S.DEAD) return restart();
      if (state === S.PLAYING && !pointerLocked && !isTouch()) canvas.requestPointerLock();
    });
    document.addEventListener("pointerlockchange", () => {
      pointerLocked = document.pointerLockElement === canvas;
    });
    window.addEventListener("mousemove", (e) => {
      if (state !== S.PLAYING || !pointerLocked) return;
      yaw += e.movementX * MOUSE_SENS;
      pitch -= e.movementY * MOUSE_SENS;
      pitch = clamp(pitch, -PITCH_LIMIT, PITCH_LIMIT);
    });

    $("play-btn").addEventListener("click", (e) => { e.stopPropagation(); start(); });
    $("restart-btn").addEventListener("click", (e) => { e.stopPropagation(); restart(); });

    // Per-frame keyboard sampling
    scene.onBeforeRenderObservable.add(() => {
      if (state !== S.PLAYING) { input.thrust = input.vert = input.roll = 0; input.brake = input.boost = false; return; }
      input.thrust = (keys["KeyW"] ? 1 : 0) - (keys["KeyS"] ? 0 : 0);
      input.brake = !!keys["KeyS"];
      input.boost = !!keys["Space"];
      input.vert = (keys["KeyQ"] ? 1 : 0) - (keys["KeyE"] ? 1 : 0);
      input.roll = (keys["KeyD"] ? 1 : 0) - (keys["KeyA"] ? 1 : 0);
      if (!keys["KeyW"]) input.thrust = 0;
    });

    setupTouch();
  }

  function setupTouch() {
    if (!isTouch()) return;
    const zone = $("stick-zone"), knob = $("stick-knob");
    let id = null, ox = 0, oy = 0;
    const cancel = () => { id = null; knob.style.transform = "translate(-50%,-50%)"; tYaw = tPitch = 0; };
    zone.addEventListener("pointerdown", (e) => { id = e.pointerId; ox = e.clientX; oy = e.clientY; });
    zone.addEventListener("pointermove", (e) => {
      if (e.pointerId !== id) return;
      let dx = clamp(e.clientX - ox, -60, 60), dy = clamp(e.clientY - oy, -60, 60);
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      tYaw = dx / 60; tPitch = -dy / 60;
    });
    zone.addEventListener("pointerup", cancel);
    zone.addEventListener("pointercancel", cancel);

    const hold = (el, on) => {
      el.addEventListener("pointerdown", (e) => { e.preventDefault(); on(true); });
      el.addEventListener("pointerup", () => on(false));
      el.addEventListener("pointercancel", () => on(false));
      el.addEventListener("pointerleave", () => on(false));
    };
    hold($("btn-boost"), (v) => tBoost = v);
    hold($("btn-up"), (v) => tUp = v);
    hold($("btn-down"), (v) => tDown = v);
  }
  let tYaw = 0, tPitch = 0, tBoost = false, tUp = false, tDown = false;

  // ========================================================================
  //  Per-frame update
  // ========================================================================
  function step(dt) {
    if (!heroBody) return;
    animT += dt;
    animateModel();

    if (state !== S.PLAYING) { updateCamera(0.04); return; }

    // Touch steering feeds yaw/pitch
    if (isTouch()) {
      yaw += tYaw * 1.6 * dt;
      pitch = clamp(pitch + tPitch * 1.6 * dt, -PITCH_LIMIT, PITCH_LIMIT);
      input.thrust = 1; // auto-forward on touch; boost button for more
      input.boost = tBoost;
      input.vert = (tUp ? 1 : 0) - (tDown ? 1 : 0);
    }

    // Roll (A/D), with bank-to-turn and auto-level
    roll = clamp(roll + input.roll * ROLL_RATE * dt, -ROLL_LIMIT, ROLL_LIMIT);
    if (input.roll === 0) roll = approach(roll, 0, 1.6 * dt);
    yaw += -roll * BANK_TURN * dt;

    // Orientation from yaw/pitch/roll. We then read the model's ACTUAL facing
    // so thrust and the chase camera stay perfectly consistent with the visuals.
    const targetQ = BABYLON.Quaternion.RotationYawPitchRoll(yaw, -pitch, -roll);
    model.rotationQuaternion = BABYLON.Quaternion.Slerp(model.rotationQuaternion, targetQ, Math.min(1, 12 * dt));
    const forward = model.getDirection(BABYLON.Axis.Z).normalize();
    const worldUp = BABYLON.Vector3.Up();

    // ---- Velocity integration (thrust + drag), Havok adds gravity ----------
    let v = heroBody.getLinearVelocity();
    const accel = input.boost && boostE > 0 ? BOOST_ACCEL : THRUST_ACCEL;
    if (input.thrust > 0) v = v.add(forward.scale(accel * dt));
    if (input.vert !== 0) v = v.add(worldUp.scale(input.vert * VERT_ACCEL * dt));

    const drag = DRAG + (input.brake ? BRAKE_DRAG : 0);
    v = v.scale(Math.max(0, 1 - drag * dt));

    const cap = input.boost && boostE > 0 ? MAX_SPEED_BOOST : MAX_SPEED;
    if (v.length() > cap) v = v.normalize().scale(cap);
    heroBody.setLinearVelocity(v);

    // Boost energy
    if (input.boost && boostE > 0) boostE = Math.max(0, boostE - dt / 2.5);
    else boostE = Math.min(1, boostE + dt / 4);

    updateCamera(CAM_LERP);
    checkRings();
    checkCrash(v);
    updateHUD(v);
  }

  function animateModel() {
    if (!model || !model._anim) return;
    const flap = Math.sin(animT * 6) * 0.35;
    model._anim.wingL.rotation.z = -0.15 + flap;
    model._anim.wingR.rotation.z = 0.15 - flap;
    model._anim.cape.rotation.x = 0.5 + Math.sin(animT * 5) * 0.12;
    model._anim.cape.rotation.z = Math.sin(animT * 3) * 0.08;
  }

  function updateCamera(lerp) {
    const fwd = model.getDirection(BABYLON.Axis.Z).normalize();
    const heroPos = heroMesh.getAbsolutePosition();
    const desired = heroPos.subtract(fwd.scale(CAM_DIST)).add(BABYLON.Vector3.Up().scale(CAM_HEIGHT));
    cam.position = BABYLON.Vector3.Lerp(cam.position, desired, lerp);
    cam.setTarget(heroPos.add(fwd.scale(7)).add(BABYLON.Vector3.Up().scale(0.5)));
  }

  function checkRings() {
    const p = heroMesh.position;
    for (const t of rings) {
      if (t.metadata.scored) continue;
      const to = p.subtract(t.position);
      const along = BABYLON.Vector3.Dot(to, t.metadata.normal);
      const inPlane = to.subtract(t.metadata.normal.scale(along)).length();
      if (Math.abs(along) < 4 && inPlane < t.metadata.radius) {
        t.metadata.scored = true;
        score++;
        flashRing(t);
        setTimeout(() => placeRing(t, false), 120);
      }
    }
  }

  function flashRing(t) {
    const m = t.material.clone("flash");
    m.emissiveColor = new BABYLON.Color3(0.2, 1, 0.5);
    t.material = m;
    setTimeout(() => { t.material = scene.getMaterialByName("ringMat"); }, 200);
  }

  function checkCrash(v) {
    const p = heroMesh.position;
    if (p.y <= GROUND_Y + 1.3) return crash();
    for (const tw of towers) {
      const dx = p.x - tw.x, dz = p.z - tw.z;
      if (dx * dx + dz * dz < (tw.r + 0.7) * (tw.r + 0.7) && p.y < tw.h + 0.5) return crash();
    }
  }

  // ========================================================================
  //  HUD + state transitions
  // ========================================================================
  function updateHUD(v) {
    ui.speed.textContent = Math.round(v.length() * 3.6);
    ui.alt.textContent = Math.max(0, Math.round(heroMesh.position.y));
    ui.score.textContent = score;
    ui.time.textContent = ((performance.now() - startT) / 1000).toFixed(1);
    ui.boostFill.style.width = (boostE * 100).toFixed(0) + "%";
  }

  function start() {
    resetHero();
    state = S.PLAYING;
    startT = performance.now();
    ui.menu.classList.add("hidden");
    ui.gameover.classList.add("hidden");
    ui.hud.classList.remove("hidden");
    if (!isTouch()) canvas.requestPointerLock();
  }

  function restart() { start(); }

  function resetHero() {
    yaw = 0; pitch = 0; roll = 0; boostE = 1; score = 0;
    heroMesh.position.set(0, 95, -40);
    model.rotationQuaternion = BABYLON.Quaternion.Identity();
    heroBody.setLinearVelocity(new BABYLON.Vector3(0, 0, 28));
    heroBody.setAngularVelocity(BABYLON.Vector3.Zero());
    cam.position = new BABYLON.Vector3(0, 99.5, -53);
    rings.forEach((t, i) => placeRing(t, i < 4));
  }

  function crash() {
    if (state !== S.PLAYING) return;
    state = S.DEAD;
    if (document.pointerLockElement) document.exitPointerLock();
    if (score > best) { best = score; localStorage.setItem(BEST_KEY, String(best)); }
    ui.finalScore.textContent = score;
    ui.finalTime.textContent = ((performance.now() - startT) / 1000).toFixed(1);
    ui.goBest.textContent = best;
    ui.menuBest.textContent = best;
    ui.hud.classList.add("hidden");
    ui.gameover.classList.remove("hidden");
  }

  // ---- helpers ------------------------------------------------------------
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function approach(v, target, step) { return v > target ? Math.max(target, v - step) : Math.min(target, v + step); }
  function rand(half) { return (Math.random() * 2 - 1) * half; }
  function isTouch() { return ("ontouchstart" in window) || navigator.maxTouchPoints > 0; }
  function rotateBy(vec, q) { const r = BABYLON.Vector3.Zero(); vec.rotateByQuaternionToRef(q, r); return r; }

  // ---- PWA service worker -------------------------------------------------
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }

  // Go
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
