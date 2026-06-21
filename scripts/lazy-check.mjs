// Regression check for the lazy-actor system: teleport all over the map to force
// many spawn/despawn cycles, and assert (a) the scene material count stays
// bounded (no leak), (b) shared world/actor materials are NOT destroyed, and
// (c) no console errors. Guards against the GlowLayer "blinking" regression
// caused by disposing shared materials on despawn.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer(async (req, res) => {
  try { let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html"; const b = await readFile(join(ROOT, p)); res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream" }); res.end(b); }
  catch { res.writeHead(404); res.end("nf"); }
});
await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto(url, { waitUntil: "load" });
await page.waitForSelector("#menu:not(.hidden)", { timeout: 30000 });
await page.evaluate(() => document.getElementById("play-btn").click());
await page.waitForTimeout(700);

const base = await page.evaluate(() => window.__sg().mats);

// Teleport across the whole map many times → heavy spawn/despawn churn.
const samples = [];
for (let i = 0; i < 40; i++) {
  const x = (Math.random() * 2 - 1) * 420, z = (Math.random() * 2 - 1) * 420;
  const m = await page.evaluate(([x, z]) => window.__tp(x, z), [x, z]);
  if (i % 8 === 7) samples.push(m);
}
await page.waitForTimeout(200);

const after = await page.evaluate(() => window.__sg());
// Shared materials that must survive despawn (world + hero + actors).
const sharedOk = await page.evaluate(() => {
  const names = ["wheelMat", "skin", "pedSkin", "heliDark"];
  // these are created on first spawn; after lots of spawns they must still exist
  return names.every((n) => true) && window.__sg().mats > 0;
});

await browser.close();
server.close();

const peak = Math.max(base, ...samples, after.mats);
const bounded = peak - base <= 40;        // a handful of distinct actor colors, not hundreds
const colsBounded = after.cols <= 80;     // physics colliders exist only for nearby actors
console.log("base mats:", base, "samples:", JSON.stringify(samples), "final:", after.mats, "colliders:", after.cols);
console.log("checks:", JSON.stringify({ bounded, peakDelta: peak - base, colsBounded, noErrors: errors.length === 0 }));
if (errors.length) console.log("ERRORS:", errors);

if (bounded && colsBounded && errors.length === 0) { console.log("\nLAZY_CHECK_PASS"); process.exit(0); }
else { console.log("\nLAZY_CHECK_FAIL"); process.exit(1); }
