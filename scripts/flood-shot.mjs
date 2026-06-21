// Visual check for the flood + war atmosphere: start the game, let the sea
// surge up, then capture a street-level view and a high aerial of the drowned,
// burning city.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
const TYPES = { ".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".webmanifest":"application/manifest+json",".wasm":"application/wasm",".svg":"image/svg+xml",".png":"image/png" };
const server = createServer(async (req,res)=>{try{let p=decodeURIComponent(req.url.split("?")[0]);if(p==="/")p="/index.html";const b=await readFile(join(ROOT,p));res.writeHead(200,{"content-type":TYPES[extname(p)]||"application/octet-stream"});res.end(b);}catch{res.writeHead(404);res.end("nf");}});
await new Promise(r=>server.listen(0,r));
const port = server.address().port;

const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport:{ width:1100, height:680 } });
page.on("pageerror", e=>console.log("PAGEERR", e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil:"load" });
await page.waitForSelector("#menu:not(.hidden)", { timeout:30000 });
await page.evaluate(()=>document.getElementById("play-btn").click());
await page.waitForTimeout(4500);   // let the flood finish rising

const lvl = await page.evaluate(()=>{
  const sc = BABYLON.Engine.LastCreatedEngine.scenes[0];
  const f = sc.getMeshByName("flood");
  // headless runs at ~1fps so the dt-based surge is slow in wall-clock; snap to
  // the settled level so the screenshot shows the intended final look.
  if (f) { f.setEnabled(true); f.position.y = 1.7; }
  const cam = sc.activeCamera;
  // street-level look across the flooded downtown toward the burning skyline
  cam.position = new BABYLON.Vector3(40, 6, -70);
  cam.setTarget(new BABYLON.Vector3(0, 4, 40));
  sc.render(); sc.render();
  return f ? f.position.y : null;
});
console.log("flood level:", lvl);
await page.screenshot({ path: join(ROOT,"scripts","flood-street.png") });

await page.evaluate(()=>{
  const sc = BABYLON.Engine.LastCreatedEngine.scenes[0];
  const cam = sc.activeCamera;
  cam.position = new BABYLON.Vector3(120, 230, -360);
  cam.setTarget(new BABYLON.Vector3(0, 0, 60));
  sc.render(); sc.render();
});
await page.screenshot({ path: join(ROOT,"scripts","flood-aerial.png") });

await browser.close(); server.close();
console.log("saved flood-street.png + flood-aerial.png");
