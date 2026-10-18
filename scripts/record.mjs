// Render the 15-second intro to an MP4, frame by frame (deterministic, no dropped frames).
//
//   npm run record                         -> media/atlas-15s.mp4 (1280x720, 30 fps)
//   npm run record -- --w 1920 --h 1080 --fps 60
//
// Needs: ffmpeg on PATH, and Playwright's Chromium (`npx playwright install chromium`).
// three.js is served from node_modules, so recording also works offline.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const W = Number(arg("w", 1280)), H = Number(arg("h", 720)), FPS = Number(arg("fps", 30));
const OUT = path.resolve(ROOT, arg("out", "media/atlas-15s.mp4"));
const FRAMES = path.join(ROOT, ".frames");

// Tiny static server for index.html
const server = http.createServer(async (req, res) => {
  try { res.writeHead(200, { "content-type": "text/html" }); res.end(await fs.readFile(path.join(ROOT, "index.html"))); }
  catch { res.writeHead(500); res.end(); }
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const url = `http://127.0.0.1:${server.address().port}/?capture`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
page.on("pageerror", (e) => console.error("page error:", e.message));

// Serve three.js locally instead of from the CDN
await page.route("https://cdn.jsdelivr.net/npm/three@*/**", async (route) => {
  const p = new URL(route.request().url()).pathname.replace(/^\/npm\/three@[^/]+\//, "");
  route.fulfill({ path: path.join(ROOT, "node_modules/three", p), contentType: "text/javascript" });
});

await page.goto(url, { waitUntil: "load" });
await page.waitForFunction(() => window.__atlas, null, { timeout: 30000 });
await page.evaluate(() => document.fonts.ready);

await fs.rm(FRAMES, { recursive: true, force: true });
await fs.mkdir(FRAMES, { recursive: true });
const total = Math.round(15 * FPS);
for (let i = 0; i < total; i++) {
  await page.evaluate((t) => window.__atlas.renderAt(t), i / FPS);
  await page.screenshot({ path: path.join(FRAMES, `f${String(i).padStart(5, "0")}.png`) });
  if (i % FPS === 0) process.stdout.write(`\rframe ${i}/${total}`);
}
process.stdout.write(`\rframe ${total}/${total}\n`);
await browser.close();
server.close();

await fs.mkdir(path.dirname(OUT), { recursive: true });
await new Promise((resolve, reject) => {
  const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(FRAMES, "f%05d.png"),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "slow", "-movflags", "+faststart", OUT], { stdio: "inherit" });
  ff.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
});
await fs.rm(FRAMES, { recursive: true, force: true });
console.log(`wrote ${path.relative(ROOT, OUT)}`);
