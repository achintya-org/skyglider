// Screenshot of the burning building near spawn.
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";
const ROOT = new URL("..", import.meta.url).pathname;
const TYPES = { ".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".webmanifest":"application/manifest+json",".wasm":"application/wasm",".svg":"image/svg+xml",".png":"image/png" };
const server = createServer(async (req,res)=>{try{let p=decodeURIComponent(req.url.split("?")[0]);if(p==="/")p="/index.html";const b=await readFile(join(ROOT,p));res.writeHead(200,{"content-type":TYPES[extname(p)]||"application/octet-stream"});res.end(b);}catch{res.writeHead(404);res.end("nf");}});
await new Promise(r=>server.listen(0,r));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({ executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"] });
const page = await browser.newPage({ viewport:{ width:430, height:820 }, deviceScaleFactor:2 });
page.on("pageerror", e=>console.log("PAGEERR", e.message));
await page.goto(url, { waitUntil:"load" });
await page.waitForSelector("#menu:not(.hidden)", { timeout:30000 });
await page.evaluate(()=>document.getElementById("play-btn").click());
await page.waitForTimeout(700);
const info = await page.evaluate(()=>{
  const s = BABYLON.EngineStore.LastCreatedScene;
  const burn = s.meshes.find(m=>m.material && m.material.name==="charred");
  const p = burn.position;
  // stand the player ~75 m south of the building so the follow-camera frames it
  window.__tp(p.x, p.z - 75);
  return { burnPos:{x:+p.x.toFixed(0),y:+p.y.toFixed(0),z:+p.z.toFixed(0)}, dist:+Math.hypot(p.x,p.z).toFixed(0), particleSystems:s.particleSystems.length };
});
console.log(JSON.stringify(info));
await page.waitForTimeout(1600);   // let the running loop populate flame + smoke particles
// freeze the loop and frame the whole tower from an elevated 3/4 angle
await page.evaluate(()=>{
  const s = BABYLON.EngineStore.LastCreatedScene;
  const e = BABYLON.EngineStore.LastCreatedEngine;
  const burn = s.meshes.find(m=>m.material && m.material.name==="charred");
  const p = burn.position;
  e.stopRenderLoop();
  const cam = s.activeCamera;
  cam.position = new BABYLON.Vector3(p.x + 150, p.y + 40, p.z + 150);
  cam.setTarget(new BABYLON.Vector3(p.x, p.y, p.z));
  s.render();
});
await page.screenshot({ path: join(ROOT,"scripts","fire-shot.png") });
await browser.close(); server.close();
console.log("saved scripts/fire-shot.png");
