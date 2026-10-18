// End-to-end test: the real Quire server against a scripted stand-in for the Claude API.
// Checks the agent loop, pencil → ink gating, strike, erase, margin notes and the book.
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
const TMP = await fs.mkdtemp(path.join(os.tmpdir(), "quire-e2e-"));
const QUIRE_HOME = path.join(TMP, "home");
const WORK = path.join(TMP, "work");
await fs.mkdir(WORK, { recursive: true });
await fs.mkdir(QUIRE_HOME, { recursive: true });
await fs.writeFile(path.join(WORK, "notes.md"), "line one\nline two\n");
await fs.writeFile(path.join(QUIRE_HOME, "config.json"), JSON.stringify({ owner: "Tester", shelves: [WORK], seepMs: { look: 50, erasable: 300 } }));

// --- a scripted Claude -------------------------------------------------------------------
const requests = [];
const sse = (res, events) => {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
};
function turn(blocks, stop) {
  const ev = [{ type: "message_start", message: { id: "msg_" + requests.length, type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }];
  blocks.forEach((b, index) => {
    if (b.type === "thinking") {
      ev.push({ type: "content_block_start", index, content_block: { type: "thinking", thinking: "", signature: "" } });
      ev.push({ type: "content_block_delta", index, delta: { type: "thinking_delta", thinking: b.text } });
      ev.push({ type: "content_block_delta", index, delta: { type: "signature_delta", signature: "sig" + index } });
    } else if (b.type === "text") {
      ev.push({ type: "content_block_start", index, content_block: { type: "text", text: "" } });
      for (const part of b.text.match(/.{1,12}/g)) ev.push({ type: "content_block_delta", index, delta: { type: "text_delta", text: part } });
    } else {
      ev.push({ type: "content_block_start", index, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      const json = JSON.stringify(b.input);
      ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(0, 10) } });
      ev.push({ type: "content_block_delta", index, delta: { type: "input_json_delta", partial_json: json.slice(10) } });
    }
    ev.push({ type: "content_block_stop", index });
  });
  ev.push({ type: "message_delta", delta: { stop_reason: stop, stop_sequence: null }, usage: { output_tokens: 20 } });
  ev.push({ type: "message_stop" });
  return ev;
}
const SCRIPT = [
  () => turn([{ type: "thinking", text: "I'll look at the notes first." }, { type: "tool_use", id: "toolu_view", name: "str_replace_based_edit_tool", input: { command: "view", path: path.join(WORK, "notes.md") } }], "tool_use"),
  () => turn([{ type: "text", text: "Adding a summary file." }, { type: "tool_use", id: "toolu_create", name: "str_replace_based_edit_tool", input: { command: "create", path: path.join(WORK, "summary.md"), file_text: "two lines\n" } }], "tool_use"),
  () => turn([{ type: "tool_use", id: "toolu_rm", name: "run_command", input: { command: `rm -rf ${WORK}/notes.md` } }], "tool_use"),
  () => turn([{ type: "text", text: "Done. I left your notes alone." }], "end_turn"),
  // second ask
  () => turn([{ type: "tool_use", id: "toolu_echo", name: "run_command", input: { command: `echo inked > ${WORK}/proof.txt` } }], "tool_use"),
  () => turn([{ type: "text", text: "Wrote the proof." }], "end_turn"),
];
const mock = http.createServer(async (req, res) => {
  let body = ""; for await (const c of req) body += c;
  const json = JSON.parse(body);
  requests.push({ headers: req.headers, body: json });
  const step = SCRIPT[requests.length - 1];
  if (!step) { res.writeHead(500); return res.end("{}"); }
  sse(res, step());
}).listen(0, "127.0.0.1");
await new Promise((r) => mock.once("listening", r));

