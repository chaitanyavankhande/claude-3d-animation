// Which of Claude's actions ATLAS lets through, and which it holds for your authorization.
//
//   allow – only looks (reads, searches, read-only commands) or drives the dashboard
//   ask   – changes something: writes, edits, other commands, unknown tools, sensitive files
//
// Each tool call also gets an "agent" — the node on the HUD that lights up while it runs.

import os from "node:os";
import path from "node:path";

const HOME = os.homedir();

export function expand(p) {
  if (typeof p !== "string" || !p.trim()) return "";
  let s = p.trim();
  if (s === "~" || s.startsWith("~/") || s.startsWith("~\\")) s = path.join(HOME, s.slice(1));
  return path.resolve(HOME, s);
}

export function tidy(p) {
  const abs = expand(p) || String(p || "");
  return abs === HOME ? "~" : abs.startsWith(HOME + path.sep) ? "~/" + path.relative(HOME, abs).split(path.sep).join("/") : abs;
}

const SENSITIVE = /(^|[\\/])(\.ssh|\.gnupg|\.aws|\.azure|\.kube|\.docker|\.netrc|\.npmrc|\.pypirc|\.git-credentials|\.env(\.[^\\/]*)?|id_[a-z0-9_]+|[^\\/]*\.(pem|key|p12|pfx|kdbx)|Keychains?|Login Data|Cookies|\.claude)([\\/]|$)/i;
export const isSensitive = (p) => SENSITIVE.test(expand(p) || String(p || ""));

const READ_ONLY = new Set(["ls", "dir", "pwd", "cat", "head", "tail", "wc", "file", "stat", "du", "df", "date", "whoami", "uname", "which", "where", "echo", "grep", "rg", "find", "tree", "git",
  "get-childitem", "get-content", "get-location", "select-string", "get-date", "get-item", "test-path"]);
const READ_ONLY_GIT = new Set(["status", "log", "diff", "show", "branch", "remote", "rev-parse", "ls-files", "blame", "describe"]);

export function isReadOnlyCommand(cmd) {
  if (typeof cmd !== "string" || !cmd.trim()) return false;
  if (/[;&|<>`$(){}\n\r]/.test(cmd)) return false;            // no chaining, pipes, redirects or substitution
  const words = cmd.trim().split(/\s+/);
  const exe = words[0].toLowerCase();
  if (!READ_ONLY.has(exe)) return false;
  if (exe === "git") return READ_ONLY_GIT.has((words[1] || "").toLowerCase());
  if (exe === "find") return !words.some((w) => /^-(exec|execdir|delete|ok|okdir|fprint|fprintf|fls)$/.test(w));
  return !words.slice(1).some(isSensitive);
}

const LOOK = new Set(["Read", "Glob", "Grep", "LS", "NotebookRead", "WebSearch", "WebFetch", "TodoWrite", "Task", "Agent", "ToolSearch", "BashOutput", "ListMcpResourcesTool", "ReadMcpResourceTool"]);
const CHANGE = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const IMAGE = /\.(png|jpe?g|gif|webp|bmp|pdf)$/i;

// The HUD agent that a tool call belongs to.
export function agentFor(name, input = {}) {
  if (name.startsWith("mcp__atlas__")) return "VISION";
  if (name === "WebSearch" || name === "WebFetch") return "RESEARCH";
  if (name === "TodoWrite" || name === "Task" || name === "Agent" || name === "ExitPlanMode") return "PLANNER";
  if (CHANGE.has(name)) return "CODER";
  if (name === "Bash" || name === "BashOutput" || name === "KillShell") return "OPERATOR";
  if (name === "Read" && IMAGE.test(String(input.file_path || ""))) return "VISION";
  if (name === "Read" || name === "Glob" || name === "Grep" || name === "LS") return "MEMORY";
  return "OPERATOR";
}

// How the step reads on the HUD: a verb and its object.
export function describe(name, input = {}) {
  const p = (k) => tidy(String(input[k] || ""));
  switch (name) {
    case "Read": return ["read", p("file_path")];
    case "Write": return ["write", p("file_path")];
    case "Edit": case "MultiEdit": return ["edit", p("file_path")];
    case "NotebookEdit": return ["edit", p("notebook_path")];
    case "Glob": return ["find", String(input.pattern || "")];
    case "Grep": return ["search for", `“${input.pattern || ""}”`];
    case "Bash": return ["run", String(input.command || "")];
    case "WebSearch": return ["search the web for", `“${input.query || ""}”`];
    case "WebFetch": return ["read", String(input.url || "")];
    case "TodoWrite": return ["plan", `${(input.todos || []).length} steps`];
    case "Task": case "Agent": return ["delegate", String(input.description || "a subtask")];
    default: return [name.replace(/^mcp__atlas__/, "").replace(/_/g, " "), Object.keys(input).length ? JSON.stringify(input).slice(0, 80) : ""];
  }
}

export function decide(name, input = {}, cfg = {}) {
  if (name.startsWith("mcp__atlas__")) return { verdict: "allow" };
  const pathOf = String(input.file_path || input.notebook_path || input.path || "");
  if (LOOK.has(name)) {
    if (pathOf && isSensitive(pathOf)) return { verdict: "ask", why: "sensitive file" };
    return { verdict: "allow" };
  }
  if (name === "Bash") return isReadOnlyCommand(input.command) ? { verdict: "allow" } : { verdict: "ask", why: "runs a command on your laptop" };
  if (CHANGE.has(name)) {
    if (isSensitive(pathOf)) return { verdict: "ask", why: "sensitive file" };
    if (cfg.autoEdits && cfg.workspace && insideDir(expand(pathOf), cfg.workspace)) return { verdict: "allow" };
    return { verdict: "ask", why: "changes a file" };
  }
  return { verdict: "ask", why: "new kind of action" };
}

function insideDir(abs, dir) {
  const rel = path.relative(dir, abs);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}
