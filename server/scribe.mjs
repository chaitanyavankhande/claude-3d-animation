// The scribe: runs Claude's agent loop and writes every step into today's chapter.

import Anthropic from "@anthropic-ai/sdk";
import os from "node:os";
import path from "node:path";
import * as book from "./book.mjs";
import { toolDefinitions, classify, validate, runEditor, runCommand, openItem, EDITOR, osName, tidy, expand } from "./tools.mjs";

const BETAS = ["thinking-display-updates-2026-08-18", "server-side-fallback-2026-07-01"];
const MAX_STEPS = 60;

export class Scribe {
  constructor(cfg, emit) {
    this.cfg = cfg;
    this.emit = emit;
    this.client = null;
    this.busy = null;          // the entry being written
    this.gates = new Map();    // action id -> resolve(verdict)
    this.inbox = [];           // margin notes and erasures waiting to reach Claude
    this.abort = null;
    this.seq = 0;
  }

  async open(date = book.today()) {
    const { chapter, messages } = await book.loadChapter(date);
    this.chapter = chapter;
    this.messages = messages;
    this.chapters = await book.listChapters();
    // An entry left "working" by a crash or restart can't resume: close it honestly.
    for (const e of this.chapter.entries) if (e.status === "working") e.status = "stopped";
    for (const e of this.chapter.entries) for (const it of e.items) if (["pencil", "waiting", "seeping", "inking"].includes(it.state)) it.state = "struck";
    this.repairMessages();
  }

  // Every tool_use needs a tool_result before the next user turn; fill any gap left by a crash.
  repairMessages() {
    const last = this.messages[this.messages.length - 1];
    if (last?.role !== "assistant" || !Array.isArray(last.content)) return;
    const uses = last.content.filter((b) => b.type === "tool_use");
    if (uses.length) this.messages.push({ role: "user", content: uses.map((u) => ({ type: "tool_result", tool_use_id: u.id, content: "Interrupted: Quire was closed before this ran.", is_error: true })) });
  }

  state() {
    return { type: "state", chapter: this.chapter, owner: this.cfg.owner, model: this.cfg.model, busy: this.busy?.id || null, keySet: hasKey(), os: osName() };
  }

  async ensureToday() {
    if (this.chapter.date !== book.today() && !this.busy) {
      await book.writeNow(this.chapter, this.messages);
      await this.open(book.today());
      this.emit(this.state());
    }
  }

  // --- the user's side ------------------------------------------------------------

  async ask(text) {
    await this.ensureToday();
    if (this.busy) { this.note({ text }); return { queued: true }; }
    const now = new Date();
    const entry = { id: `e${Date.now().toString(36)}`, time: `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`, prompt: text, status: "working", items: [] };
    this.chapter.entries.push(entry);
    this.busy = entry;
    this.emitEntry(entry);
    this.run(entry, text).catch((err) => this.fail(entry, err)).finally(() => {
      this.busy = null;
      if (entry.status === "working") entry.status = "done";
      this.emitEntry(entry);
      this.persist();
    });
    return { entry: entry.id };
  }

  decide(id, verdict) {
    const resolve = this.gates.get(id);
    if (!resolve) return false;
    resolve(verdict === "ink" ? "ink" : "strike");
    return true;
  }

  note({ itemId, quote = "", text }) {
    const entry = this.busy || this.chapter.entries[this.chapter.entries.length - 1];
    if (!entry || !text) return false;
    const item = { kind: "note", id: `n${++this.seq}${Date.now().toString(36)}`, after: itemId || null, quote: quote.slice(0, 300), text: text.slice(0, 2000), state: this.busy ? "pencil" : "inked" };
    entry.items.push(item);
    this.emitItem(entry, item);
    if (this.busy) this.inbox.push({ note: item });
    else this.ask(quote ? `About “${quote}”: ${text}` : text);
    this.persist();
    return true;
  }

  async erase(id) {
    const found = this.findItem(id);
    if (!found || found.item.state !== "inked" || !found.item.erasable) throw new Error("that line can't be erased");
    const meta = await book.restoreSnapshot(safeId(id));
    // Erasing restores the file to before this change, so later changes to the same file go too.
    const erased = [];
    let after = false;
    for (const e of this.chapter.entries) for (const it of e.items) {
      if (it.id === id) after = true;
      if (after && it.kind === "action" && it.erasable && it.state === "inked" && it.path === meta.path) {
        it.state = "erased"; erased.push(it.object); this.emitItem(e, it);
      }
    }
    this.inbox.push({ text: `The user erased your change${erased.length > 1 ? "s" : ""} to ${tidy(meta.path)}; the file is back to how it was before. Don't redo it unless they ask.` });
    this.persist();
    return { erased };
  }

