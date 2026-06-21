/*
 * Sky Glider — open-world free roam. Walk the streets or fly anywhere.
 * Stack: Babylon.js 7 (rendering) + Havok (physics).
 *
 * Two movement modes share one rigid body and one GTA-style third-person
 * orbit camera:
 *   WALK — full gravity, camera-relative running, jump.
 *   FLY  — weightless 6-axis flight, thrust where you look, boost.
 * Press F to switch. No score, no fail state — just roam.
 */
(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const canvas = $("renderCanvas");

  const ui = {
    hud: $("hud"), touch: $("touch"), loading: $("loading"), menu: $("menu"),
    pause: $("pause"), err: $("err"),
    speed: $("speed"), alt: $("alt"), mode: $("mode"), area: $("area"), boostFill: $("boost-fill"),
    prompt: $("prompt"), zooGuide: $("zoo-guide"), zooArrow: $("zoo-arrow"), zooDist: $("zoo-dist"),
  };

  function fail(msg, e) {
    console.error("[SkyGlider]", msg, e || "");
    ui.loading.classList.add("hidden");
    ui.err.textContent = "⚠ " + msg;
    ui.err.classList.remove("hidden");
  }

  // ---- Tunables -----------------------------------------------------------
  const GRAVITY = 9.81;
  const WALK_SPEED = 5.2, RUN_SPEED = 10, JUMP_V = 7.6, WALK_ACCEL = 18;
  // Arcade car driving
  const CAR_ACCEL = 18, CAR_MAX = 30, CAR_REVERSE = 11, CAR_FRICTION = 0.9, CAR_STEER = 2.3, CAR_R = 1.7, ENTER_DIST = 6;
  const HELI_ACCEL = 15, HELI_UP = 11, HELI_DRAG = 1.0, HELI_MAX = 34, HELI_YAW = 1.7;
  // Flight is heading-based: arrows/WASD steer a heading, the glider cruises
  // along it with momentum. Hold Up to keep pitching up and climb, etc.
  const FLY_CRUISE = 22, FLY_MAX_BOOST = 62, FLY_RESPONSE = 3.2, STEER_RATE = 2.1;
  const MOUSE_SENS = 0.0024;
  // Heavy weapon — the player shoulders a sophisticated rocket launcher and can
  // blow anyone away. Rockets fly out and detonate with an area blast.
  const GUN_RANGE = 700, FIRE_CD = 0.7, GUN_AIM = -1.42;   // metres, seconds between launches, shoulder pose
  const ROCKET_SPEED = 95, BLAST_R = 16;                   // metres/sec, explosion kill radius
  const MELEE_RANGE = 3.2, MELEE_CD = 0.45, MELEE_SWING = 0.26;   // punch reach, cooldown, swing time (s)
  // The Zoo — every creature (ghosts, giants, rhinos, dinos) lives penned in one
  // enclosure far from spawn. The whole creature system is dormant (zero cost)
  // until the player travels there; the rest of the world stays empty & light.
  const ZOO_X = 780, ZOO_Z = 140, ZOO_R = 62;              // enclosure centre + roam radius (metres)
  const ZOO_NEAR = 250, ZOO_FAR = 320;                     // load creatures within NEAR, unload past FAR
  const CAM_PITCH_MIN = -0.45, CAM_PITCH_MAX = 1.15;
  const CAM_DIST_WALK = 6.5, CAM_DIST_FLY = 11, CAM_LERP = 9; // exponential rate (frame-rate independent)

  // ---- State --------------------------------------------------------------
  const S = { LOADING: 0, MENU: 1, PLAYING: 2, PAUSED: 3 };
  let state = S.LOADING;
  const MODE = { WALK: "walk", FLY: "fly", DRIVE: "drive", HELI: "heli" };
  let mode = MODE.WALK;

  let engine, scene, heroMesh, heroBody, model, joints = {}, cam, shadowGen;
  let buildings = [], water, traffic = [], peds = [], birds = [], ghosts = [], giants = [], rhinos = [], dinos = [];
  let nearZoo = false;                       // creature system is active only near the zoo
  let enterables = [], obstacles = [], drivingCar = null, carHeading = 0, carSpeed = 0, heliVel = null;
  let camYaw = 0, camPitch = 0.25, modelYaw = 0, flyYaw = 0, flyPitch = 0, boostE = 1, animPhase = 0, animT = 0;
  let grounded = false, coyoteT = 0, pointerLocked = false, lockedOnce = false;
  // Rocket launcher: opt-in (off by default) + event-driven — costs ~0 unless
  // you take it out and pull the trigger.
  let armed = false, firing = false, fireCD = 0, fxT = 0, dying = [], rockets = [];
  let punchT = 0, punchCD = 0;               // melee: swing timer + cooldown (event-driven)
  let gunPivot = null, muzzle = null, muzzleFlash = null, rocketProto = null;
  let bloodPS = null, boomPS = null, smokePS = null, noiseBuf = null;
  const keys = {};
  // touch
  let tMoveX = 0, tMoveY = 0, tLookX = 0, tLookY = 0, tBoost = false, tUp = false, tDown = false;

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
    scene.clearColor = new BABYLON.Color3(0.55, 0.74, 0.9);
    scene.ambientColor = new BABYLON.Color3(0.55, 0.55, 0.6);

    let havok;
    try {
      havok = await Promise.race([
        HavokPhysics(),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 30000)),
      ]);
    } catch (e) { return fail("Physics engine failed to start. Check your connection and reload.", e); }
    scene.enablePhysics(new BABYLON.Vector3(0, -GRAVITY, 0), new BABYLON.HavokPlugin(true, havok));

    buildEnvironment();
    buildWorld();
    buildHero();
    buildCamera();
    setupInput();
    setMode(MODE.WALK, true);
    if (window.MP) {
      MP.attach(scene, { vehicle: makeVehicle, human: makeRemoteHuman }); MP.onChatToggle = onChatToggle;
      if (MP.available) { const row = document.getElementById("online-row"); if (row) row.classList.remove("hidden"); }
    }

    // read-only snapshot for the headless smoke test
    window.__sg = () => ({
      state, mode, alt: heroMesh.position.y,
      vy: heroBody.getLinearVelocity().y,
      speed: heroBody.getLinearVelocity().length(), flyPitch, carSpeed,
      heliVy: heliVel ? heliVel.y : 0,
      px: heroMesh.position.x, pz: heroMesh.position.z,
      cars: enterables.length,
      mats: scene.materials.length, meshes: scene.meshes.length,
      cols: scene.meshes.reduce((n, m) => n + (m.name === "acol" || m.name === "pcol" ? 1 : 0), 0),
    });
    window.__tp = (x, z) => { heroMesh.position.set(x, heroMesh.position.y, z); maybeManageActors(heroMesh.position); return scene.materials.length; };
    // weapon test hooks (headless): count alive/dead actors, launch, detonate.
    window.__actors = () => {
      const all = [].concat(peds, ghosts, giants, rhinos, dinos);
      return { alive: all.filter((a) => a.node && !a.dead).length, dead: all.filter((a) => a.dead).length, rockets: rockets.length, dying: dying.length, nearZoo };
    };
    window.__fire = () => { launchRocket(); return rockets.length; };
    window.__blast = (x, y, z) => { explode(new BABYLON.Vector3(x, y, z), null, null); return window.__actors(); };
    window.__zoo = () => { heroMesh.position.set(ZOO_X, heroMesh.position.y, ZOO_Z); nearZoo = true; manX = manZ = 1e9; maybeManageActors(heroMesh.position); return window.__actors(); };
    window.__meleeTest = () => {
      let best = null, bk = null, bd = 1e18; const p = heroMesh.position;
      for (const kind of KINDS) { const list = ({ peds, ghosts, giants, rhinos, dinos })[kind]; for (const it of list) { if (!it.node || it.dead) continue; const c = it.node.getAbsolutePosition(); const d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2; if (d < bd) { bd = d; best = it; bk = kind; } } }
      if (!best) return null;
      const c = best.node.getAbsolutePosition();
      heroMesh.position.set(c.x - 1.4, p.y, c.z);
      modelYaw = Math.atan2(c.x - heroMesh.position.x, c.z - heroMesh.position.z);
      const before = window.__actors().dead; punchCD = 0; punch(); return { before, after: window.__actors().dead };
    };
    window.__nearestActor = () => {
      const p = heroMesh.position; let best = null, bd = 1e18;
      for (const a of [].concat(peds, ghosts, giants, rhinos, dinos)) {
        if (!a.node || a.dead) continue;
        const c = a.node.getAbsolutePosition(), d = (c.x - p.x) ** 2 + (c.z - p.z) ** 2;
        if (d < bd) { bd = d; best = { x: c.x, y: c.y, z: c.z }; }
      }
      return best;
    };
    window.__enter = (type) => {
      if (state !== S.PLAYING || mode !== MODE.WALK) return mode;
      const c = enterables.find((e) => !type || e.type === type);
      if (c) { if (!c.node) spawnVehicle(c); heroMesh.position.set(c.x + 2, 1.3, c.z); enterCar(c); }
      return mode;
    };

    engine.runRenderLoop(() => {
      const dt = Math.min(engine.getDeltaTime() / 1000, 0.05);
      step(dt);
      scene.render();
    });
    window.addEventListener("resize", () => engine.resize());

    state = S.MENU;
    ui.loading.classList.add("hidden");
    ui.menu.classList.remove("hidden");
    if (isTouch()) ui.touch.classList.remove("hidden");
  }

  // ========================================================================
  //  Environment
  // ========================================================================
  function buildEnvironment() {
    const glow = new BABYLON.GlowLayer("glow", scene);
    glow.intensity = 0.7;

    const hemi = new BABYLON.HemisphericLight("hemi", new BABYLON.Vector3(0.3, 1, 0.2), scene);
    hemi.intensity = 0.8;
    hemi.groundColor = new BABYLON.Color3(0.3, 0.32, 0.38);

    const sun = new BABYLON.DirectionalLight("sun", new BABYLON.Vector3(-0.5, -1, -0.35), scene);
    sun.position = new BABYLON.Vector3(300, 600, 250);
    sun.intensity = 1.5;
    shadowGen = new BABYLON.ShadowGenerator(1024, sun);
    shadowGen.useBlurExponentialShadowMap = true;
    shadowGen.blurKernel = 12;

    scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
    scene.fogColor = new BABYLON.Color3(0.72, 0.82, 0.9);
    scene.fogDensity = 0.0006;

    // Sky dome (gradient)
    const sky = BABYLON.MeshBuilder.CreateSphere("sky", { diameter: 7000, sideOrientation: BABYLON.Mesh.BACKSIDE }, scene);
    const tex = new BABYLON.DynamicTexture("skyTex", { width: 16, height: 512 }, scene, false);
    const c = tex.getContext();
    const g = c.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0.0, "#1a63c4"); g.addColorStop(0.5, "#5aa0e0");
    g.addColorStop(0.8, "#acd5f0"); g.addColorStop(1.0, "#e9f4fb");
    c.fillStyle = g; c.fillRect(0, 0, 16, 512); tex.update();
    const m = new BABYLON.StandardMaterial("skyMat", scene);
    m.emissiveTexture = tex; m.diffuseColor = new BABYLON.Color3(0, 0, 0);
    m.specularColor = new BABYLON.Color3(0, 0, 0); m.disableLighting = true; m.backFaceCulling = false;
    sky.material = m; sky.infiniteDistance = true; sky.applyFog = false; sky.isPickable = false;

    // Soft clouds
    const cloudMat = new BABYLON.StandardMaterial("cloudMat", scene);
    cloudMat.diffuseColor = new BABYLON.Color3(1, 1, 1);
    cloudMat.emissiveColor = new BABYLON.Color3(0.5, 0.55, 0.6);
    cloudMat.specularColor = new BABYLON.Color3(0, 0, 0);
    cloudMat.alpha = 0.5;
    for (let i = 0; i < 14; i++) {
      const cl = BABYLON.MeshBuilder.CreateSphere("cloud" + i, { diameter: 1, segments: 6 }, scene);
      cl.material = cloudMat; cl.isPickable = false;
      cl.position.set(rand(1500), 220 + Math.random() * 260, rand(1500));
      cl.scaling.set(60 + Math.random() * 80, 16 + Math.random() * 14, 50 + Math.random() * 70);
    }
  }

  // ========================================================================
  //  Open world — countryside, downtown, coastline + ocean, a village
  // ========================================================================
  function buildWorld() {
    buildGround();
    buildCity();
    buildOcean();
    buildVillage();
    buildNature();
    buildVehicles();
    buildPedestrians();
    buildBirds();
    igniteNearestBuilding();
    buildZoo();
    buildGhosts();
    buildGiants();
    buildRhinos();
    buildDinos();
    setWarAtmosphere();
  }

  // ---- The Zoo enclosure: a fenced compound far from spawn that holds every
  // creature. Just static geometry (one merged fence + a pad + a sign) — the
  // creatures themselves stay dormant until the player arrives. ------------
  function buildZoo() {
    const R = ZOO_R + 6;
    // ground pad — packed dirt
    const pad = BABYLON.MeshBuilder.CreateGround("zooPad", { width: R * 2 + 8, height: R * 2 + 8 }, scene);
    pad.position.set(ZOO_X, 0.06, ZOO_Z);
    const dirt = new BABYLON.StandardMaterial("zooDirt", scene);
    dirt.diffuseColor = new BABYLON.Color3(0.32, 0.26, 0.19); dirt.specularColor = new BABYLON.Color3(0, 0, 0);
    pad.material = dirt; pad.receiveShadows = true; pad.freezeWorldMatrix();

    const bar = new BABYLON.StandardMaterial("zooBar", scene);
    bar.diffuseColor = new BABYLON.Color3(0.16, 0.17, 0.19); bar.specularColor = new BABYLON.Color3(0.3, 0.3, 0.32);
    const parts = [];
    const GATE = 16;                          // gap on the south side (facing spawn)
    const post = (x, z) => { const e = BABYLON.MeshBuilder.CreateBox("zf", { width: 0.4, height: 4.2, depth: 0.4 }, scene); e.material = bar; e.position.set(x, 2.1, z); parts.push(e); };
    const rail = (x, z, w, d) => { const e = BABYLON.MeshBuilder.CreateBox("zf", { width: w, height: 0.16, depth: d }, scene); e.material = bar; e.position.set(x, 3.4, z); parts.push(e); const e2 = e.clone("zf"); e2.position.y = 1.6; parts.push(e2); };
    for (const sgn of [-1, 1]) {
      // north/south fences (run along X), with a gate gap centred on the south side
      const z = ZOO_Z + sgn * R;
      if (sgn > 0) { rail(ZOO_X, z, R * 2, 0.16); for (let x = -R; x <= R + 0.1; x += R / 4) post(ZOO_X + x, z); }
      else {
        rail(ZOO_X - (R + GATE / 2) / 2, z, R - GATE / 2, 0.16); rail(ZOO_X + (R + GATE / 2) / 2, z, R - GATE / 2, 0.16);
        for (let x = -R; x <= R + 0.1; x += R / 4) if (Math.abs(ZOO_X + x - ZOO_X) > GATE / 2) post(ZOO_X + x, z);
      }
      // east/west fences (run along Z)
      const x = ZOO_X + sgn * R;
      rail(x, ZOO_Z, 0.16, R * 2); for (let z2 = -R; z2 <= R + 0.1; z2 += R / 4) post(x, ZOO_Z + z2);
    }
    const fence = BABYLON.Mesh.MergeMeshes(parts, true, true, undefined, false, false);
    if (fence) { fence.name = "zooFence"; fence.isPickable = false; fence.freezeWorldMatrix(); shadowGen.addShadowCaster(fence); }

    // entrance sign arch over the south gate
    const sign = BABYLON.MeshBuilder.CreateBox("zooSign", { width: GATE + 4, height: 2.2, depth: 0.4 }, scene);
    sign.position.set(ZOO_X, 6.2, ZOO_Z - R);
    const st = new BABYLON.DynamicTexture("zooSignTex", { width: 512, height: 128 }, scene, true);
    const sx = st.getContext(); sx.fillStyle = "#3a2d12"; sx.fillRect(0, 0, 512, 128);
    sx.fillStyle = "#ffcf4a"; sx.font = "bold 86px sans-serif"; sx.textAlign = "center"; sx.textBaseline = "middle";
    sx.fillText("◣ ZOO ◢", 256, 70); st.update();
    const sm = new BABYLON.StandardMaterial("zooSignMat", scene);
    sm.diffuseTexture = st; sm.emissiveColor = new BABYLON.Color3(0.4, 0.32, 0.08); sm.specularColor = new BABYLON.Color3(0, 0, 0);
    sign.material = sm; sign.isPickable = false; sign.freezeWorldMatrix();
    for (const sgn of [-1, 1]) { const gp = BABYLON.MeshBuilder.CreateBox("zooSignPost", { width: 0.6, height: 7.6, depth: 0.6 }, scene); gp.material = bar; gp.position.set(ZOO_X + sgn * (GATE / 2 + 2), 3.8, ZOO_Z - R); gp.isPickable = false; gp.freezeWorldMatrix(); }
  }

  // ---- War atmosphere: a smoke-choked, burning sky over the whole city -----
  // One-time re-tint of the existing sky/fog/lights — zero per-frame cost.
  function setWarAtmosphere() {
    scene.clearColor = new BABYLON.Color3(0.16, 0.11, 0.09);
    scene.ambientColor = new BABYLON.Color3(0.34, 0.26, 0.24);
    scene.fogColor = new BABYLON.Color3(0.26, 0.17, 0.13);
    scene.fogDensity = 0.0011;                       // thick battlefield haze (clear up close)

    const sun = scene.getLightByName("sun");
    if (sun) { sun.diffuse = new BABYLON.Color3(1.0, 0.5, 0.26); sun.intensity = 1.05; }
    const hemi = scene.getLightByName("hemi");
    if (hemi) { hemi.intensity = 0.55; hemi.diffuse = new BABYLON.Color3(0.95, 0.62, 0.5); hemi.groundColor = new BABYLON.Color3(0.18, 0.12, 0.12); }

    const skyMat = scene.getMaterialByName("skyMat");
    if (skyMat && skyMat.emissiveTexture) {
      const tex = skyMat.emissiveTexture, cx = tex.getContext();
      const g = cx.createLinearGradient(0, 0, 0, 512);
      g.addColorStop(0.0, "#160a08");   // black smoke overhead
      g.addColorStop(0.45, "#591f0e");  // ember haze
      g.addColorStop(0.72, "#a8421a");  // burning horizon
      g.addColorStop(1.0, "#d9802f");   // fiery glow at the skyline
      cx.fillStyle = g; cx.fillRect(0, 0, 16, 512); tex.update();
    }
    const cloud = scene.getMaterialByName("cloudMat");
    if (cloud) { cloud.diffuseColor = new BABYLON.Color3(0.22, 0.17, 0.16); cloud.emissiveColor = new BABYLON.Color3(0.13, 0.07, 0.05); cloud.alpha = 0.62; }
  }

  // ---- A building on fire near the spawn (flames + smoke) -----------------
  // One bounded effect; emission is gated on distance so it costs ~0 when far.
  let fireFX = null;
  function makeSoftTexture() {
    const t = new BABYLON.DynamicTexture("soft", { width: 64, height: 64 }, scene, false);
    const c = t.getContext();
    const g = c.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.45, "rgba(255,255,255,0.5)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    c.fillStyle = g; c.fillRect(0, 0, 64, 64); t.update(); t.hasAlpha = true;
    return t;
  }
  function igniteNearestBuilding() {
    if (!buildings.length) return;
    let b = buildings[0], bd = Infinity;
    for (const x of buildings) { const d = x.position.x * x.position.x + x.position.z * x.position.z; if (d < bd) { bd = d; b = x; } }
    const ext = b.getBoundingInfo().boundingBox.extendSize;   // half-dims (local)
    const fw = ext.x * 2, fd = ext.z * 2;

    // charred facade
    const ch = new BABYLON.StandardMaterial("charred", scene);
    ch.diffuseColor = new BABYLON.Color3(0.06, 0.05, 0.05);
    ch.emissiveColor = new BABYLON.Color3(0.07, 0.025, 0);
    ch.specularColor = new BABYLON.Color3(0, 0, 0);
    b.material = ch;

    const tex = makeSoftTexture();
    const fire = new BABYLON.ParticleSystem("bldFire", 360, scene);
    fire.particleTexture = tex;
    fire.emitter = b.position.clone();
    fire.minEmitBox = new BABYLON.Vector3(-fw * 0.7, -ext.y, -fd * 0.7);   // spill outside the walls so flames are visible
    fire.maxEmitBox = new BABYLON.Vector3(fw * 0.7, ext.y * 0.85, fd * 0.7);
    fire.color1 = new BABYLON.Color4(1, 0.55, 0.12, 1);
    fire.color2 = new BABYLON.Color4(1, 0.28, 0.0, 1);
    fire.colorDead = new BABYLON.Color4(0.25, 0.04, 0, 0);
    fire.minSize = Math.max(3, fw * 0.12); fire.maxSize = Math.max(8, fw * 0.32);
    fire.minLifeTime = 0.6; fire.maxLifeTime = 1.6;
    fire.emitRate = 180;
    fire.blendMode = BABYLON.ParticleSystem.BLENDMODE_ONEONE;
    fire.gravity = new BABYLON.Vector3(0, 9, 0);
    fire.direction1 = new BABYLON.Vector3(-1.2, 6, -1.2);
    fire.direction2 = new BABYLON.Vector3(1.2, 9, 1.2);
    fire.minEmitPower = 1; fire.maxEmitPower = 3; fire.updateSpeed = 0.02;

    const smoke = new BABYLON.ParticleSystem("bldSmoke", 260, scene);
    smoke.particleTexture = tex;
    smoke.emitter = new BABYLON.Vector3(b.position.x, b.position.y + ext.y * 0.7, b.position.z);
    smoke.minEmitBox = new BABYLON.Vector3(-fw / 2, 0, -fd / 2);
    smoke.maxEmitBox = new BABYLON.Vector3(fw / 2, ext.y * 0.3, fd / 2);
    smoke.color1 = new BABYLON.Color4(0.12, 0.12, 0.13, 0.55);
    smoke.color2 = new BABYLON.Color4(0.05, 0.05, 0.06, 0.45);
    smoke.colorDead = new BABYLON.Color4(0, 0, 0, 0);
    smoke.minSize = Math.max(10, fw * 0.45); smoke.maxSize = Math.max(20, fw * 1.0);
    smoke.minLifeTime = 3; smoke.maxLifeTime = 6;
    smoke.emitRate = 44;
    smoke.gravity = new BABYLON.Vector3(3, 16, 0);   // rise + drift
    smoke.direction1 = new BABYLON.Vector3(-1, 4, -1);
    smoke.direction2 = new BABYLON.Vector3(2, 7, 1);
    smoke.minEmitPower = 2; smoke.maxEmitPower = 5; smoke.updateSpeed = 0.02;

    fireFX = { fire, smoke, pos: b.position.clone(), active: false };
  }
  function setFireActive(on) {
    if (!fireFX || fireFX.active === on) return;
    fireFX.active = on;
    if (on) { fireFX.fire.start(); fireFX.smoke.start(); }
    else { fireFX.fire.stop(); fireFX.smoke.stop(); }
  }
  function updateFireFX(p) {
    if (!fireFX) return;
    const dx = p.x - fireFX.pos.x, dz = p.z - fireFX.pos.z;
    setFireActive(dx * dx + dz * dz < 600 * 600);   // only emit within 600 m
  }

  // ---- Scary ghosts: distorted human figures haunting the world ----------
  // Lazy actors that drift low around anchor points; most haunt the open map,
  // some the zoo. Meshes exist only near the player. Six variants (shadow /
  // corpse / wraith / tall / screamer / reaper).
  function buildGhosts() {
    for (let i = 0; i < 28; i++) {
      const type = i % 6;
      const sp = roamSpot(i);
      const ax = sp.cx, az = sp.cz;
      ghosts.push({
        type, baseScale: 0.92 + Math.random() * 0.18,   // wraith/tall size is baked into the mesh
        flick: type === 0 || type === 3 || type === 5,
        ax, az, radius: 4 + Math.random() * 12,
        angle: Math.random() * 6.28, angVel: (Math.random() < 0.5 ? -1 : 1) * (0.12 + Math.random() * 0.3),
        bob: Math.random() * 6, bobSp: 1.1 + Math.random() * 1.0,
        creep: Math.random() * 6, creepSp: 0.15 + Math.random() * 0.25,
        baseY: 1.5 + Math.random() * 6, creepAmp: 1.5 + Math.random() * 3,
        x: ax, z: az, node: null, stuck: false,
      });
    }
  }
  function ghostMats() {
    const C = (r, g, b) => new BABYLON.Color3(r, g, b);
    const mk = (n, diff, em, a) => { let x = scene.getMaterialByName(n); if (!x) { x = new BABYLON.StandardMaterial(n, scene); x.diffuseColor = diff; x.emissiveColor = em; x.specularColor = C(0, 0, 0); if (a != null) { x.alpha = a; x.backFaceCulling = false; } } return x; };
    return {
      shadow: mk("gShadow", C(0.012, 0.012, 0.018), C(0.02, 0.02, 0.028), null),     // opaque near-black
      pale: mk("gPale", C(0.03, 0.03, 0.038), C(0.035, 0.035, 0.045), null),         // dark grey skin
      blood: mk("gBlood", C(0.32, 0, 0), C(0.72, 0.02, 0.02), null),                 // glows red via GlowLayer
      eyeR: mk("gEyeR", C(0.1, 0, 0), C(1, 0.1, 0.08), null),
      eyeD: mk("gEyeD", C(0.01, 0.01, 0.02), C(0, 0, 0), null),
      bone: mk("gBone", C(0.42, 0.4, 0.35), C(0.07, 0.066, 0.055), null),            // teeth / ribs / claws
    };
  }
  // Elaborate, full-featured ghost. Built from many primitives (skull with eye
  // sockets/teeth, ribcage, jointed clawed arms, tattered robe) then MERGED into
  // a single opaque mesh, so all that detail costs ~1 draw call per ghost.
  function makeGhost(type) {
    const M = ghostMats(), MB = BABYLON.MeshBuilder;
    const root = new BABYLON.TransformNode("gtmp", scene);
    const parts = [];
    const skin = type === 0 ? M.shadow : M.pale, B = M.blood, eR = M.eyeR, eD = M.eyeD, bn = M.bone;
    const gory = type === 1 || type === 2 || type === 4 || type === 5;
    const box = (w, h, d, m, x, y, z, par) => { const e = MB.CreateBox("g", { width: w, height: h, depth: d }, scene); e.material = m; e.parent = par || root; e.position.set(x, y, z); parts.push(e); return e; };
    const sph = (dia, m, x, y, z, par) => { const e = MB.CreateSphere("g", { diameter: dia, segments: 8 }, scene); e.material = m; e.parent = par || root; e.position.set(x, y, z); parts.push(e); return e; };
    const cap = (r, h, m, x, y, z, par) => { const e = MB.CreateCapsule("g", { radius: r, height: h }, scene); e.material = m; e.parent = par || root; e.position.set(x, y, z); parts.push(e); return e; };
    const jnt = (x, y, z, par) => { const n = new BABYLON.TransformNode("gn", scene); n.parent = par || root; n.position.set(x, y, z); return n; };

    // ---- skull ----
    const H = jnt(0, 1.92, 0.04);
    sph(0.4, skin, 0, 0.02, 0, H).scaling.set(0.9, 1.05, 1);
    box(0.36, 0.06, 0.14, skin, 0, 0.12, 0.15, H);                         // brow ridge
    for (const s of [-0.1, 0.1]) { sph(0.15, eD, s, 0.03, 0.13, H).scaling.set(1, 1, 0.55); sph(0.075, eR, s, 0.03, 0.18, H); }
    box(0.05, 0.13, 0.07, eD, 0, -0.05, 0.2, H);                           // nose cavity
    for (const s of [-0.15, 0.15]) box(0.08, 0.2, 0.1, skin, s, -0.04, 0.1, H);  // cheekbones
    const J = jnt(0, -0.18, 0.1, H);
    box(0.26, 0.16, 0.18, skin, 0, -0.06, 0.02, J);                        // jaw
    sph(0.2, eD, 0, -0.06, 0.14, H).scaling.set(0.9, 0.8, 0.5);            // mouth cavity
    for (let t = -2; t <= 2; t++) box(0.035, 0.06, 0.03, bn, t * 0.05, 0.02, 0.22, H);    // upper teeth
    for (let t = -1; t <= 1; t++) box(0.035, 0.05, 0.03, bn, t * 0.06, 0.0, 0.16, J);     // lower teeth
    // ---- neck + gaunt torso ----
    cap(0.06, 0.16, skin, 0, 1.76, 0.03);
    box(0.44, 0.34, 0.24, skin, 0, 1.52, 0);                               // chest
    for (let r = 0; r < 3; r++) box(0.42 - r * 0.03, 0.03, 0.26, bn, 0, 1.46 - r * 0.09, 0.02);   // ribs
    box(0.28, 0.3, 0.2, skin, 0, 1.2, 0);                                  // abdomen
    box(0.34, 0.22, 0.22, skin, 0, 0.96, 0);                              // hips
    // ---- jointed clawed arms ----
    for (const s of [-1, 1]) {
      const sh = jnt(s * 0.28, 1.62, 0.02, root); sh.rotation.z = s * 0.35; sh.rotation.x = type === 4 ? -2.2 : -0.2;
      sph(0.11, skin, 0, 0, 0, sh);
      cap(0.06, 0.52, skin, 0, -0.3, 0, sh);
      const el = jnt(0, -0.58, 0, sh); el.rotation.x = type === 4 ? 0.4 : -0.7;
      cap(0.05, 0.5, skin, 0, -0.28, 0, el);
      const wr = jnt(0, -0.55, 0, el);
      box(0.11, 0.05, 0.13, skin, 0, 0, 0.03, wr);
      for (let f = -1; f <= 1; f++) { const fg = cap(0.018, 0.2, bn, f * 0.04, -0.11, 0.06, wr); fg.rotation.x = 0.4; }   // claw fingers
      if (gory) box(0.04, 0.4, 0.04, B, 0, -0.78, 0.03, wr);
    }
    // ---- tattered robe / floating lower body ----
    for (let i = 0; i < 6; i++) { const a = i / 6 * 6.28; const dr = box(0.14, 0.6 + (i % 3) * 0.18, 0.08, skin, Math.cos(a) * 0.2, 0.55 - (i % 2) * 0.1, Math.sin(a) * 0.14); dr.rotation.x = Math.sin(a) * 0.3; dr.rotation.z = Math.cos(a) * 0.3; }
    cap(0.26, 0.7, skin, 0, 0.35, 0).scaling.set(1, 1.3, 0.85);
    sph(0.3, skin, 0.04, -0.25, 0).scaling.set(1, 1.7, 0.7);
    // ---- blood ----
    if (gory) {
      for (const s of [-0.1, 0.1]) box(0.035, 0.4, 0.035, B, s, -0.2, 0.19, H);
      box(0.05, 0.45, 0.045, B, 0, -0.36, 0.14, H);
      box(0.05, 0.55, 0.05, B, 0.1, 1.3, 0.13); box(0.04, 0.45, 0.04, B, -0.08, 1.15, 0.13);
    }
    // ---- per-type extras ----
    if (type === 4) { H.rotation.x = -0.55; J.rotation.x = 0.7; for (const p of [[-0.12, 0.3, 0.12], [0.12, 0.3, 0.12], [0, 0.36, 0.08]]) sph(0.07, eR, p[0], p[1], p[2], H); }   // screamer
    if (type === 5) sph(0.6, M.shadow, 0, 0.08, -0.05, H).scaling.set(1.15, 1.3, 1.15);   // reaper hood
    if (type === 2) root.scaling.setAll(1.32);                             // wraith
    else if (type === 3) root.scaling.set(0.84, 1.72, 0.84);              // tall slender

    root.computeWorldMatrix(true);
    const merged = BABYLON.Mesh.MergeMeshes(parts, true, true, undefined, false, true);   // one opaque mesh
    root.dispose();
    if (merged) { merged.name = "ghost"; merged.isPickable = false; }
    return merged || new BABYLON.TransformNode("ghost", scene);
  }
  function spawnGhost(it) { it.node = makeGhost(it.type); it.node.position.set(it.x, it.baseY, it.z); }

  let stuckGhosts = 0;
  function animateGhosts(dt) {
    const hp = heroMesh.position;
    for (const g of ghosts) {
      if (!g.node) continue;                 // despawned → no work
      g.bob += g.bobSp * dt;
      const puls = g.baseScale * (1 + Math.sin(g.bob * 1.2) * 0.06);
      if (g.stuck) {                         // clings to the player and follows forever
        g.node.setEnabled(true);
        const a = g.stickAng + animT * 0.35;
        const gx = hp.x + Math.cos(a) * 1.25, gz = hp.z + Math.sin(a) * 1.25;
        const gy = hp.y + 0.3 + g.stickH + Math.sin(g.bob) * 0.25;
        g.node.position.set(gx, gy, gz);
        g.node.rotation.y = Math.atan2(hp.x - gx, hp.z - gz);   // stare at the player
        g.node.scaling.set(puls, puls, puls);
        g.x = hp.x; g.z = hp.z;              // stay "near" so it never despawns
        continue;
      }
      g.angle += g.angVel * dt; g.creep += g.creepSp * dt;
      const r = g.radius + Math.sin(g.bob * 0.5) * 2.5;          // creep out of / back to the wall
      g.x = g.ax + Math.cos(g.angle) * r; g.z = g.az + Math.sin(g.angle) * r;
      const y = Math.max(0.8, g.baseY + Math.sin(g.creep) * g.creepAmp + Math.sin(g.bob) * 0.7);
      g.node.position.set(g.x, y, g.z);
      const ddx = hp.x - g.x, ddz = hp.z - g.z, near2 = ddx * ddx + ddz * ddz;
      // turn to STARE at the player when close; twitch; glitch-flicker
      g.node.rotation.y = near2 < 32 * 32 ? Math.atan2(ddx, ddz) : (-g.angle + Math.PI / 2 + Math.sin(g.bob * 0.6) * 0.35);
      g.node.rotation.z = near2 < 55 * 55 ? Math.sin(g.bob * 11) * 0.05 : 0;
      g.node.scaling.set(puls, puls, puls);
      if (g.flick) g.node.setEnabled(near2 > 45 * 45 || Math.sin(g.bob * 14 + g.creep) > -0.62);
      // A one-shot scare sting when you get right up to a caged ghost — but it
      // never latches on or follows, so the zoo stays self-contained.
      if (!g.scared) { const dx = g.x - hp.x, dz = g.z - hp.z; if (dx * dx + dz * dz < 3.4 * 3.4) { g.scared = true; playScare(); } }
    }
  }
  // One-shot scare sting when a ghost latches on.
  let sfxCtx = null;
  function playScare() {
    if (muted) return;
    try {
      if (!sfxCtx) sfxCtx = new (window.AudioContext || window.webkitAudioContext)();
      const ctx = sfxCtx; if (ctx.state === "suspended") ctx.resume();
      const t = ctx.currentTime;
      const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.setValueAtTime(900, t); o.frequency.exponentialRampToValueAtTime(110, t + 0.5);
      const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 700; f.Q.value = 4;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.28, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
      o.connect(f); f.connect(g); g.connect(ctx.destination); o.start(t); o.stop(t + 0.75);
    } catch (e) {}
  }

  // ---- Giants: hulking muscular monsters roaming the streets -------------
  // Detailed (abs, pecs, delts, biceps, scary head) merged into one opaque mesh
  // + two swinging legs. Some are as tall as the towers. Lazy + big view range
  // so the tall ones are seen across the city. Bodies exist only when near you.
  function giantMats() {
    const C = (r, g, b) => new BABYLON.Color3(r, g, b);
    const mk = (n, diff, em, sp) => { let x = scene.getMaterialByName(n); if (!x) { x = new BABYLON.StandardMaterial(n, scene); x.diffuseColor = diff; x.emissiveColor = em || C(0, 0, 0); x.specularColor = sp || C(0.05, 0.05, 0.05); } return x; };
    return {
      skin: mk("giSkin", C(0.33, 0.3, 0.27), C(0.045, 0.04, 0.034), C(0.12, 0.11, 0.1)),
      eye: mk("giEye", C(0.2, 0, 0), C(1, 0.16, 0.1)),
      teeth: mk("giTeeth", C(0.5, 0.48, 0.42), C(0.07, 0.07, 0.06)),
    };
  }
  function makeGiant() {
    const M = giantMats(), MB = BABYLON.MeshBuilder, S = M.skin;
    const root = new BABYLON.TransformNode("giant", scene);
    const merge = (build) => { const tmp = new BABYLON.TransformNode("gtmp", scene), parts = []; build(tmp, parts); tmp.computeWorldMatrix(true); const m = BABYLON.Mesh.MergeMeshes(parts, true, true, undefined, false, true); tmp.dispose(); m.isPickable = false; return m; };
    const body = merge((tmp, parts) => {
      const box = (w, h, d, m, x, y, z) => { const e = MB.CreateBox("gi", { width: w, height: h, depth: d }, scene); e.material = m; e.parent = tmp; e.position.set(x, y, z); parts.push(e); return e; };
      const sph = (dia, m, x, y, z) => { const e = MB.CreateSphere("gi", { diameter: dia, segments: 8 }, scene); e.material = m; e.parent = tmp; e.position.set(x, y, z); parts.push(e); return e; };
      const cap = (r, h, m, x, y, z) => { const e = MB.CreateCapsule("gi", { radius: r, height: h }, scene); e.material = m; e.parent = tmp; e.position.set(x, y, z); parts.push(e); return e; };
      box(0.92, 0.5, 0.52, S, 0, 1.5, 0);                                  // pelvis
      for (let r = 0; r < 4; r++) for (const s of [-1, 1]) sph(0.27, S, s * 0.16, 2.0 + r * 0.27, 0.28).scaling.set(1, 0.9, 0.7);  // abs (8-pack)
      for (const s of [-1, 1]) box(0.18, 1.1, 0.42, S, s * 0.42, 2.4, 0.06);  // obliques
      for (const s of [-1, 1]) sph(0.52, S, s * 0.28, 3.1, 0.26).scaling.set(1, 0.82, 0.95);  // pecs
      box(1.1, 0.42, 0.62, S, 0, 3.4, 0);                                  // upper chest
      for (const s of [-1, 1]) sph(0.36, S, s * 0.3, 3.56, -0.1);          // traps
      for (const s of [-1, 1]) box(0.22, 1.1, 0.56, S, s * 0.56, 2.9, -0.05);  // lats
      for (const s of [-1, 1]) { sph(0.52, S, s * 0.68, 3.45, 0); cap(0.27, 1.0, S, s * 0.86, 2.9, 0.12); sph(0.36, S, s * 0.96, 3.08, 0.16); cap(0.21, 0.95, S, s * 0.98, 1.98, 0.26); sph(0.3, S, s * 1.02, 1.5, 0.32); }  // delts/biceps/forearms/fists
      cap(0.23, 0.4, S, 0, 3.72, 0);                                       // neck
      sph(0.52, S, 0, 4.12, 0.05).scaling.set(0.95, 1.05, 1);             // head
      box(0.42, 0.09, 0.16, S, 0, 4.2, 0.34);                             // brow
      for (const s of [-0.17, 0.17]) sph(0.12, M.eye, s, 4.13, 0.44);     // glowing eyes
      box(0.36, 0.18, 0.18, S, 0, 3.9, 0.36);                            // jaw
      for (let t = -2; t <= 2; t++) box(0.05, 0.08, 0.04, M.teeth, t * 0.07, 3.96, 0.46);  // gritted teeth
    });
    body.parent = root;
    const leg = (sx) => {
      const lt = new BABYLON.TransformNode("gileg", scene); lt.parent = root; lt.position.set(sx * 0.34, 1.5, 0);
      const m = merge((tmp, parts) => {
        const cap = (r, h, x, y, z) => { const e = MB.CreateCapsule("gl", { radius: r, height: h }, scene); e.material = S; e.parent = tmp; e.position.set(x, y, z); parts.push(e); };
        cap(0.31, 1.15, 0, -0.55, 0); cap(0.25, 1.05, 0, -1.55, 0.05);     // thigh + calf
        const f = MB.CreateBox("glf", { width: 0.36, height: 0.22, depth: 0.64 }, scene); f.material = S; f.parent = tmp; f.position.set(0, -2.12, 0.2); parts.push(f);
      });
      m.parent = lt;
      return lt;
    };
    return { root, legL: leg(-1), legR: leg(1) };
  }
  // A roam centre + wander radius for a monster: most prowl the open map; about a
  // quarter den up in the zoo. Each wanders around its own centre so they stay
  // spread out (and the lazy system only spawns the ones near you).
  function roamSpot(i) {
    const ang = Math.random() * 6.28;
    if (i % 4 === 0) { const r = Math.random() * (ZOO_R - 10); return { cx: ZOO_X + Math.cos(ang) * r, cz: ZOO_Z + Math.sin(ang) * r, wr: ZOO_R }; }
    const r = 120 + Math.random() * 760;
    return { cx: Math.cos(ang) * r, cz: Math.sin(ang) * r, wr: 150 };
  }
  function buildGiants() {
    for (let i = 0; i < 12; i++) {
      const tall = i % 4 === 1;                         // ~a quarter are tower-tall
      const scale = tall ? 10 + Math.random() * 10 : 3 + Math.random() * 3.5;
      const sp = roamSpot(i);
      giants.push({
        scale, x: sp.cx, z: sp.cz, cx: sp.cx, cz: sp.cz, wr: sp.wr,
        heading: Math.random() * 6.28, turn: (Math.random() - 0.5) * 0.1,
        speed: (tall ? 4 : 2) + Math.random() * 2, walk: Math.random() * 6, walkSp: tall ? 1.0 : 2.0,
        node: null, legL: null, legR: null,
      });
    }
  }
  function spawnGiant(it) {
    const g = makeGiant();
    it.node = g.root; it.legL = g.legL; it.legR = g.legR;
    g.root.scaling.setAll(it.scale);
    g.root.position.set(it.x, 0.7 * it.scale, it.z);
  }
  function animateGiants(dt) {
    for (const g of giants) {
      if (!g.node) continue;
      g.heading += g.turn * dt;
      g.x += Math.sin(g.heading) * g.speed * dt; g.z += Math.cos(g.heading) * g.speed * dt;
      if ((g.x - g.cx) ** 2 + (g.z - g.cz) ** 2 > g.wr * g.wr) g.heading = Math.atan2(g.cx - g.x, g.cz - g.z);   // wander around its patch
      g.walk += g.walkSp * dt;
      const sw = Math.sin(g.walk) * 0.5;
      g.legL.rotation.x = sw; g.legR.rotation.x = -sw;
      g.node.position.set(g.x, 0.7 * g.scale + Math.abs(Math.sin(g.walk)) * 0.04 * g.scale, g.z);   // stomp bob
      g.node.rotation.y = g.heading;
    }
  }

  // ---- Fire breath: a jet that exists only while a beast is spawned -------
  // Shared soft texture; the ParticleSystem is created on spawn and disposed
  // on despawn (in disposeActor), so distant beasts cost nothing. Emission is
  // bursty (breathe → rest) and the jet aims along the beast's heading.
  let fireTex = null;
  function makeBreathFire(emitter, size) {
    if (!fireTex) fireTex = makeSoftTexture();
    const ps = new BABYLON.ParticleSystem("breath", 160, scene);
    ps.particleTexture = fireTex;
    ps.emitter = emitter;                       // follows the mouth mesh's world matrix
    ps.minEmitBox = new BABYLON.Vector3(-0.08, -0.08, 0); ps.maxEmitBox = new BABYLON.Vector3(0.08, 0.08, 0.2);
    ps.color1 = new BABYLON.Color4(1, 0.62, 0.14, 1); ps.color2 = new BABYLON.Color4(1, 0.24, 0, 1);
    ps.colorDead = new BABYLON.Color4(0.22, 0.03, 0, 0);
    ps.minSize = size * 0.6; ps.maxSize = size * 2.0;
    ps.minLifeTime = 0.28; ps.maxLifeTime = 0.7;
    ps.emitRate = 130;
    ps.blendMode = BABYLON.ParticleSystem.BLENDMODE_ONEONE;
    ps.gravity = new BABYLON.Vector3(0, 2.5, 0);
    ps.direction1 = new BABYLON.Vector3(0, 0, 1); ps.direction2 = new BABYLON.Vector3(0, 0, 1);   // re-aimed per frame
    ps.minEmitPower = 7 * size; ps.maxEmitPower = 14 * size; ps.updateSpeed = 0.02;
    return ps;
  }
  // Drive the breathe→rest cycle and aim the jet along the heading. Cheap and
  // only runs for spawned beasts.
  function breathe(b, dt, size) {
    b.breathT -= dt;
    if (b.breathT <= 0) {
      b.breathing = !b.breathing;
      b.breathT = b.breathing ? 1.0 + Math.random() * 0.8 : 2.5 + Math.random() * 3;
      if (b.breathing) b.fire.start(); else b.fire.stop();
    }
    if (b.breathing) {
      const fx = Math.sin(b.heading), fz = Math.cos(b.heading);
      b.fire.direction1.set(fx - 0.25, 0.05, fz - 0.25);
      b.fire.direction2.set(fx + 0.25, 0.45, fz + 0.25);
    }
  }

  // ---- Rhinos: armoured beasts that charge and snort fire ----------------
  // Bulky merged hide + plates + horns, four animated legs, a fire jet from the
  // snout. Lazy: meshes + jet exist only within range of the player.
  function rhinoMats() {
    const C = (r, g, b) => new BABYLON.Color3(r, g, b);
    const mk = (n, diff, em, sp) => { let x = scene.getMaterialByName(n); if (!x) { x = new BABYLON.StandardMaterial(n, scene); x.diffuseColor = diff; x.emissiveColor = em || C(0, 0, 0); x.specularColor = sp || C(0.04, 0.04, 0.04); } return x; };
    return {
      hide: mk("rhHide", C(0.27, 0.26, 0.28), C(0.02, 0.02, 0.025)),
      plate: mk("rhPlate", C(0.17, 0.16, 0.18), C(0.014, 0.014, 0.02)),
      horn: mk("rhHorn", C(0.64, 0.62, 0.55), C(0.05, 0.05, 0.045)),
      eye: mk("rhEye", C(0.3, 0, 0), C(1, 0.2, 0.1)),
    };
  }
  function makeRhino() {
    const M = rhinoMats(), MB = BABYLON.MeshBuilder, H = M.hide;
    const root = new BABYLON.TransformNode("rhino", scene);
    const merge = (build) => { const tmp = new BABYLON.TransformNode("rtmp", scene), parts = []; build(tmp, parts); tmp.computeWorldMatrix(true); const m = BABYLON.Mesh.MergeMeshes(parts, true, true, undefined, false, true); tmp.dispose(); m.isPickable = false; return m; };
    const body = merge((tmp, parts) => {
      const box = (w, h, d, m, x, y, z, rx) => { const e = MB.CreateBox("rh", { width: w, height: h, depth: d }, scene); e.material = m; e.parent = tmp; e.position.set(x, y, z); if (rx) e.rotation.x = rx; parts.push(e); return e; };
      const sph = (dia, m, x, y, z, sx, sy, sz) => { const e = MB.CreateSphere("rh", { diameter: dia, segments: 9 }, scene); e.material = m; e.parent = tmp; e.position.set(x, y, z); if (sx) e.scaling.set(sx, sy, sz); parts.push(e); return e; };
      const cone = (dt, db, h, m, x, y, z, rx) => { const e = MB.CreateCylinder("rh", { diameterTop: dt, diameterBottom: db, height: h, tessellation: 10 }, scene); e.material = m; e.parent = tmp; e.position.set(x, y, z); e.rotation.x = rx; parts.push(e); return e; };
      sph(1.9, H, 0, 1.15, -0.1, 1.0, 1.0, 1.5);                            // barrel torso (long in z)
      sph(1.5, H, 0, 1.2, 1.1, 1.0, 0.95, 1.0);                            // shoulders
      box(1.5, 0.5, 1.3, M.plate, 0, 1.95, 0.2);                           // armoured back plate
      box(1.2, 0.4, 1.0, M.plate, 0, 1.9, 1.2);
      sph(1.0, H, 0, 1.0, 2.0, 1.0, 0.9, 1.1);                             // head base
      box(0.7, 0.55, 0.9, H, 0, 0.85, 2.7);                                // snout
      cone(0.02, 0.34, 1.0, M.horn, 0, 1.35, 3.1, 1.05);                   // big front horn
      cone(0.02, 0.2, 0.5, M.horn, 0, 1.55, 2.5, 0.9);                     // small rear horn
      for (const s of [-1, 1]) cone(0.02, 0.22, 0.34, H, s * 0.34, 1.7, 1.85, -0.3 + s * 0.0);  // ears
      for (const s of [-1, 1]) sph(0.16, M.eye, s * 0.36, 1.2, 2.45);      // glowing eyes
      box(0.5, 0.35, 0.6, H, 0, 1.3, -1.7);                                // rump
      cone(0.02, 0.14, 0.7, H, 0, 1.5, -2.0, -2.1);                        // tail
    });
    body.parent = root;
    const leg = (x, z) => {
      const lt = new BABYLON.TransformNode("rleg", scene); lt.parent = root; lt.position.set(x, 1.0, z);
      const m = merge((tmp, parts) => {
        const c = MB.CreateCapsule("rl", { radius: 0.27, height: 1.1 }, scene); c.material = H; c.parent = tmp; c.position.set(0, -0.5, 0); parts.push(c);
        const f = MB.CreateCylinder("rl", { diameter: 0.5, height: 0.22, tessellation: 8 }, scene); f.material = M.plate; f.parent = tmp; f.position.set(0, -1.05, 0); parts.push(f);
      });
      m.parent = lt; return lt;
    };
    const legs = [leg(-0.62, 1.15), leg(0.62, 1.15), leg(-0.6, -1.05), leg(0.6, -1.05)];
    const mouth = MB.CreateBox("rMouth", { size: 0.06 }, scene); mouth.parent = root; mouth.position.set(0, 0.95, 3.2); mouth.isVisible = false;
    const fire = makeBreathFire(mouth, 0.7);
    return { root, legs, mouth, fire };
  }
  function buildRhinos() {
    for (let i = 0; i < 10; i++) {
      const sp = roamSpot(i), scale = 1.6 + Math.random() * 1.4;
      rhinos.push({
        scale, x: sp.cx, z: sp.cz, cx: sp.cx, cz: sp.cz, wr: sp.wr,
        heading: Math.random() * 6.28, turn: (Math.random() - 0.5) * 0.5,
        speed: 5 + Math.random() * 6, walk: Math.random() * 6, walkSp: 5 + Math.random() * 2,
        breathT: 1 + Math.random() * 4, breathing: false,
        node: null, legs: null, mouth: null, fire: null,
      });
    }
  }
  function spawnRhino(it) {
    const r = makeRhino();
    it.node = r.root; it.legs = r.legs; it.mouth = r.mouth; it.fire = r.fire;
    r.root.scaling.setAll(it.scale);
    r.root.position.set(it.x, 0.18 * it.scale, it.z);
  }
  function animateRhinos(dt) {
    for (const r of rhinos) {
      if (!r.node) continue;
      r.heading += r.turn * dt;
      r.x += Math.sin(r.heading) * r.speed * dt; r.z += Math.cos(r.heading) * r.speed * dt;
      if ((r.x - r.cx) ** 2 + (r.z - r.cz) ** 2 > r.wr * r.wr) { r.heading = Math.atan2(r.cx - r.x, r.cz - r.z); r.turn = (Math.random() - 0.5) * 0.5; }
      r.walk += r.walkSp * dt;
      const sw = Math.sin(r.walk) * 0.6;
      r.legs[0].rotation.x = sw; r.legs[3].rotation.x = sw;           // diagonal gait
      r.legs[1].rotation.x = -sw; r.legs[2].rotation.x = -sw;
      r.node.position.set(r.x, 0.18 * r.scale + Math.abs(Math.sin(r.walk)) * 0.05 * r.scale, r.z);
      r.node.rotation.y = r.heading;
      breathe(r, dt, r.scale);
    }
  }

  // ---- Dinosaurs: fire-breathing T-rex roaming the outskirts -------------
  // Merged body + head with jaws/teeth + tapering tail + tiny arms, two big
  // animated legs, and a fire jet from the maw. Big view range so they loom
  // over the skyline; meshes + jet exist only when near the player.
  function dinoMats() {
    const C = (r, g, b) => new BABYLON.Color3(r, g, b);
    const mk = (n, diff, em, sp) => { let x = scene.getMaterialByName(n); if (!x) { x = new BABYLON.StandardMaterial(n, scene); x.diffuseColor = diff; x.emissiveColor = em || C(0, 0, 0); x.specularColor = sp || C(0.05, 0.05, 0.05); } return x; };
    return {
      hide: mk("dnHide", C(0.16, 0.2, 0.15), C(0.018, 0.024, 0.016)),
      belly: mk("dnBelly", C(0.28, 0.27, 0.2), C(0.03, 0.029, 0.022)),
      teeth: mk("dnTeeth", C(0.6, 0.58, 0.5), C(0.08, 0.078, 0.066)),
      eye: mk("dnEye", C(0.35, 0.25, 0), C(1, 0.7, 0.05)),
      claw: mk("dnClaw", C(0.08, 0.08, 0.07), C(0.01, 0.01, 0.01)),
    };
  }
  function makeDino() {
    const M = dinoMats(), MB = BABYLON.MeshBuilder, H = M.hide;
    const root = new BABYLON.TransformNode("dino", scene);
    const merge = (build) => { const tmp = new BABYLON.TransformNode("dtmp", scene), parts = []; build(tmp, parts); tmp.computeWorldMatrix(true); const m = BABYLON.Mesh.MergeMeshes(parts, true, true, undefined, false, true); tmp.dispose(); m.isPickable = false; return m; };
    const body = merge((tmp, parts) => {
      const box = (w, h, d, m, x, y, z, rx) => { const e = MB.CreateBox("dn", { width: w, height: h, depth: d }, scene); e.material = m; e.parent = tmp; e.position.set(x, y, z); if (rx) e.rotation.x = rx; parts.push(e); return e; };
      const sph = (dia, m, x, y, z, sx, sy, sz) => { const e = MB.CreateSphere("dn", { diameter: dia, segments: 9 }, scene); e.material = m; e.parent = tmp; e.position.set(x, y, z); if (sx) e.scaling.set(sx, sy, sz); parts.push(e); return e; };
      const cap = (r, h, m, x, y, z, rx) => { const e = MB.CreateCapsule("dn", { radius: r, height: h }, scene); e.material = m; e.parent = tmp; e.position.set(x, y, z); if (rx) e.rotation.x = rx; parts.push(e); return e; };
      const cone = (db, h, m, x, y, z, rx) => { const e = MB.CreateCylinder("dn", { diameterTop: 0.02, diameterBottom: db, height: h, tessellation: 8 }, scene); e.material = m; e.parent = tmp; e.position.set(x, y, z); e.rotation.x = rx; parts.push(e); return e; };
      sph(1.7, H, 0, 3.0, 0, 1.0, 1.05, 1.6);                              // torso
      sph(1.0, M.belly, 0, 2.7, 0.2, 0.9, 0.85, 1.2);                      // belly
      // neck up to the head
      cap(0.45, 1.1, H, 0, 3.9, 1.0, 0.6);
      const hx = 0, hy = 4.5, hz = 1.9;
      sph(0.95, H, hx, hy, hz, 1.0, 0.95, 1.25);                           // skull
      box(0.7, 0.42, 1.2, H, hx, hy - 0.15, hz + 0.75);                    // upper jaw / snout
      box(0.66, 0.34, 1.1, H, hx, hy - 0.5, hz + 0.7);                     // lower jaw
      for (let t = -2; t <= 2; t++) { cone(0.12, 0.26, M.teeth, t * 0.13, hy - 0.32, hz + 1.2, Math.PI); cone(0.1, 0.22, M.teeth, t * 0.13, hy - 0.5, hz + 1.15, 0); }  // fangs
      box(0.5, 0.12, 0.3, H, hx, hy + 0.34, hz + 0.2);                     // brow
      for (const s of [-1, 1]) sph(0.2, M.eye, s * 0.42, hy + 0.18, hz + 0.32);  // glowing eyes
      // tail — tapering boxes
      for (let i = 0; i < 6; i++) { const t = i / 6; box(0.9 - t * 0.7, 0.8 - t * 0.6, 0.6, H, 0, 3.0 - t * 0.9, -1.1 - i * 0.55, 0.12); }
      // tiny arms
      for (const s of [-1, 1]) { const a = box(0.18, 0.5, 0.18, H, s * 0.7, 2.9, 0.9); a.rotation.x = 0.7; cone(0.14, 0.5, H, s * 0.7, 2.55, 1.2, 0.9); for (let f = -1; f <= 1; f++) cone(0.05, 0.16, M.claw, s * 0.7 + f * 0.06, 2.3, 1.45, 1.2); }
    });
    body.parent = root;
    const leg = (sx) => {
      const lt = new BABYLON.TransformNode("dleg", scene); lt.parent = root; lt.position.set(sx * 0.55, 2.4, 0);
      const m = merge((tmp, parts) => {
        const cap = (r, h, x, y, z, rx) => { const e = MB.CreateCapsule("dl", { radius: r, height: h }, scene); e.material = H; e.parent = tmp; e.position.set(x, y, z); if (rx) e.rotation.x = rx; parts.push(e); };
        cap(0.5, 1.3, 0, -0.7, -0.1);                                      // thigh
        cap(0.34, 1.3, 0, -1.7, 0.15, -0.3);                              // shin (angled)
        const f = MB.CreateBox("df", { width: 0.5, height: 0.25, depth: 1.1 }, scene); f.material = H; f.parent = tmp; f.position.set(0, -2.4, 0.4); parts.push(f);
        for (let t = -1; t <= 1; t++) { const c = MB.CreateCylinder("dl", { diameterTop: 0.02, diameterBottom: 0.12, height: 0.3, tessellation: 6 }, scene); c.material = M.claw; c.parent = tmp; c.position.set(t * 0.16, -2.45, 1.0); c.rotation.x = 1.4; parts.push(c); }
      });
      m.parent = lt; return lt;
    };
    const legL = leg(-1), legR = leg(1);
    const mouth = MB.CreateBox("dMouth", { size: 0.08 }, scene); mouth.parent = root; mouth.position.set(0, 4.3, 3.3); mouth.isVisible = false;
    const fire = makeBreathFire(mouth, 1.3);
    return { root, legL, legR, mouth, fire };
  }
  function buildDinos() {
    for (let i = 0; i < 7; i++) {
      const sp = roamSpot(i), scale = 2.2 + Math.random() * 2.6;
      dinos.push({
        scale, x: sp.cx, z: sp.cz, cx: sp.cx, cz: sp.cz, wr: sp.wr,
        heading: Math.random() * 6.28, turn: (Math.random() - 0.5) * 0.18,
        speed: 4 + Math.random() * 4, walk: Math.random() * 6, walkSp: 2.4 + Math.random() * 1.2,
        breathT: 1 + Math.random() * 4, breathing: false,
        node: null, legL: null, legR: null, mouth: null, fire: null,
      });
    }
  }
  function spawnDino(it) {
    const d = makeDino();
    it.node = d.root; it.legL = d.legL; it.legR = d.legR; it.mouth = d.mouth; it.fire = d.fire;
    d.root.scaling.setAll(it.scale);
    d.root.position.set(it.x, 0.6 * it.scale, it.z);
  }
  function animateDinos(dt) {
    for (const d of dinos) {
      if (!d.node) continue;
      d.heading += d.turn * dt;
      d.x += Math.sin(d.heading) * d.speed * dt; d.z += Math.cos(d.heading) * d.speed * dt;
      if ((d.x - d.cx) ** 2 + (d.z - d.cz) ** 2 > d.wr * d.wr) { d.heading = Math.atan2(d.cx - d.x, d.cz - d.z); d.turn = (Math.random() - 0.5) * 0.18; }
      d.walk += d.walkSp * dt;
      const sw = Math.sin(d.walk) * 0.55;
      d.legL.rotation.x = sw; d.legR.rotation.x = -sw;
      d.node.position.set(d.x, 0.6 * d.scale + Math.abs(Math.sin(d.walk)) * 0.05 * d.scale, d.z);
      d.node.rotation.y = d.heading;
      breathe(d, dt, d.scale);
    }
  }

  // ---- Horror background score -------------------------------------------
  // Plays a real licensed track if one is supplied (window.HORROR_MUSIC_URL or
  // a file at audio/horror.mp3); otherwise synthesises a cinematic horror bed
  // in-engine (no asset/bundle cost, works offline). Starts on the play gesture.
  let ambient = null, musicEl = null, muted = false;
  const MUSIC_VOL = 0.55;

  // Called from the play gesture. Two layers so SOMETHING always plays:
  //  1) an <audio> element UNLOCKED in the gesture (HTMLMedia can play through the
  //     iOS mute switch when a real track loads), and
  //  2) the synth bed (Web Audio) — guaranteed offline, but obeys the iOS mute
  //     switch. Whichever real track loads first fades the synth out.
  function startAudio() { startTrack(); startAmbient(); }

  function startTrack() {
    // A real, SAME-ORIGIN file is the only reliable iPhone path: it loads with
    // no CDN dependency and HTML5 media playback plays through the iOS silent
    // switch (the Web Audio synth bed below does NOT). Drop in your own track
    // by setting window.HORROR_MUSIC_URL or replacing audio/horror.wav.
    const urls = window.HORROR_MUSIC_URL ? [window.HORROR_MUSIC_URL, "audio/horror.wav"] : ["audio/horror.wav"];
    try {
      const a = document.createElement("audio");
      a.loop = true; a.preload = "auto"; a.setAttribute("playsinline", ""); a.volume = muted ? 0 : MUSIC_VOL;
      musicEl = a;
      let i = 0;
      a.addEventListener("playing", () => {     // a real track started → fade the synth out
        if (ambient) { try { ambient.master.gain.linearRampToValueAtTime(0, ambient.ctx.currentTime + 2); } catch (e) {} }
      });
      a.addEventListener("error", () => { i++; if (i < urls.length) { a.src = urls[i]; a.load(); a.play().catch(() => {}); } });
      a.src = urls[i]; a.play().catch(() => {});   // play() IN the gesture → unlocks iOS
    } catch (e) {}
  }

  function makeReverbIR(ctx, secs, decay) {
    const len = (ctx.sampleRate * secs) | 0, ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) { const d = ir.getChannelData(ch); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay); }
    return ir;
  }
  function startAmbient() {
    if (ambient) { try { ambient.ctx.resume(); } catch (e) {} return; }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      const ctx = new Ctx();
      const master = ctx.createGain(); master.gain.value = 0; master.connect(ctx.destination);
      master.gain.linearRampToValueAtTime(muted ? 0 : 0.2, ctx.currentTime + 2);
      const conv = ctx.createConvolver(); conv.buffer = makeReverbIR(ctx, 3.5, 2.2);
      const wet = ctx.createGain(); wet.gain.value = 0.5; conv.connect(wet); wet.connect(master);
      const bus = ctx.createGain(); bus.connect(master); bus.connect(conv);   // dry + reverb send
      // dissonant low drone (root, slight detune, tritone, octaves)
      const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 300; lp.connect(bus);
      [55, 55.4, 77.78, 110, 220.6].forEach((f, i) => { const o = ctx.createOscillator(); o.type = i % 2 ? "sine" : "sawtooth"; o.frequency.value = f; const g = ctx.createGain(); g.gain.value = 0.16 / (i + 1); o.connect(g); g.connect(lp); o.start(); });
      const lfo = ctx.createOscillator(); lfo.frequency.value = 0.05; const lg = ctx.createGain(); lg.gain.value = 180; lfo.connect(lg); lg.connect(lp.frequency); lfo.start();
      // high atonal shimmer (detuned saws, tremolo) — unease
      const hp = ctx.createBiquadFilter(); hp.type = "highpass"; hp.frequency.value = 1500; const hg = ctx.createGain(); hg.gain.value = 0.012; hp.connect(hg); hg.connect(bus);
      [1760, 1764, 2217].forEach((f) => { const o = ctx.createOscillator(); o.type = "sawtooth"; o.frequency.value = f; o.connect(hp); o.start(); });
      const trem = ctx.createOscillator(); trem.frequency.value = 5.5; const tg = ctx.createGain(); tg.gain.value = 0.009; trem.connect(tg); tg.connect(hg.gain); trem.start();
      // wind gusts
      const nb = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate); const d = nb.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
      const noise = ctx.createBufferSource(); noise.buffer = nb; noise.loop = true; const nf = ctx.createBiquadFilter(); nf.type = "bandpass"; nf.frequency.value = 420; nf.Q.value = 0.5;
      const ng = ctx.createGain(); ng.gain.value = 0.05; noise.connect(nf); nf.connect(ng); ng.connect(bus); noise.start();
      const wl = ctx.createOscillator(); wl.frequency.value = 0.03; const wlg = ctx.createGain(); wlg.gain.value = 0.035; wl.connect(wlg); wlg.connect(ng.gain); wl.start();
      ambient = { ctx, master, timers: [] };
      // slow heartbeat (double thump)
      const beat = () => {
        if (!ambient) return; const t = ctx.currentTime;
        const thump = (at, peak) => { const o = ctx.createOscillator(); o.type = "sine"; o.frequency.setValueAtTime(62, at); o.frequency.exponentialRampToValueAtTime(36, at + 0.2); const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(peak, at + 0.03); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.32); o.connect(g); g.connect(bus); o.start(at); o.stop(at + 0.36); };
        thump(t, 0.5); thump(t + 0.33, 0.36);
        ambient.timers.push(setTimeout(beat, 1600 + Math.random() * 1500));
      };
      ambient.timers.push(setTimeout(beat, 2200));
      // dissonant stinger (minor-2nd cluster with long reverb tail)
      const stinger = () => {
        if (!ambient) return; const t = ctx.currentTime;
        const root = [185, 196, 220, 233][Math.floor(Math.random() * 4)] * (Math.random() < 0.3 ? 2 : 1);
        [root, root * 1.059].forEach((f, k) => { const o = ctx.createOscillator(); o.type = "sine"; o.frequency.value = f; const g = ctx.createGain(); g.gain.value = 0; o.connect(g); g.connect(conv); g.connect(bus); g.gain.linearRampToValueAtTime(0.04, t + 1.4 + k * 0.3); g.gain.linearRampToValueAtTime(0, t + 5); o.start(t); o.stop(t + 5.2); });
        ambient.timers.push(setTimeout(stinger, 9000 + Math.random() * 12000));
      };
      ambient.timers.push(setTimeout(stinger, 5000));
      ctx.resume();
    } catch (e) { /* audio unavailable */ }
  }
  function setAudio(on) {
    if (musicEl) { if (on) musicEl.play().catch(() => {}); else musicEl.pause(); }
    if (ambient) { try { on ? ambient.ctx.resume() : ambient.ctx.suspend(); } catch (e) {} }
  }
  function toggleMute() {
    muted = !muted;
    if (musicEl) musicEl.volume = muted ? 0 : MUSIC_VOL;
    if (ambient) ambient.master.gain.value = muted ? 0 : 0.2;
    const b = document.getElementById("sound-btn"); if (b) b.textContent = muted ? "🔇" : "🔊";
  }

  function buildGround() {
    // Green countryside floor — what you walk and land on, everywhere
    const ground = BABYLON.MeshBuilder.CreateGround("ground", { width: 6000, height: 6000, subdivisions: 1 }, scene);
    const gMat = new BABYLON.StandardMaterial("gMat", scene);
    gMat.diffuseColor = new BABYLON.Color3(0.33, 0.46, 0.27);
    gMat.specularColor = new BABYLON.Color3(0.02, 0.02, 0.02);
    ground.material = gMat; ground.receiveShadows = true;
    new BABYLON.PhysicsAggregate(ground, BABYLON.PhysicsShapeType.MESH, { mass: 0, friction: 0.8 }, scene);

    // Downtown asphalt plate beneath the city blocks
    const plate = BABYLON.MeshBuilder.CreateGround("plate", { width: 1140, height: 1140 }, scene);
    plate.position.y = 0.05;
    const pMat = new BABYLON.StandardMaterial("pMat", scene);
    pMat.diffuseColor = new BABYLON.Color3(0.2, 0.21, 0.24);
    pMat.specularColor = new BABYLON.Color3(0.02, 0.02, 0.02);
    pMat.zOffset = -1;   // sit above the ground plane in the depth test (no z-fighting)
    plate.material = pMat; plate.receiveShadows = true; plate.freezeWorldMatrix();
  }

  // ---- Downtown: road grid, towers, parked cars (central) ----
  function buildCity() {
    // Road grid (dashed asphalt strips) + sidewalks
    const S0 = 120, G = 9, half = (G - 1) / 2, ROAD_W = 22, SPAN = (G - 1) * S0 + ROAD_W;
    const roadTex = new BABYLON.DynamicTexture("roadTex", { width: 64, height: 512 }, scene, true);
    const rc = roadTex.getContext();
    rc.fillStyle = "#33363d"; rc.fillRect(0, 0, 64, 512);
    rc.fillStyle = "#e8c84a"; for (let y = 16; y < 512; y += 64) rc.fillRect(30, y, 4, 34); // centre dashes
    rc.fillStyle = "rgba(230,230,230,0.7)"; rc.fillRect(4, 0, 3, 512); rc.fillRect(57, 0, 3, 512); // edges
    roadTex.update(); roadTex.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE; roadTex.vScale = 40;
    roadTex.anisotropicFilteringLevel = 8;   // stop the lane markings shimmering at grazing angles
    const roadMat = new BABYLON.StandardMaterial("roadMat", scene);
    roadMat.diffuseTexture = roadTex; roadMat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
    roadMat.zOffset = -2;   // draw on top of the plate; avoids the lane-line z-fighting flicker

    const swMat = new BABYLON.StandardMaterial("swMat", scene);
    swMat.diffuseColor = new BABYLON.Color3(0.45, 0.46, 0.5);

    for (let i = 0; i < G; i++) {
      const p = (i - half) * S0;
      const rx = BABYLON.MeshBuilder.CreateGround("rx" + i, { width: SPAN, height: ROAD_W }, scene);
      rx.position.set(0, 0.12, p); rx.material = roadMat; rx.receiveShadows = true; rx.rotation.y = Math.PI / 2;
      const rz = BABYLON.MeshBuilder.CreateGround("rz" + i, { width: SPAN, height: ROAD_W }, scene);
      rz.position.set(p, 0.16, 0); rz.material = roadMat; rz.receiveShadows = true;
    }

    // Window-facade materials (a few shared variants)
    const facadeMats = [];
    const palette = [["#3b4250", "#0d1018"], ["#4a4036", "#140d06"], ["#36454d", "#0a1216"], ["#454354", "#120d18"]];
    for (let v = 0; v < palette.length; v++) {
      const t = new BABYLON.DynamicTexture("fac" + v, { width: 256, height: 512 }, scene, true);
      const x = t.getContext();
      x.fillStyle = palette[v][1]; x.fillRect(0, 0, 256, 512);
      const cols = 6, rows = 16, mw = 256 / cols, mh = 512 / rows;
      for (let r = 0; r < rows; r++) for (let cI = 0; cI < cols; cI++) {
        const lit = Math.random() < 0.45;
        x.fillStyle = lit ? "rgba(255,214,140,0.95)" : palette[v][0];
        x.fillRect(cI * mw + mw * 0.18, r * mh + mh * 0.18, mw * 0.64, mh * 0.6);
      }
      t.update();
      const fm = new BABYLON.StandardMaterial("facMat" + v, scene);
      fm.diffuseTexture = t; fm.emissiveTexture = t; fm.emissiveColor = new BABYLON.Color3(0.5, 0.45, 0.35);
      fm.specularColor = new BABYLON.Color3(0.1, 0.1, 0.12);
      facadeMats.push(fm);
    }

    // Buildings in each block cell (leave the centre cell open as a plaza/spawn)
    for (let ix = 0; ix < G - 1; ix++) for (let iz = 0; iz < G - 1; iz++) {
      const cx = (ix - half + 0.5) * S0, cz = (iz - half + 0.5) * S0;
      if (Math.abs(cx) < S0 && Math.abs(cz) < S0) continue; // keep plaza clear
      const fw = S0 - ROAD_W - 8 - Math.random() * 18;
      const fd = S0 - ROAD_W - 8 - Math.random() * 18;
      const h = 24 + Math.random() * Math.random() * 230;
      // sidewalk pad
      const sw = BABYLON.MeshBuilder.CreateBox("sw", { width: fw + 10, depth: fd + 10, height: 0.6 }, scene);
      sw.position.set(cx, 0.3, cz); sw.material = swMat; sw.receiveShadows = true;
      // building
      const b = BABYLON.MeshBuilder.CreateBox("bld", { width: fw, depth: fd, height: h }, scene);
      b.position.set(cx, h / 2 + 0.6, cz);
      b.material = facadeMats[(ix + iz) % facadeMats.length];
      b.receiveShadows = true; shadowGen.addShadowCaster(b);
      new BABYLON.PhysicsAggregate(b, BABYLON.PhysicsShapeType.BOX, { mass: 0, friction: 0.6 }, scene);
      buildings.push(b);
      obstacles.push({ x: cx, z: cz, hw: fw / 2 + 1.6, hd: fd / 2 + 1.6 });
    }

    buildCars(S0, half, G);
  }

  const CAR_COLORS = [[0.8, 0.2, 0.2], [0.15, 0.35, 0.8], [0.9, 0.8, 0.2], [0.9, 0.9, 0.92], [0.12, 0.12, 0.14], [0.2, 0.6, 0.4]];

  // Build a vehicle (car or bike) as a TransformNode facing +Z. Returns the node.
  function makeVehicle(type, x, z, rotY, col) {
    const node = new BABYLON.TransformNode(type, scene);
    node.position.set(x, type === "bike" ? 0.6 : type === "heli" ? 1.2 : 0.9, z); node.rotation.y = rotY;
    const cm = cachedMat("vmat_" + col.join("_"), col, 0.4);
    const wheelMat = scene.getMaterialByName("wheelMat") || mat("wheelMat", new BABYLON.Color3(0.05, 0.05, 0.06));
    const wheel = (dia, thick, px, py, pz) => {
      const w = BABYLON.MeshBuilder.CreateCylinder("w", { diameter: dia, height: thick, tessellation: 12 }, scene);
      w.rotation.z = Math.PI / 2; w.position.set(px, py, pz); w.material = wheelMat; w.parent = node; w.isPickable = false;
    };
    if (type === "heli") {
      const dark = scene.getMaterialByName("heliDark") || mat("heliDark", new BABYLON.Color3(0.08, 0.08, 0.1));
      const body = BABYLON.MeshBuilder.CreateSphere("hb", { diameter: 1, segments: 10 }, scene);
      body.scaling.set(1.7, 1.5, 3.2); body.position.y = 1.2; body.material = cm; body.parent = node;
      body.isPickable = false; shadowGen.addShadowCaster(body);
      const tail = BABYLON.MeshBuilder.CreateBox("ht", { width: 0.28, height: 0.28, depth: 3.2 }, scene);
      tail.position.set(0, 1.45, -2.7); tail.material = cm; tail.parent = node; tail.isPickable = false;
      const fin = BABYLON.MeshBuilder.CreateBox("hfin", { width: 0.1, height: 0.8, depth: 0.5 }, scene);
      fin.position.set(0, 1.85, -4.2); fin.material = cm; fin.parent = node; fin.isPickable = false;
      for (const sx of [0.75, -0.75]) {
        const skid = BABYLON.MeshBuilder.CreateBox("hsk", { width: 0.1, height: 0.1, depth: 2.6 }, scene);
        skid.position.set(sx, 0.15, 0.2); skid.material = dark; skid.parent = node; skid.isPickable = false;
        const strut = BABYLON.MeshBuilder.CreateBox("hstr", { width: 0.08, height: 0.6, depth: 0.08 }, scene);
        strut.position.set(sx, 0.5, 0.2); strut.material = dark; strut.parent = node; strut.isPickable = false;
      }
      const rotor = new BABYLON.TransformNode("rotor", scene); rotor.parent = node; rotor.position.y = 2.05;
      for (const r of [0, Math.PI / 2]) {
        const blade = BABYLON.MeshBuilder.CreateBox("hbl", { width: 6.4, height: 0.07, depth: 0.34 }, scene);
        blade.rotation.y = r; blade.material = dark; blade.parent = rotor; blade.isPickable = false;
      }
      const tailRotor = new BABYLON.TransformNode("trotor", scene); tailRotor.parent = node; tailRotor.position.set(0.18, 1.85, -4.2);
      const tb = BABYLON.MeshBuilder.CreateBox("htb", { width: 0.08, height: 1.5, depth: 0.12 }, scene);
      tb.material = dark; tb.parent = tailRotor; tb.isPickable = false;
      node.metadata = { rotor, tailRotor };
    } else if (type === "bike") {
      const frame = BABYLON.MeshBuilder.CreateBox("bf", { width: 0.26, height: 0.4, depth: 1.7 }, scene);
      frame.material = cm; frame.parent = node; frame.position.y = 0.35; shadowGen.addShadowCaster(frame);
      const seat = BABYLON.MeshBuilder.CreateBox("bs", { width: 0.3, height: 0.18, depth: 0.7 }, scene);
      seat.material = scene.getMaterialByName("seatMat") || mat("seatMat", new BABYLON.Color3(0.08, 0.08, 0.1)); seat.parent = node; seat.position.set(0, 0.6, -0.45);
      const bar = BABYLON.MeshBuilder.CreateBox("bb", { width: 0.7, height: 0.08, depth: 0.08 }, scene);
      bar.material = seat.material; bar.parent = node; bar.position.set(0, 0.7, 0.7);
      wheel(1.0, 0.16, 0, 0.0, 0.85); wheel(1.0, 0.16, 0, 0.0, -0.85);
      // seated rider so it never looks empty
      const skin = scene.getMaterialByName("skin") || mat("skin", new BABYLON.Color3(0.86, 0.66, 0.52));
      const rb = BABYLON.MeshBuilder.CreateBox("rb", { width: 0.42, height: 0.6, depth: 0.3 }, scene);
      rb.material = scene.getMaterialByName("riderMat") || mat("riderMat", new BABYLON.Color3(0.2, 0.22, 0.28)); rb.parent = node; rb.position.set(0, 1.0, -0.35);
      rb.rotation.x = 0.3; shadowGen.addShadowCaster(rb);
      const rh = BABYLON.MeshBuilder.CreateSphere("rh", { diameter: 0.3, segments: 6 }, scene);
      rh.material = skin; rh.parent = node; rh.position.set(0, 1.42, -0.2);
    } else {
      const body = BABYLON.MeshBuilder.CreateBox("cb", { width: 2, height: 0.7, depth: 4.4 }, scene);
      body.material = cm; body.parent = node; shadowGen.addShadowCaster(body);
      const cabin = BABYLON.MeshBuilder.CreateBox("cc", { width: 1.8, height: 0.6, depth: 2.2 }, scene);
      cabin.material = cm; cabin.parent = node; cabin.position.set(0, 0.55, -0.2);
      for (const [wx, wz] of [[0.9, 1.4], [-0.9, 1.4], [0.9, -1.4], [-0.9, -1.4]]) wheel(0.7, 0.3, wx, -0.35, wz);
    }
    return node;
  }

  // A lightweight humanoid for remote players — mirrors the hero's proportions
  // and shares the hero's materials (per-player shirt colour is cached).
  function makeRemoteHuman(col) {
    const root = new BABYLON.TransformNode("rhuman", scene);
    const skin = scene.getMaterialByName("skin") || mat("skin", new BABYLON.Color3(0.86, 0.66, 0.52));
    const pants = scene.getMaterialByName("pants") || mat("pants", new BABYLON.Color3(0.17, 0.19, 0.24));
    const shoe = scene.getMaterialByName("shoe") || mat("shoe", new BABYLON.Color3(0.08, 0.08, 0.1));
    const hair = scene.getMaterialByName("hair") || mat("hair", new BABYLON.Color3(0.18, 0.12, 0.08));
    const shirt = cachedMat("rshirt_" + col.join("_"), col, 0.06);
    const add = (m, opt, mtl, x, y, z) => {
      const e = BABYLON.MeshBuilder["Create" + m]("rh", opt, scene);
      e.material = mtl; e.parent = root; e.position.set(x, y, z); e.isPickable = false; return e;
    };
    add("Box", { width: 0.5, height: 0.7, depth: 0.28 }, shirt, 0, 1.15, 0);
    add("Box", { width: 0.46, height: 0.25, depth: 0.26 }, pants, 0, 0.78, 0);
    add("Sphere", { diameter: 0.34 }, skin, 0, 1.72, 0.02);
    add("Sphere", { diameter: 0.37, slice: 0.6 }, hair, 0, 1.78, 0);
    add("Box", { width: 0.16, height: 0.12, depth: 0.16 }, skin, 0, 1.5, 0);
    for (const sx of [0.32, -0.32]) { add("Capsule", { radius: 0.085, height: 0.62 }, shirt, sx, 1.11, 0); add("Sphere", { diameter: 0.13 }, skin, sx, 0.8, 0); }
    for (const sx of [0.13, -0.13]) { add("Capsule", { radius: 0.11, height: 0.78 }, pants, sx, 0.39, 0); add("Box", { width: 0.16, height: 0.12, depth: 0.3 }, shoe, sx, 0.02, 0.07); }
    return root;
  }

  function buildCars(S0, half, G) {
    for (let i = 0; i < 16; i++) {
      const lane = (Math.floor(Math.random() * G) - half) * S0;
      const along = rand((G - 1) * S0 * 0.5);
      const onX = Math.random() < 0.5;
      const x = onX ? along : lane + (Math.random() < 0.5 ? 5 : -5);
      const z = onX ? lane + (Math.random() < 0.5 ? 5 : -5) : along;
      const dir = Math.random() < 0.5 ? 1 : -1;
      const rotY = onX ? (dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (dir > 0 ? 0 : Math.PI);
      traffic.push({ onX, dir, speed: 7 + Math.random() * 7, x, z, rotY, col: CAR_COLORS[i % CAR_COLORS.length], node: null });
    }
  }
  function spawnTraffic(it) {
    it.node = makeVehicle("car", it.x, it.z, it.rotY, it.col);
    const c = makeVehicleCollider("car", it.x, it.z, it.rotY); it.collider = c.collider; it.agg = c.agg;
  }

  // Enterable, parked vehicles you can drive — a mix of cars and bikes.
  function buildVehicles() {
    const spots = [
      ["heli", 12, 14, 0],   // right by the spawn plaza — grab it and fly immediately
      ["car", 3, 4, 0], ["bike", -5, 5, Math.PI], ["car", 22, -8, Math.PI / 2],
      ["bike", -24, 10, -Math.PI / 2], ["car", 9, 95, 0], ["car", -100, -9, Math.PI / 2],
      ["bike", 120, 14, 0], ["car", -130, 100, Math.PI],
      ["heli", 44, 0, -36], ["heli", -150, 130, Math.PI / 2],
    ];
    spots.forEach(([type, x, z, rotY], i) => {
      const col = type === "heli" ? [[0.88, 0.32, 0.2], [0.15, 0.55, 0.78]][i % 2]
        : type === "bike" ? [[0.1, 0.1, 0.12], [0.7, 0.15, 0.15]][i % 2]
          : CAR_COLORS[(i + 2) % CAR_COLORS.length];
      enterables.push({ type, x, z, rotY, col, node: null, rotor: null, tailRotor: null });
    });
  }
  function spawnVehicle(it) {
    it.node = makeVehicle(it.type, it.x, it.z, it.rotY, it.col);
    if (it.node.metadata) { it.rotor = it.node.metadata.rotor; it.tailRotor = it.node.metadata.tailRotor; }
    const c = makeVehicleCollider(it.type, it.x, it.z, it.rotY); it.collider = c.collider; it.agg = c.agg;
  }

  // ---- Lazy actor manager: meshes exist only near the player -------------
  // Evaluated ONLY when the player has moved a threshold distance — not every
  // frame. Per-frame cost is one squared-distance compare; the actual scan runs
  // every ~12 m of travel. Hysteresis (spawn < despawn) avoids churn.
  let manX = 1e9, manZ = 1e9;
  function maybeManageActors(p) {
    const dx = p.x - manX, dz = p.z - manZ;
    if (dx * dx + dz * dz < 144) return;     // < 12 m moved → nothing to do
    manX = p.x; manZ = p.z;
    ensureList(enterables, spawnVehicle, 120, 165, p, (it) => it === drivingCar);
    ensureList(traffic, spawnTraffic, 130, 175, p, null);
    ensureList(peds, spawnPed, 110, 150, p, null);
    // Monsters roam the whole map; the lazy system spawns only the ones near you.
    ensureList(ghosts, spawnGhost, 230, 270, p, null);   // glowing — visible from a distance
    ensureList(giants, spawnGiant, 420, 470, p, null);   // tower-tall — wider radius so they loom from afar
    ensureList(rhinos, spawnRhino, 170, 215, p, null);   // ground beasts — meet them up close
    ensureList(dinos, spawnDino, 300, 350, p, null);     // tower over the skyline → wider radius
    updateFireFX(p);                          // burning building emits only when you're near
  }
  function animateCreatures(dt) { animateGhosts(dt); animateGiants(dt); animateRhinos(dt); animateDinos(dt); }
  function ensureList(list, makeFn, sR, dR, p, keep) {
    const s2 = sR * sR, d2 = dR * dR;
    for (const it of list) {
      if (it.dead) continue;                  // gunned down → never respawns
      const dx = it.x - p.x, dz = it.z - p.z, dd = dx * dx + dz * dz;
      if (!it.node && dd < s2) makeFn(it);
      else if (it.node && dd > d2 && !(keep && keep(it))) disposeActor(it);
    }
  }
  function disposeActor(it) {
    // Physics colliders exist only while spawned (nearby), so cost stays bounded.
    if (it.agg) { it.agg.dispose(); it.agg = null; }
    if (it.collider && it.collider !== it.node) it.collider.dispose();
    it.collider = null;
    if (it.fire) { it.fire.dispose(); it.fire = null; }   // fire jet exists only while spawned
    // Dispose the meshes only — NOT the shared/cached sub-materials. Merged
    // actors own per-instance MultiMaterial wrappers; collect and dispose just
    // those wrappers (keeping their shared sub-materials) so they don't pile up.
    const mms = [];
    if (it.node.material) mms.push(it.node.material);
    if (it.node.getChildMeshes) for (const c of it.node.getChildMeshes()) if (c.material) mms.push(c.material);
    it.node.dispose(false, false);
    for (const m of mms) if (m && m.getClassName && m.getClassName() === "MultiMaterial") m.dispose(false, false);
    it.node = null; it.rotor = null; it.tailRotor = null; it.legL = null; it.legR = null; it.legs = null; it.mouth = null;
  }

  // ---- Actor physics: nearby actors are SOLID -----------------------------
  // Vehicles are kinematic (ANIMATED) boxes that shove dynamic pedestrians and
  // the player; pedestrians are upright dynamic capsules so cars push them and
  // they bump each other. Bodies exist only while the actor is spawned.
  function makeVehicleCollider(type, x, z, rotY) {
    const d = type === "bike" ? [0.7, 1.2, 1.9] : type === "heli" ? [2.4, 2.0, 4.4] : [2.2, 1.5, 4.6];
    const c = BABYLON.MeshBuilder.CreateBox("acol", { width: d[0], height: d[1], depth: d[2] }, scene);
    c.position.set(x, d[1] / 2, z); c.rotation.y = rotY; c.isVisible = false; c.isPickable = false;
    const agg = new BABYLON.PhysicsAggregate(c, BABYLON.PhysicsShapeType.BOX, { mass: 1500, friction: 0.3, restitution: 0 }, scene);
    agg.body.setAngularDamping(100);
    agg.body.setMassProperties({ inertia: BABYLON.Vector3.Zero() });   // heavy + never tips: shoves peds, holds against the player
    return { collider: c, agg };
  }
  function makePedCollider(x, z) {
    const c = BABYLON.MeshBuilder.CreateCapsule("pcol", { radius: 0.3, height: 1.7 }, scene);
    c.position.set(x, 0.9, z); c.isVisible = false; c.isPickable = false;
    const agg = new BABYLON.PhysicsAggregate(c, BABYLON.PhysicsShapeType.CAPSULE, { mass: 70, restitution: 0, friction: 0.8 }, scene);
    agg.body.setAngularDamping(100);
    agg.body.setLinearDamping(0.4);
    agg.body.setMassProperties({ inertia: BABYLON.Vector3.Zero() });   // stay upright
    return { collider: c, agg };
  }
  // Drive the heavy dynamic collider toward its visual via velocity, so it
  // actually pushes pedestrians / blocks the player instead of tunnelling
  // through them (kinematic teleport doesn't impart contact in this Havok build).
  function driveCollider(it, dt) {
    if (!it.agg || !it.collider) return;
    const c = it.collider.position, n = it.node.position, k = 1 / Math.max(dt, 0.016);
    it.agg.body.setLinearVelocity(new BABYLON.Vector3((n.x - c.x) * k, (n.y - c.y) * k, (n.z - c.z) * k));
  }

  // ---- Coastline + ocean (north, +Z) ----
  function buildOcean() {
    const beach = BABYLON.MeshBuilder.CreateGround("beach", { width: 3600, height: 200 }, scene);
    beach.position.set(0, 0.04, 640);
    const sand = new BABYLON.StandardMaterial("sandMat", scene);
    sand.diffuseColor = new BABYLON.Color3(0.82, 0.74, 0.52);
    sand.specularColor = new BABYLON.Color3(0.04, 0.04, 0.04);
    beach.material = sand; beach.receiveShadows = true; beach.freezeWorldMatrix();

    water = BABYLON.MeshBuilder.CreateGround("water", { width: 4400, height: 2800 }, scene);
    water.position.set(0, 0.08, 2150);
    const wMat = new BABYLON.StandardMaterial("waterMat", scene);
    wMat.diffuseColor = new BABYLON.Color3(0.05, 0.28, 0.46);
    wMat.specularColor = new BABYLON.Color3(0.7, 0.8, 0.9);
    wMat.specularPower = 96;
    wMat.emissiveColor = new BABYLON.Color3(0.02, 0.07, 0.12);
    wMat.alpha = 0.9;
    const wb = new BABYLON.DynamicTexture("wbump", { width: 256, height: 256 }, scene, true);
    const wx = wb.getContext();
    wx.fillStyle = "#808080"; wx.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 1600; i++) {
      const s = 1 + Math.random() * 2;
      wx.fillStyle = Math.random() < 0.5 ? "rgba(255,255,255,0.5)" : "rgba(0,0,0,0.5)";
      wx.fillRect(Math.random() * 256, Math.random() * 256, s, s);
    }
    wb.update();
    wb.wrapU = wb.wrapV = BABYLON.Texture.WRAP_ADDRESSMODE; wb.uScale = wb.vScale = 45;
    wMat.bumpTexture = wb;
    water.material = wMat; water.isPickable = false;

    // small islands with palms
    for (let i = 0; i < 3; i++) {
      const ix = rand(1600), iz = 1500 + Math.random() * 1100;
      const isle = BABYLON.MeshBuilder.CreateSphere("isle", { diameter: 1, segments: 8 }, scene);
      isle.scaling.set(55 + Math.random() * 55, 11, 55 + Math.random() * 55);
      isle.position.set(ix, 1.5, iz); isle.material = sand; isle.isPickable = false; isle.freezeWorldMatrix();
      makeTree(ix, iz, 1.4, true);
    }
  }

  // ---- Village (south, -Z): cottages, dirt yards, trees ----
  function buildVillage() {
    const dirt = new BABYLON.StandardMaterial("dirtMat", scene);
    dirt.diffuseColor = new BABYLON.Color3(0.46, 0.37, 0.24);
    dirt.specularColor = new BABYLON.Color3(0, 0, 0);
    const yard = BABYLON.MeshBuilder.CreateGround("yard", { width: 2300, height: 1400 }, scene);
    yard.position.set(0, 0.03, -1150); yard.material = dirt; yard.receiveShadows = true; yard.freezeWorldMatrix();

    const cols = [[0.88, 0.83, 0.72], [0.82, 0.72, 0.6], [0.72, 0.76, 0.8], [0.86, 0.62, 0.52]];
    for (let i = 0; i < 24; i++) {
      const x = rand(1000), z = -740 - Math.random() * 780;
      makeHouse(x, z, Math.random() * Math.PI, cols[i % cols.length]);
      if (Math.random() < 0.7) makeTree(x + rand(34), z + rand(34), 0.9 + Math.random() * 0.5);
    }
  }

  // ---- Trees scattered across the countryside ----
  function buildNature() {
    for (let i = 0; i < 90; i++) {
      const x = rand(2400), z = rand(2400);
      if (Math.abs(x) < 560 && Math.abs(z) < 560) continue; // not downtown
      if (z > 540) continue;                                // not in the sea
      makeTree(x, z, 0.8 + Math.random() * 0.8, Math.random() < 0.4);
    }
  }

  function makeTree(x, z, scale, palm) {
    const trunk = BABYLON.MeshBuilder.CreateCylinder("trunk",
      { diameterTop: 0.4 * scale, diameterBottom: 0.6 * scale, height: 4 * scale, tessellation: 6 }, scene);
    trunk.material = scene.getMaterialByName("trunkMat") || mat("trunkMat", new BABYLON.Color3(0.36, 0.25, 0.15));
    trunk.position.set(x, 2 * scale, z); trunk.isPickable = false;
    shadowGen.addShadowCaster(trunk); trunk.freezeWorldMatrix();
    if (palm) {
      const pm = scene.getMaterialByName("palmMat") || mat("palmMat", new BABYLON.Color3(0.22, 0.52, 0.26));
      for (let f = 0; f < 6; f++) {
        const fr = BABYLON.MeshBuilder.CreateBox("frond", { width: 0.3 * scale, height: 0.1, depth: 3.2 * scale }, scene);
        fr.material = pm; fr.position.set(x, 4 * scale, z);
        fr.rotation.set(0.5, (f / 6) * Math.PI * 2, 0); fr.isPickable = false; fr.freezeWorldMatrix();
      }
    } else {
      const lm = scene.getMaterialByName("leafMat") || mat("leafMat", new BABYLON.Color3(0.18, 0.42, 0.2));
      const crown = BABYLON.MeshBuilder.CreateSphere("crown", { diameter: 3.4 * scale, segments: 6 }, scene);
      crown.material = lm; crown.position.set(x, 4.4 * scale, z); crown.scaling.y = 1.2;
      crown.isPickable = false; shadowGen.addShadowCaster(crown); crown.freezeWorldMatrix();
    }
  }

  function makeHouse(x, z, rotY, col) {
    const node = new BABYLON.TransformNode("house", scene);
    node.position.set(x, 0, z); node.rotation.y = rotY;
    const w = 7 + Math.random() * 4, d = 6 + Math.random() * 3, h = 3.4 + Math.random() * 1.4;
    const wallMat = new BABYLON.StandardMaterial("wall", scene);
    wallMat.diffuseColor = new BABYLON.Color3(col[0], col[1], col[2]);
    wallMat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
    const walls = BABYLON.MeshBuilder.CreateBox("walls", { width: w, height: h, depth: d }, scene);
    walls.material = wallMat; walls.parent = node; walls.position.y = h / 2;
    walls.receiveShadows = true; shadowGen.addShadowCaster(walls);
    new BABYLON.PhysicsAggregate(walls, BABYLON.PhysicsShapeType.BOX, { mass: 0, friction: 0.7 }, scene);
    obstacles.push({ x, z, hw: Math.max(w, d) / 2 + 1.4, hd: Math.max(w, d) / 2 + 1.4 });
    const roof = BABYLON.MeshBuilder.CreateCylinder("roof",
      { diameterTop: 0, diameterBottom: Math.hypot(w, d) * 0.92, height: 2.4, tessellation: 4 }, scene);
    roof.material = scene.getMaterialByName("roofMat") || mat("roofMat", new BABYLON.Color3(0.5, 0.22, 0.18));
    roof.parent = node; roof.position.y = h + 1.0; roof.rotation.y = Math.PI / 4; shadowGen.addShadowCaster(roof);
    const door = BABYLON.MeshBuilder.CreateBox("door", { width: 1.1, height: 2, depth: 0.12 }, scene);
    door.material = roof.material; door.parent = node; door.position.set(0, 1, d / 2 + 0.02);
  }

  // ---- Pedestrians strolling the sidewalks (lazy) ----
  const PED_SHIRTS = [[0.82, 0.3, 0.3], [0.2, 0.42, 0.72], [0.3, 0.62, 0.42], [0.72, 0.62, 0.24], [0.6, 0.32, 0.6], [0.85, 0.85, 0.88]];
  function buildPedestrians() {
    for (let i = 0; i < 16; i++) {
      const onX = Math.random() < 0.5;
      const lane = (Math.floor(Math.random() * 9) - 4) * 120 + (Math.random() < 0.5 ? 11 : -11);
      const start = rand(440);
      peds.push({
        onX, dir: Math.random() < 0.5 ? 1 : -1, base: onX ? Math.PI / 2 : 0,
        speed: 1.1 + Math.random() * 1.2, range: 60 + Math.random() * 120, travel: 0, phase: Math.random() * 6,
        x: onX ? start : lane, z: onX ? lane : start, col: PED_SHIRTS[i % PED_SHIRTS.length], node: null, legL: null, legR: null,
      });
    }
  }
  function spawnPed(it) {
    const skin = scene.getMaterialByName("pedSkin") || mat("pedSkin", new BABYLON.Color3(0.82, 0.62, 0.5));
    const sm = cachedMat("pedShirt_" + it.col.join("_"), it.col, 0.05);
    const c = makePedCollider(it.x, it.z);
    it.collider = c.collider; it.agg = c.agg; it.node = c.collider;   // dynamic capsule = physics root
    const vis = new BABYLON.TransformNode("pvis", scene); vis.parent = c.collider; vis.position.y = -0.9;
    vis.rotation.y = it.base + (it.dir > 0 ? 0 : Math.PI);
    const torso = BABYLON.MeshBuilder.CreateBox("pt", { width: 0.4, height: 0.7, depth: 0.24 }, scene);
    torso.material = sm; torso.parent = vis; torso.position.y = 1.15; torso.isPickable = false;
    const head = BABYLON.MeshBuilder.CreateSphere("ph", { diameter: 0.3, segments: 6 }, scene);
    head.material = skin; head.parent = vis; head.position.y = 1.62; head.isPickable = false;
    const mkLeg = (sx) => {
      const j = new BABYLON.TransformNode("pl", scene); j.parent = vis; j.position.set(sx, 0.8, 0);
      const l = BABYLON.MeshBuilder.CreateBox("plm", { width: 0.14, height: 0.7, depth: 0.18 }, scene);
      l.material = sm; l.parent = j; l.position.y = -0.35; l.isPickable = false; return j;
    };
    it.vis = vis; it.legL = mkLeg(0.1); it.legR = mkLeg(-0.1);
  }
  function animatePedestrians(dt) {
    for (const p of peds) {
      if (!p.node) continue;                 // despawned → no work
      p.travel += p.speed * dt;
      if (p.travel > p.range) { p.travel = 0; p.dir *= -1; }
      // walk along the lane via velocity; preserve the perpendicular axis so a
      // car (or another body) can shove the pedestrian sideways.
      const v = p.agg.body.getLinearVelocity();
      const vx = p.onX ? p.dir * p.speed : v.x;
      const vz = p.onX ? v.z : p.dir * p.speed;
      p.agg.body.setLinearVelocity(new BABYLON.Vector3(vx, v.y, vz));
      const cp = p.collider.position; p.x = cp.x; p.z = cp.z;     // descriptor follows physics
      p.vis.rotation.y = p.base + (p.dir > 0 ? 0 : Math.PI);
      p.phase += dt * 5;
      const sw = Math.sin(p.phase) * 0.5;
      p.legL.rotation.x = sw; p.legR.rotation.x = -sw;
    }
  }

  // ---- Birds circling overhead ----
  function buildBirds() {
    const bm = mat("birdMat", new BABYLON.Color3(0.12, 0.12, 0.14));
    for (let i = 0; i < 10; i++) {
      const node = new BABYLON.TransformNode("bird" + i, scene);
      const wl = BABYLON.MeshBuilder.CreateBox("wl", { width: 1.2, height: 0.05, depth: 0.35 }, scene);
      wl.material = bm; wl.parent = node; wl.position.x = 0.6; wl.isPickable = false; wl.applyFog = false;
      const wr = BABYLON.MeshBuilder.CreateBox("wr", { width: 1.2, height: 0.05, depth: 0.35 }, scene);
      wr.material = bm; wr.parent = node; wr.position.x = -0.6; wr.isPickable = false; wr.applyFog = false;
      birds.push({ node, wl, wr, cx: rand(1500), cz: rand(1500), r: 60 + Math.random() * 130, a: Math.random() * 6.28, y: 90 + Math.random() * 90, sp: 0.1 + Math.random() * 0.15, flap: Math.random() * 6 });
    }
  }
  function animateBirds(dt) {
    for (const b of birds) {
      b.a += b.sp * dt;
      b.node.position.set(b.cx + Math.cos(b.a) * b.r, b.y, b.cz + Math.sin(b.a) * b.r);
      b.node.rotation.y = -b.a + Math.PI / 2;
      b.flap += dt * 8;
      const f = Math.sin(b.flap) * 0.5;
      b.wl.rotation.z = -f; b.wr.rotation.z = f;
    }
  }

  // ========================================================================
  //  Character (GTA-style regular person — no wings)
  // ========================================================================
  function buildHero() {
    heroMesh = BABYLON.MeshBuilder.CreateCapsule("hero", { radius: 0.45, height: 1.9 }, scene);
    heroMesh.isVisible = false; heroMesh.isPickable = false;
    heroMesh.position = new BABYLON.Vector3(0, 1.2, 0);

    const agg = new BABYLON.PhysicsAggregate(heroMesh, BABYLON.PhysicsShapeType.CAPSULE,
      { mass: 75, restitution: 0, friction: 0.1 }, scene);
    heroBody = agg.body;
    heroBody.setAngularDamping(100);
    heroBody.setMassProperties({ inertia: BABYLON.Vector3.Zero() });

    model = new BABYLON.TransformNode("model", scene);
    model.rotationQuaternion = BABYLON.Quaternion.Identity();
    model.parent = heroMesh;
    model.position.set(0, -0.95, 0); // model origin at the feet

    // ---- A lifelike human, built from rounded primitives and merged into a
    // handful of meshes. Proportions are realistic (~7.5 heads tall); the head
    // carries a real face (eyes, brows, nose, lips, ears, hair); arms and legs
    // are jointed so they still animate. Skin has a soft sheen; clothing is matte.
    const mkMat = (name, d, spec, sp) => {
      let m = scene.getMaterialByName(name);
      if (!m) { m = new BABYLON.StandardMaterial(name, scene); m.diffuseColor = d; m.specularColor = spec || new BABYLON.Color3(0.05, 0.05, 0.05); if (sp) m.specularPower = sp; }
      return m;
    };
    const skin = mkMat("skin", new BABYLON.Color3(0.80, 0.61, 0.49), new BABYLON.Color3(0.18, 0.15, 0.13), 28);
    const shirt = mkMat("shirt", new BABYLON.Color3(0.16, 0.36, 0.46));
    const pants = mkMat("pants", new BABYLON.Color3(0.17, 0.19, 0.24));
    const shoe = mkMat("shoe", new BABYLON.Color3(0.09, 0.09, 0.11), new BABYLON.Color3(0.2, 0.2, 0.22), 40);
    const hair = mkMat("hair", new BABYLON.Color3(0.11, 0.08, 0.06));
    const eyeW = mkMat("eyeW", new BABYLON.Color3(0.92, 0.92, 0.9), new BABYLON.Color3(0.4, 0.4, 0.4), 64);
    const iris = mkMat("iris", new BABYLON.Color3(0.22, 0.14, 0.08), new BABYLON.Color3(0.3, 0.3, 0.3), 64);
    const lip = mkMat("lip", new BABYLON.Color3(0.62, 0.33, 0.31));

    const MB = BABYLON.MeshBuilder, V = (x, y, z) => new BABYLON.Vector3(x, y, z);
    let bin = [];
    const P = (kind, opt, mtl, x, y, z, scl, rot) => {
      const e = MB["Create" + kind]("p", opt, scene);
      e.material = mtl; e.position.set(x, y, z);
      if (scl) e.scaling.copyFrom(scl); if (rot) e.rotation.copyFrom(rot);
      bin.push(e); return e;
    };
    const fuse = (parent, name, pos) => {
      const m = BABYLON.Mesh.MergeMeshes(bin, true, true, undefined, false, true);
      bin = [];
      m.name = name; m.isPickable = false; m.parent = parent || model;
      if (pos) m.position.copyFrom(pos);
      shadowGen.addShadowCaster(m); return m;
    };

    // ---- HEAD (built around its own centre, then placed at the neck top) ----
    P("Sphere", { diameter: 0.3, segments: 16 }, skin, 0, 0.05, 0, V(0.94, 1.04, 0.98));     // cranium
    P("Sphere", { diameter: 0.25, segments: 14 }, skin, 0, -0.08, 0.012, V(0.86, 0.92, 0.92)); // cheeks / jaw
    P("Box", { width: 0.2, height: 0.05, depth: 0.04 }, skin, 0, -0.165, 0.085);              // chin/jawline
    P("Box", { width: 0.22, height: 0.03, depth: 0.04 }, skin, 0, 0.075, 0.125);             // brow ridge
    P("Cylinder", { diameterTop: 0.03, diameterBottom: 0.07, height: 0.1, tessellation: 8 }, skin, 0, -0.02, 0.15, null, V(1.4, 0, 0)); // nose
    for (const s of [-1, 1]) {
      P("Sphere", { diameter: 0.07, segments: 10 }, eyeW, s * 0.068, 0.01, 0.128, V(1, 0.78, 0.7));  // eyeball
      P("Sphere", { diameter: 0.034, segments: 8 }, iris, s * 0.072, 0.01, 0.157);                   // iris
      P("Box", { width: 0.075, height: 0.014, depth: 0.02 }, hair, s * 0.07, 0.065, 0.15, null, V(0, 0, -s * 0.12)); // eyebrow
      P("Sphere", { diameter: 0.065, segments: 8 }, skin, s * 0.158, -0.01, 0.0, V(0.45, 1, 0.85));  // ear
    }
    P("Box", { width: 0.085, height: 0.022, depth: 0.03 }, lip, 0, -0.115, 0.13);            // lips
    // hair: scalp cap + back + sideburns (kept off the face)
    P("Sphere", { diameter: 0.315, segments: 16, slice: 0.62 }, hair, 0, 0.055, -0.004, V(1.02, 1.0, 1.04));
    P("Sphere", { diameter: 0.3, segments: 12 }, hair, 0, 0.04, -0.06, V(0.96, 0.95, 0.7));
    fuse(model, "head", V(0, 1.71, 0.012));

    // ---- TORSO (static): neck, shoulders, tapered chest→waist, pelvis -------
    P("Cylinder", { diameterTop: 0.12, diameterBottom: 0.15, height: 0.16, tessellation: 12 }, skin, 0, 1.52, 0.005);   // neck
    P("Box", { width: 0.44, height: 0.14, depth: 0.22 }, shirt, 0, 1.45, 0, V(1, 1, 1), V(0, 0, 0));                    // shoulders/traps
    P("Capsule", { radius: 0.165, height: 0.46, tessellation: 12 }, shirt, 0, 1.24, 0, V(1.18, 1, 0.74));               // chest
    P("Capsule", { radius: 0.145, height: 0.34, tessellation: 12 }, shirt, 0, 0.99, 0, V(1.06, 1, 0.72));               // waist
    P("Box", { width: 0.38, height: 0.26, depth: 0.24 }, pants, 0, 0.8, 0);                                            // pelvis
    for (const s of [-1, 1]) P("Sphere", { diameter: 0.2, segments: 12 }, shirt, s * 0.3, 1.44, 0, V(1, 0.95, 1));      // deltoids
    fuse(model, "torso", V(0, 0, 0));

    // ---- LIMBS on joint nodes (so they swing); each whole limb is one mesh --
    const limb = (key, x0, isLeg) => {
      const j = new BABYLON.TransformNode(key, scene); j.parent = model;
      j.position.set(x0, isLeg ? 0.78 : 1.42, 0);
      if (isLeg) {
        P("Capsule", { radius: 0.105, height: 0.4, tessellation: 10 }, pants, 0, -0.2, 0, V(1, 1, 0.95));    // thigh
        P("Sphere", { diameter: 0.15, segments: 10 }, pants, 0, -0.4, 0);                                    // knee
        P("Capsule", { radius: 0.08, height: 0.36, tessellation: 10 }, pants, 0, -0.58, 0.005, V(1, 1, 0.9));// calf
        P("Box", { width: 0.12, height: 0.08, depth: 0.16, }, shoe, 0, -0.75, 0.03);                          // ankle/heel
        P("Box", { width: 0.115, height: 0.06, depth: 0.12 }, shoe, 0, -0.77, 0.14);                          // toe
      } else {
        P("Sphere", { diameter: 0.14, segments: 10 }, shirt, 0, -0.02, 0);                                   // shoulder cap
        P("Capsule", { radius: 0.062, height: 0.3, tessellation: 10 }, shirt, 0, -0.18, 0);                  // upper arm (sleeve)
        P("Sphere", { diameter: 0.095, segments: 8 }, skin, 0, -0.34, 0);                                    // elbow
        P("Capsule", { radius: 0.052, height: 0.26, tessellation: 10 }, skin, 0, -0.47, 0.01);               // forearm
        P("Box", { width: 0.075, height: 0.1, depth: 0.04 }, skin, 0, -0.6, 0.015);                          // palm
        P("Box", { width: 0.072, height: 0.055, depth: 0.035 }, skin, 0, -0.655, 0.02);                      // fingers
        P("Box", { width: 0.024, height: 0.05, depth: 0.03 }, skin, x0 > 0 ? -0.04 : 0.04, -0.6, 0.025);     // thumb
      }
      fuse(j, key + "M", V(0, 0, 0));
      joints[key] = j;
      return j;
    };
    limb("armL", 0.32, false); limb("armR", -0.32, false);
    limb("legL", 0.13, true); limb("legR", -0.13, true);

    buildGun();
  }

  // ---- The player's heavy weapon: a sophisticated rocket launcher -----------
  // A shouldered tube (one merged static mesh on the hand joint) plus a rocket
  // prototype and pooled FX that stay idle (zero cost) until you pull the trigger.
  function buildGun() {
    const metal = mat("gunMetal", new BABYLON.Color3(0.16, 0.18, 0.14));   // olive-drab military body
    metal.specularColor = new BABYLON.Color3(0.4, 0.42, 0.45); metal.specularPower = 64;
    const dark = mat("gunDark", new BABYLON.Color3(0.07, 0.075, 0.08));
    const accent = new BABYLON.StandardMaterial("gunAccent", scene);       // cyan tech glow — matches the brand
    accent.diffuseColor = new BABYLON.Color3(0.04, 0.5, 0.62);
    accent.emissiveColor = new BABYLON.Color3(0.0, 0.55, 0.72);
    accent.specularColor = new BABYLON.Color3(0.2, 0.2, 0.2);
    const warhead = mat("rktHead", new BABYLON.Color3(0.7, 0.16, 0.12));

    // gunPivot sits at the right hand; rotation.x maps the launcher's +z (the
    // bore) onto the forearm's −y, so when the arm raises, the tube points ahead.
    gunPivot = new BABYLON.TransformNode("gunPivot", scene);
    gunPivot.parent = joints["armR"];
    gunPivot.position.set(0, -0.62, 0.05);
    gunPivot.rotation.x = Math.PI / 2;

    const parts = [];
    const box = (w, h, d, m, x, y, z, rx) => { const e = BABYLON.MeshBuilder.CreateBox("gun", { width: w, height: h, depth: d }, scene); e.material = m; e.position.set(x, y, z); if (rx) e.rotation.x = rx; parts.push(e); return e; };
    const tube = (dia, h, m, x, y, z, tess) => { const e = BABYLON.MeshBuilder.CreateCylinder("gun", { diameter: dia, height: h, tessellation: tess || 16 }, scene); e.material = m; e.rotation.x = Math.PI / 2; e.position.set(x, y, z); parts.push(e); return e; };
    tube(0.26, 1.15, metal, 0, 0, 0.05);               // main launch tube
    tube(0.3, 0.12, dark, 0, 0, 0.62);                 // flared muzzle
    tube(0.31, 0.1, dark, 0, 0, -0.5);                 // rear exhaust cone
    tube(0.265, 0.5, accent, 0, 0, 0.05, 16);          // thin glowing ring band around the tube
    box(0.28, 0.05, 0.5, accent, 0, 0.0, 0.05);        // glowing top data-strip
    box(0.1, 0.16, 0.34, dark, 0, 0.17, 0.04);         // optic housing on top
    tube(0.07, 0.16, dark, 0, 0.26, 0.1, 12);          // scope lens
    box(0.05, 0.07, 0.05, accent, 0, 0.27, 0.18);      // glowing reticle dot on the scope
    box(0.09, 0.26, 0.1, dark, 0, -0.2, -0.06, 0.32);  // pistol grip
    box(0.07, 0.06, 0.16, dark, 0, -0.05, 0.24);       // fore grip
    box(0.16, 0.12, 0.2, metal, 0.0, -0.12, -0.18);    // trigger/body block

    const gun = BABYLON.Mesh.MergeMeshes(parts, true, true, undefined, false, true);
    gun.name = "gun"; gun.isPickable = false; gun.parent = gunPivot; gun.position.set(0, 0, 0);
    shadowGen.addShadowCaster(gun);

    // muzzle reference point + a back-blast flash that flares only on launch
    muzzle = new BABYLON.TransformNode("muzzle", scene); muzzle.parent = gunPivot; muzzle.position.set(0, 0, 0.72);
    const flashMat = new BABYLON.StandardMaterial("flashMat", scene);
    flashMat.emissiveColor = new BABYLON.Color3(1, 0.7, 0.3); flashMat.diffuseColor = new BABYLON.Color3(0, 0, 0);
    flashMat.disableLighting = true; flashMat.specularColor = new BABYLON.Color3(0, 0, 0);
    muzzleFlash = BABYLON.MeshBuilder.CreateSphere("muzzleFlash", { diameter: 0.55, segments: 6 }, scene);
    muzzleFlash.material = flashMat; muzzleFlash.parent = muzzle; muzzleFlash.scaling.set(1, 1, 1.4);
    muzzleFlash.isPickable = false; muzzleFlash.setEnabled(false);

    // rocket prototype: warhead cone + body + tail fins + a glowing exhaust.
    const rp = [];
    const rcone = BABYLON.MeshBuilder.CreateCylinder("rk", { diameterTop: 0, diameterBottom: 0.22, height: 0.34, tessellation: 12 }, scene);
    rcone.material = warhead; rcone.rotation.x = Math.PI / 2; rcone.position.z = 0.42; rp.push(rcone);
    const rbody = BABYLON.MeshBuilder.CreateCylinder("rk", { diameter: 0.22, height: 0.6, tessellation: 12 }, scene);
    rbody.material = dark; rbody.rotation.x = Math.PI / 2; rbody.position.z = 0.08; rp.push(rbody);
    const rband = BABYLON.MeshBuilder.CreateCylinder("rk", { diameter: 0.235, height: 0.1, tessellation: 12 }, scene);
    rband.material = accent; rband.rotation.x = Math.PI / 2; rband.position.z = 0.2; rp.push(rband);
    for (let f = 0; f < 4; f++) { const fin = BABYLON.MeshBuilder.CreateBox("rk", { width: 0.02, height: 0.2, depth: 0.2 }, scene); fin.material = dark; fin.position.z = -0.16; fin.rotation.z = f * Math.PI / 2; fin.position.x = Math.cos(f * Math.PI / 2) * 0.14; fin.position.y = Math.sin(f * Math.PI / 2) * 0.14; rp.push(fin); }
    rocketProto = BABYLON.Mesh.MergeMeshes(rp, true, true, undefined, false, true);
    rocketProto.name = "rocketProto"; rocketProto.isPickable = false; rocketProto.setEnabled(false);
    const flame = BABYLON.MeshBuilder.CreateCylinder("rkFlame", { diameterTop: 0.18, diameterBottom: 0.02, height: 0.5, tessellation: 8 }, scene);
    flame.material = flashMat; flame.rotation.x = -Math.PI / 2; flame.position.z = -0.45; flame.parent = rocketProto; flame.isPickable = false;

    const soft = makeSoftTexture();
    // shared blood burst for direct/▒nearby kills (idle = 0 particles, ~0 cost)
    bloodPS = burstSystem("blood", soft, 200, [0.7, 0.02, 0.02], [0.35, 0, 0], 0.18, 0.6, -14);
    // shared explosion fireball (orange→black), and a rising smoke puff
    boomPS = burstSystem("boom", soft, 360, [1, 0.6, 0.15], [1, 0.25, 0.0], 1.2, 4.5, 4);
    boomPS.blendMode = BABYLON.ParticleSystem.BLENDMODE_ONEONE;
    boomPS.colorDead = new BABYLON.Color4(0.2, 0.05, 0, 0);
    boomPS.minLifeTime = 0.3; boomPS.maxLifeTime = 0.9; boomPS.minEmitPower = 6; boomPS.maxEmitPower = 22;
    smokePS = burstSystem("boomSmoke", soft, 220, [0.1, 0.1, 0.11], [0.04, 0.04, 0.05], 2, 7, 7);
    smokePS.minLifeTime = 1.2; smokePS.maxLifeTime = 3; smokePS.minEmitPower = 2; smokePS.maxEmitPower = 8;
    smokePS.color1 = new BABYLON.Color4(0.12, 0.12, 0.13, 0.6); smokePS.color2 = new BABYLON.Color4(0.04, 0.04, 0.05, 0.5);

    gunPivot.setEnabled(false);                // holstered by default — clean, fast start
  }
  // Take or leave the rocket launcher. When holstered the weapon is fully gone:
  // no mesh, no aim pose, no reticle, no fire button — the default clean view.
  function setArmed(on) {
    armed = on;
    if (gunPivot) gunPivot.setEnabled(on);
    if (!on) firing = false;
    const dot = document.getElementById("dot"); if (dot) dot.classList.toggle("hidden", !on);
    const wb = document.getElementById("weapon-btn");
    if (wb) { wb.classList.toggle("on", on); wb.textContent = on ? "🚀 ARMED" : "🚀 ARM"; }
    if (isTouch()) updateTouchUI();
  }
  function toggleArmed() { setArmed(!armed); }

  // ---- Melee: a bare-handed punch that knocks the thing in front of you flying.
  // Event-driven: a forward cone check over the small set of spawned creatures,
  // only when you actually throw a punch.
  function punch() {
    if (punchCD > 0 || mode !== MODE.WALK) return;
    punchCD = MELEE_CD; punchT = MELEE_SWING;
    const p = heroMesh.position;
    const fx = Math.sin(modelYaw), fz = Math.cos(modelYaw);     // facing direction
    let best = null, bestKind = null, bestD = MELEE_RANGE * MELEE_RANGE;
    for (const kind of KINDS) {
      const list = ({ peds, ghosts, giants, rhinos, dinos })[kind];
      for (const it of list) {
        if (!it.node || it.dead) continue;
        const c = it.node.getAbsolutePosition();
        const dx = c.x - p.x, dz = c.z - p.z, d2 = dx * dx + dz * dz;
        if (d2 > bestD) continue;
        const dl = Math.sqrt(d2) || 1;
        if ((dx / dl) * fx + (dz / dl) * fz < 0.45) continue;    // must be in front
        bestD = d2; best = it; bestKind = kind;
      }
    }
    punchSound();
    if (best) {
      const c = best.node.getAbsolutePosition();
      killActor(best, bestKind, new BABYLON.Vector3(fx, 0.5, fz), c);   // send it flying forward
    }
  }
  function punchSound() {
    const ctx = audio(); if (!ctx) return;
    try {
      const t = ctx.currentTime;
      const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.playbackRate.value = 0.9;
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.setValueAtTime(900, t); bp.frequency.exponentialRampToValueAtTime(180, t + 0.12); bp.Q.value = 0.8;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.4, t + 0.008); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.16);
      src.connect(bp); bp.connect(g); g.connect(ctx.destination); src.start(t); src.stop(t + 0.18);
    } catch (e) {}
  }

  // Build a pooled, manual-emit particle burst system (starts emitting nothing).
  function burstSystem(name, tex, cap, c1, c2, minS, maxS, gy) {
    const ps = new BABYLON.ParticleSystem(name, cap, scene);
    ps.particleTexture = tex;
    ps.emitter = new BABYLON.Vector3(0, -80, 0);
    ps.minEmitBox = new BABYLON.Vector3(-0.2, -0.2, -0.2); ps.maxEmitBox = new BABYLON.Vector3(0.2, 0.2, 0.2);
    ps.color1 = new BABYLON.Color4(c1[0], c1[1], c1[2], 1); ps.color2 = new BABYLON.Color4(c2[0], c2[1], c2[2], 1);
    ps.colorDead = new BABYLON.Color4(c2[0] * 0.4, 0, 0, 0);
    ps.minSize = minS; ps.maxSize = maxS;
    ps.minLifeTime = 0.25; ps.maxLifeTime = 0.7;
    ps.emitRate = 0;                            // bursts via manualEmitCount only
    ps.gravity = new BABYLON.Vector3(0, gy, 0);
    ps.direction1 = new BABYLON.Vector3(-3, 1, -3); ps.direction2 = new BABYLON.Vector3(3, 5, 3);
    ps.minEmitPower = 2; ps.maxEmitPower = 7; ps.updateSpeed = 0.02;
    ps.start();
    return ps;
  }

  // Hit volume (centre height above the node origin, radius) per actor kind —
  // scaled by the actor's own size so big monsters are easy to hit.
  const KINDS = ["peds", "ghosts", "giants", "rhinos", "dinos"];
  const HIT = {
    peds:   { hf: 1.0, rf: 1.4 }, ghosts: { hf: 1.1, rf: 1.7 },
    giants: { hf: 1.7, rf: 1.6 }, rhinos: { hf: 0.9, rf: 1.8 }, dinos: { hf: 2.0, rf: 2.0 },
  };
  // Fire a rocket from the launcher straight down the reticle. The projectile
  // flies, and detonates on the first body / the ground / a building.
  function launchRocket() {
    if (!muzzle || !rocketProto) return;
    const mz = muzzle.getAbsolutePosition();
    const aim = cam.getDirection(BABYLON.Axis.Z).normalize();   // reticle direction
    const node = rocketProto.clone("rocket");
    node.setEnabled(true); node.position.copyFrom(mz);
    node.rotationQuaternion = BABYLON.Quaternion.FromLookDirectionLH(aim, BABYLON.Axis.Y);
    rockets.push({ node, dir: aim, x: mz.x, y: mz.y, z: mz.z, life: GUN_RANGE / ROCKET_SPEED });
    backBlast();
    launchSound();
  }
  // Move every in-flight rocket; detonate on contact. Bounded by how fast you
  // fire (rockets are short-lived) → no idle cost once they're gone.
  function updateRockets(dt) {
    if (!rockets.length) return;
    for (let i = rockets.length - 1; i >= 0; i--) {
      const r = rockets[i];
      const step = ROCKET_SPEED * dt;
      r.x += r.dir.x * step; r.y += r.dir.y * step; r.z += r.dir.z * step;
      r.node.position.set(r.x, r.y, r.z);
      r.life -= dt;
      let hit = r.life <= 0 || r.y <= 0.4 || (r.y < 80 && blocked(r.x, r.z));
      let victim = null, vkind = null;
      if (!hit) {
        for (const kind of KINDS) {
          const list = ({ peds, ghosts, giants, rhinos, dinos })[kind], cfg = HIT[kind];
          for (const it of list) {
            if (!it.node || it.dead) continue;
            const s = it.scale || it.baseScale || 1, rr = cfg.rf * s;
            const c = it.node.getAbsolutePosition();
            const dx = c.x - r.x, dy = (c.y + cfg.hf * s) - r.y, dz = c.z - r.z;
            if (dx * dx + dy * dy + dz * dz < rr * rr) { hit = true; victim = it; vkind = kind; break; }
          }
          if (hit) break;
        }
      }
      if (hit) {
        explode(new BABYLON.Vector3(r.x, Math.max(0.4, r.y), r.z), victim, vkind);
        r.node.dispose(); rockets.splice(i, 1);
      }
    }
  }
  // Area blast: a fireball + smoke, and everyone within BLAST_R is killed and
  // flung outward from the centre.
  function explode(center, direct, dkind) {
    boomBurst(center);
    explosionSound();
    const R2 = BLAST_R * BLAST_R;
    for (const kind of KINDS) {
      const list = ({ peds, ghosts, giants, rhinos, dinos })[kind];
      for (const it of list) {
        if (!it.node || it.dead) continue;
        const c = it.node.getAbsolutePosition();
        const dx = c.x - center.x, dz = c.z - center.z;
        if (it === direct || dx * dx + dz * dz < R2) {
          const len = Math.hypot(dx, dz) || 1;
          killActor(it, kind, new BABYLON.Vector3(dx / len, 0.4, dz / len), c);
        }
      }
    }
  }

  // Knock the victim off its feet and blow it apart, then dispose. The short
  // "dying" list is processed only while non-empty → no idle cost.
  function killActor(it, kind, aim, point) {
    it.dead = true;
    const node = it.node; it.node = null;
    if (it.agg) { it.agg.dispose(); it.agg = null; }
    if (it.collider && it.collider !== node) it.collider.dispose();
    it.collider = null;
    if (it.fire) { it.fire.dispose(); it.fire = null; }
    it.legL = it.legR = it.legs = it.mouth = null;
    const mms = [];
    if (node.material) mms.push(node.material);
    if (node.getChildMeshes) for (const c of node.getChildMeshes()) if (c.material) mms.push(c.material);
    const s = it.scale || it.baseScale || 1;
    const kb = 7 / Math.sqrt(s);                           // lighter folks fly further
    dying.push({
      node, mms, t: 0, ttl: 1.1, s0: node.scaling.x,
      vx: aim.x * kb + (Math.random() - 0.5) * 3, vy: 6 + Math.random() * 3, vz: aim.z * kb + (Math.random() - 0.5) * 3,
      sx: (Math.random() - 0.5) * 9, sy: (Math.random() - 0.5) * 9, sz: (Math.random() - 0.5) * 9,
    });
    bloodBurst(point, s);
  }
  function updateDying(dt) {
    if (!dying.length) return;
    for (let i = dying.length - 1; i >= 0; i--) {
      const d = dying[i]; d.t += dt; d.vy -= 16 * dt;
      const n = d.node;
      n.position.x += d.vx * dt; n.position.y += d.vy * dt; n.position.z += d.vz * dt;
      n.rotation.x += d.sx * dt; n.rotation.y += d.sy * dt; n.rotation.z += d.sz * dt;
      if (n.position.y < 0.2) { n.position.y = 0.2; d.vy *= -0.3; d.vx *= 0.6; d.vz *= 0.6; }
      const k = Math.max(0.001, 1 - d.t / d.ttl);
      n.scaling.setAll(d.s0 * k);                          // shrink to nothing
      if (d.t >= d.ttl) {
        n.dispose(false, false);
        for (const m of d.mms) if (m && m.getClassName && m.getClassName() === "MultiMaterial") m.dispose(false, false);
        dying.splice(i, 1);
      }
    }
  }
  function bloodBurst(point, s) {
    if (!bloodPS) return;
    bloodPS.emitter = point.clone();
    const scl = Math.min(3, Math.sqrt(s));
    bloodPS.minSize = 0.18 * scl; bloodPS.maxSize = 0.6 * scl;
    bloodPS.manualEmitCount = Math.round(34 * scl);        // one burst, then it stops on its own
  }
  function boomBurst(center) {
    if (boomPS) { boomPS.emitter = center.clone(); boomPS.manualEmitCount = 130; }
    if (smokePS) { smokePS.emitter = center.clone(); smokePS.manualEmitCount = 70; }
  }
  // Back-blast flash at the launcher muzzle, auto-hidden after a few frames.
  function backBlast() {
    if (muzzleFlash) { muzzleFlash.scaling.set(1 + Math.random() * 0.8, 1 + Math.random() * 0.8, 1.2 + Math.random()); muzzleFlash.rotation.z = Math.random() * 6.28; muzzleFlash.setEnabled(true); }
    fxT = 0.07;
  }
  function updateGunFX(dt) {
    if (fxT <= 0) return;                                  // idle: a single compare, no work
    fxT -= dt;
    if (fxT <= 0 && muzzleFlash) muzzleFlash.setEnabled(false);
  }
  function audio() {
    if (muted) return null;
    if (!sfxCtx) sfxCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (sfxCtx.state === "suspended") sfxCtx.resume();
    if (!noiseBuf) { noiseBuf = sfxCtx.createBuffer(1, Math.floor(sfxCtx.sampleRate * 0.6), sfxCtx.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1; }
    return sfxCtx;
  }
  // Launch: a sharp whoosh as the rocket leaves the tube.
  function launchSound() {
    const ctx = audio(); if (!ctx) return;
    try {
      const t = ctx.currentTime;
      const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.playbackRate.value = 1.4;
      const bp = ctx.createBiquadFilter(); bp.type = "bandpass"; bp.frequency.setValueAtTime(1600, t); bp.frequency.exponentialRampToValueAtTime(500, t + 0.25); bp.Q.value = 1.2;
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.4, t + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.3);
      src.connect(bp); bp.connect(g); g.connect(ctx.destination); src.start(t); src.stop(t + 0.32);
    } catch (e) {}
  }
  // Detonation: a deep boom + a noisy blast.
  function explosionSound() {
    const ctx = audio(); if (!ctx) return;
    try {
      const t = ctx.currentTime;
      const src = ctx.createBufferSource(); src.buffer = noiseBuf; src.playbackRate.value = 0.7;
      const lp = ctx.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.setValueAtTime(900, t); lp.frequency.exponentialRampToValueAtTime(120, t + 0.4);
      const g = ctx.createGain(); g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(0.7, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.5);
      src.connect(lp); lp.connect(g); g.connect(ctx.destination); src.start(t); src.stop(t + 0.55);
      const o = ctx.createOscillator(); o.type = "sine"; o.frequency.setValueAtTime(110, t); o.frequency.exponentialRampToValueAtTime(34, t + 0.35);
      const g2 = ctx.createGain(); g2.gain.setValueAtTime(0.8, t); g2.gain.exponentialRampToValueAtTime(0.0001, t + 0.4);
      o.connect(g2); g2.connect(ctx.destination); o.start(t); o.stop(t + 0.42);
    } catch (e) {}
  }

  function mat(name, color) {
    const m = new BABYLON.StandardMaterial(name, scene);
    m.diffuseColor = color; m.specularColor = new BABYLON.Color3(0.08, 0.08, 0.08);
    return m;
  }

  // Returns a shared material for a given key/color (created once, reused across
  // all spawns of that color). Lazy actors must use these so despawn never has
  // to free a material — keeping the world/hero materials and GlowLayer intact.
  function cachedMat(key, col, spec) {
    let m = scene.getMaterialByName(key);
    if (!m) {
      m = new BABYLON.StandardMaterial(key, scene);
      m.diffuseColor = new BABYLON.Color3(col[0], col[1], col[2]);
      m.specularColor = new BABYLON.Color3(spec, spec, spec);
    }
    return m;
  }

  // ========================================================================
  //  Camera (third-person orbit)
  // ========================================================================
  function buildCamera() {
    cam = new BABYLON.UniversalCamera("cam", new BABYLON.Vector3(0, 3, -8), scene);
    cam.fov = 1.05; cam.minZ = 0.5; cam.maxZ = 3200;
    scene.activeCamera = cam;
  }

  function updateCamera(dt, instant) {
    const heroPos = heroMesh.getAbsolutePosition();
    let target, desired;
    if ((mode === MODE.DRIVE || mode === MODE.HELI) && drivingCar) {
      const heli = mode === MODE.HELI;
      const fwd = new BABYLON.Vector3(Math.sin(carHeading), 0, Math.cos(carHeading));
      const p = drivingCar.node.position;
      target = new BABYLON.Vector3(p.x, p.y + (heli ? 1.8 : 1.4), p.z).add(fwd.scale(heli ? 2 : 3));
      desired = new BABYLON.Vector3(p.x, p.y + (heli ? 5 : 4.2), p.z).subtract(fwd.scale(heli ? 14 : 9));
    } else if (mode === MODE.FLY) {
      // Chase behind the flight heading so "up" on screen is always climb.
      const cp = Math.cos(flyPitch), sp = Math.sin(flyPitch);
      const fwd = new BABYLON.Vector3(Math.sin(flyYaw) * cp, sp, Math.cos(flyYaw) * cp);
      target = heroPos.add(fwd.scale(4)).add(new BABYLON.Vector3(0, 0.6, 0));
      desired = heroPos.subtract(fwd.scale(CAM_DIST_FLY)).add(new BABYLON.Vector3(0, 3.2, 0));
    } else {
      // GTA-style orbit (mouse-controlled) with a pull-in if a wall is behind.
      const cp = Math.cos(camPitch), sp = Math.sin(camPitch);
      const dir = new BABYLON.Vector3(Math.sin(camYaw) * cp, sp, Math.cos(camYaw) * cp);
      target = heroPos.add(new BABYLON.Vector3(0, 0.5, 0));
      desired = target.subtract(dir.scale(CAM_DIST_WALK));
      const ray = new BABYLON.Ray(target, desired.subtract(target).normalize(), CAM_DIST_WALK);
      const hit = scene.pickWithRay(ray, (m) => m.isPickable && m !== heroMesh);
      if (hit && hit.hit && hit.distance < CAM_DIST_WALK) desired = target.subtract(dir.scale(Math.max(1.5, hit.distance - 0.4)));
    }
    const camAlpha = instant ? 1 : 1 - Math.exp(-CAM_LERP * dt);
    cam.position = BABYLON.Vector3.Lerp(cam.position, desired, camAlpha);
    cam.setTarget(target);
  }

  function scrollWater(dt) {
    if (!water || !water.material || !water.material.bumpTexture) return;
    water.material.bumpTexture.uOffset += dt * 0.025;
    water.material.bumpTexture.vOffset += dt * 0.018;
  }

  // Cars cruise along their road lane and wrap around at the city edge.
  function animateTraffic(dt) {
    for (const t of traffic) {
      if (!t.node) continue;                 // despawned → no work
      const ax = t.onX ? "x" : "z";
      t[ax] += t.dir * t.speed * dt;
      if (t[ax] > 640) t[ax] = -640; else if (t[ax] < -640) t[ax] = 640;
      t.node.position[ax] = t[ax];
      driveCollider(t, dt);                   // collider chases the car, shoving pedestrians
    }
  }

  function areaName(p) {
    if ((p.x - ZOO_X) ** 2 + (p.z - ZOO_Z) ** 2 < (ZOO_R + 10) ** 2) return "THE ZOO";
    if (p.z > 720) return "OCEAN";
    if (p.z > 540) return "COAST";
    if (p.z < -680) return "VILLAGE";
    if (Math.abs(p.x) < 560 && Math.abs(p.z) < 560) return "DOWNTOWN";
    return "COUNTRYSIDE";
  }

  // ========================================================================
  //  Input
  // ========================================================================
  function setupInput() {
    const navKeys = ["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"];
    const onKey = (e, down) => {
      if (window.MP && MP.chatting) return;       // ignore game keys while typing
      keys[e.code] = down;
      if (navKeys.includes(e.code)) e.preventDefault();
      if (!down || state !== S.PLAYING) return;
      if (e.code === "KeyE") tryEnterExit();
      else if (e.code === "KeyF" && mode !== MODE.DRIVE) toggleMode();
      else if (e.code === "KeyG") toggleArmed();   // take / leave the rocket launcher
      else if (e.code === "KeyQ") punch();          // melee
      else if ((e.code === "Enter" || e.code === "KeyT") && window.MP && MP.enabled) MP.openChat();
    };
    window.addEventListener("keydown", (e) => onKey(e, true));
    window.addEventListener("keyup", (e) => onKey(e, false));

    canvas.addEventListener("click", () => {
      if (state === S.MENU) return start();
      if (state === S.PLAYING && !pointerLocked && !isTouch()) lockPointer();
    });
    document.addEventListener("pointerlockchange", () => {
      const locked = document.pointerLockElement === canvas;
      pointerLocked = locked;
      if (locked) lockedOnce = true;
      else if (lockedOnce && state === S.PLAYING && !isTouch() && !(window.MP && MP.chatting)) { lockedOnce = false; pauseGame(); }
    });
    window.addEventListener("mousemove", (e) => {
      if (state !== S.PLAYING || !pointerLocked) return;
      camYaw += e.movementX * MOUSE_SENS;
      camPitch = clamp(camPitch + e.movementY * MOUSE_SENS, CAM_PITCH_MIN, CAM_PITCH_MAX);
    });
    // Hold left mouse to fire (once the pointer is locked); release to stop.
    window.addEventListener("mousedown", (e) => { if (e.button === 0 && armed && state === S.PLAYING && pointerLocked) firing = true; });
    window.addEventListener("mouseup", (e) => { if (e.button === 0) firing = false; });
    window.addEventListener("blur", () => { firing = false; });

    $("play-btn").addEventListener("click", (e) => { e.stopPropagation(); start(); });
    $("resume-btn").addEventListener("click", (e) => { e.stopPropagation(); resumeGame(); });
    $("menu-btn").addEventListener("click", (e) => { e.stopPropagation(); toMenu(); });
    $("pause-btn").addEventListener("click", (e) => { e.stopPropagation(); pauseGame(); });
    $("sound-btn").addEventListener("click", (e) => { e.stopPropagation(); toggleMute(); });
    const weaponBtn = document.getElementById("weapon-btn");
    if (weaponBtn) weaponBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleArmed(); });
    const chatBtn = document.getElementById("chat-btn");
    if (chatBtn) chatBtn.addEventListener("click", (e) => { e.stopPropagation(); if (window.MP && MP.enabled) MP.openChat(); });
    const onlineBtn = document.getElementById("online-btn");
    if (onlineBtn) onlineBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (!window.MP || !MP.available) return;
      if (!MP.enabled) { MP.setName((document.getElementById("name-input") || {}).value || ""); }
      MP.toggle(!MP.enabled);
      reflectOnline();
    });

    setupTouch();
  }

  function setupTouch() {
    if (!isTouch()) return;
    // Floating joystick: the pad appears wherever the thumb lands (easy to reach
    // anywhere in the left zone) with a soft deadzone and full-range response.
    const zone = $("stick-zone"), base = $("stick-base"), knob = $("stick-knob");
    const R = 62, DEAD = 0.14;
    let sid = null, sx = 0, sy = 0;
    const reset = () => { sid = null; base.classList.add("hidden"); knob.style.transform = "translate(-50%,-50%)"; tMoveX = tMoveY = 0; };
    zone.addEventListener("pointerdown", (e) => {
      sid = e.pointerId; sx = e.clientX; sy = e.clientY;
      base.style.left = sx + "px"; base.style.top = sy + "px"; base.classList.remove("hidden");
      knob.style.transform = "translate(-50%,-50%)";
    });
    zone.addEventListener("pointermove", (e) => {
      if (e.pointerId !== sid) return;
      let dx = e.clientX - sx, dy = e.clientY - sy;
      const d = Math.hypot(dx, dy);
      if (d > R) { dx = dx / d * R; dy = dy / d * R; }
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      const nx = dx / R, ny = dy / R, m = Math.hypot(nx, ny);
      if (m < DEAD) { tMoveX = 0; tMoveY = 0; }
      else { const s = ((m - DEAD) / (1 - DEAD)) / m; tMoveX = nx * s; tMoveY = -ny * s; }
    });
    zone.addEventListener("pointerup", reset); zone.addEventListener("pointercancel", reset);

    // right half of screen = look
    let lid = null, lx = 0, ly = 0;
    canvas.addEventListener("pointerdown", (e) => { if (e.clientX > window.innerWidth * 0.5) { lid = e.pointerId; lx = e.clientX; ly = e.clientY; } });
    canvas.addEventListener("pointermove", (e) => {
      if (e.pointerId !== lid) return;
      camYaw += (e.clientX - lx) * 0.006; camPitch = clamp(camPitch + (e.clientY - ly) * 0.006, CAM_PITCH_MIN, CAM_PITCH_MAX);
      lx = e.clientX; ly = e.clientY;
    });
    const end = (e) => { if (e.pointerId === lid) lid = null; };
    canvas.addEventListener("pointerup", end); canvas.addEventListener("pointercancel", end);

    const hold = (el, set) => {
      el.addEventListener("pointerdown", (e) => { e.preventDefault(); set(true); });
      ["pointerup", "pointercancel", "pointerleave"].forEach((ev) => el.addEventListener(ev, () => set(false)));
    };
    hold($("btn-boost"), (v) => tBoost = v);
    hold($("btn-up"), (v) => tUp = v);
    hold($("btn-down"), (v) => tDown = v);           // descend in fly / heli
    const fb = document.getElementById("btn-fire"); if (fb) hold(fb, (v) => firing = v);   // hold to shoot
    const pb = document.getElementById("btn-punch"); if (pb) pb.addEventListener("pointerdown", (e) => { e.preventDefault(); punch(); });
    $("btn-fly").addEventListener("click", (e) => {
      e.preventDefault();
      if (state === S.PLAYING && (mode === MODE.WALK || mode === MODE.FLY)) toggleMode();
    });
    $("btn-action").addEventListener("click", (e) => {
      e.preventDefault();
      if (state === S.PLAYING) tryEnterExit();        // enter/exit car, bike or heli
    });
    updateTouchUI();
  }

  // Mobile: every action is a button — no keyboard needed. Buttons appear
  // contextually (Enter when near a vehicle, Exit while in one, Descend while
  // airborne) and relabel to match the mode.
  function updateTouchUI() {
    if (!isTouch()) return;
    const inVeh = mode === MODE.DRIVE || mode === MODE.HELI;
    let act = null;
    if (inVeh) act = "EXIT";
    else if (mode === MODE.WALK) { const c = nearestCar(); if (c) act = c.type === "bike" ? "RIDE" : c.type === "heli" ? "BOARD" : "DRIVE"; }
    showBtn($("btn-action"), act);
    showBtn($("btn-fly"), inVeh ? null : (mode === MODE.FLY ? "LAND" : "FLY"));
    showBtn($("btn-down"), (mode === MODE.FLY || mode === MODE.HELI) ? "DOWN" : null);
    showBtn(document.getElementById("btn-fire"), (armed && mode === MODE.WALK) ? "FIRE" : null);   // only when armed, on foot
    showBtn(document.getElementById("btn-punch"), mode === MODE.WALK ? "PUNCH" : null);            // melee on foot
    if (mode !== MODE.WALK || !armed) firing = false;
    const up = $("btn-up"); if (up) up.textContent = mode === MODE.WALK ? "JUMP" : "UP";
  }
  function showBtn(el, label) {
    if (!el) return;
    if (label) { if (el.textContent !== label) el.textContent = label; el.classList.remove("hidden"); }
    else el.classList.add("hidden");
  }

  // ========================================================================
  //  Update
  // ========================================================================
  function step(dt) {
    if (!heroBody) return;
    animT += dt;
    scrollWater(dt);
    animateTraffic(dt);
    animateVehicles(dt);
    animatePedestrians(dt);
    animateBirds(dt);
    animateCreatures(dt);                     // monsters roaming the map (lazy: only the spawned ones do work)
    updateRockets(dt);                        // rockets in flight (only while any exist)
    updateDying(dt);                          // blown-apart bodies (only while any exist)
    updateGunFX(dt);                          // hide the back-blast flash after a few frames
    maybeManageActors(heroMesh.position);
    if (state !== S.PLAYING) { animateIdle(dt); updateCamera(dt); return; }

    // Trigger: fire a rocket while held, armed, on foot, on a cooldown.
    if (fireCD > 0) fireCD -= dt;
    if (firing && armed && mode === MODE.WALK && fireCD <= 0) { launchRocket(); fireCD = FIRE_CD; }
    if (punchCD > 0) punchCD -= dt;
    if (punchT > 0) punchT -= dt;

    // Unified 4-direction intent — arrow keys mirror the touch stick exactly.
    const kR = keys["ArrowRight"] || keys["KeyD"];
    const kL = keys["ArrowLeft"] || keys["KeyA"];
    const kU = keys["ArrowUp"] || keys["KeyW"];
    const kD = keys["ArrowDown"] || keys["KeyS"];

    if (mode === MODE.DRIVE) updateDrive(dt, kU, kD, kL, kR);
    else if (mode === MODE.HELI) updateHeli(dt, kU, kD, kL, kR);
    else if (mode === MODE.WALK) { updateWalk(dt, kU, kD, kL, kR); updatePrompt(); }
    else updateFly(dt, kU, kD, kL, kR);

    updateCamera(dt);
    updateHUD();

    // Online: broadcast our state and render nearby players.
    if (window.MP && MP.enabled) {
      if (MP.ready) {
        const p = heroMesh.position;
        const h = mode === MODE.FLY ? flyYaw : (mode === MODE.DRIVE || mode === MODE.HELI) ? carHeading : modelYaw;
        MP.update({ x: p.x, y: p.y, z: p.z, h, mode });
      }
      MP.sync(dt, heroMesh.getAbsolutePosition());
    }
  }

  function onChatToggle(open) {
    if (open) { if (document.pointerLockElement) document.exitPointerLock(); }
    else if (state === S.PLAYING) lockPointer();
  }

  function reflectOnline() {
    const b = document.getElementById("online-btn");
    if (!b || !window.MP) return;
    b.classList.toggle("hidden", !MP.available);
    b.classList.toggle("on", MP.enabled);
    b.textContent = MP.enabled ? "ONLINE" : "GO ONLINE";
    const chatBtn = document.getElementById("chat-btn");
    if (chatBtn) chatBtn.classList.toggle("hidden", !MP.enabled);   // a clear way to talk once online
  }

  // ---- Driving (arcade) ----
  function updateDrive(dt, kU, kD, kL, kR) {
    const throttle = (kU ? 1 : 0) - (kD ? 1 : 0) + tMoveY;
    const steerIn = (kR ? 1 : 0) - (kL ? 1 : 0) + tMoveX;
    if (throttle > 0) carSpeed += CAR_ACCEL * throttle * dt;
    else if (throttle < 0) carSpeed += (carSpeed > 0 ? -CAR_ACCEL * 1.6 : -CAR_ACCEL) * -throttle * dt;
    carSpeed *= Math.max(0, 1 - CAR_FRICTION * dt);
    carSpeed = clamp(carSpeed, -CAR_REVERSE, CAR_MAX);
    // steering scales with (signed) speed so you turn into the direction of travel
    carHeading += steerIn * CAR_STEER * dt * clamp(carSpeed / 10, -1, 1);

    const node = drivingCar.node;
    const fx = Math.sin(carHeading), fz = Math.cos(carHeading);
    const nx = node.position.x + fx * carSpeed * dt;
    const nz = node.position.z + fz * carSpeed * dt;
    if (!blocked(nx, node.position.z)) node.position.x = nx; else carSpeed *= 0.2;
    if (!blocked(node.position.x, nz)) node.position.z = nz; else carSpeed *= 0.2;
    node.rotation.y = carHeading;
    heroMesh.position.set(node.position.x, node.position.y, node.position.z);
  }

  // ---- Helicopter (vertical-takeoff arcade flight) ----
  function updateHeli(dt, kU, kD, kL, kR) {
    const shift = keys["ShiftLeft"] || keys["ShiftRight"];
    carHeading += (((kR ? 1 : 0) - (kL ? 1 : 0)) + tMoveX) * HELI_YAW * dt;
    const fb = ((kU ? 1 : 0) - (kD ? 1 : 0)) + tMoveY;
    const up = ((keys["Space"] || tUp ? 1 : 0) - (shift || tDown ? 1 : 0));
    const fwd = new BABYLON.Vector3(Math.sin(carHeading), 0, Math.cos(carHeading));
    heliVel = heliVel.add(fwd.scale(fb * HELI_ACCEL * dt)).add(new BABYLON.Vector3(0, up * HELI_UP * dt, 0));
    heliVel = heliVel.scale(Math.max(0, 1 - HELI_DRAG * dt));
    if (heliVel.length() > HELI_MAX) heliVel = heliVel.normalize().scale(HELI_MAX);

    const node = drivingCar.node;
    let nx = node.position.x + heliVel.x * dt, nz = node.position.z + heliVel.z * dt, ny = node.position.y + heliVel.y * dt;
    if (ny < 1.2) { ny = 1.2; if (heliVel.y < 0) heliVel.y = 0; }
    const lowBlock = ny < 6;
    if (!(lowBlock && blocked(nx, node.position.z))) node.position.x = nx; else heliVel.x = 0;
    if (!(lowBlock && blocked(node.position.x, nz))) node.position.z = nz; else heliVel.z = 0;
    node.position.y = ny;
    node.rotation.y = carHeading;
    node.rotation.x = clamp(fb * 0.18, -0.25, 0.25);   // nose tilt with travel
    heroMesh.position.set(node.position.x, node.position.y, node.position.z);
  }

  // Spin every helicopter's rotors (faster for the one being piloted).
  function animateVehicles(dt) {
    for (const c of enterables) {
      if (!c.node) continue;
      driveCollider(c, dt);                   // keep each car's collider on its visual (parked or driven)
      if (!c.rotor) continue;
      const fast = c === drivingCar;
      c.rotor.rotation.y += (fast ? 32 : 13) * dt;
      if (c.tailRotor) c.tailRotor.rotation.x += (fast ? 42 : 17) * dt;
    }
  }

  function blocked(x, z) {
    for (const o of obstacles) {
      if (Math.abs(x - o.x) < o.hw + CAR_R && Math.abs(z - o.z) < o.hd + CAR_R) return true;
    }
    return false;
  }

  function nearestCar() {
    const p = heroMesh.position; let best = null, bd = ENTER_DIST * ENTER_DIST;
    for (const c of enterables) {
      const dx = c.x - p.x, dz = c.z - p.z, d = dx * dx + dz * dz;
      if (d < bd && c.node) { bd = d; best = c; }
    }
    return best;
  }
  function updatePrompt() {
    if (isTouch()) { if (ui.prompt) ui.prompt.classList.add("hidden"); updateTouchUI(); return; }
    if (!ui.prompt) return;
    const c = nearestCar();
    ui.prompt.classList.toggle("hidden", !c);
    if (c) ui.prompt.textContent = c.type === "bike" ? "Press E to ride" : c.type === "heli" ? "Press E to board" : "Press E to drive";
  }
  function enterCar(c) {
    drivingCar = c;
    mode = c.type === "heli" ? MODE.HELI : MODE.DRIVE;
    carHeading = c.node.rotation.y; carSpeed = 0; heliVel = BABYLON.Vector3.Zero();
    model.setEnabled(false);
    heroBody.setMotionType(BABYLON.PhysicsMotionType.ANIMATED);
    if (ui.mode) ui.mode.textContent = c.type === "heli" ? "HELICOPTER" : c.type === "bike" ? "RIDING" : "DRIVING";
    if (ui.prompt) ui.prompt.classList.add("hidden");
    updateTouchUI();
  }
  function exitCar() {
    const node = drivingCar.node;
    drivingCar = null; mode = MODE.WALK;
    heroBody.setMotionType(BABYLON.PhysicsMotionType.DYNAMIC);
    heroBody.setGravityFactor(1);
    const side = new BABYLON.Vector3(Math.cos(carHeading), 0, -Math.sin(carHeading)).scale(2.4);
    heroMesh.position.set(node.position.x + side.x, Math.max(1.3, node.position.y), node.position.z + side.z);
    heroBody.setLinearVelocity(BABYLON.Vector3.Zero());
    camYaw = carHeading;
    model.setEnabled(true);
    if (ui.mode) ui.mode.textContent = "ON FOOT";
    updateTouchUI();
  }

  function updateWalk(dt, kU, kD, kL, kR) {
    const fwd = new BABYLON.Vector3(Math.sin(camYaw), 0, Math.cos(camYaw));
    const right = new BABYLON.Vector3(Math.cos(camYaw), 0, -Math.sin(camYaw));
    const ix = clamp((kR ? 1 : 0) - (kL ? 1 : 0) + tMoveX, -1, 1);
    const iz = clamp((kU ? 1 : 0) - (kD ? 1 : 0) + tMoveY, -1, 1);
    const moveDir = right.scale(ix).add(fwd.scale(iz));
    const moving = moveDir.lengthSquared() > 0.001;
    if (moving) moveDir.normalize();

    grounded = isGrounded();
    if (grounded) coyoteT = 0.14; else coyoteT = Math.max(0, coyoteT - dt);
    const v = heroBody.getLinearVelocity();
    const sprint = keys["ShiftLeft"] || keys["ShiftRight"] || tBoost;
    const target = moving ? (sprint ? RUN_SPEED : WALK_SPEED) : 0;
    const k = Math.min(1, WALK_ACCEL * dt);
    v.x += (moveDir.x * target - v.x) * k; v.z += (moveDir.z * target - v.z) * k;
    if (coyoteT > 0 && (keys["Space"] || tUp)) { v.y = JUMP_V; coyoteT = 0; }
    heroBody.setLinearVelocity(v);

    const yawAlpha = 1 - Math.exp(-13 * dt);
    if (moving) modelYaw = lerpAngle(modelYaw, Math.atan2(moveDir.x, moveDir.z), yawAlpha);
    setModelRot(modelYaw, 0, 0, dt);
    animateWalk(dt, Math.hypot(v.x, v.z), grounded);
  }

  // Heading-based glide: Up/Down pitch the heading, Left/Right turn it, and the
  // glider always cruises forward along it — so holding Up climbs, etc. The
  // touch stick feeds the same flyPitch/flyYaw (it is the base input model).
  function updateFly(dt, kU, kD, kL, kR) {
    const boost = (keys["ShiftLeft"] || keys["ShiftRight"] || keys["Space"] || tBoost) && boostE > 0;
    const s = STEER_RATE * dt;
    const pitchIn = ((kU ? 1 : 0) - (kD ? 1 : 0) + tMoveY);
    flyPitch += pitchIn * s;
    if (!pitchIn) flyPitch -= flyPitch * 0.8 * dt;  // auto-level when no pitch input
    flyYaw += ((kR ? 1 : 0) - (kL ? 1 : 0) + tMoveX) * s;
    flyPitch = clamp(flyPitch, -1.3, 1.3);

    const cp = Math.cos(flyPitch), sp = Math.sin(flyPitch);
    const fwd = new BABYLON.Vector3(Math.sin(flyYaw) * cp, sp, Math.cos(flyYaw) * cp);
    const cruise = boost ? FLY_MAX_BOOST : FLY_CRUISE;
    let v = heroBody.getLinearVelocity();
    v = BABYLON.Vector3.Lerp(v, fwd.scale(cruise), clamp(FLY_RESPONSE * dt, 0, 1));
    heroBody.setLinearVelocity(v);

    if (boost) boostE = Math.max(0, boostE - dt / 3); else boostE = Math.min(1, boostE + dt / 5);

    modelYaw = flyYaw;
    const bank = ((kL ? 1 : 0) - (kR ? 1 : 0) + (-tMoveX)) * 0.4;
    setModelRot(flyYaw, clamp(flyPitch, -0.55, 0.55), bank, dt);
    animateFly(dt);
  }

  function isGrounded() {
    const o = heroMesh.getAbsolutePosition();
    const ray = new BABYLON.Ray(o, new BABYLON.Vector3(0, -1, 0), 1.15);
    const hit = scene.pickWithRay(ray, (m) => m.isPickable && m !== heroMesh);
    return !!(hit && hit.hit);
  }

  function setModelRot(yaw, pitch, roll, dt) {
    const q = BABYLON.Quaternion.RotationYawPitchRoll(yaw, pitch, roll);
    const t = dt != null ? 1 - Math.exp(-17 * dt) : 0.25;
    model.rotationQuaternion = BABYLON.Quaternion.Slerp(model.rotationQuaternion, q, t);
  }

  // ---- procedural animation ----
  function animateWalk(dt, speedH, grounded) {
    const norm = clamp(speedH / RUN_SPEED, 0, 1);
    animPhase += dt * (4 + speedH * 1.1);
    const amp = norm * 0.85;
    const sw = Math.sin(animPhase) * amp;
    setJoint("legL", sw, dt); setJoint("legR", -sw, dt);
    // Armed → right arm raised sighting the launcher; unarmed → a natural swing.
    if (armed) { setJoint("armR", GUN_AIM, dt); setJoint("armL", -sw * 0.5 - 0.15, dt); }
    else { setJoint("armL", -sw * 0.8, dt); setJoint("armR", sw * 0.8, dt); }
    if (punchT > 0) { setJoint("armR", -2.0, dt); setJoint("armL", -0.5, dt); }
    if (!grounded) { setJoint("legL", -0.3, dt); setJoint("legR", -0.3, dt); }
  }
  function animateFly(dt) {
    setJoint("legL", -0.25, dt); setJoint("legR", -0.18, dt);
    setJoint("armL", 2.5, dt); setJoint("armR", 2.5, dt);
  }
  function animateIdle(dt) {
    const b = Math.sin(animT * 1.5) * 0.04;
    setJoint("legL", 0, dt); setJoint("legR", 0, dt);
    // Armed idle keeps the launcher raised; otherwise arms rest naturally.
    if (armed && mode === MODE.WALK) { setJoint("armR", GUN_AIM + b * 0.5, dt); setJoint("armL", -0.15 + b, dt); }
    else { setJoint("armL", b, dt); setJoint("armR", -b, dt); }
  }
  function setJoint(key, x, dt) {
    const j = joints[key]; if (!j) return;
    const t = dt != null ? 1 - Math.exp(-20 * dt) : 0.3;
    j.rotation.x += (x - j.rotation.x) * t;
  }

  // ========================================================================
  //  Mode + state
  // ========================================================================
  function setMode(next, instant) {
    mode = next;
    if (mode === MODE.FLY) {
      flyYaw = camYaw; flyPitch = 0.12;             // lift off facing the camera
      heroBody.setGravityFactor(0);
      const v = heroBody.getLinearVelocity(); v.y = Math.max(v.y, 4); heroBody.setLinearVelocity(v);
    } else {
      camYaw = flyYaw;                              // land looking the same way
      heroBody.setGravityFactor(1);
    }
    heroBody.setLinearDamping(0);
    if (ui.mode) ui.mode.textContent = mode === MODE.FLY ? "FLYING" : "ON FOOT";
    if (ui.prompt) ui.prompt.classList.add("hidden");
    updateTouchUI();
    if (instant) updateCamera(0, true);
  }
  function toggleMode() { setMode(mode === MODE.FLY ? MODE.WALK : MODE.FLY); }
  function tryEnterExit() {
    if (mode === MODE.DRIVE || mode === MODE.HELI) return exitCar();
    if (mode === MODE.WALK) { const c = nearestCar(); if (c && c.node) enterCar(c); }
  }

  function updateHUD() {
    const v = heroBody.getLinearVelocity();
    const spd = mode === MODE.DRIVE ? Math.abs(carSpeed)
      : mode === MODE.HELI ? Math.hypot(heliVel.x, heliVel.z)
        : mode === MODE.FLY ? v.length() : Math.hypot(v.x, v.z);
    ui.speed.textContent = Math.round(spd * 3.6);
    ui.alt.textContent = Math.max(0, Math.round(heroMesh.position.y - 1));
    ui.boostFill.style.width = (boostE * 100).toFixed(0) + "%";
    const a = areaName(heroMesh.position);
    if (ui.area && ui.area.textContent !== a) ui.area.textContent = a;
    updateZooGuide();
  }
  // A compass chip that always points the way to the zoo (where the creatures
  // are kept) and shows the distance — so it's easy to go find them.
  function updateZooGuide() {
    if (!ui.zooGuide) return;
    const p = heroMesh.position, dx = ZOO_X - p.x, dz = ZOO_Z - p.z;
    const dist = Math.hypot(dx, dz);
    if (dist < ZOO_R + 10) {
      ui.zooGuide.classList.add("here");
      if (ui.zooDist.textContent !== "AT THE ZOO") ui.zooDist.textContent = "AT THE ZOO";
      return;
    }
    ui.zooGuide.classList.remove("here");
    const facing = mode === MODE.FLY ? flyYaw : (mode === MODE.DRIVE || mode === MODE.HELI) ? carHeading : camYaw;
    const rel = Math.atan2(dx, dz) - facing;            // 0 = straight ahead
    ui.zooArrow.style.transform = "rotate(" + (rel * 180 / Math.PI).toFixed(0) + "deg)";
    const txt = "ZOO " + (dist >= 1000 ? (dist / 1000).toFixed(1) + " km" : Math.round(dist) + " m");
    if (ui.zooDist.textContent !== txt) ui.zooDist.textContent = txt;
  }

  function lockPointer() {
    if (isTouch()) return;
    try { const p = canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* ignore */ }
  }

  function start() {
    state = S.PLAYING;
    ui.menu.classList.add("hidden");
    ui.pause.classList.add("hidden");
    ui.hud.classList.remove("hidden");
    if (window.MP && MP.available) {
      const nameEl = document.getElementById("name-input");
      MP.setName(nameEl ? nameEl.value.trim() : "");
      const onl = document.getElementById("online-toggle");
      if (onl && onl.checked) MP.connect();   // opt-in only
      reflectOnline();
    }
    maybeManageActors(heroMesh.position);   // ensure nearby actors exist before first input
    startAudio();                           // horror score: synth bed in-gesture (iOS-safe) + real-track upgrade
    lockPointer();
  }
  function pauseGame() {
    if (state !== S.PLAYING) return;
    state = S.PAUSED;
    if (document.pointerLockElement) document.exitPointerLock();
    ui.pause.classList.remove("hidden");
    setAudio(false);
  }
  function resumeGame() {
    if (state !== S.PAUSED) return;
    state = S.PLAYING;
    ui.pause.classList.add("hidden");
    setAudio(true);
    lockPointer();
  }
  function toMenu() {
    state = S.MENU;
    setAudio(false);
    if (window.MP && MP.enabled) MP.disconnect();   // stop networking when leaving
    reflectOnline();
    // leave any vehicle and reset to the downtown plaza, on foot
    drivingCar = null; carSpeed = 0;
    model.setEnabled(true);
    heroBody.setMotionType(BABYLON.PhysicsMotionType.DYNAMIC);
    heroMesh.position.set(0, 1.2, 0);
    heroBody.setLinearVelocity(BABYLON.Vector3.Zero());
    camYaw = 0; camPitch = 0.25; flyYaw = 0; flyPitch = 0; boostE = 1;
    setMode(MODE.WALK, true);
    ui.pause.classList.add("hidden");
    ui.hud.classList.add("hidden");
    ui.menu.classList.remove("hidden");
  }

  // ---- helpers ----
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function rand(half) { return (Math.random() * 2 - 1) * half; }
  function isTouch() { return ("ontouchstart" in window) || navigator.maxTouchPoints > 0; }
  function lerpAngle(a, b, t) {
    let d = ((b - a + Math.PI) % (Math.PI * 2)) - Math.PI;
    if (d < -Math.PI) d += Math.PI * 2;
    return a + d * t;
  }

  // Show the loaded build (read from game.js's own ?v=) at the bottom, so it's
  // obvious whether a new version actually loaded or the cache is stale.
  (function showVersion() {
    try {
      const el = document.getElementById("version");
      const s = document.querySelector('script[src*="game.js"]');
      const m = s && s.src.match(/[?&]v=([^&]+)/);
      if (el) el.textContent = "Sky Glider · " + (m ? m[1] : "dev");
    } catch (e) {}
  })();

  // Service worker: network-first + auto-apply updates (reload once when a new
  // worker takes control) so deploys reach players without a manual hard refresh.
  if ("serviceWorker" in navigator) {
    let refreshing = false;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (refreshing) return; refreshing = true; window.location.reload();
    });
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").then((reg) => {
        reg.update();
        setInterval(() => reg.update(), 60000);   // poll for new builds while playing
      }).catch(() => {});
    });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
