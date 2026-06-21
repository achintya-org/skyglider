// Visuals: the clean default view (no creatures, gun holstered), the armed
// state (launcher in hand + reticle), and the zoo full of penned creatures.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".webmanifest": "application/manifest+json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png" };
const server = createServer(async (req, res) => { try { let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html"; const b = await readFile(join(ROOT, p)); res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream" }); res.end(b); } catch { res.writeHead(404); res.end("nf"); } });
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport: { width: 1000, height: 640 } });
page.on("pageerror", (e) => console.log("PAGEERR", e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: "load" });
await page.waitForSelector("#menu:not(.hidden)", { timeout: 30000 });
await page.evaluate(() => document.getElementById("play-btn").click());
await page.waitForTimeout(700);
// Freeze the game's render loop so our manual camera framing is what gets shot.
await page.evaluate(() => BABYLON.Engine.LastCreatedEngine.stopRenderLoop());

// 1) clean default: looking across downtown, no creatures, gun holstered
await page.evaluate(() => {
  const sc = BABYLON.Engine.LastCreatedEngine.scenes[0], hero = sc.getMeshByName("hero"), cam = sc.activeCamera;
  cam.position = new BABYLON.Vector3(hero.position.x + 2.6, hero.position.y + 1.4, hero.position.z + 3.6);
  cam.setTarget(new BABYLON.Vector3(hero.position.x, hero.position.y + 1.1, hero.position.z));
  sc.render(); sc.render();
});
await page.screenshot({ path: join(ROOT, "scripts", "default-clean.png") });

// 2) armed: take the launcher → gun appears + reticle
await page.evaluate(() => document.getElementById("weapon-btn").click());
await page.waitForTimeout(150);
await page.evaluate(() => { const sc = BABYLON.Engine.LastCreatedEngine.scenes[0]; sc.render(); sc.render(); });
await page.screenshot({ path: join(ROOT, "scripts", "default-armed.png") });

// 3) the zoo, full of creatures
await page.evaluate(() => {
  window.__zoo();
  const sc = BABYLON.Engine.LastCreatedEngine.scenes[0], cam = sc.activeCamera;
  cam.position = new BABYLON.Vector3(780, 120, 140 - 150);
  cam.setTarget(new BABYLON.Vector3(780, 2, 140));
  for (let i = 0; i < 8; i++) sc.render();
});
await page.screenshot({ path: join(ROOT, "scripts", "zoo.png") });

await browser.close(); server.close();
console.log("saved default-clean.png, default-armed.png, zoo.png");
