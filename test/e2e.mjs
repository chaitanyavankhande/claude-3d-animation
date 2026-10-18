// End-to-end: ATLAS's server running Claude's real agent engine (Claude Agent SDK)
// against a scripted stand-in for the Claude API.
//
//   node test/e2e.mjs

import http from "node:http";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const WORK = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-e2e-"));
await fs.writeFile(path.join(WORK, "notes.md"), "Lecture 7: graphs\n");

// --- a scripted Claude ------------------------------------------------------------------
const main = [];   // request bodies of the engine's main loop
const turn = (blocks, stop) => {
  const ev = [{ type: "message_start", message: { id: `msg_${main.length}`, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 5, output_tokens: 1 } } }];
  blocks.forEach((b, index) => {
    if (b.text) {
      ev.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } }, { type: "content_block_delta", index, delta: { type: "text_delta", text: b.text } });
    } else {
      ev.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } }, { type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input) } });
    }
    ev.push({ type: "content_block_stop", index });
  });
  ev.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 4 } }, { type: "message_stop" });
  return ev;
};
const plan = path.join(WORK, "plan.md"), notes = path.join(WORK, "notes.md");
const SCRIPT = [
  () => turn([{ text: "Reading your notes." }, { id: "toolu_read", name: "Read", input: { file_path: notes } }], "tool_use"),
  () => turn([{ id: "toolu_ls", name: "Bash", input: { command: `ls ${WORK}`, description: "list" } }], "tool_use"),
  () => turn([{ id: "toolu_write1", name: "Write", input: { file_path: plan, content: "plan v1\n" } }], "tool_use"),
  () => turn([{ text: "Understood." }, { id: "toolu_alert", name: "mcp__atlas__set_alert_level", input: { level: "red" } }], "tool_use"),
  () => turn([{ text: "Done, no file written." }], "end_turn"),
  // second request
  () => turn([{ id: "toolu_write2", name: "Write", input: { file_path: plan, content: "plan v2\n" } }], "tool_use"),
  () => turn([{ id: "toolu_rm", name: "Bash", input: { command: `rm ${notes}`, description: "delete notes" } }], "tool_use"),
  () => turn([{ text: "Plan written; notes kept." }], "end_turn"),
];
const mock = http.createServer(async (req, res) => {
  let raw = ""; for await (const c of req) raw += c;
  let body = {}; try { body = JSON.parse(raw); } catch { /* not JSON */ }
  if (!req.url.startsWith("/v1/messages") || req.url.includes("count_tokens")) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ input_tokens: 1 })); }
  const isMain = (body.tools || []).some((t) => t.name === "Bash");
  if (!body.stream) { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify({ id: "m", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })); }
  const events = isMain ? (main.push(body), SCRIPT[main.length - 1]?.() ?? turn([{ text: "?" }], "end_turn")) : turn([{ text: "ok" }], "end_turn");
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}).listen(0, "127.0.0.1");
await new Promise((r) => mock.once("listening", r));

