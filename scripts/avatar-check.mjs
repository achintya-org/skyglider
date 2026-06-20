// Verifies remote avatars render in the peer's CURRENT shape (car / heli /
// human) with distinct per-player colours. Loads the real game, enters the
// world, injects two fake peers (one driving, one flying) into MP.players and
// asserts the scene builds a car body and a human body, tinted differently.
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

// Inject two peers: one driving a car, one flying.
await page.evaluate(() => {
  const now = Date.now();
  window.MP.enabled = true;
  window.MP.players = {
    driverX: { x: 12, y: 0.9, z: 0, h: 0.5, mode: "drive", name: "Carla", t: now },
    flyerZ: { x: -12, y: 28, z: 6, h: 1.2, mode: "fly", name: "Faye", t: now },
  };
});
await page.waitForTimeout(1800);

const info = await page.evaluate(() => {
  const s = BABYLON.EngineStore.LastCreatedScene;
  const roots = s.transformNodes.filter((n) => n.name === "rp");
  const shapes = roots.map((r) => {
    const body = r.getChildTransformNodes(true).find((n) => ["car", "heli", "bike", "rhuman", "rp0"].includes(n.name));
    // a representative material name off the first child mesh, to compare colours
    const meshes = (body ? body.getChildMeshes() : []);
    const matName = meshes.length ? meshes[0].material && meshes[0].material.name : null;
    return { shape: body ? body.name : null, mat: matName };
  });
  return { count: roots.length, shapes };
});

await browser.close();
server.close();

const shapeNames = info.shapes.map((s) => s.shape);
const hasCar = shapeNames.includes("car");
const hasHuman = shapeNames.includes("rhuman");
const mats = info.shapes.map((s) => s.mat).filter(Boolean);
const distinctColors = new Set(mats).size === mats.length && mats.length >= 2;

console.log("avatars:", JSON.stringify(info));
console.log("checks:", JSON.stringify({ count: info.count, hasCar, hasHuman, distinctColors, noErrors: errors.length === 0 }));
if (errors.length) console.log("ERRORS:", errors);

if (info.count === 2 && hasCar && hasHuman && distinctColors && errors.length === 0) { console.log("\nAVATAR_CHECK_PASS"); process.exit(0); }
else { console.log("\nAVATAR_CHECK_FAIL"); process.exit(1); }
