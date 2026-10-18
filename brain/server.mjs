// Atlas local brain: serves the dashboard and bridges it to Claude.
//
//   ANTHROPIC_API_KEY=sk-ant-... npm start      ->  http://localhost:7777
//
// The browser never sees your API key. It POSTs to /api/ask and reads back
// newline-delimited JSON events: {"type":"text"} deltas, {"type":"tool"} UI
// actions Claude chose (alert colour, missions, focus), and {"type":"error"}.

import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || "127.0.0.1"; // local only: don't expose your key-backed brain to the network
const MODEL = process.env.ATLAS_MODEL || "claude-opus-5-5";
const AGENTS = ["PLANNER", "RESEARCH", "MEMORY", "CODER", "VISION", "OPERATOR"];
const MAX_ROUNDS = 5;

const SYSTEM = `You are ATLAS, the voice of a personal "agentic OS" dashboard running on the user's laptop (think JARVIS). Claude is your brain.
The dashboard shows a cognition core and six agents: ${AGENTS.join(", ")}.
Speak like a calm, capable assistant. Reply in at most 3 short sentences of plain text: no markdown, no lists.
When the user gives you a task, call run_mission to animate which agents would handle it, then say briefly what you would do.
Use set_alert_level when the user asks for an alert, red alert, or to stand down. Use focus_agent to highlight one agent.
Use get_laptop_status when the user asks about their machine. It returns real CPU, memory and uptime.
Be honest: you can only change the dashboard and read laptop stats. You cannot open apps or read files yet, so say so if asked.`;

// Tools Claude can call. Dashboard tools are executed in the browser (we forward
// them as events); get_laptop_status runs here, on the real machine.
const TOOLS = [
  {
    name: "run_mission",
    description: "Animate the dashboard running a mission: a short title and the ordered agents that would work on it. Returns 'started'.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short mission title, under 60 characters" },
        agents: { type: "array", items: { type: "string", enum: AGENTS }, description: "Agents in the order they work" },
      },
      required: ["title", "agents"],
      additionalProperties: false,
    },
  },
  {
    name: "set_alert_level",
    description: "Change the dashboard alert colour: normal (cyan), amber (caution) or red (red alert). Returns the new level.",
    input_schema: { type: "object", properties: { level: { type: "string", enum: ["normal", "amber", "red"] } }, required: ["level"], additionalProperties: false },
  },
  {
    name: "focus_agent",
    description: "Highlight one agent on the dashboard for a few seconds. Returns 'focused'.",
    input_schema: { type: "object", properties: { agent: { type: "string", enum: AGENTS } }, required: ["agent"], additionalProperties: false },
  },
  {
    name: "get_laptop_status",
    description: "Read this laptop's real CPU load, memory use, uptime, hostname and OS. Returns JSON.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
].map((t) => ({ ...t, eager_input_streaming: true }));

// Inputs arrive already parsed but, with eager streaming, unvalidated: check them here.
function validate(name, input) {
  if (!input || typeof input !== "object") return "input must be an object";
  if (name === "run_mission") {
    if (typeof input.title !== "string" || !input.title.trim()) return "title must be a non-empty string";
    if (!Array.isArray(input.agents) || !input.agents.length || !input.agents.every((a) => AGENTS.includes(a))) return `agents must be a non-empty list drawn from ${AGENTS.join(", ")}`;
  }
  if (name === "set_alert_level" && !["normal", "amber", "red"].includes(input.level)) return "level must be normal, amber or red";
  if (name === "focus_agent" && !AGENTS.includes(input.agent)) return `agent must be one of ${AGENTS.join(", ")}`;
  return null;
}

// --- laptop stats ----------------------------------------------------------
let lastCpu = os.cpus();
function laptopStats() {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const prev = lastCpu[i] || c;
    const t = (k) => c.times[k] - prev.times[k];
    const sum = t("user") + t("nice") + t("sys") + t("idle") + t("irq");
    idle += t("idle"); total += sum;
  });
  lastCpu = now;
  return {
    cpu: total > 0 ? Math.round((1 - idle / total) * 100) : 0,
    mem: Math.round((1 - os.freemem() / os.totalmem()) * 100),
    memGB: +(os.totalmem() / 2 ** 30).toFixed(1),
    cores: now.length,
    uptimeH: +(os.uptime() / 3600).toFixed(1),
    host: os.hostname(),
    platform: `${os.type()} ${os.release()}`,
  };
}

