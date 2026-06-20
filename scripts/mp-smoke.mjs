// Headless multiplayer test. The real Realtime Database host is blocked by the
// container's network egress allowlist, so we stand up a local mock of the RTDB
// REST + SSE streaming endpoints and run TWO isolated browser clients through
// the real mp.js + mp-worker.js. Asserts presence propagates peer→peer over the
// server-push stream (no polling) and names/positions arrive.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
let players = {};
let sse = [];
const broadcast = (p, data) => {
  const msg = `event: put\ndata: ${JSON.stringify({ path: p, data })}\n\n`;
  for (const r of sse) { try { r.write(msg); } catch {} }
};

const server = createServer(async (req, res) => {
  const path = req.url.split("?")[0];
  if (path === "/players.json") {
    if ((req.headers.accept || "").includes("text/event-stream")) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      res.write(`event: put\ndata: ${JSON.stringify({ path: "/", data: players })}\n\n`);
      sse.push(res);
      req.on("close", () => { sse = sse.filter((x) => x !== res); });
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(players));
    return;
  }
  const m = path.match(/^\/players\/([^/]+)\.json$/);
  if (m) {
    const id = m[1];
    if (req.method === "PUT") {
      let b = ""; req.on("data", (d) => (b += d));
      req.on("end", () => { try { players[id] = JSON.parse(b); } catch {} broadcast("/" + id, players[id]); res.writeHead(200); res.end(""); });
      return;
    }
    if (req.method === "DELETE") { delete players[id]; broadcast("/" + id, null); res.writeHead(200); res.end(""); return; }
  }
  if (path === "/") {
    const base = `http://127.0.0.1:${server.address().port}`;
    res.writeHead(200, { "content-type": "text/html" });
    res.end(`<!doctype html><meta charset=utf-8><body><input id="chat-input" class="hidden">
<script>window.FIREBASE_CONFIG={apiKey:"test",databaseURL:"${base}"};</script>
<script src="/mp.js?v=mp3"></script></body>`);
    return;
  }
  try { const buf = await readFile(join(ROOT, path)); res.writeHead(200, { "content-type": "text/javascript" }); res.end(buf); }
  catch { res.writeHead(404); res.end("nf"); }
});

await new Promise((r) => server.listen(0, r));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});

async function client(name, axis) {
  const ctx = await browser.newContext();          // isolated localStorage → distinct uid
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("PAGEERROR: " + e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.MP && window.MP.available);
  await page.evaluate((n) => { window.MP.setName(n); window.MP.connect(); }, name);
  await page.evaluate((ax) => {
    let v = 0;
    window.__iv = setInterval(() => { v += 5; const s = { x: 0, y: 1, z: 0, h: 0, mode: "walk" }; s[ax] = v; window.MP.update(s); }, 200);
  }, axis);
  return { page, errors };
}

const a = await client("Alice", "x");
const b = await client("Bob", "z");
await new Promise((r) => setTimeout(r, 3500));

const aSees = await a.page.evaluate(() => window.MP.players);
const bSees = await b.page.evaluate(() => window.MP.players);

const aVals = Object.values(aSees), bVals = Object.values(bSees);
const aSeesBob = aVals.some((p) => p.name === "Bob" && typeof p.z === "number" && p.z > 0);
const bSeesAlice = bVals.some((p) => p.name === "Alice" && typeof p.x === "number" && p.x > 0);
const isolated = Object.keys(aSees).length === 1 && Object.keys(bSees).length === 1;

console.log("Alice sees:", JSON.stringify(aVals.map((p) => ({ name: p.name, x: p.x, z: p.z }))));
console.log("Bob sees:  ", JSON.stringify(bVals.map((p) => ({ name: p.name, x: p.x, z: p.z }))));
console.log("checks:", JSON.stringify({ aSeesBob, bSeesAlice, isolated }));

const errs = [...a.errors, ...b.errors];
if (errs.length) console.log("PAGE ERRORS:", errs);

await browser.close();
server.close();

if (aSeesBob && bSeesAlice && isolated && !errs.length) { console.log("\nMP_SMOKE_PASS"); process.exit(0); }
else { console.log("\nMP_SMOKE_FAIL"); process.exit(1); }
