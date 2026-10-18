// What Claude can do on this laptop, and how much each action asks of you.
//
// Every tool call is sorted into one of three kinds of ink:
//   look       – only reads or shows something. Inks itself almost at once.
//   erasable   – changes a file, but Quire snapshots it first so you can erase it.
//                Inks itself after a short pause unless you strike it.
//   permanent  – can't be taken back (shell commands, launching programs).
//                Stays in pencil until you ink it.
// Anything that touches a sensitive path or a folder outside your shelves also waits.

import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

export const EDITOR = "str_replace_based_edit_tool";

export function toolDefinitions() {
  const shell = process.platform === "win32" ? "PowerShell" : path.basename(process.env.SHELL || "bash");
  return [
    { type: "text_editor_20250728", name: EDITOR, max_characters: 40000 },
    {
      name: "run_command",
      description: `Run one command in ${shell} on the user's ${osName()} laptop and return its exit code and output. ` +
        "Read-only commands (ls, cat, grep, find, git status/log/diff…) run straight away; anything else waits until the user approves it, so prefer the editor tool for reading and changing files.",
      input_schema: {
        type: "object",
        properties: {
          command: { type: "string", description: "The command line to run" },
          cwd: { type: "string", description: "Working directory (default: the user's home folder)" },
        },
        required: ["command"],
      },
      eager_input_streaming: true,
    },
    {
      name: "open_item",
      description: "Open a file, folder or https URL on the user's screen with their default app (e.g. a PDF in their viewer, a folder in their file manager, a page in their browser). Returns 'opened'.",
      input_schema: {
        type: "object",
        properties: { target: { type: "string", description: "Absolute path, ~/path, or https:// URL" } },
        required: ["target"],
      },
      eager_input_streaming: true,
    },
    { type: "web_search_20260209", name: "web_search" },
    { type: "web_fetch_20260209", name: "web_fetch" },
  ];
}

export function osName() {
  return { darwin: "macOS", win32: "Windows", linux: "Linux" }[process.platform] || process.platform;
}

// --- paths -------------------------------------------------------------------

export function expand(p, home = os.homedir()) {
  if (typeof p !== "string" || !p.trim()) throw new Error("path is required");
  let s = p.trim();
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) s = path.join(home, s.slice(1));
  return path.resolve(home, s);
}

const SENSITIVE = /(^|[\\/])(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.env(\.[^\\/]*)?|id_[a-z0-9_]+|[^\\/]*\.(pem|key|p12|pfx|kdbx)|Keychains?|Login Data|Cookies)([\\/]|$)/i;

export function isSensitive(abs) { return SENSITIVE.test(abs); }

export function insideShelves(abs, shelves) {
  return shelves.some((root) => {
    const rel = path.relative(root, abs);
    return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
  });
}

// --- classification --------------------------------------------------------------

const READ_ONLY_CMDS = new Set(["ls", "dir", "pwd", "cat", "head", "tail", "wc", "file", "stat", "du", "df", "date", "whoami", "uname", "which", "where", "echo", "grep", "rg", "find", "tree", "git",
  "get-childitem", "get-content", "get-location", "select-string", "get-date", "get-item", "test-path", "type"]);
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "branch", "remote", "rev-parse", "ls-files", "blame", "describe"]);
const EXECUTABLE = /\.(exe|bat|cmd|com|msi|ps1|vbs|js|jse|wsf|scr|sh|bash|zsh|command|app|pkg|dmg|jar|py|pl|rb|run|bin|appimage|deb|rpm|lnk|desktop)$/i;

