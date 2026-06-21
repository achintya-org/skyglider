// Rasterises the SVG app icons to the PNG sizes the manifest needs. Run after
// editing icons/icon.svg or icons/icon-maskable.svg:  node scripts/make-icons.mjs
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";

const ROOT = new URL("..", import.meta.url).pathname;
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--no-sandbox"],
});

async function render(svgRel, size, outRel, transparent) {
  const svg = await readFile(join(ROOT, svgRel), "utf8");
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<!doctype html><meta charset=utf8><style>*{margin:0;padding:0}html,body{width:${size}px;height:${size}px}svg{width:${size}px;height:${size}px;display:block}</style>${svg}`,
    { waitUntil: "networkidle" });
  const buf = await page.screenshot({ omitBackground: !!transparent });
  await writeFile(join(ROOT, outRel), buf);
  await page.close();
  console.log("wrote", outRel, `${size}x${size}`);
}

await render("icons/icon.svg", 192, "icons/icon-192.png", true);
await render("icons/icon.svg", 512, "icons/icon-512.png", true);
await render("icons/icon-maskable.svg", 512, "icons/icon-maskable-512.png", false);
await browser.close();
