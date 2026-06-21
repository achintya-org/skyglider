// Verifies the rocket launcher end-to-end: launching creates a flying rocket,
// and an explosion at the zoo kills nearby creatures without allocating any new
// materials (no leak) and with no console errors. Everything runs in one
// synchronous step so it's independent of the headless frame rate / physics.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer(async (req, res) => { try { let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html"; const b = await readFile(join(ROOT, p)); res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream" }); res.end(b); } catch { res.writeHead(404); res.end("nf"); } });
await new Promise((r) => server.listen(0, r));
const url = `http://${"127.0.0.1"}:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto(url, { waitUntil: "load" });
await page.waitForSelector("#menu:not(.hidden)", { timeout: 30000 });
await page.evaluate(() => document.getElementById("play-btn").click());
await page.waitForTimeout(500);

const res = await page.evaluate(() => {
  const before = window.__zoo();                 // teleport to the zoo + spawn the creatures
  const matsBefore = window.__sg().mats;
  const rk = window.__fire();                     // a rocket is now in flight
  const a = window.__nearestActor();
  const after = a ? window.__blast(a.x, a.y, a.z) : null;   // detonate on it
  const matsAfter = window.__sg().mats;
  return { before, after, rk, matsBefore, matsAfter };
});

await browser.close(); server.close();

console.log("at zoo:", JSON.stringify(res.before));
console.log("after blast:", JSON.stringify(res.after), "rockets:", res.rk);
console.log("mats before/after kill:", res.matsBefore, res.matsAfter);

const spawned = res.before.alive > 0 && res.before.nearZoo;
const launched = res.rk >= 1;
const killedSome = res.after && res.after.dead > res.before.dead;
const noNewMats = res.matsAfter <= res.matsBefore;          // killing reuses pooled FX, allocates nothing
const ok = spawned && launched && killedSome && noNewMats && errors.length === 0;
console.log("checks:", JSON.stringify({ spawned, launched, killedSome, noNewMats, noErrors: errors.length === 0 }));
if (errors.length) console.log("ERRORS:", errors);
console.log(ok ? "\nGUN_CHECK_PASS" : "\nGUN_CHECK_FAIL");
process.exit(ok ? 0 : 1);