  stop() {
    if (!this.busy) return false;
    this.stopping = true;
    this.abort?.abort();
    for (const resolve of this.gates.values()) resolve("stop");
    return true;
  }

  // --- the loop -------------------------------------------------------------------

  async run(entry, text) {
    this.client ??= new Anthropic();
    this.stopping = false;
    const intro = [{ type: "text", text }];
    this.pushUser([...this.drainInbox(), ...intro]);
    let badJson = 0;

    for (let step = 0; step < MAX_STEPS; step++) {
      if (this.stopping) { entry.status = "stopped"; return; }
      this.abort = new AbortController();
      let message;
      try {
        message = await this.stream(entry);
      } catch (err) {
        if (this.stopping || err?.name === "AbortError" || err instanceof Anthropic.APIUserAbortError) { entry.status = "stopped"; return; }
        if (!(err instanceof Anthropic.APIError) && /json/i.test(String(err?.message)) && badJson++ < 2) continue; // unparseable tool input: ask again
        throw err;
      }
      this.messages.push({ role: "assistant", content: message.content });
      this.persist();

      if (message.stop_reason === "refusal") { this.addProse(entry, "Claude declined to continue with this request.", "error"); entry.status = "error"; return; }
      if (message.stop_reason === "pause_turn") { step--; continue; }                // server tools paused: resend as-is
      const uses = message.content.filter((b) => b.type === "tool_use");
      if (message.stop_reason === "max_tokens" && uses.length) {
        this.pushUser(uses.map((u) => ({ type: "tool_result", tool_use_id: u.id, content: "Your tool call was cut off by the length limit; try again with less in one call.", is_error: true })));
        continue;
      }
      if (!uses.length) return;

      const results = [];
      for (const use of uses) results.push(await this.act(entry, use));
      this.pushUser([...results, ...this.drainInbox()]);
    }
    this.addProse(entry, `Stopped after ${MAX_STEPS} steps. Ask me to carry on if there's more to do.`, "aside");
  }

  async stream(entry) {
    const params = {
      model: this.cfg.model,
      max_tokens: 64000,
      system: this.systemPrompt(),
      tools: toolDefinitions(),
      messages: this.messages,
      thinking: { type: "adaptive", display: "updates" },
      output_config: { effort: this.cfg.effort },
      cache_control: { type: "ephemeral" },
      betas: BETAS,
      fallbacks: "default",
    };
    const stream = this.client.beta.messages.stream(params, { signal: this.abort.signal });
    const byIndex = new Map();
    const partial = new Map();
    for await (const ev of stream) {
      if (ev.type === "content_block_start") {
        const b = ev.content_block;
        if (b.type === "text" || b.type === "thinking") byIndex.set(ev.index, this.addProse(entry, b.text || b.thinking || "", b.type === "thinking" ? "aside" : "prose"));
        else if (b.type === "tool_use") byIndex.set(ev.index, this.addAction(entry, { id: b.id, tool: b.name, verb: verbFor(b.name), object: "…", state: "pencil" }));
        else if (b.type === "server_tool_use") byIndex.set(ev.index, this.addAction(entry, { id: b.id, tool: b.name, verb: b.name === "web_fetch" ? "read the page" : "search the web for", object: "…", state: "pencil", ink: "look" }));
        else if (/_tool_result$/.test(b.type) && b.tool_use_id) this.serverResult(entry, b);
      } else if (ev.type === "content_block_delta") {
        const item = byIndex.get(ev.index);
        if (!item) continue;
        if (ev.delta.type === "text_delta") { item.text += ev.delta.text; this.emitItem(entry, item); }
        else if (ev.delta.type === "thinking_delta") { item.text += ev.delta.thinking; if (item.text.trim()) this.emitItem(entry, item); }
        else if (ev.delta.type === "input_json_delta") partial.set(ev.index, (partial.get(ev.index) || "") + ev.delta.partial_json);
      } else if (ev.type === "content_block_stop") {
        const item = byIndex.get(ev.index);
        if (item?.kind === "action") {
          let input = null;
          try { input = JSON.parse(partial.get(ev.index) || "{}"); } catch { /* finalMessage will have the parsed form */ }
          if (input) this.describe(item, item.tool, input);
          if (["web_search", "web_fetch"].includes(item.tool)) item.state = "inking";
          this.emitItem(entry, item);
        }
      }
    }
    return stream.finalMessage();
  }

