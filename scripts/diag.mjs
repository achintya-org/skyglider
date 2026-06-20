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
const page = await browser.newPage({ viewport:{ width:1024, height:640 } });
page.on("pageerror", e=>console.log("PAGEERR", e.message));
await page.goto(`http://127.0.0.1:${port}/`, { waitUntil:"load" });
await page.waitForSelector("#menu:not(.hidden)", { timeout:30000 });
await page.evaluate(()=>document.getElementById("play-btn").click());
await page.waitForTimeout(1500);

const info = await page.evaluate(()=>{
  const sc = BABYLON.Engine.LastCreatedEngine.scenes[0];
  const cam = sc.activeCamera;
  const hero = sc.getMeshByName("hero");
  const model = sc.getTransformNodeByName("model");
  const fwd = model.getDirection(BABYLON.Axis.Z);
  const sky = sc.getMeshByName("sky");
  const view = cam.getTarget().subtract(cam.position); view.normalize();
  const pitchDeg = Math.asin(view.y) * 180/Math.PI;
  // Force a clearly-framed orbit shot to verify assets render
  cam.position = new BABYLON.Vector3(hero.position.x+18, hero.position.y+6, hero.position.z-26);
  cam.setTarget(hero.position.add(new BABYLON.Vector3(0,0,12)));
  sc.render();
  return {
    heroPos: hero.position.asArray().map(n=>+n.toFixed(1)),
    camPos: cam.position.asArray().map(n=>+n.toFixed(1)),
    fwd: fwd.asArray().map(n=>+n.toFixed(2)),
    viewPitchDeg: +pitchDeg.toFixed(1),
    skyVisible: sky?.isEnabled() && sky?.isVisible,
    meshes: sc.meshes.length,
  };
});
console.log(JSON.stringify(info,null,2));
await page.screenshot({ path: join(ROOT,"scripts","diag.png") });
await browser.close(); server.close();
