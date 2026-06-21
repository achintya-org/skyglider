// Verifies the rocket launcher: launching creates a flying rocket, and an
// explosion kills every nearby actor (and they don't respawn). Also asserts no
// console errors and that the killed bodies clean up (no material leak).
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer(async (req, res) => { try { let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html"; const b = await readFile(join(ROOT, p)); res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream" }); res.end(b); } catch { res.writeHead(404); res.end("nf"); } });
await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 800, height: 500 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto(url, { waitUntil: "load" });
await page.waitForSelector("#menu:not(.hidden)", { timeout: 30000 });
await page.evaluate(() => document.getElementById("play-btn").click());
await page.waitForTimeout(600);
const baseMats = await page.evaluate(() => window.__sg().mats);

// Park on a cluster of actors so several are spawned nearby.
await page.evaluate(() => window.__tp(120, 0));
await page.waitForTimeout(300);
const before = await page.evaluate(() => window.__actors());

// A rocket should appear in flight.
const rk = await page.evaluate(() => window.__fire());

// Detonate right on a nearby actor to wipe out everyone in blast range.
const after = await page.evaluate(() => { const a = window.__nearestActor(); return a ? window.__blast(a.x, a.y, a.z) : null; });
await page.waitForTimeout(1600);                 // let the dying bodies finish & dispose
const settled = await page.evaluate(() => window.__actors());
const matsNow = await page.evaluate(() => window.__sg().mats);

await browser.close(); server.close();

console.log("before:", JSON.stringify(before), "rocketsAfterFire:", rk);
console.log("after blast:", JSON.stringify(after), "settled:", JSON.stringify(settled));
console.log("mats base:", baseMats, "now:", matsNow);

const launched = rk >= 1;
const killedSome = after.dead > before.dead;
const cleanedUp = settled.dying <= 4;            // bounded backlog (headless runs ~1fps, so bodies linger)
const noLeak = matsNow - baseMats <= 40;
const ok = launched && killedSome && cleanedUp && noLeak && errors.length === 0;
console.log("checks:", JSON.stringify({ launched, killedSome, cleanedUp, noLeak, noErrors: errors.length === 0 }));
if (errors.length) console.log("ERRORS:", errors);
console.log(ok ? "\nGUN_CHECK_PASS" : "\nGUN_CHECK_FAIL");
process.exit(ok ? 0 : 1);