  describe(item, tool, input) {
    if (tool === "web_search") item.object = String(input.query || "…");
    else if (tool === "web_fetch") item.object = String(input.url || "…");
    else {
      const c = classify(tool, input, this.cfg);
      Object.assign(item, { verb: c.verb, object: c.object, ink: c.kind, why: c.why });
    }
  }

  serverResult(entry, block) {
    const found = this.findItem(block.tool_use_id);
    if (!found) return;
    const c = block.content;
    const err = c && !Array.isArray(c) && c.error_code;
    found.item.state = err ? "failed" : "inked";
    found.item.result = { summary: err ? `error: ${c.error_code}` : Array.isArray(c) ? `${c.length} results` : "read" };
    this.emitItem(found.entry, found.item);
  }

  async act(entry, use) {
    const item = this.findItem(use.id)?.item || this.addAction(entry, { id: use.id, tool: use.name, verb: verbFor(use.name), object: "…", state: "pencil" });
    const answer = (content, is_error = false) => ({ type: "tool_result", tool_use_id: use.id, content, ...(is_error ? { is_error: true } : {}) });

    const problem = validate(use.name, use.input);
    if (problem) {
      item.state = "failed"; item.result = { summary: "garbled request" }; this.emitItem(entry, item);
      return answer(JSON.stringify({ INVALID_INPUT: problem, received: use.input }), true);
    }
    const c = classify(use.name, use.input, this.cfg);
    Object.assign(item, { verb: c.verb, object: c.object, ink: c.kind, why: c.why });
    if (use.name === EDITOR && use.input.command !== "view") { item.erasable = true; item.path = expand(use.input.path); }

    const verdict = this.stopping ? "stop" : await this.gate(entry, item, c);
    if (verdict !== "ink") {
      item.state = "struck"; item.erasable = false; this.emitItem(entry, item);
      return answer(verdict === "stop" ? "The user stopped the work before this ran." : "The user struck this line out: they don't want it done. Don't try to achieve the same thing another way; adapt, or ask them.");
    }

    item.state = "inking"; this.emitItem(entry, item);
    try {
      let out;
      if (use.name === EDITOR) out = await runEditor(use.input, (abs) => book.snapshotFile(safeId(use.id), abs));
      else if (use.name === "run_command") out = await runCommand(use.input, { signal: this.abort?.signal });
      else if (use.name === "open_item") out = await openItem(use.input);
      else throw new Error(`Unknown tool ${use.name}`);
      item.state = out.error ? "failed" : "inked";
      item.result = { summary: out.summary, output: out.text.slice(0, 12000) };
      if (out.error) item.erasable = false;
      this.emitItem(entry, item);
      return answer(out.text, Boolean(out.error));
    } catch (err) {
      item.state = "failed"; item.erasable = false; item.result = { summary: err.code === "ENOENT" ? "not found" : String(err.message).slice(0, 120) };
      this.emitItem(entry, item);
      return answer(`Error: ${err.message}`, true);
    }
  }

  // Pencil → ink. Lines that wait need you; the rest ink themselves after a pause unless struck.
  gate(entry, item, c) {
    return new Promise((resolve) => {
      let timer = null;
      const done = (v) => { clearTimeout(timer); this.gates.delete(item.id); resolve(v); };
      this.gates.set(item.id, done);
      if (c.waits) item.state = "waiting";
      else {
        item.state = "seeping";
        item.seepMs = this.cfg.seepMs[c.kind] ?? 1000;
        timer = setTimeout(() => done("ink"), item.seepMs);
      }
      this.emitItem(entry, item);
      this.persist();
    });
  }

  // --- bookkeeping ------------------------------------------------------------------

