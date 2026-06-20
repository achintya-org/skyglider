// Headless smoke test: serve the site, load it, drive a few frames, assert the
// 3D scene + Havok physics initialise and the hero actually moves.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
const TYPES = {
  ".html": "text/html", ".js": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png",
};

const server = createServer(async (req, res) => {
  try {
    let p = decodeURIComponent(req.url.split("?")[0]);
    if (p === "/") p = "/index.html";
    const buf = await readFile(join(ROOT, p));
    res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream" });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end("nf");
  }
});

await new Promise((r) => server.listen(0, r));
const port = server.address().port;
const url = `http://127.0.0.1:${port}/`;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox", "--use-gl=angle", "--use-angle=swiftshader", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"],
});
const page = await browser.newPage({ viewport: { width: 1024, height: 640 } });

const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

await page.goto(url, { waitUntil: "load" });

// Wait for the menu to appear (scene + physics ready) — fails fast if init throws.
await page.waitForSelector("#menu:not(.hidden)", { timeout: 30000 });
console.log("✓ engine + physics initialised (menu shown)");

// Enter the world on foot.
await page.evaluate(() => document.getElementById("play-btn").click());
await page.waitForTimeout(700);
const walk = await page.evaluate(() => ({ mode: document.getElementById("mode").textContent }));
console.log("✓ entered world:", JSON.stringify(walk));

// Enter the nearest vehicle (E) and drive forward (Up).
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyE" })));
const drive0 = await page.evaluate(() => window.__sg());
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowUp" })));
await page.waitForTimeout(1600);
const drive = await page.evaluate(() => window.__sg());
console.log("✓ driving:", JSON.stringify({ mode: drive.mode, carSpeed: +drive.carSpeed.toFixed(2), cars: drive.cars }));

// Exit the car (E).
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "ArrowUp" }));
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyE" }));
});

// Board a helicopter and ascend (Space).
await page.evaluate(() => window.__enter("heli"));
const heli0 = await page.evaluate(() => window.__sg());
await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { code: "Space" })));
await page.waitForTimeout(1600);
const heli = await page.evaluate(() => window.__sg());
console.log("✓ helicopter:", JSON.stringify({ mode: heli.mode, heliVy: +heli.heliVy.toFixed(2) }));

// Exit heli, then take flight (F) and climb (Up).
await page.evaluate(() => {
  window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space" }));
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyE" }));
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyF" }));
  window.dispatchEvent(new KeyboardEvent("keydown", { code: "ArrowUp" }));
});
const alt0 = await page.evaluate(() => window.__sg().alt);
await page.waitForTimeout(2000);

const probe = await page.evaluate(() => ({ ...window.__sg(), fps: BABYLON.Engine.LastCreatedEngine.getFps() }));
console.log("✓ probe", JSON.stringify(probe), "alt0=" + alt0.toFixed(2));

const errs = errors.filter((e) => /Uncaught|TypeError|ReferenceError|is not a function|undefined is not/i.test(e));
if (errs.length) { console.log("✗ console errors:\n" + errs.join("\n")); }

await page.screenshot({ path: join(ROOT, "scripts", "smoke.png") });
console.log("✓ screenshot saved");

await browser.close();
server.close();

// Climbing: mode flipped to fly, nose pitched up, and rising (vy>0 / gained alt).
const climbing = probe.vy > 0.2 || probe.alt > alt0 + 0.3;
const drove = drive0.mode === "drive" && drive.mode === "drive" && drive.carSpeed > 0.3;
const heliFlew = heli0.mode === "heli" && heli.mode === "heli" && heli.heliVy > 0.2;
const ok = walk.mode === "ON FOOT" && drove && heliFlew && probe.mode === "fly" && probe.flyPitch > 0.05 && climbing && errs.length === 0;
console.log("checks:", JSON.stringify({ walk: walk.mode === "ON FOOT", drove, heliFlew, fly: probe.mode === "fly", climbing }));
console.log(ok ? "\nSMOKE_PASS" : "\nSMOKE_FAIL");
process.exit(ok ? 0 : 1);
