// Quire: start the scribe and serve the notebook.
//
//   ANTHROPIC_API_KEY=sk-ant-... npm start   ->   http://127.0.0.1:4417
//
// Only your own browser tab can drive it: the page carries a per-launch token,
// every API call must present it, and requests for any other host name are refused.

import http from "node:http";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as book from "./book.mjs";
import { Scribe, hasKey } from "./scribe.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 4417);
const HOST = "127.0.0.1";
const TOKEN = crypto.randomBytes(24).toString("hex");
const THREE = path.join(ROOT, "node_modules", "three");

const cfg = await book.loadConfig();
const clients = new Set();
const emit = (ev) => { const line = `data: ${JSON.stringify(ev)}\n\n`; for (const res of clients) res.write(line); };
const scribe = new Scribe(cfg, emit);
await scribe.open();

async function standingOrders() {
  const ch = scribe.chapter;
  if (ch.entries.length || ch.ordersRan || !hasKey()) return;
  const orders = await book.standingOrders();
  if (!orders.length) return;
  ch.ordersRan = true;
  for (const order of orders) {
    await scribe.ask(order);
    while (scribe.busy) await new Promise((r) => setTimeout(r, 400));
  }
}

async function body(req) {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 200_000) throw new Error("too large"); }
  return s ? JSON.parse(s) : {};
}

const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)) { res.writeHead(421); return res.end(); }
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      let html = await fs.readFile(path.join(ROOT, "quire.html"), "utf8");
      html = html.replace("<head>", `<head>\n<meta name="quire-token" content="${TOKEN}">`);
      if (existsSync(THREE)) html = html.replace(/https:\/\/cdn\.jsdelivr\.net\/npm\/three@[\d.]+\//g, "/vendor/three/");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" });
      return res.end(html);
    }
    if (url.pathname.startsWith("/vendor/three/")) {
      const file = path.resolve(THREE, url.pathname.slice("/vendor/three/".length));
      if (!file.startsWith(THREE + path.sep) || !file.endsWith(".js")) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { "content-type": "text/javascript", "cache-control": "max-age=86400" });
      return res.end(await fs.readFile(file));
    }
    if (!url.pathname.startsWith("/api/")) { res.writeHead(404); return res.end(); }

    const token = req.headers["x-quire-token"] || url.searchParams.get("token");
    if (token !== TOKEN) return send(res, 403, { error: "missing or wrong token" });

    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      await scribe.ensureToday();
      res.write(`data: ${JSON.stringify(scribe.state())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => { clients.delete(res); clearInterval(ping); });
      standingOrders().catch((e) => console.error("standing orders:", e.message));
      return;
    }
    if (req.method === "GET" && url.pathname === "/api/book") return send(res, 200, { chapters: await book.listChapters() });
    const day = url.pathname.match(/^\/api\/book\/(\d{4}-\d{2}-\d{2})$/);
    if (req.method === "GET" && day) return send(res, 200, (await book.loadChapter(day[1])).chapter);

    if (req.method !== "POST") return send(res, 405, { error: "POST only" });
    const b = await body(req);
    if (url.pathname === "/api/ask") {
      if (typeof b.text !== "string" || !b.text.trim()) return send(res, 400, { error: "text is required" });
      return send(res, 200, await scribe.ask(b.text.trim().slice(0, 20000)));
    }
    if (url.pathname === "/api/decide") return send(res, scribe.decide(String(b.id), b.verdict) ? 200 : 409, {});
    if (url.pathname === "/api/note") return send(res, scribe.note({ itemId: b.itemId, quote: String(b.quote || ""), text: String(b.text || "").trim() }) ? 200 : 409, {});
    if (url.pathname === "/api/erase") {
      try { return send(res, 200, await scribe.erase(String(b.id))); }
      catch (e) { return send(res, 409, { error: e.message }); }
    }
    if (url.pathname === "/api/stop") return send(res, 200, { stopped: scribe.stop() });
    if (url.pathname === "/api/pace") {
      if (["low", "medium", "high"].includes(b.effort)) cfg.effort = b.effort;
      return send(res, 200, { effort: cfg.effort });
    }
    return send(res, 404, { error: "unknown endpoint" });
  } catch (err) {
    console.error(err);
    if (!res.headersSent) send(res, 500, { error: String(err.message || err) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Quire is open  →  http://${HOST}:${PORT}`);
  console.log(`book: ${path.join(book.HOME, "book")}   brain: ${cfg.model}`);
  if (!hasKey()) console.log("No ANTHROPIC_API_KEY set: the notebook opens, but Claude can't write until you add one.");
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, async () => { await book.writeNow(scribe.chapter, scribe.messages).catch(() => {}); process.exit(0); });
