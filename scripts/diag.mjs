// High-altitude overview to verify the biomes (city, coast+ocean, village).
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
await page.waitForTimeout(400);

const info = await page.evaluate(()=>{
  const sc = BABYLON.Engine.LastCreatedEngine.scenes[0];
  const cam = sc.activeCamera;
  // Bird's-eye over the map, looking north toward the coast.
  cam.position = new BABYLON.Vector3(50, 4.5, -44);
  cam.setTarget(new BABYLON.Vector3(44, 3, -36));
  sc.render(); sc.render();
  const names = {};
  for (const m of sc.meshes) { const k = m.name.replace(/\d+$/, ""); names[k] = (names[k]||0)+1; }
  return { meshes: sc.meshes.length, kinds: names };
});
console.log(JSON.stringify(info, null, 2));
await page.screenshot({ path: join(ROOT,"scripts","diag.png") });
await browser.close(); server.close();
