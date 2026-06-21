// Screenshot of a beast (giant|rhino|dino) striding near spawn.
// Usage: node scripts/beast-shot.mjs rhino
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";
const ROOT = new URL("..", import.meta.url).pathname;
const NAME = process.argv[2] || "rhino";
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
await page.waitForTimeout(800);
const result = await page.evaluate(async (NAME)=>{
  const s = BABYLON.EngineStore.LastCreatedScene;
  const e = BABYLON.EngineStore.LastCreatedEngine;
  const tp = window.__tp;
  for (let r = 80; r <= 860; r += 70) {
    for (let a = 0; a < 6.28; a += 0.5) {
      tp(Math.cos(a)*r, Math.sin(a)*r);
      await new Promise(res=>setTimeout(res,40));
      const roots = (s.transformNodes||[]).filter(n=>n.name===NAME && n.getChildMeshes && n.getChildMeshes().length);
      if (roots.length) {
        roots.sort((x,y)=>x.scaling.x-y.scaling.x);
        const g = roots[0], gp = g.getAbsolutePosition(), sc = g.scaling.x;
        await new Promise(res=>setTimeout(res,300));
        e.stopRenderLoop();
        const hd = g.rotation.y;
        const fwd = new BABYLON.Vector3(Math.sin(hd), 0, Math.cos(hd));
        const cam = s.activeCamera; cam.minZ = 0.3; cam.maxZ = 6000;
        const fp = new BABYLON.Vector3(gp.x + fwd.x*sc*7 + sc*3, gp.y + sc*3.2, gp.z + fwd.z*sc*7 + sc*3);
        cam.setTarget(new BABYLON.Vector3(gp.x, gp.y + sc*2.4, gp.z));
        // force the fire jet on and aim it forward, then render frames so it fills out
        const ps = s.particleSystems.find(p=>p.name==="breath" && p.emitter && p.emitter.isDescendantOf && p.emitter.isDescendantOf(g));
        if (ps) { ps.direction1.set(fwd.x-0.25,0.1,fwd.z-0.25); ps.direction2.set(fwd.x+0.25,0.5,fwd.z+0.25); ps.start(); }
        for (let f=0; f<30; f++) { cam.position.copyFrom(fp); cam.setTarget(new BABYLON.Vector3(gp.x, gp.y + sc*2.4, gp.z)); s.render(); await new Promise(res=>setTimeout(res,22)); }
        return { found:true, scale:+sc.toFixed(1), at:{x:+gp.x.toFixed(0),z:+gp.z.toFixed(0)}, fire: !!ps };
      }
    }
  }
  return { found:false };
}, NAME);
console.log(JSON.stringify(result));
await page.screenshot({ path: join(ROOT,"scripts",`beast-${NAME}.png`) });
await browser.close(); server.close();
console.log(`saved scripts/beast-${NAME}.png`);
