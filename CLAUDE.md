# Sky Glider — repo guide

## TOP PRIORITY (non-negotiable): performance must never regress
The single most important rule in this repo: **every feature added must have
ZERO impact on the running game's performance.** The game must stay exactly as
fast as the original baseline — the initial single-player load *before*
vehicles, pedestrians, and multiplayer existed. This overrides feature scope,
convenience, and "it's only a little work per frame." If a change could affect
frame time or initial load, it is wrong until proven otherwise.

Hard rules:
- **No per-frame work that scales with world content.** Never scan all actors
  every frame. Never poll. No per-second timers in the render loop.
- **Event-driven / gated only.** Systems must do effectively nothing until
  needed. Examples in this repo:
  - Actor (de)spawn is evaluated only when the player has moved a threshold
    distance (~12 m), not every frame.
  - Only *spawned* (nearby/visible) actors animate. Despawned actors do no
    per-frame work at all.
  - Networking is OPT-IN and uses a server-push stream in a Web Worker — never
    polling, never on the render thread, ~0 cost when alone.
- **Lazy-load everything.** Initial load must stay as lean as the original
  single-player build. No heavy SDKs/assets at startup (e.g. multiplayer uses
  the DB over REST/stream, NOT the Firebase SDK — zero bundle cost). Build/fetch
  on demand; dispose when far.
- **When a feature isn't in use, it must cost ~0** — no allocations, no network,
  no meaningful per-frame branches.
- **If a performance-relevant tradeoff is unclear, STOP and ASK the user.** Do
  not pick an inefficient default. The user would rather be asked than have the
  game slowed down.
- Always verify with `node scripts/smoke.mjs` (headless walk→drive→heli→fly)
  before pushing. Keep the existing game path byte-for-byte unchanged.

## Architecture
- Static, no-build site on GitHub Pages. Engine vendored under `vendor/`
  (Babylon.js + Havok WASM). Plain `<script>` tags with `?v=` cache-busting; the
  service worker (`sw.js`) is network-first with an offline app-shell cache.
- `game.js` — single-player world + controls: walk / fly (heading-based, arrow
  keys mirror the touch stick) / drive / helicopter. Open world with biomes
  (downtown, coast+ocean, village, countryside).
- **Lazy actors** — vehicles (cars/bikes/helis), traffic, pedestrians are light
  descriptors; meshes instantiate within ~120 m of the player and dispose beyond
  (hysteresis avoids churn). Spawn evaluation is gated on player movement, not
  per-frame. Only spawned actors animate.
- `mp.js` — online layer: **opt-in, off by default**. When enabled, all
  networking runs in a Web Worker over a Realtime Database **server-push stream
  (no polling, no SDK)**. Avatars update only when a peer is nearby. Fully
  dormant unless `firebase-config.js` is populated.
- Backend: Firebase Realtime Database. Rules in `database.rules.json`, deployed
  by CI (`.github/workflows/firebase-rules.yml`) using the `FIREBASE_TOKEN` org
  secret. A new project can be provisioned with `firebase-setup.yml` (edit
  `.github/firebase-trigger.txt`).

## Deploy / verify
- Develop on branch `claude/move-into-org-one-712g89`; pushing deploys to Pages.
- `node scripts/smoke.mjs` is the headless regression check (also asserts no
  console errors). `scripts/diag.mjs` captures a screenshot for visual checks.
- Container note: CDNs are blocked; `registry.npmjs.org` is allowed, so deps are
  vendored. Playwright Chromium is at `/opt/pw-browsers/chromium-1194`.
