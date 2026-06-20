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

// Start flight and let it run a couple of seconds.
await page.evaluate(() => document.getElementById("play-btn").click());
await page.waitForTimeout(2200);

// Read internal state to confirm the hero is airborne and moving.
const probe = await page.evaluate(() => {
  const c = document.getElementById("renderCanvas");
  return {
    fps: BABYLON?.Engine?.LastCreatedEngine?.getFps?.() ?? null,
    speed: document.getElementById("speed").textContent,
    alt: document.getElementById("alt").textContent,
    time: document.getElementById("time").textContent,
    canvas: c.width + "x" + c.height,
  };
});
console.log("✓ probe", JSON.stringify(probe));

const errs = errors.filter((e) => !/Havok|wasm streaming|Could not load content for/i.test(e) || /Uncaught|TypeError|ReferenceError/i.test(e));
if (errs.length) { console.log("✗ console errors:\n" + errs.join("\n")); }

await page.screenshot({ path: join(ROOT, "scripts", "smoke.png") });
console.log("✓ screenshot saved");

await browser.close();
server.close();

const ok = Number(probe.time) > 0.5 && Number(probe.alt) > 0 && errs.length === 0;
console.log(ok ? "\nSMOKE_PASS" : "\nSMOKE_FAIL");
process.exit(ok ? 0 : 1);
