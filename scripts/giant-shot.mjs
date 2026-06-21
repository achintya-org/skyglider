// Screenshot of a giant striding near spawn.
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
const page = await browser.newPage({ viewport:{ width:560, height:820 }, deviceScaleFactor:2 });
page.on("pageerror", e=>console.log("PAGEERR", e.message));
await page.goto(url, { waitUntil:"load" });
await page.waitForSelector("#menu:not(.hidden)", { timeout:30000 });
await page.evaluate(()=>document.getElementById("play-btn").click());
await page.waitForTimeout(700);
const info = await page.evaluate(()=>{
  const s = BABYLON.EngineStore.LastCreatedScene;
  // teleport to the nearest giant's home position so it spawns
  const gs = (window.__giants ? window.__giants() : null);
  return { hasHook: !!gs };
});
// teleport via the giants list directly
const tp = await page.evaluate(()=>{
  // find the giant descriptor list through a spawned giant or via global
  // fall back: walk toward origin-area giants by scanning the scene after a few teleports
  // We expose nothing, so just teleport outward in a ring until a giant mesh appears.
  return true;
});
await page.waitForTimeout(300);
// Try a spiral of teleports to trigger giant spawn, then frame the tallest one.
const result = await page.evaluate(async ()=>{
  const s = BABYLON.EngineStore.LastCreatedScene;
  const e = BABYLON.EngineStore.LastCreatedEngine;
  const tp = window.__tp;
  // scan a grid to find where giants spawn
  for (let r = 120; r <= 820; r += 80) {
    for (let a = 0; a < 6.28; a += 0.6) {
      tp(Math.cos(a)*r, Math.sin(a)*r);
      await new Promise(res=>setTimeout(res,30));
      const gm = s.meshes.filter(m=>m.name==="gi" || m.name==="gtmp");
      const roots = s.transformNodes ? s.transformNodes.filter(n=>n.name==="giant") : [];
      let spawned = roots.filter(n=>n.getChildMeshes && n.getChildMeshes().length);
      if (spawned.length) {
        // prefer the smallest spawned giant for a clear full-body anatomy shot
        spawned.sort((a,b)=>a.scaling.x-b.scaling.x);
        const g = spawned[0];
        const gp = g.getAbsolutePosition();
        e.stopRenderLoop();
        const cam = s.activeCamera;
        const sc = g.scaling.x;
        // ~5 units tall in model space → frame whole body, eye level at mid-height
        cam.minZ = 0.3; cam.maxZ = 6000;
        cam.position = new BABYLON.Vector3(gp.x + sc*4.5, gp.y + sc*3.0, gp.z + sc*7.5);
        cam.setTarget(new BABYLON.Vector3(gp.x, gp.y + sc*2.4, gp.z));
        s.render();
        return { found:true, scale:+sc.toFixed(1), at:{x:+gp.x.toFixed(0),z:+gp.z.toFixed(0)} };
      }
    }
  }
  return { found:false };
});
console.log(JSON.stringify(result));
await page.screenshot({ path: join(ROOT,"scripts","giant-shot.png") });
await browser.close(); server.close();
console.log("saved scripts/giant-shot.png");
