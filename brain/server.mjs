// ATLAS brain: serves the HUD and runs Claude's official agent engine (Claude Agent SDK,
// the same engine as Claude Code) on your laptop.
//
//   put ANTHROPIC_API_KEY=sk-ant-... in a .env file next to package.json (see .env.example)
//   npm start                      ->  http://127.0.0.1:7777
//
// Settings (in .env, or as environment variables, which win):
//   ATLAS_MODEL        default claude-opus-5-5
//   ATLAS_WORKSPACE    folder Claude works in (default: your home folder)
//   ATLAS_AUTO_EDITS=1 let file edits inside the workspace through without asking
//   ATLAS_BUDGET_USD   spending cap per request (default 2)
//   ATLAS_OWNER        what ATLAS calls you (default: your login name)
//
// Only your own browser tab can drive it: the page carries a per-launch token, every API
// call must present it, and requests for any other host name are refused.

import http from "node:http";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { query, createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { agentFor, describe, decide, tidy } from "./policy.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Read settings from .env (KEY=value per line) without overriding anything already set.
try {
  for (const line of (await fs.readFile(path.join(ROOT, ".env"), "utf8")).split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#") && process.env[m[1]] === undefined) process.env[m[1]] = /^["']/.test(m[2]) ? m[2].replace(/^(["'])(.*)\1$/, "$2") : m[2].replace(/\s+#.*$/, "");
  }
} catch { /* no .env: environment variables only */ }
const home = (p) => p.replace(/^~(?=$|[\\/])/, os.homedir());

const PORT = Number(process.env.PORT || 7777);
const HOST = "127.0.0.1";
const TOKEN = crypto.randomBytes(24).toString("hex");
const THREE = path.join(ROOT, "node_modules", "three");
const cfg = {
  model: process.env.ATLAS_MODEL || "claude-opus-5-5",
  workspace: path.resolve(home(process.env.ATLAS_WORKSPACE || os.homedir())),
  autoEdits: process.env.ATLAS_AUTO_EDITS === "1",
  budget: Number(process.env.ATLAS_BUDGET_USD || 2),
  owner: process.env.ATLAS_OWNER || os.userInfo().username,
};
const AGENTS = ["PLANNER", "RESEARCH", "MEMORY", "CODER", "VISION", "OPERATOR"];
const hasKey = () => Boolean(process.env.ANTHROPIC_API_KEY);

// --- events to every open HUD --------------------------------------------------------
const clients = new Set();
function send(ev) { const line = `data: ${JSON.stringify(ev)}\n\n`; for (const res of clients) res.write(line); }

// --- laptop stats ----------------------------------------------------------------------
let lastCpu = os.cpus();
function laptopStats() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const prev = lastCpu[i] || c, d = (k) => c.times[k] - prev.times[k];
    idle += d("idle"); total += d("user") + d("nice") + d("sys") + d("idle") + d("irq");
  });
  lastCpu = now;
  return {
    cpu: total > 0 ? Math.round((1 - idle / total) * 100) : 0,
    mem: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    memGB: +(os.totalmem() / 2 ** 30).toFixed(1), cores: now.length,
    uptimeH: +(os.uptime() / 3600).toFixed(1), host: os.hostname(), platform: `${os.type()} ${os.release()}`,
  };
}

// --- dashboard tools Claude can call (in-process MCP server) ----------------------------
const text = (t) => ({ content: [{ type: "text", text: t }] });
const dashboard = createSdkMcpServer({
  name: "atlas",
  version: "2.0.0",
  tools: [
    tool("set_alert_level", "Change the HUD alert colour: normal (cyan), amber (caution) or red (red alert). Use it when the user asks for an alert or to stand down.",
      { level: z.enum(["normal", "amber", "red"]) }, async ({ level }) => { send({ type: "alert", level }); return text(`alert level ${level}`); }),
    tool("focus_agent", "Highlight one agent on the HUD for a few seconds.",
      { agent: z.enum(AGENTS) }, async ({ agent }) => { send({ type: "focus", agent }); return text("focused"); }),
    tool("get_laptop_status", "Read this laptop's real CPU load, memory use, uptime, hostname and OS.",
      {}, async () => { const s = laptopStats(); send({ type: "stats", stats: s }); return text(JSON.stringify(s)); }),
  ],
});