// --- start Quire -----------------------------------------------------------------------
const PORT = 4400 + Math.floor(Math.random() * 500);
const quire = spawn(process.execPath, [path.join(ROOT, "server/quire.mjs")], {
  env: { ...process.env, PORT: String(PORT), QUIRE_HOME, ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${mock.address().port}` },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = ""; quire.stdout.on("data", (d) => (log += d)); quire.stderr.on("data", (d) => (log += d));
const BASE = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 50 && !log.includes("Quire is open"); i++) await new Promise((r) => setTimeout(r, 100));

let passed = 0;
const ok = (name) => { passed++; console.log("  ✓", name); };
try {
  // security
  const html = await (await fetch(BASE + "/")).text();
  const token = html.match(/name="quire-token" content="([0-9a-f]+)"/)[1];
  ok("page carries a per-launch token");
  assert.equal((await fetch(BASE + "/api/book")).status, 403); ok("API refuses calls without the token");
  const evil = await new Promise((resolve) => http.get({ host: "127.0.0.1", port: PORT, path: "/", headers: { host: "evil.example" } }, (r) => resolve(r.statusCode)));
  assert.equal(evil, 421); ok("requests for other host names are refused (DNS rebinding)");
  const H = { "content-type": "application/json", "x-quire-token": token };
  const post = (p, b) => fetch(BASE + p, { method: "POST", headers: H, body: JSON.stringify(b) });

  // events
  const items = new Map(); const entries = new Map(); const waiters = [];
  const es = await fetch(`${BASE}/api/events?token=${token}`);
  (async () => {
    const reader = es.body.getReader(); const dec = new TextDecoder(); let buf = "";
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data: ")); if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.type === "item") items.set(ev.item.id, ev.item);
        if (ev.type === "entry") entries.set(ev.entry.id, ev.entry);
        waiters.forEach((w) => w());
      }
    }
  })();
  const until = (cond, ms = 8000) => new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timed out waiting; log:\n" + log)), ms);
    const check = () => { const v = cond(); if (v) { clearTimeout(t); resolve(v); } };
    waiters.push(check); check();
  });

  // ask #1: view (look, auto) → create (erasable, auto after seep) → rm (permanent, waits) → we strike it
  const r1 = await (await post("/api/ask", { text: "Summarise my notes" })).json();
  assert.ok(r1.entry); ok("ask starts an entry");
  await until(() => items.get("toolu_view")?.state === "inked"); ok("a read inks itself");
  const seen = await until(() => ["seeping", "inking", "inked"].includes(items.get("toolu_create")?.state) && items.get("toolu_create"));
  assert.equal(seen.ink, "erasable"); ok("a file change is marked erasable and inks after a pause");
  const rm = await until(() => items.get("toolu_rm")?.state === "waiting" && items.get("toolu_rm"));
  assert.equal(rm.ink, "permanent"); ok("a destructive command waits in pencil");
  assert.ok(existsSync(path.join(WORK, "notes.md")));
  await post("/api/note", { itemId: [...items.values()].find((i) => i.kind === "prose")?.id, quote: "summary", text: "keep it short" });
  assert.equal((await post("/api/decide", { id: "toolu_rm", verdict: "strike" })).status, 200);
  await until(() => items.get("toolu_rm")?.state === "struck"); ok("striking it stops it");
  assert.ok(existsSync(path.join(WORK, "notes.md"))); ok("the struck command never ran");
  await until(() => entries.get(r1.entry)?.status === "done"); ok("the entry finishes");

  // what Claude was sent
  const first = requests[0];
  assert.match(first.headers["anthropic-beta"], /thinking-display-updates-2026-08-18/);
  assert.equal(first.body.thinking.display, "updates");
  assert.equal(first.body.model, "claude-opus-5-5");
  assert.ok(first.body.tools.some((t) => t.type === "text_editor_20250728"));
  assert.ok(first.body.tools.some((t) => t.type === "web_search_20260209"));
  ok("requests use Opus 5.5, progress updates, the editor and web tools");
  assert.equal(await fs.readFile(path.join(WORK, "summary.md"), "utf8"), "two lines\n"); ok("the file change happened");
  const afterStrike = requests[3].body.messages.at(-1).content;
  const struckResult = afterStrike.find((b) => b.tool_use_id === "toolu_rm");
  assert.match(struckResult.content, /struck/); ok("Claude is told the line was struck");
  assert.ok(afterStrike.some((b) => b.type === "text" && /Margin note/.test(b.text) && /keep it short/.test(b.text))); ok("the margin note reached Claude mid-task");
  const asst = requests[1].body.messages.find((m) => m.role === "assistant");
  assert.equal(asst.content[0].type, "thinking"); assert.equal(asst.content[0].signature, "sig0"); ok("thinking blocks go back unchanged");
  assert.ok(items.has([...items.values()].find((i) => i.kind === "prose" && /look at the notes/.test(i.text))?.id)); ok("progress updates show as prose");

  // erase the file change
  const er = await (await post("/api/erase", { id: "toolu_create" })).json();
  assert.ok(!existsSync(path.join(WORK, "summary.md"))); ok("erasing removes the new file");
  await until(() => items.get("toolu_create")?.state === "erased"); ok("the line is marked erased"); void er;

  // ask #2: a permanent command that we ink
  const r2 = await (await post("/api/ask", { text: "Write a proof file" })).json();
  await until(() => items.get("toolu_echo")?.state === "waiting");
  await post("/api/decide", { id: "toolu_echo", verdict: "ink" });
  await until(() => entries.get(r2.entry)?.status === "done");
  assert.equal((await fs.readFile(path.join(WORK, "proof.txt"), "utf8")).trim(), "inked"); ok("inking a permanent command runs it");
  const conv = requests[4].body.messages;
  assert.ok(conv.length > 6 && conv.at(-1).content.some((b) => b.type === "text" && /erased your change/.test(b.text))); ok("the conversation carries on, and Claude hears about the erase");

  // the book
  await new Promise((r) => setTimeout(r, 700));
  const day = (await (await fetch(`${BASE}/api/book`, { headers: H })).json()).chapters[0];
  const md = await fs.readFile(path.join(QUIRE_HOME, "book", day.date + ".md"), "utf8");
  assert.match(md, /- \[-\] run `rm -rf/); assert.match(md, /- \[~\] write `/); assert.match(md, /margin note on “summary”: keep it short/);
  ok("the day is written to a Markdown chapter");
  console.log(`\n${passed} checks passed`);
} catch (e) {
  console.error("\nFAILED:", e.message);
  process.exitCode = 1;
} finally {
  quire.kill(); mock.close();
  await fs.rm(TMP, { recursive: true, force: true });
  process.exit();
}