export function isReadOnlyCommand(cmd) {
  if (typeof cmd !== "string" || !cmd.trim()) return false;
  if (/[;&|<>`$(){}\n\r]/.test(cmd)) return false;          // no chaining, pipes, redirects or substitution
  const words = cmd.trim().split(/\s+/);
  const exe = words[0].toLowerCase();
  if (!READ_ONLY_CMDS.has(exe)) return false;
  if (exe === "git") return READ_ONLY_GIT.has((words[1] || "").toLowerCase());
  if (exe === "find") return !words.some((w) => /^-(exec|execdir|delete|ok|okdir|fprint|fprintf|fls)$/.test(w));
  return true;
}

// Returns how an action is written in the book and whether it has to wait for you.
export function classify(name, input, cfg) {
  const shelves = cfg.shelves;
  if (name === EDITOR) {
    const cmd = input?.command;
    let abs;
    try { abs = expand(input?.path); } catch { abs = String(input?.path || ""); }
    const outside = !insideShelves(abs, shelves), sensitive = isSensitive(abs);
    const isQuire = insideShelves(abs, [cfg.home]);
    if (cmd === "view") {
      const why = sensitive ? "sensitive file" : outside ? "outside your shelves" : null;
      return { verb: "read", object: tidy(abs), kind: "look", waits: Boolean(why), why };
    }
    const verb = { create: existsSync(abs) ? "rewrite" : "write", str_replace: "edit", insert: "add to" }[cmd] || cmd;
    const why = sensitive ? "sensitive file" : outside ? "outside your shelves" : isQuire ? "Quire's own files" : cfg.inkErasable === "ask" ? "you asked to approve every change" : null;
    return { verb, object: tidy(abs), kind: "erasable", waits: Boolean(why), why };
  }
  if (name === "run_command") {
    const ro = isReadOnlyCommand(input?.command);
    return { verb: "run", object: String(input?.command || ""), kind: ro ? "look" : "permanent", waits: !ro, why: ro ? null : "can't be undone" };
  }
  if (name === "open_item") {
    const t = String(input?.target || "");
    if (/^https:\/\//i.test(t)) return { verb: "open", object: t, kind: "look", waits: false, why: null };
    let abs; try { abs = expand(t); } catch { abs = t; }
    const exe = EXECUTABLE.test(abs) || /^[a-z][a-z0-9+.-]*:/i.test(t);
    const why = exe ? "launches a program" : isSensitive(abs) ? "sensitive file" : null;
    return { verb: "open", object: exe ? t : tidy(abs), kind: exe ? "permanent" : "look", waits: Boolean(why), why };
  }
  return { verb: name, object: JSON.stringify(input).slice(0, 120), kind: "permanent", waits: true, why: "unknown tool" };
}

export function tidy(abs) {
  const home = os.homedir();
  return abs === home ? "~" : abs.startsWith(home + path.sep) ? "~/" + path.relative(home, abs).split(path.sep).join("/") : abs;
}

// --- validation (eager streaming hands us unvalidated input) ----------------------

export function validate(name, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return "input must be an object";
  const str = (k) => typeof input[k] === "string";
  if (name === EDITOR) {
    if (!["view", "create", "str_replace", "insert"].includes(input.command)) return "command must be view, create, str_replace or insert";
    if (!str("path")) return "path must be a string";
    if (input.command === "create" && !str("file_text")) return "file_text must be a string";
    if (input.command === "str_replace" && (!str("old_str") || (input.new_str !== undefined && !str("new_str")))) return "old_str/new_str must be strings";
    if (input.command === "insert" && (!Number.isInteger(input.insert_line) || !(str("insert_text") || str("new_str")))) return "insert needs insert_line (integer) and insert_text";
  }
  if (name === "run_command" && !str("command")) return "command must be a string";
  if (name === "open_item" && !str("target")) return "target must be a string";
  return null;
}

// --- execution ---------------------------------------------------------------

const clip = (s, n = 30000) => (s.length <= n ? s : s.slice(0, n * 0.7) + `\n…[${s.length - n} characters cut]…\n` + s.slice(-n * 0.3));

export async function runEditor(input, snapshot) {
  const abs = expand(input.path);
  switch (input.command) {
    case "view": {
      const st = await fs.stat(abs);
      if (st.isDirectory()) {
        const items = await fs.readdir(abs, { withFileTypes: true });
        const lines = items.filter((d) => !d.name.startsWith(".")).slice(0, 400)
          .map((d) => (d.isDirectory() ? d.name + "/" : d.name)).sort();
        return { text: lines.join("\n") || "(empty folder)", summary: `${lines.length} item${lines.length === 1 ? "" : "s"}` };
      }
      const buf = await fs.readFile(abs);
      if (buf.subarray(0, 8000).includes(0)) {
        const hint = /\.pdf$/i.test(abs) ? " For a PDF, try run_command with pdftotext if it is installed." : "";
        return { text: `Binary file, ${buf.length} bytes.${hint}`, summary: `binary · ${fmtBytes(buf.length)}` };
      }
      let lines = buf.toString("utf8").split("\n");
      let start = 1;
      if (Array.isArray(input.view_range) && input.view_range.length === 2) {
        const [a, b] = input.view_range.map(Number);
        start = Math.max(1, a);
        lines = lines.slice(start - 1, b === -1 ? undefined : b);
      }
      const numbered = lines.map((l, i) => `${String(start + i).padStart(5)}\t${l}`).join("\n");
      return { text: clip(numbered), summary: `${lines.length} lines` };
    }
    case "create": {
      await snapshot(abs);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, input.file_text);
      return { text: `Wrote ${input.file_text.split("\n").length} lines to ${abs}`, summary: `${input.file_text.split("\n").length} lines` };
    }
    case "str_replace": {
      const before = await fs.readFile(abs, "utf8");
      const count = before.split(input.old_str).length - 1;
      if (count === 0) throw new Error("old_str was not found in the file");
      if (count > 1) throw new Error(`old_str appears ${count} times; include more context so it matches exactly once`);
      await snapshot(abs);
      await fs.writeFile(abs, before.replace(input.old_str, () => input.new_str ?? ""));
      return { text: "Edited.", summary: "1 change" };
    }
    case "insert": {
      const before = await fs.readFile(abs, "utf8");
      const lines = before.split("\n");
      const at = Math.max(0, Math.min(lines.length, input.insert_line));
      const text = input.insert_text ?? input.new_str;
      await snapshot(abs);
      lines.splice(at, 0, ...text.split("\n"));
      await fs.writeFile(abs, lines.join("\n"));
      return { text: `Inserted after line ${at}.`, summary: `${text.split("\n").length} lines added` };
    }
  }
  throw new Error("unknown editor command");
}

export function runCommand(input, { signal, timeoutMs = 120000 } = {}) {
  return new Promise((resolve) => {
    const cwd = input.cwd ? expand(input.cwd) : os.homedir();
    const win = process.platform === "win32";
    const child = win
      ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", input.command], { cwd, windowsHide: true })
      : spawn(process.env.SHELL || "/bin/bash", ["-lc", input.command], { cwd, detached: true });
    let out = "";
    const add = (d) => { if (out.length < 200000) out += d; };
    child.stdout.on("data", add); child.stderr.on("data", add);
    const kill = () => { try { win ? child.kill() : process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
    const timer = setTimeout(() => { add(`\n[stopped after ${timeoutMs / 1000}s]`); kill(); }, timeoutMs);
    signal?.addEventListener("abort", kill, { once: true });
    child.on("error", (e) => { clearTimeout(timer); resolve({ text: `Could not start: ${e.message}`, summary: "failed to start", error: true }); });
    child.on("close", (code) => {
      clearTimeout(timer);
      const text = `exit code ${code}\n${clip(out.trim())}`;
      const n = out.trim() ? out.trim().split("\n").length : 0;
      resolve({ text, summary: `exit ${code} · ${n} lines`, error: code !== 0 });
    });
  });
}

export function openItem(input) {
  const t = String(input.target);
  const target = /^https:\/\//i.test(t) ? t : expand(t);
  const [cmd, args] = process.platform === "darwin" ? ["open", [target]]
    : process.platform === "win32" ? ["cmd", ["/c", "start", "", target]]
    : ["xdg-open", [target]];
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", (e) => resolve({ text: `Could not open: ${e.message}`, summary: "couldn't open", error: true }));
    child.on("spawn", () => { child.unref(); resolve({ text: "opened", summary: "opened on your screen" }); });
  });
}

export function fmtBytes(n) {
  return n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`;
}
