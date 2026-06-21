// Mobile controls check: emulate a touch device and verify every action works
// from on-screen buttons — no keyboard. Asserts the contextual Enter button
// appears near a vehicle, drives on tap, exits on tap, and that NO "Press E…"
// keyboard prompt is shown on touch.
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
const ctx = await browser.newContext({ hasTouch: true, isMobile: true, viewport: { width: 760, height: 380 } });
const page = await ctx.newPage();
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));

const vis = (sel) => page.evaluate((s) => { const e = document.querySelector(s); return e ? { hidden: e.classList.contains("hidden"), text: e.textContent.trim() } : null; }, sel);

await page.goto(url, { waitUntil: "load" });
await page.waitForSelector("#menu:not(.hidden)", { timeout: 30000 });
await page.evaluate(() => document.getElementById("play-btn").click());
await page.waitForTimeout(900);

const promptHidden = (await vis("#prompt")).hidden;                 // no "Press E" on touch
const action0 = await vis("#btn-action");                          // should be DRIVE near spawn car
await page.click("#btn-action");
await page.waitForTimeout(400);
const modeAfterEnter = await page.evaluate(() => window.__sg().mode);
const action1 = await vis("#btn-action");                          // should now read EXIT
await page.click("#btn-action");
await page.waitForTimeout(400);
const modeAfterExit = await page.evaluate(() => window.__sg().mode);

// Fly toggle works from its own button.
await page.click("#btn-fly");
await page.waitForTimeout(300);
const modeAfterFly = await page.evaluate(() => window.__sg().mode);
const downShown = !(await vis("#btn-down")).hidden;                 // descend button appears while flying

await browser.close();
server.close();

const checks = {
  promptHidden,
  enterShown: action0 && !action0.hidden && action0.text === "DRIVE",
  drove: modeAfterEnter === "drive",
  exitLabel: action1 && action1.text === "EXIT",
  exited: modeAfterExit === "walk",
  flew: modeAfterFly === "fly",
  descendShown: downShown,
  noErrors: errors.length === 0,
};
console.log("checks:", JSON.stringify(checks));
if (errors.length) console.log("ERRORS:", errors);
const ok = Object.values(checks).every(Boolean);
console.log(ok ? "\nTOUCH_CHECK_PASS" : "\nTOUCH_CHECK_FAIL");
process.exit(ok ? 0 : 1);