// --- conversation ----------------------------------------------------------
// One conversation per server process (it's your laptop, you're the only user).
// History is append-only: assistant turns go back exactly as the API returned them.
let history = [];
let client = null;

async function ask(text, deep, send) {
  client ??= new Anthropic(); // reads ANTHROPIC_API_KEY (or an `ant auth login` profile)
  history.push({ role: "user", content: text });

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const stream = client.beta.messages.stream({
      model: MODEL,
      max_tokens: 64000,
      system: SYSTEM,
      tools: TOOLS,
      messages: history,
      output_config: { effort: deep ? "high" : "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    let wrote = false;
    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") { wrote = true; send({ type: "text", delta: event.delta.text }); }
    }
    const message = await stream.finalMessage();
    history.push({ role: "assistant", content: message.content });

    if (message.stop_reason === "refusal") { send({ type: "error", message: "Claude declined that request." }); return; }
    if (message.stop_reason === "max_tokens") { send({ type: "error", message: "The answer hit the length limit." }); return; }
    if (message.stop_reason !== "tool_use") return;

    const results = [];
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      const problem = validate(block.name, block.input);
      if (problem) { results.push({ type: "tool_result", tool_use_id: block.id, content: `Error: ${problem}`, is_error: true }); continue; }
      if (block.name === "get_laptop_status") {
        const stats = laptopStats();
        send({ type: "stats", stats });
        results.push({ type: "tool_result", tool_use_id: block.id, content: JSON.stringify(stats) });
      } else {
        send({ type: "tool", name: block.name, input: block.input });
        const out = block.name === "run_mission" ? "started" : block.name === "focus_agent" ? "focused" : block.input.level;
        results.push({ type: "tool_result", tool_use_id: block.id, content: out });
      }
    }
    history.push({ role: "user", content: results }); // all results in one message
    if (wrote) send({ type: "text", delta: "\n" });
  }
}

function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Claude rejected the API key. Check ANTHROPIC_API_KEY.";
  if (err instanceof Anthropic.RateLimitError) return "Rate limited by the Claude API. Wait a moment and try again.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Claude API. Check your internet connection.";
  if (err instanceof Anthropic.APIError) return `Claude API error ${err.status ?? ""}: ${err.message}`;
  if (/api key|apiKey|credentials/i.test(String(err?.message))) return "No API key found. Start the server with ANTHROPIC_API_KEY set.";
  return String(err?.message || err);
}

// --- http ------------------------------------------------------------------
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".mp4": "video/mp4", ".svg": "image/svg+xml" };

async function readJson(req) {
  let body = "";
  for await (const chunk of req) { body += chunk; if (body.length > 64_000) throw new Error("request too large"); }
  return JSON.parse(body || "{}");
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === "/api/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ atlas: true, model: MODEL, keySet: Boolean(process.env.ANTHROPIC_API_KEY) }));
    }
    if (url.pathname === "/api/stats") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(laptopStats()));
    }
    if (url.pathname === "/api/reset" && req.method === "POST") {
      history = [];
      res.writeHead(204); return res.end();
    }
    if (url.pathname === "/api/ask" && req.method === "POST") {
      const { text, deep } = await readJson(req);
      if (typeof text !== "string" || !text.trim()) { res.writeHead(400); return res.end("text is required"); }
      res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
      const send = (ev) => res.write(JSON.stringify(ev) + "\n");
      const before = history.length;
      try { await ask(text.slice(0, 4000), Boolean(deep), send); }
      catch (err) { history.length = before; send({ type: "error", message: describeError(err) }); }
      return res.end();
    }
    // static files from the project root
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = path.resolve(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep) || rel.split("/").some((p) => p.startsWith(".")) || rel.startsWith("node_modules")) { res.writeHead(404); return res.end(); }
    const data = await fs.readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch (err) {
    if (!res.headersSent) res.writeHead(err.code === "ENOENT" ? 404 : 500);
    res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`ATLAS online  ->  http://${HOST}:${PORT}`);
  console.log(`brain: ${MODEL}${process.env.ANTHROPIC_API_KEY ? "" : "  (ANTHROPIC_API_KEY not set: the page will load, asks will fail)"}`);
});
