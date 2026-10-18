// Render Quire's 15-second opening to an MP4, frame by frame (deterministic, no dropped frames).
//
//   npm run record                               -> media/quire-opening-15s.mp4 (1280x720, 30 fps)
//   npm run record -- --w 1920 --h 1080 --fps 60 --owner Sam --theme dark
//   npm run record -- --tour                     -> media/quire-tour.webm (the demo, in real time)
//
// Needs ffmpeg on PATH and Playwright's Chromium (`npx playwright install chromium`).
// three.js is served from node_modules, so recording works offline.

import { chromium } from "playwright";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };
const W = Number(arg("w", 1280)), H = Number(arg("h", 720)), FPS = Number(arg("fps", 30));
const OWNER = arg("owner", "Chaitanya"), THEME = arg("theme", "light"), TOUR = process.argv.includes("--tour");
const OUT = path.resolve(ROOT, arg("out", TOUR ? "media/quire-tour.webm" : "media/quire-opening-15s.mp4"));
const FRAMES = path.join(ROOT, ".frames");

const server = http.createServer(async (req, res) => {
  try { res.writeHead(200, { "content-type": "text/html" }); res.end(await fs.readFile(path.join(ROOT, "quire.html"))); }
  catch { res.writeHead(500); res.end(); }
}).listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${server.address().port}/`;

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || undefined,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
await fs.mkdir(path.dirname(OUT), { recursive: true });
const context = await browser.newContext({
  viewport: { width: W, height: H }, deviceScaleFactor: 1, colorScheme: THEME,
  ...(TOUR ? { recordVideo: { dir: FRAMES, size: { width: W, height: H } } } : {}),
});
// Skip the opening in tour mode; serve three.js locally either way.
if (TOUR) await context.addInitScript(() => { const d = new Date(), p = (n) => String(n).padStart(2, "0"); localStorage.setItem("quire.opened", JSON.stringify(`${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`)); });
const page = await context.newPage();
page.on("pageerror", (e) => console.error("page error:", e.message));
await page.route("https://cdn.jsdelivr.net/npm/three@*/**", (route) => {
  const p = new URL(route.request().url()).pathname.replace(/^\/npm\/three@[^/]+\//, "");
  route.fulfill({ path: path.join(ROOT, "node_modules/three", p), contentType: "text/javascript" });
});

if (TOUR) {
  await page.goto(`${base}?demo&owner=${encodeURIComponent(OWNER)}#tour`, { waitUntil: "load" });
  await page.waitForTimeout(Number(arg("seconds", 34)) * 1000);
  const video = page.video();
  await context.close();
  await fs.rename(await video.path(), OUT);
} else {
  await page.goto(`${base}?capture&demo&owner=${encodeURIComponent(OWNER)}`, { waitUntil: "load" });
  await page.waitForFunction(() => window.__quire, null, { timeout: 30000 });
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(async () => { window.__op = await window.__quire.opening(); });
  await fs.rm(FRAMES, { recursive: true, force: true });
  await fs.mkdir(FRAMES, { recursive: true });
  const total = Math.round(15 * FPS);
  for (let i = 0; i < total; i++) {
    await page.evaluate((t) => window.__op.renderAt(t), i / FPS);
    await page.screenshot({ path: path.join(FRAMES, `f${String(i).padStart(5, "0")}.png`) });
    if (i % FPS === 0) process.stdout.write(`\rframe ${i}/${total}`);
  }
  process.stdout.write(`\rframe ${total}/${total}\n`);
  await new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(FRAMES, "f%05d.png"),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "slow", "-movflags", "+faststart", OUT], { stdio: "inherit" });
    ff.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`))));
  });
}
await browser.close();
server.close();
await fs.rm(FRAMES, { recursive: true, force: true });
console.log(`wrote ${path.relative(ROOT, OUT)}`);
