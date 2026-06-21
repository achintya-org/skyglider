// Reproduce the road artifact from a mobile third-person view (portrait), then
// move a little so any z-fighting/aliasing on the road shows up.
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
const ctx = await browser.newContext({ viewport:{ width:430, height:880 }, deviceScaleFactor: 2 });
const page = await ctx.newPage();
page.on("pageerror", e=>console.log("PAGEERR", e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil:"load" });
await page.waitForSelector("#menu:not(.hidden)", { timeout:30000 });
await page.evaluate(()=>document.getElementById("play-btn").click());
await page.waitForTimeout(500);
// stand on a downtown road and lower/leveling the camera toward a grazing road angle
await page.evaluate(()=>{
  const sc = BABYLON.Engine.LastCreatedEngine.scenes[0];
  window.__tp && window.__tp(2, 40);
  const cam = sc.activeCamera;
  cam.position = new BABYLON.Vector3(2, 3.0, 28);
  cam.setTarget(new BABYLON.Vector3(2, 1.2, 80));
  sc.render(); sc.render();
});
await page.waitForTimeout(200);
await page.screenshot({ path: join(ROOT,"scripts","road-shot.png") });
await browser.close(); server.close();
console.log("saved scripts/road-shot.png");