  pushUser(blocks) {
    if (!blocks.length) return;
    const last = this.messages[this.messages.length - 1];
    if (last?.role === "user") last.content = [...(Array.isArray(last.content) ? last.content : [{ type: "text", text: last.content }]), ...blocks];
    else this.messages.push({ role: "user", content: blocks });
  }

  drainInbox() {
    const out = this.inbox.splice(0).map((m) => {
      if (m.note) {
        m.note.state = "inked";
        const e = this.findItem(m.note.id)?.entry; if (e) this.emitItem(e, m.note);
        return { type: "text", text: m.note.quote ? `Margin note from the user on your words “${m.note.quote}”: ${m.note.text}` : `Note from the user: ${m.note.text}` };
      }
      return { type: "text", text: m.text };
    });
    return out;
  }

  addProse(entry, text, style = "prose") {
    const item = { kind: "prose", id: `p${++this.seq}${Date.now().toString(36)}`, style, text };
    entry.items.push(item);
    if (text.trim()) this.emitItem(entry, item);
    return item;
  }

  addAction(entry, fields) {
    const item = { kind: "action", ...fields };
    entry.items.push(item);
    this.emitItem(entry, item);
    return item;
  }

  findItem(id) {
    for (const entry of this.chapter.entries) { const item = entry.items.find((i) => i.id === id); if (item) return { entry, item }; }
    return null;
  }

  fail(entry, err) {
    entry.status = "error";
    this.addProse(entry, describeError(err), "error");
    this.repairMessages();
  }

  emitItem(entry, item) { this.emit({ type: "item", entry: entry.id, item }); }
  emitEntry(entry) { const { items, ...meta } = entry; this.emit({ type: "entry", entry: meta }); }
  persist() { book.save(this.chapter, this.messages); }

  systemPrompt() {
    const d = new Date(this.chapter.date + "T12:00:00");
    const day = d.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
    const shell = process.platform === "win32" ? "PowerShell" : path.basename(process.env.SHELL || "bash");
    return `You are the scribe in Quire, a personal operating system on ${this.cfg.owner}'s ${osName()} laptop. You are its brain: you do the work, and everything you do is written into today's chapter of their book, which they read like a notebook.

How the page works:
- Each tool call appears as a line written in pencil. Reading inks itself almost at once. File changes ink themselves after a short pause (the user can strike them first), and Quire snapshots each file before changing it, so the user can erase any change later. Commands that change things and anything that launches a program stay in pencil until the user inks them.
- If the user strikes a line, take it as a no. Adapt or ask; never route around it with a different tool.
- Write for the page: plain, short sentences, like a careful notebook. Before your first tool call, say in one line what you're about to do. When you finish, say what you did, what you found, and anything that needs the user. Avoid headers and tables; short lists are fine.
- The user may leave margin notes on sentences you wrote. Treat them as corrections or instructions about that part.
- Prefer the editor tool for reading and changing files; use run_command for everything else. Be careful with anything you can't undo.

Facts:
- Today is ${day} (chapter ${this.chapter.number}). Home folder: ${os.homedir()}. Shell: ${shell}.
- Shelves (you may read and change these freely): ${this.cfg.shelves.map(tidy).join(", ")}.
- The user's book is in ${tidy(path.join(book.HOME, "book"))}: one Markdown file per day (YYYY-MM-DD.md). Read it when they mention earlier days.

Previously:
${book.previously(this.chapters, this.chapter.date)}`;
  }
}

function verbFor(name) { return { run_command: "run", open_item: "open", [EDITOR]: "use" }[name] || name; }
function safeId(id) { return String(id).replace(/[^a-zA-Z0-9_-]/g, "_"); }
export function hasKey() { return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN); }

export function describeError(err) {
  if (err instanceof Anthropic.AuthenticationError) return "Claude rejected the API key. Check ANTHROPIC_API_KEY and restart Quire.";
  if (err instanceof Anthropic.RateLimitError) return "The Claude API is rate limiting us. Wait a minute, then ask again.";
  if (err instanceof Anthropic.APIConnectionError) return "Couldn't reach the Claude API. Check the internet connection.";
  if (err instanceof Anthropic.APIError) return `The Claude API returned an error (${err.status ?? "?"}): ${err.message}`;
  if (/api ?key|credentials|auth/i.test(String(err?.message))) return "No Claude API key found. Start Quire with ANTHROPIC_API_KEY set.";
  return `Something went wrong: ${err?.message || err}`;
}
