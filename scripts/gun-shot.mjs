// Visual: frame the player from the front so the shouldered rocket launcher is
// clearly visible, then a second shot mid-explosion.
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
await page.waitForTimeout(600);

await page.evaluate(() => {
  const sc = BABYLON.Engine.LastCreatedEngine.scenes[0];
  const hero = sc.getMeshByName("hero");
  const cam = sc.activeCamera;
  // face the player head-on, slightly above, to show the launcher in hand
  cam.position = new BABYLON.Vector3(hero.position.x + 2.6, hero.position.y + 1.4, hero.position.z + 3.4);
  cam.setTarget(new BABYLON.Vector3(hero.position.x, hero.position.y + 1.2, hero.position.z));
  sc.render(); sc.render();
});
await page.screenshot({ path: join(ROOT, "scripts", "gun-pose.png") });

// detonate near an actor and frame the blast
await page.evaluate(() => {
  window.__tp(120, 0);
  const a = window.__nearestActor();
  if (a) {
    window.__blast(a.x, a.y, a.z);
    const sc = BABYLON.Engine.LastCreatedEngine.scenes[0], cam = sc.activeCamera;
    cam.position = new BABYLON.Vector3(a.x + 10, a.y + 6, a.z + 12);
    cam.setTarget(new BABYLON.Vector3(a.x, a.y + 1, a.z));
    for (let i = 0; i < 30; i++) sc.render();
  }
});
await page.screenshot({ path: join(ROOT, "scripts", "gun-blast.png") });

await browser.close(); server.close();
console.log("saved gun-pose.png + gun-blast.png");
