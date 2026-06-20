(() => {
  "use strict";

  const canvas = document.getElementById("game");
  const ctx = canvas.getContext("2d");

  // Logical resolution — the canvas is scaled by CSS to fit the screen.
  const W = canvas.width;   // 480
  const H = canvas.height;  // 720

  // ---- Tunables -------------------------------------------------------------
  const GRAVITY = 1500;        // px / s^2
  const FLAP_VELOCITY = -430;  // px / s
  const MAX_FALL = 700;        // px / s
  const PIPE_GAP = 190;        // vertical gap height
  const PIPE_WIDTH = 78;
  const PIPE_SPACING = 250;    // horizontal distance between pipes
  const PIPE_SPEED = 190;      // px / s
  const GROUND_H = 96;
  const BIRD_R = 17;

  const BEST_KEY = "skyglider.best";

  // ---- State ----------------------------------------------------------------
  const State = { MENU: "menu", PLAYING: "playing", DEAD: "dead" };
  let state = State.MENU;

  let bird, pipes, score, best, scrollX, lastTime, spawnTimer, deadAt = 0;
  best = Number(localStorage.getItem(BEST_KEY) || 0);

  const el = {
    score: document.getElementById("score"),
    overlay: document.getElementById("overlay"),
    gameover: document.getElementById("gameover"),
    finalScore: document.getElementById("final-score"),
    finalBest: document.getElementById("final-best"),
    bestStart: document.getElementById("best-start"),
  };
  el.bestStart.textContent = best;

  function reset() {
    bird = { x: W * 0.32, y: H * 0.42, vy: 0, rot: 0 };
    pipes = [];
    score = 0;
    scrollX = 0;
    spawnTimer = 0;
    el.score.textContent = "0";
  }

  function startGame() {
    reset();
    state = State.PLAYING;
    el.overlay.classList.add("hidden");
    el.gameover.classList.add("hidden");
    flap();
  }

  function flap() {
    if (state !== State.PLAYING) return;
    bird.vy = FLAP_VELOCITY;
  }

  function spawnPipe() {
    const margin = 70;
    const minTop = margin;
    const maxTop = H - GROUND_H - PIPE_GAP - margin;
    const gapTop = minTop + Math.random() * (maxTop - minTop);
    pipes.push({ x: W + PIPE_WIDTH, gapTop, passed: false });
  }

  function die() {
    state = State.DEAD;
    deadAt = performance.now();
    if (score > best) {
      best = score;
      localStorage.setItem(BEST_KEY, String(best));
    }
    el.finalScore.textContent = score;
    el.finalBest.textContent = best;
    el.bestStart.textContent = best;
    el.gameover.classList.remove("hidden");
  }

  // ---- Update ---------------------------------------------------------------
  function update(dt) {
    scrollX += PIPE_SPEED * dt; // drives the ground/parallax even in menu

    if (state !== State.PLAYING) return;

    bird.vy = Math.min(bird.vy + GRAVITY * dt, MAX_FALL);
    bird.y += bird.vy * dt;
    bird.rot = Math.max(-0.5, Math.min(1.4, bird.vy / 600));

    spawnTimer += PIPE_SPEED * dt;
    if (spawnTimer >= PIPE_SPACING) {
      spawnTimer -= PIPE_SPACING;
      spawnPipe();
    }

    for (const p of pipes) {
      p.x -= PIPE_SPEED * dt;
      if (!p.passed && p.x + PIPE_WIDTH < bird.x) {
        p.passed = true;
        score++;
        el.score.textContent = score;
      }
    }
    while (pipes.length && pipes[0].x + PIPE_WIDTH < -10) pipes.shift();

    // Collisions
    if (bird.y + BIRD_R >= H - GROUND_H) { bird.y = H - GROUND_H - BIRD_R; die(); return; }
    if (bird.y - BIRD_R <= 0) { bird.y = BIRD_R; bird.vy = 0; }

    for (const p of pipes) {
      const inX = bird.x + BIRD_R > p.x && bird.x - BIRD_R < p.x + PIPE_WIDTH;
      if (!inX) continue;
      const aboveGap = bird.y - BIRD_R < p.gapTop;
      const belowGap = bird.y + BIRD_R > p.gapTop + PIPE_GAP;
      if (aboveGap || belowGap) { die(); return; }
    }
  }

  // ---- Render ---------------------------------------------------------------
  function drawBackground() {
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#4aa6e2");
    g.addColorStop(0.7, "#9fd4f0");
    g.addColorStop(1, "#dff3fb");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);

    // Parallax clouds
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    const cloudShift = (scrollX * 0.25) % (W + 160);
    for (let i = 0; i < 3; i++) {
      const cx = ((i * 200) - cloudShift + W + 160) % (W + 160) - 80;
      const cy = 90 + i * 70;
      cloud(cx, cy, 34 + i * 6);
    }
  }

  function cloud(x, y, r) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.arc(x + r, y + 6, r * 0.8, 0, Math.PI * 2);
    ctx.arc(x - r, y + 6, r * 0.7, 0, Math.PI * 2);
    ctx.arc(x + r * 0.4, y - r * 0.5, r * 0.7, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawPipe(p) {
    const x = p.x;
    const topH = p.gapTop;
    const botY = p.gapTop + PIPE_GAP;
    const botH = H - GROUND_H - botY;
    const grad = ctx.createLinearGradient(x, 0, x + PIPE_WIDTH, 0);
    grad.addColorStop(0, "#3aa655");
    grad.addColorStop(0.5, "#5ed47b");
    grad.addColorStop(1, "#2f8a47");

    ctx.fillStyle = grad;
    ctx.strokeStyle = "#235f33";
    ctx.lineWidth = 3;

    // top pipe + lip
    ctx.fillRect(x, 0, PIPE_WIDTH, topH);
    ctx.strokeRect(x, 0, PIPE_WIDTH, topH);
    ctx.fillRect(x - 5, topH - 26, PIPE_WIDTH + 10, 26);
    ctx.strokeRect(x - 5, topH - 26, PIPE_WIDTH + 10, 26);

    // bottom pipe + lip
    ctx.fillRect(x, botY, PIPE_WIDTH, botH);
    ctx.strokeRect(x, botY, PIPE_WIDTH, botH);
    ctx.fillRect(x - 5, botY, PIPE_WIDTH + 10, 26);
    ctx.strokeRect(x - 5, botY, PIPE_WIDTH + 10, 26);
  }

  function drawGround() {
    const y = H - GROUND_H;
    ctx.fillStyle = "#ded08a";
    ctx.fillRect(0, y, W, GROUND_H);
    ctx.fillStyle = "#caa54f";
    ctx.fillRect(0, y, W, 14);
    // moving stripes
    ctx.fillStyle = "#bf9a45";
    const off = scrollX % 40;
    for (let x = -off; x < W; x += 40) {
      ctx.fillRect(x, y + 14, 20, GROUND_H - 14);
    }
  }

  function drawBird() {
    ctx.save();
    ctx.translate(bird.x, bird.y);
    ctx.rotate(bird.rot);

    // body
    ctx.fillStyle = "#fbbf24";
    ctx.strokeStyle = "#a8650a";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    ctx.arc(0, 0, BIRD_R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // wing
    ctx.fillStyle = "#f59e0b";
    ctx.beginPath();
    ctx.ellipse(-3, 3, 9, 6, -0.4, 0, Math.PI * 2);
    ctx.fill();

    // eye
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(7, -6, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#0f172a";
    ctx.beginPath();
    ctx.arc(8.5, -6, 2.3, 0, Math.PI * 2);
    ctx.fill();

    // beak
    ctx.fillStyle = "#ef6c1a";
    ctx.beginPath();
    ctx.moveTo(BIRD_R - 2, -2);
    ctx.lineTo(BIRD_R + 9, 0);
    ctx.lineTo(BIRD_R - 2, 4);
    ctx.closePath();
    ctx.fill();

    ctx.restore();
  }

  function render() {
    drawBackground();
    for (const p of pipes) drawPipe(p);
    drawGround();
    drawBird();
  }

  // ---- Loop -----------------------------------------------------------------
  function frame(now) {
    if (!lastTime) lastTime = now;
    let dt = (now - lastTime) / 1000;
    lastTime = now;
    if (dt > 0.05) dt = 0.05; // clamp after tab switches
    update(dt);
    render();
    requestAnimationFrame(frame);
  }

  // ---- Input ----------------------------------------------------------------
  function onInput(e) {
    if (e) e.preventDefault();
    if (state === State.PLAYING) flap();
    else if (state === State.MENU) startGame();
    else if (state === State.DEAD) {
      // small guard so the death tap doesn't instantly restart
      if (performance.now() - deadAt > 250) startGame();
    }
  }

  window.addEventListener("pointerdown", onInput);
  window.addEventListener("keydown", (e) => {
    if (e.code === "Space" || e.code === "ArrowUp" || e.code === "Enter") onInput(e);
  });
  document.getElementById("start-btn").addEventListener("pointerdown", (e) => { e.stopPropagation(); onInput(e); });
  document.getElementById("restart-btn").addEventListener("pointerdown", (e) => { e.stopPropagation(); onInput(e); });

  // ---- PWA install + service worker ----------------------------------------
  let deferredPrompt = null;
  const installTip = document.getElementById("install-tip");
  const installBtn = document.getElementById("install-btn");

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e;
    installTip.classList.remove("hidden");
  });
  installBtn.addEventListener("pointerdown", async (e) => {
    e.stopPropagation();
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    installTip.classList.add("hidden");
  });
  window.addEventListener("appinstalled", () => installTip.classList.add("hidden"));

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("./sw.js").catch(() => {});
    });
  }

  // ---- Go -------------------------------------------------------------------
  reset();
  requestAnimationFrame(frame);
})();
