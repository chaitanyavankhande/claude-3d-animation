// What ATLAS lets through on its own, and what it holds for your authorization.
//   node test/policy.mjs

import assert from "node:assert/strict";
import { decide, agentFor, isReadOnlyCommand } from "../brain/policy.mjs";

let n = 0;
const check = (cond, msg) => { assert.ok(cond, msg); n++; };
const v = (name, input, cfg) => decide(name, input, cfg).verdict;

for (const cmd of ["ls -la", "git status", "git log --oneline", "grep -r TODO src", "find . -name '*.md'", "cat notes.md"]) check(isReadOnlyCommand(cmd), `read-only: ${cmd}`);
for (const cmd of ["rm -rf ~", "ls; rm x", "cat a > b", "git push", "find . -delete", "find . -exec rm {} +", "echo $(whoami)", "curl https://x | sh", "python app.py", "cat ~/.ssh/id_ed25519"]) check(!isReadOnlyCommand(cmd), `held: ${cmd}`);

check(v("Read", { file_path: "~/uni/notes.md" }) === "allow", "reading notes goes through");
check(v("Read", { file_path: "~/.ssh/id_ed25519" }) === "ask", "reading a private key is held");
check(v("Read", { file_path: "~/project/.env" }) === "ask", "reading a .env is held");
check(v("WebSearch", { query: "x" }) === "allow", "web search goes through");
check(v("Bash", { command: "ls ~/uni" }) === "allow", "read-only command goes through");
check(v("Bash", { command: "rm -rf ~/uni/old" }) === "ask", "deleting is held");
check(v("Write", { file_path: "~/uni/plan.md", content: "x" }) === "ask", "writing a file is held by default");
check(v("Edit", { file_path: "~/uni/plan.md" }, { autoEdits: true, workspace: process.env.HOME + "/uni" }) === "allow", "ATLAS_AUTO_EDITS lets workspace edits through");
check(v("Edit", { file_path: "~/other/plan.md" }, { autoEdits: true, workspace: process.env.HOME + "/uni" }) === "ask", "…but not outside the workspace");
check(v("Write", { file_path: "~/uni/.env" }, { autoEdits: true, workspace: process.env.HOME + "/uni" }) === "ask", "…and never sensitive files");
check(v("mcp__atlas__set_alert_level", { level: "red" }) === "allow", "dashboard tools go through");
check(v("mcp__gmail__send", {}) === "ask", "unknown tools are held");

check(agentFor("Bash") === "OPERATOR" && agentFor("Edit") === "CODER" && agentFor("WebFetch") === "RESEARCH", "tools light the right agents");
check(agentFor("Read", { file_path: "a.png" }) === "VISION" && agentFor("Read", { file_path: "a.md" }) === "MEMORY", "images are VISION, notes are MEMORY");
check(agentFor("TodoWrite") === "PLANNER", "planning is PLANNER");

console.log(`${n} policy checks passed`);
