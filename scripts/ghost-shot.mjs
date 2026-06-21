// Screenshot of ghosts haunting a building near spawn.
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
const page = await browser.newPage({ viewport:{ width:480, height:820 }, deviceScaleFactor:2 });
page.on("pageerror", e=>console.log("PAGEERR", e.message));
await page.goto(url, { waitUntil:"load" });
await page.waitForSelector("#menu:not(.hidden)", { timeout:30000 });
await page.evaluate(()=>document.getElementById("play-btn").click());
await page.waitForTimeout(700);
const info = await page.evaluate(()=>{
  const s = BABYLON.EngineStore.LastCreatedScene;
  // a non-burning building near the centre
  const blds = s.meshes.filter(m=>m.name==="bld" && (!m.material || m.material.name!=="charred"));
  blds.sort((a,b)=>Math.hypot(a.position.x,a.position.z)-Math.hypot(b.position.x,b.position.z));
  const b = blds[0]; const p = b.position;
  window.__tp(p.x, p.z - 70);
  return { bld:{x:+p.x.toFixed(0),z:+p.z.toFixed(0)}, dist:+Math.hypot(p.x,p.z).toFixed(0) };
});
console.log(JSON.stringify(info));
await page.waitForTimeout(1400);
const n = await page.evaluate(()=>{
  const s = BABYLON.EngineStore.LastCreatedScene;
  const e = BABYLON.EngineStore.LastCreatedEngine;
  const blds = s.meshes.filter(m=>m.name==="bld" && (!m.material || m.material.name!=="charred"));
  blds.sort((a,b)=>Math.hypot(a.position.x,a.position.z)-Math.hypot(b.position.x,b.position.z));
  const p = blds[0].position;
  e.stopRenderLoop();
  const ghosts = s.transformNodes.filter(t=>t.name==="ghost" && t.getChildMeshes().length);
  const g = ghosts[0]; const gp = g.getAbsolutePosition();
  const cam = s.activeCamera;
  cam.position = new BABYLON.Vector3(gp.x + 3.5, gp.y + 1.2, gp.z + 4.5);
  cam.setTarget(gp);
  s.render();
  return ghosts.length;
});
console.log("spawned ghosts:", n);
await page.screenshot({ path: join(ROOT,"scripts","ghost-shot.png") });
await browser.close(); server.close();
console.log("saved scripts/ghost-shot.png");
