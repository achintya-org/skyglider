import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { chromium } from "playwright";
const ROOT = new URL("..", import.meta.url).pathname;
const T = { ".html":"text/html",".js":"text/javascript",".css":"text/css",".json":"application/json",".webmanifest":"application/manifest+json",".wasm":"application/wasm",".svg":"image/svg+xml",".png":"image/png" };
const server = createServer(async (req,res)=>{try{let p=decodeURIComponent(req.url.split("?")[0]);if(p==="/")p="/index.html";const b=await readFile(join(ROOT,p));res.writeHead(200,{"content-type":T[extname(p)]||"application/octet-stream"});res.end(b);}catch{res.writeHead(404);res.end("x");}});
await new Promise(r=>server.listen(0,r));
const port=server.address().port;
const browser=await chromium.launch({executablePath:"/opt/pw-browsers/chromium-1194/chrome-linux/chrome",args:["--no-sandbox","--use-gl=angle","--use-angle=swiftshader","--enable-unsafe-swiftshader"]});
const page=await browser.newPage({viewport:{width:900,height:600}});
page.on("pageerror",e=>console.log("PAGEERR",e.message));
await page.goto(`http://127.0.0.1:${port}/`,{waitUntil:"load"});
await page.waitForSelector("#menu:not(.hidden)",{timeout:30000});
await page.evaluate(()=>document.getElementById("play-btn").click());
await page.waitForTimeout(500);
// arm + spawn some creatures ahead to aim at
await page.evaluate(()=>{ document.getElementById("weapon-btn").click(); });
await page.waitForTimeout(1500);  // let the camera lerp over-the-shoulder
await page.screenshot({path:join(ROOT,"scripts","aim-view.png")});
await browser.close();server.close();
console.log("saved aim-view.png");
