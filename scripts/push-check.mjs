// Confirms the car-collision fix: a kinematic (ANIMATED) body with
// disablePreStep=false actually follows its mesh and PUSHES a dynamic body.
// (Before the fix the body stayed frozen at spawn, so cars never collided.)
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
const page = await browser.newPage({ viewport:{ width:700, height:440 } });
const errors = []; page.on("pageerror", e=>errors.push(e.message));
await page.goto(url, { waitUntil:"load" });
await page.waitForSelector("#menu:not(.hidden)", { timeout:30000 });
await page.evaluate(()=>document.getElementById("play-btn").click());
await page.waitForTimeout(500);

const r = await page.evaluate(async () => {
  const s = BABYLON.EngineStore.LastCreatedScene;
  const ball = BABYLON.MeshBuilder.CreateSphere("tball", { diameter: 1 }, s);
  ball.position.set(300, 1, 300);
  new BABYLON.PhysicsAggregate(ball, BABYLON.PhysicsShapeType.SPHERE, { mass: 5, friction: 0.4 }, s);
  const box = BABYLON.MeshBuilder.CreateBox("tbox", { width: 1, height: 1, depth: 1 }, s);
  box.position.set(297.6, 1, 300);
  const bx = new BABYLON.PhysicsAggregate(box, BABYLON.PhysicsShapeType.BOX, { mass: 1500, friction: 0.3 }, s);
  bx.body.setAngularDamping(100);
  bx.body.setMassProperties({ inertia: BABYLON.Vector3.Zero() });
  const x0 = ball.position.x;
  for (let i = 0; i < 26; i++) {
    const v = bx.body.getLinearVelocity();
    bx.body.setLinearVelocity(new BABYLON.Vector3(3, v.y, 0));   // heavy dynamic, velocity-driven
    await new Promise((res) => requestAnimationFrame(res));
  }
  return { x0, x1: ball.position.x, boxX: box.position.x };
});

await browser.close(); server.close();
const pushed = r.x1 - r.x0;
console.log("ball x:", r.x0.toFixed(2), "->", r.x1.toFixed(2), "(pushed", pushed.toFixed(2) + ")", "boxX", r.boxX.toFixed(2));
const ok = pushed > 0.4 && errors.length === 0;
if (errors.length) console.log("ERRORS:", errors);
console.log(ok ? "\nPUSH_CHECK_PASS" : "\nPUSH_CHECK_FAIL");
process.exit(ok ? 0 : 1);