const PERSONA = `You are ATLAS, the voice of ${cfg.owner}'s agentic OS: a JARVIS-style HUD on their ${({ darwin: "macOS", win32: "Windows", linux: "Linux" })[process.platform] || process.platform} laptop. You are its brain, running as Claude.
Speak like a calm, capable assistant: short plain sentences, no headers or tables. Before your first tool call, say in one line what you're about to do. When you finish, say what you did and what you found in one to three sentences.
Anything that changes the laptop (writing or editing files, most commands) is held on the HUD until the user authorizes it. If they deny it, accept that and adapt; never route around a denial with a different tool.
Dashboard tools: mcp__atlas__set_alert_level for "red alert" or "stand down", mcp__atlas__focus_agent to highlight an agent, mcp__atlas__get_laptop_status for real CPU and memory.
The working folder is ${tidy(cfg.workspace)}.`;

// --- one request at a time ----------------------------------------------------------------
let sessionId = null, busy = null;
const gates = new Map();   // tool_use_id -> resolve(verdict)
const steps = new Map();   // tool_use_id -> step shown on the HUD

function step(id, fields) {
  const s = { ...(steps.get(id) || { id }), ...fields };
  steps.set(id, s);
  send({ type: "step", step: s });
  return s;
}

async function run(prompt, deep) {
  const abort = new AbortController();
  busy = { abort, q: null };
  send({ type: "state", busy: true });
  let wroteText = false, lastWasTool = false, finished = null;
  try {
    const q = query({
      prompt,
      options: {
        model: cfg.model,
        effort: deep ? "high" : "low",
        cwd: cfg.workspace,
        resume: sessionId || undefined,
        settingSources: [],                      // don't load ~/.claude settings: ATLAS decides permissions
        permissionMode: "default",
        includePartialMessages: true,
        maxBudgetUsd: cfg.budget,
        abortController: abort,
        systemPrompt: { type: "preset", preset: "claude_code", append: PERSONA },
        mcpServers: { atlas: dashboard },
        hooks: {
          PreToolUse: [{ hooks: [async (input) => {
            const [verb, object] = describe(input.tool_name, input.tool_input || {});
            step(input.tool_use_id, { agent: agentFor(input.tool_name, input.tool_input || {}), tool: input.tool_name, verb, object, state: "running" });
            lastWasTool = true;
            // Make our policy the authority even where the engine would allow on its own.
            return decide(input.tool_name, input.tool_input || {}, cfg).verdict === "ask"
              ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: "ATLAS holds this for the user's authorization" } }
              : {};
          }] }],
          PostToolUse: [{ hooks: [async (input) => { step(input.tool_use_id, { state: "done" }); return {}; }] }],
          PostToolUseFailure: [{ hooks: [async (input) => {
            if (steps.get(input.tool_use_id)?.state !== "denied") step(input.tool_use_id, { state: "failed", why: String(input.error || "").slice(0, 120) });
            return {};
          }] }],
        },
        canUseTool: async (name, input, { signal, toolUseID }) => {
          const d = decide(name, input, cfg);
          if (d.verdict === "allow") return { behavior: "allow", updatedInput: input };
          const [verb, object] = describe(name, input);
          step(toolUseID, { agent: agentFor(name, input), tool: name, verb, object, state: "waiting", why: d.why });
          const verdict = await new Promise((resolve) => {
            gates.set(toolUseID, resolve);
            signal.addEventListener("abort", () => resolve("deny"), { once: true });
          });
          gates.delete(toolUseID);
          if (verdict === "allow") { step(toolUseID, { state: "running" }); return { behavior: "allow", updatedInput: input }; }
          step(toolUseID, { state: "denied" });
          return { behavior: "deny", message: "The user denied this on the ATLAS HUD. Don't try to do the same thing another way; adapt or ask them." };
        },
        stderr: (d) => { if (process.env.ATLAS_DEBUG) process.stderr.write(d); },
      },
    });
    busy.q = q;
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "init") sessionId = m.session_id;
      else if (m.type === "stream_event" && !m.parent_tool_use_id) {
        const ev = m.event;
        if (ev.type === "content_block_start" && ev.content_block?.type === "text" && wroteText && lastWasTool) send({ type: "text", delta: "\n" });
        if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") { send({ type: "text", delta: ev.delta.text }); wroteText = true; lastWasTool = false; }
      } else if (m.type === "assistant" && m.error) {
        send({ type: "error", message: engineError(m.error) });
      } else if (m.type === "result") {
        finished = { type: "done", cost: m.total_cost_usd, turns: m.num_turns, error: m.is_error ? engineError(m.subtype) : null };
      }
    }
  } catch (err) {
    finished = { type: "done", error: abort.signal.aborted ? null : engineError(err?.message || String(err)) };
  } finally {
    for (const resolve of gates.values()) resolve("deny");
    busy = null;                                  // free before announcing, so the next request is accepted
    send({ type: "state", busy: false });
    send(finished || { type: "done", error: abort.signal.aborted ? null : "The engine stopped without a result." });
  }
}

