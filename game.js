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
  };

  function fail(msg, e) {
    console.error("[SkyGlider]", msg, e || "");
    ui.loading.classList.add("hidden");
    ui.err.textContent = "⚠ " + msg;
    ui.err.classList.remove("hidden");
  }

  // ---- Tunables -----------------------------------------------------------
  const GRAVITY = 9.81;
  const WALK_SPEED = 5.2, RUN_SPEED = 10, JUMP_V = 7.6, WALK_ACCEL = 12;
  // Flight is heading-based: arrows/WASD steer a heading, the glider cruises
  // along it with momentum. Hold Up to keep pitching up and climb, etc.
  const FLY_CRUISE = 22, FLY_MAX_BOOST = 62, FLY_RESPONSE = 2.4, STEER_RATE = 1.7;
  const MOUSE_SENS = 0.0024;
  const CAM_PITCH_MIN = -0.45, CAM_PITCH_MAX = 1.15;
  const CAM_DIST_WALK = 6.5, CAM_DIST_FLY = 11, CAM_LERP = 0.12;

  // ---- State --------------------------------------------------------------
  const S = { LOADING: 0, MENU: 1, PLAYING: 2, PAUSED: 3 };
  let state = S.LOADING;
  const MODE = { WALK: "walk", FLY: "fly" };
  let mode = MODE.WALK;

  let engine, scene, heroMesh, heroBody, model, joints = {}, cam, shadowGen;
  let buildings = [], water, traffic = [];
  let camYaw = 0, camPitch = 0.25, modelYaw = 0, flyYaw = 0, flyPitch = 0, boostE = 1, animPhase = 0, animT = 0;
  let grounded = false, pointerLocked = false, lockedOnce = false;
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

    // read-only snapshot for the headless smoke test
    window.__sg = () => ({
      state, mode, alt: heroMesh.position.y,
      vy: heroBody.getLinearVelocity().y,
      speed: heroBody.getLinearVelocity().length(), flyPitch,
    });

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
    plate.position.y = 0.02;
    const pMat = new BABYLON.StandardMaterial("pMat", scene);
    pMat.diffuseColor = new BABYLON.Color3(0.2, 0.21, 0.24);
    pMat.specularColor = new BABYLON.Color3(0.02, 0.02, 0.02);
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
    const roadMat = new BABYLON.StandardMaterial("roadMat", scene);
    roadMat.diffuseTexture = roadTex; roadMat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);

    const swMat = new BABYLON.StandardMaterial("swMat", scene);
    swMat.diffuseColor = new BABYLON.Color3(0.45, 0.46, 0.5);

    for (let i = 0; i < G; i++) {
      const p = (i - half) * S0;
      const rx = BABYLON.MeshBuilder.CreateGround("rx" + i, { width: SPAN, height: ROAD_W }, scene);
      rx.position.set(0, 0.04, p); rx.material = roadMat; rx.receiveShadows = true; rx.rotation.y = Math.PI / 2;
      const rz = BABYLON.MeshBuilder.CreateGround("rz" + i, { width: SPAN, height: ROAD_W }, scene);
      rz.position.set(p, 0.05, 0); rz.material = roadMat; rz.receiveShadows = true;
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
    }

    buildCars(S0, half, G);
  }

  function buildCars(S0, half, G) {
    const colors = [[0.8, 0.2, 0.2], [0.15, 0.35, 0.8], [0.9, 0.8, 0.2], [0.9, 0.9, 0.92], [0.12, 0.12, 0.14], [0.2, 0.6, 0.4]];
    const wheelMat = new BABYLON.StandardMaterial("wheelMat", scene);
    wheelMat.diffuseColor = new BABYLON.Color3(0.05, 0.05, 0.06);
    for (let i = 0; i < 16; i++) {
      const lane = (Math.floor(Math.random() * G) - half) * S0;
      const along = rand((G - 1) * S0 * 0.5);
      const onX = Math.random() < 0.5;
      const x = onX ? along : lane + (Math.random() < 0.5 ? 5 : -5);
      const z = onX ? lane + (Math.random() < 0.5 ? 5 : -5) : along;
      const dir = Math.random() < 0.5 ? 1 : -1;
      const car = new BABYLON.TransformNode("car" + i, scene);
      car.position.set(x, 0.9, z);
      car.rotation.y = onX ? (dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (dir > 0 ? 0 : Math.PI);
      traffic.push({ node: car, onX, dir, speed: 7 + Math.random() * 7 });
      const col = colors[i % colors.length];
      const cm = new BABYLON.StandardMaterial("carMat" + i, scene);
      cm.diffuseColor = new BABYLON.Color3(col[0], col[1], col[2]);
      cm.specularColor = new BABYLON.Color3(0.4, 0.4, 0.4);
      const body = BABYLON.MeshBuilder.CreateBox("cb", { width: 2, height: 0.7, depth: 4.4 }, scene);
      body.material = cm; body.parent = car; shadowGen.addShadowCaster(body);
      const cabin = BABYLON.MeshBuilder.CreateBox("cc", { width: 1.8, height: 0.6, depth: 2.2 }, scene);
      cabin.material = cm; cabin.parent = car; cabin.position.set(0, 0.55, -0.2);
      for (const [wx, wz] of [[0.9, 1.4], [-0.9, 1.4], [0.9, -1.4], [-0.9, -1.4]]) {
        const w = BABYLON.MeshBuilder.CreateCylinder("w", { diameter: 0.7, height: 0.3, tessellation: 10 }, scene);
        w.rotation.z = Math.PI / 2; w.position.set(wx, -0.35, wz); w.material = wheelMat; w.parent = car;
      }
    }
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
    const roof = BABYLON.MeshBuilder.CreateCylinder("roof",
      { diameterTop: 0, diameterBottom: Math.hypot(w, d) * 0.92, height: 2.4, tessellation: 4 }, scene);
    roof.material = scene.getMaterialByName("roofMat") || mat("roofMat", new BABYLON.Color3(0.5, 0.22, 0.18));
    roof.parent = node; roof.position.y = h + 1.0; roof.rotation.y = Math.PI / 4; shadowGen.addShadowCaster(roof);
    const door = BABYLON.MeshBuilder.CreateBox("door", { width: 1.1, height: 2, depth: 0.12 }, scene);
    door.material = roof.material; door.parent = node; door.position.set(0, 1, d / 2 + 0.02);
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

    const skin = mat("skin", new BABYLON.Color3(0.86, 0.66, 0.52));
    const shirt = mat("shirt", new BABYLON.Color3(0.16, 0.42, 0.5));
    const pants = mat("pants", new BABYLON.Color3(0.17, 0.19, 0.24));
    const shoe = mat("shoe", new BABYLON.Color3(0.08, 0.08, 0.1));
    const hair = mat("hair", new BABYLON.Color3(0.18, 0.12, 0.08));

    const add = (m, name, opt, mtl, parent, pos) => {
      const x = BABYLON.MeshBuilder["Create" + m](name, opt, scene);
      x.material = mtl; x.parent = parent || model; if (pos) x.position.copyFrom(pos);
      x.isPickable = false; shadowGen.addShadowCaster(x);
      return x;
    };
    const V = (x, y, z) => new BABYLON.Vector3(x, y, z);

    add("Box", "torso", { width: 0.5, height: 0.7, depth: 0.28 }, shirt, model, V(0, 1.15, 0));
    add("Box", "hips", { width: 0.46, height: 0.25, depth: 0.26 }, pants, model, V(0, 0.78, 0));
    add("Sphere", "head", { diameter: 0.34 }, skin, model, V(0, 1.72, 0.02));
    add("Sphere", "hairTop", { diameter: 0.37, slice: 0.6 }, hair, model, V(0, 1.78, 0));
    add("Box", "neck", { width: 0.16, height: 0.12, depth: 0.16 }, skin, model, V(0, 1.5, 0));

    // limbs on joint nodes so we can swing them
    const limb = (key, x0, isLeg, topMtl) => {
      const j = new BABYLON.TransformNode(key, scene); j.parent = model;
      j.position.set(x0, isLeg ? 0.78 : 1.42, 0);
      const len = isLeg ? 0.78 : 0.62;
      const seg = add("Capsule", key + "S", { radius: isLeg ? 0.11 : 0.085, height: len }, topMtl, j, V(0, -len / 2, 0));
      if (isLeg) add("Box", key + "F", { width: 0.16, height: 0.12, depth: 0.3 }, shoe, j, V(0, -len + 0.02, 0.07));
      else add("Sphere", key + "H", { diameter: 0.13 }, skin, j, V(0, -len, 0));
      joints[key] = j;
      return j;
    };
    limb("armL", 0.32, false, shirt); limb("armR", -0.32, false, shirt);
    limb("legL", 0.13, true, pants); limb("legR", -0.13, true, pants);
  }

  function mat(name, color) {
    const m = new BABYLON.StandardMaterial(name, scene);
    m.diffuseColor = color; m.specularColor = new BABYLON.Color3(0.08, 0.08, 0.08);
    return m;
  }

  // ========================================================================
  //  Camera (third-person orbit)
  // ========================================================================
  function buildCamera() {
    cam = new BABYLON.UniversalCamera("cam", new BABYLON.Vector3(0, 3, -8), scene);
    cam.fov = 1.05; cam.minZ = 0.15; cam.maxZ = 8000;
    scene.activeCamera = cam;
  }

  function updateCamera(dt, instant) {
    const heroPos = heroMesh.getAbsolutePosition();
    let target, desired;
    if (mode === MODE.FLY) {
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
    cam.position = instant ? desired : BABYLON.Vector3.Lerp(cam.position, desired, CAM_LERP);
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
      const d = t.dir * t.speed * dt;
      const ax = t.onX ? "x" : "z";
      t.node.position[ax] += d;
      if (t.node.position[ax] > 640) t.node.position[ax] = -640;
      else if (t.node.position[ax] < -640) t.node.position[ax] = 640;
    }
  }

  function areaName(p) {
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
      keys[e.code] = down;
      if (navKeys.includes(e.code)) e.preventDefault();
      if (!down) return;
      if (e.code === "KeyF" && state === S.PLAYING) toggleMode();
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
      else if (lockedOnce && state === S.PLAYING && !isTouch()) { lockedOnce = false; pauseGame(); }
    });
    window.addEventListener("mousemove", (e) => {
      if (state !== S.PLAYING || !pointerLocked) return;
      camYaw += e.movementX * MOUSE_SENS;
      camPitch = clamp(camPitch + e.movementY * MOUSE_SENS, CAM_PITCH_MIN, CAM_PITCH_MAX);
    });

    $("play-btn").addEventListener("click", (e) => { e.stopPropagation(); start(); });
    $("resume-btn").addEventListener("click", (e) => { e.stopPropagation(); resumeGame(); });
    $("menu-btn").addEventListener("click", (e) => { e.stopPropagation(); toMenu(); });
    $("pause-btn").addEventListener("click", (e) => { e.stopPropagation(); pauseGame(); });

    setupTouch();
  }

  function setupTouch() {
    if (!isTouch()) return;
    const zone = $("stick-zone"), knob = $("stick-knob");
    let sid = null, sx = 0, sy = 0;
    const reset = () => { sid = null; knob.style.transform = "translate(-50%,-50%)"; tMoveX = tMoveY = 0; };
    zone.addEventListener("pointerdown", (e) => { sid = e.pointerId; sx = e.clientX; sy = e.clientY; });
    zone.addEventListener("pointermove", (e) => {
      if (e.pointerId !== sid) return;
      const dx = clamp(e.clientX - sx, -55, 55), dy = clamp(e.clientY - sy, -55, 55);
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      tMoveX = dx / 55; tMoveY = -dy / 55;
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
    $("btn-down").addEventListener("click", () => { if (state === S.PLAYING) toggleMode(); });
  }

  // ========================================================================
  //  Update
  // ========================================================================
  function step(dt) {
    if (!heroBody) return;
    animT += dt;
    scrollWater(dt);
    animateTraffic(dt);
    if (state !== S.PLAYING) { animateIdle(dt); updateCamera(dt); return; }

    // Unified 4-direction intent — arrow keys mirror the touch stick exactly.
    const kR = keys["ArrowRight"] || keys["KeyD"];
    const kL = keys["ArrowLeft"] || keys["KeyA"];
    const kU = keys["ArrowUp"] || keys["KeyW"];
    const kD = keys["ArrowDown"] || keys["KeyS"];

    if (mode === MODE.WALK) updateWalk(dt, kU, kD, kL, kR);
    else updateFly(dt, kU, kD, kL, kR);

    updateCamera(dt);
    updateHUD();
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
    const v = heroBody.getLinearVelocity();
    const sprint = keys["ShiftLeft"] || keys["ShiftRight"] || tBoost;
    const target = moving ? (sprint ? RUN_SPEED : WALK_SPEED) : 0;
    const k = Math.min(1, WALK_ACCEL * dt);
    v.x += (moveDir.x * target - v.x) * k; v.z += (moveDir.z * target - v.z) * k;
    if (grounded && (keys["Space"] || tUp)) v.y = JUMP_V;
    heroBody.setLinearVelocity(v);

    if (moving) modelYaw = lerpAngle(modelYaw, Math.atan2(moveDir.x, moveDir.z), 0.2);
    setModelRot(modelYaw, 0, 0);
    animateWalk(dt, Math.hypot(v.x, v.z), grounded);
  }

  // Heading-based glide: Up/Down pitch the heading, Left/Right turn it, and the
  // glider always cruises forward along it — so holding Up climbs, etc. The
  // touch stick feeds the same flyPitch/flyYaw (it is the base input model).
  function updateFly(dt, kU, kD, kL, kR) {
    const boost = (keys["ShiftLeft"] || keys["ShiftRight"] || keys["Space"] || tBoost) && boostE > 0;
    const s = STEER_RATE * dt;
    flyPitch += ((kU ? 1 : 0) - (kD ? 1 : 0) + tMoveY) * s;
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
    setModelRot(flyYaw, clamp(flyPitch, -0.55, 0.55), bank);
    animateFly(dt);
  }

  function isGrounded() {
    const o = heroMesh.getAbsolutePosition();
    const ray = new BABYLON.Ray(o, new BABYLON.Vector3(0, -1, 0), 1.15);
    const hit = scene.pickWithRay(ray, (m) => m.isPickable && m !== heroMesh);
    return !!(hit && hit.hit);
  }

  function setModelRot(yaw, pitch, roll) {
    const q = BABYLON.Quaternion.RotationYawPitchRoll(yaw, pitch, roll);
    model.rotationQuaternion = BABYLON.Quaternion.Slerp(model.rotationQuaternion, q, 0.25);
  }

  // ---- procedural animation ----
  function animateWalk(dt, speedH, grounded) {
    const norm = clamp(speedH / RUN_SPEED, 0, 1);
    animPhase += dt * (4 + speedH * 1.1);
    const amp = norm * 0.85;
    const sw = Math.sin(animPhase) * amp;
    setJoint("legL", sw); setJoint("legR", -sw);
    setJoint("armL", -sw * 0.8); setJoint("armR", sw * 0.8);
    if (!grounded) { setJoint("legL", -0.3); setJoint("legR", -0.3); }
  }
  function animateFly(dt) {
    setJoint("legL", -0.25); setJoint("legR", -0.18);
    setJoint("armL", 2.5); setJoint("armR", 2.5); // arms swept back
  }
  function animateIdle(dt) {
    const b = Math.sin(animT * 1.5) * 0.04;
    setJoint("legL", 0); setJoint("legR", 0);
    setJoint("armL", b); setJoint("armR", -b);
  }
  function setJoint(key, x) {
    const j = joints[key]; if (!j) return;
    j.rotation.x += (x - j.rotation.x) * 0.3;
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
    if (instant) updateCamera(0, true);
  }
  function toggleMode() { setMode(mode === MODE.FLY ? MODE.WALK : MODE.FLY); }

  function updateHUD() {
    const v = heroBody.getLinearVelocity();
    const spd = mode === MODE.FLY ? v.length() : Math.hypot(v.x, v.z);
    ui.speed.textContent = Math.round(spd * 3.6);
    ui.alt.textContent = Math.max(0, Math.round(heroMesh.position.y - 1));
    ui.boostFill.style.width = (boostE * 100).toFixed(0) + "%";
    const a = areaName(heroMesh.position);
    if (ui.area && ui.area.textContent !== a) ui.area.textContent = a;
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
    lockPointer();
  }
  function pauseGame() {
    if (state !== S.PLAYING) return;
    state = S.PAUSED;
    if (document.pointerLockElement) document.exitPointerLock();
    ui.pause.classList.remove("hidden");
  }
  function resumeGame() {
    if (state !== S.PAUSED) return;
    state = S.PLAYING;
    ui.pause.classList.add("hidden");
    lockPointer();
  }
  function toMenu() {
    state = S.MENU;
    // reset to the downtown plaza, on foot
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

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();
})();