// --- start ATLAS with a clean environment ---------------------------------------------------
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE|ANTHROPIC|CCR_|HTTPS?_PROXY|NO_PROXY)/i.test(k)));
const PORT = 7800 + Math.floor(Math.random() * 400);
const start = (extra) => spawn(process.execPath, [path.join(ROOT, "brain/server.mjs")], { env: { ...env, PORT: String(PORT), ATLAS_WORKSPACE: WORK, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
let atlas = start({ ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.address().port}`, DISABLE_TELEMETRY: "1", CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" });
let log = ""; atlas.stdout.on("data", (d) => (log += d)); atlas.stderr.on("data", (d) => (log += d));
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80 && !log.includes("ATLAS online"); i++) await new Promise((r) => setTimeout(r, 100));

let passed = 0;
const ok = (name) => { passed++; console.log("  ✓", name); };
try {
  const html = await (await fetch(BASE + "/")).text();
  const token = html.match(/name="atlas-token" content="([0-9a-f]+)"/)[1]; ok("the HUD carries a per-launch token");
  assert.equal((await fetch(BASE + "/api/stats")).status, 403); ok("the API refuses calls without it");
  const rebind = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: PORT, path: "/", headers: { host: "evil.example" } }, (r) => resolve(r.statusCode)));
  assert.equal(rebind, 421); ok("other host names are refused");
  const H = { "content-type": "application/json", "x-atlas-token": token };
  const post = (p, b) => fetch(BASE + p, { method: "POST", headers: H, body: JSON.stringify(b || {}) });

  const steps = new Map(), seen = []; let text = "", done = [];
  const waiters = [];
  const es = await fetch(`${BASE}/api/events?token=${token}`);
  (async () => {
    const reader = es.body.getReader(), dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done: end } = await reader.read(); if (end) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, i).split("\n").find((l) => l.startsWith("data: ")); buf = buf.slice(i + 2);
        if (!line) continue;
        const ev = JSON.parse(line.slice(6)); seen.push(ev);
        if (ev.type === "step") steps.set(ev.step.id, ev.step);
        if (ev.type === "text") text += ev.delta;
        if (ev.type === "done") done.push(ev);
        waiters.forEach((w) => w());
      }
    }
  })().catch(() => { /* closes when the server stops */ });
  const until = (cond, ms = 30000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out\n" + log.slice(-2000))), ms);
    const check = () => { const v = cond(); if (v) { clearTimeout(t); resolve(v); } };
    waiters.push(check); check();
  });

  // request 1: read and ls go through; the write is held and denied; Claude sets red alert
  assert.equal((await post("/api/ask", { text: "Plan my week from my notes" })).status, 202); ok("a request starts");
  await until(() => steps.get("toolu_read")?.state === "done"); assert.equal(steps.get("toolu_read").agent, "MEMORY"); ok("reading notes goes through and lights MEMORY");
  await until(() => steps.get("toolu_ls")?.state === "done"); assert.equal(steps.get("toolu_ls").agent, "OPERATOR"); ok("a read-only command goes through and lights OPERATOR");
  const held = await until(() => steps.get("toolu_write1")?.state === "waiting" && steps.get("toolu_write1"));
  assert.equal(held.agent, "CODER"); assert.equal(held.why, "changes a file"); ok("writing a file is held for authorization");
  assert.equal((await post("/api/decide", { id: "toolu_write1", verdict: "deny" })).status, 200);
  await until(() => steps.get("toolu_write1")?.state === "denied"); ok("denying it marks the step denied");
  assert.ok(!existsSync(plan)); ok("the denied write never happened");
  await until(() => seen.some((e) => e.type === "alert" && e.level === "red")); ok("Claude can drive the HUD (red alert) through the in-process tool");
  await until(() => done.length === 1); assert.equal(done[0].error, null); assert.match(text, /Reading your notes/); assert.match(text, /Done, no file written/); ok("the request finishes with Claude's words streamed");
  const deniedResult = main[3].messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((b) => b.tool_use_id === "toolu_write1");
  assert.ok(deniedResult.is_error && /denied this on the ATLAS HUD/.test(JSON.stringify(deniedResult.content))); ok("Claude is told the user denied it");

  // request 2: allow the write, deny the delete; the conversation carries on
  assert.equal((await post("/api/ask", { text: "OK, write the plan, and clean up" })).status, 202);
  await until(() => steps.get("toolu_write2")?.state === "waiting");
  await post("/api/decide", { id: "toolu_write2", verdict: "allow" });
  await until(() => steps.get("toolu_write2")?.state === "done");
  assert.equal(await fs.readFile(plan, "utf8"), "plan v2\n"); ok("authorizing a write lets it happen");
  const rm = await until(() => steps.get("toolu_rm")?.state === "waiting" && steps.get("toolu_rm"));
  assert.equal(rm.why, "runs a command on your laptop"); ok("a destructive command is held");
  await post("/api/decide", { id: "toolu_rm", verdict: "deny" });
  await until(() => done.length === 2);
  assert.ok(existsSync(notes)); ok("the denied delete never ran");
  const history = main[5].messages;
  assert.ok(history.length >= 8 && JSON.stringify(history).includes("Plan my week from my notes")); ok("the second request remembers the first (session resume)");
  assert.equal(main[0].model, "claude-opus-5-5"); assert.ok(JSON.stringify(main[0].system).includes("You are ATLAS")); ok("the engine uses Opus 5.5 with ATLAS's persona");

  // no key: the HUD loads but asks are refused with a clear message
  atlas.kill(); await new Promise((r) => atlas.once("exit", r));
  log = ""; atlas = start({}); atlas.stdout.on("data", (d) => (log += d));
  for (let i = 0; i < 80 && !log.includes("ATLAS online"); i++) await new Promise((r) => setTimeout(r, 100));
  const t2 = (await (await fetch(BASE + "/")).text()).match(/name="atlas-token" content="([0-9a-f]+)"/)[1];
  const r = await fetch(BASE + "/api/ask", { method: "POST", headers: { "content-type": "application/json", "x-atlas-token": t2 }, body: JSON.stringify({ text: "hi" }) });
  assert.equal(r.status, 412); assert.match((await r.json()).error, /ANTHROPIC_API_KEY/); ok("without an API key, asks are refused with a clear message");

  console.log(`\n${passed} checks passed`);
} catch (e) {
  console.error("\nFAILED:", e.message);
  process.exitCode = 1;
} finally {
  const exited = new Promise((r) => atlas.once("exit", r));
  atlas.kill(); mock.close();
  await exited;
  await fs.rm(WORK, { recursive: true, force: true });
  process.exit();
}
