// Verifies actor solidity is wired: nearby vehicles get kinematic (ANIMATED)
// physics bodies and pedestrians get dynamic bodies — the same Havok mechanism
// that already makes buildings solid. (The collision *feel* is best confirmed
// on-device; this guards the wiring + that bodies exist while spawned.)
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
await page.waitForTimeout(900);

const info = await page.evaluate(() => {
  const s = BABYLON.EngineStore.LastCreatedScene;
  const car = s.meshes.find((m) => m.name === "acol");
  const ped = s.meshes.find((m) => m.name === "pcol");
  const mt = (m) => (m && m.physicsBody ? m.physicsBody.getMotionType() : null);
  return {
    DYNAMIC: BABYLON.PhysicsMotionType.DYNAMIC, ANIMATED: BABYLON.PhysicsMotionType.ANIMATED,
    carBody: !!(car && car.physicsBody), pedBody: !!(ped && ped.physicsBody),
    carMotion: mt(car), pedMotion: mt(ped),
  };
});

await browser.close();
server.close();

const checks = {
  vehicleHasBody: info.carBody,
  pedHasBody: info.pedBody,
  vehicleKinematic: info.carMotion === info.ANIMATED,
  pedDynamic: info.pedMotion === info.DYNAMIC,
  noErrors: errors.length === 0,
};
console.log("info:", JSON.stringify(info));
console.log("checks:", JSON.stringify(checks));
if (errors.length) console.log("ERRORS:", errors);
const ok = Object.values(checks).every(Boolean);
console.log(ok ? "\nSOLIDITY_CHECK_PASS" : "\nSOLIDITY_CHECK_FAIL");
process.exit(ok ? 0 : 1);