function engineError(code) {
  const c = String(code || "");
  if (/authentication|api key|401/i.test(c)) return "Claude rejected the API key. Check ANTHROPIC_API_KEY and restart ATLAS.";
  if (/rate_limit|429/i.test(c)) return "Claude is rate limiting us. Give it a minute.";
  if (/billing|credit/i.test(c)) return "The API account is out of credit.";
  if (/max_budget/i.test(c)) return `Stopped at the $${cfg.budget} spending cap for one request (ATLAS_BUDGET_USD).`;
  if (/overloaded|server_error|5\d\d/i.test(c)) return "Claude's servers are busy. Try again shortly.";
  return `The engine stopped: ${c.slice(0, 200)}`;
}

// --- http ---------------------------------------------------------------------------------
async function body(req) {
  let s = "";
  for await (const c of req) { s += c; if (s.length > 64_000) throw new Error("request too large"); }
  return s ? JSON.parse(s) : {};
}
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}`);
  if (![`127.0.0.1:${PORT}`, `localhost:${PORT}`].includes(req.headers.host)) { res.writeHead(421); return res.end(); }
  try {
    if (url.pathname === "/" || url.pathname === "/index.html") {
      let html = await fs.readFile(path.join(ROOT, "index.html"), "utf8");
      html = html.replace("<head>", `<head>\n<meta name="atlas-token" content="${TOKEN}">`);
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
    if ((req.headers["x-atlas-token"] || url.searchParams.get("token")) !== TOKEN) return json(res, 403, { error: "missing or wrong token" });

    if (url.pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(`data: ${JSON.stringify({ type: "hello", model: cfg.model, owner: cfg.owner, keySet: hasKey(), busy: Boolean(busy), workspace: tidy(cfg.workspace), autoEdits: cfg.autoEdits })}\n\n`);
      for (const s of steps.values()) if (s.state === "waiting") res.write(`data: ${JSON.stringify({ type: "step", step: s })}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(": ping\n\n"), 25000);
      req.on("close", () => { clients.delete(res); clearInterval(ping); });
      return;
    }
    if (url.pathname === "/api/stats") return json(res, 200, laptopStats());
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    const b = await body(req);
    if (url.pathname === "/api/ask") {
      if (typeof b.text !== "string" || !b.text.trim()) return json(res, 400, { error: "text is required" });
      if (!hasKey()) return json(res, 412, { error: "No API key. Start ATLAS with ANTHROPIC_API_KEY set (an API key from platform.claude.com)." });
      if (busy) return json(res, 409, { error: "Still working on the last request. Stop it first, or wait." });
      run(b.text.trim().slice(0, 8000), Boolean(b.deep));
      return json(res, 202, { started: true });
    }
    if (url.pathname === "/api/decide") {
      const resolve = gates.get(String(b.id));
      if (!resolve) return json(res, 409, { error: "nothing is waiting with that id" });
      resolve(b.verdict === "allow" ? "allow" : "deny");
      return json(res, 200, {});
    }
    if (url.pathname === "/api/stop") {
      if (busy) { busy.q?.interrupt().catch(() => {}); busy.abort.abort(); }
      return json(res, 200, { stopped: Boolean(busy) });
    }
    if (url.pathname === "/api/reset") { if (!busy) { sessionId = null; steps.clear(); } return json(res, 200, { reset: !busy }); }
    return json(res, 404, { error: "unknown endpoint" });
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: String(err?.message || err) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ATLAS online  →  http://${HOST}:${PORT}`);
  console.log(`brain: ${cfg.model} via Claude Agent SDK · workspace ${tidy(cfg.workspace)} · cap $${cfg.budget}/request`);
  if (!hasKey()) console.log("No ANTHROPIC_API_KEY found: put it in the .env file (see .env.example), then restart. The HUD loads, but Claude can't act until then.");
  if (process.env.ATLAS_OPEN === "1") {
    const url = `http://${HOST}:${PORT}`;
    const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
    import("node:child_process").then(({ spawn }) => spawn(cmd, args, { stdio: "ignore", detached: true }).on("error", () => {}).unref());
  }
});
