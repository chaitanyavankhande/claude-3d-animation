// The book: one chapter per day, kept as plain files you can read without Quire.
//
//   ~/.quire/book/2026-10-18.md            what happened, in readable Markdown
//   ~/.quire/book/2026-10-18.json          the same day as Quire renders it
//   ~/.quire/book/.2026-10-18.messages.json the conversation sent to Claude (append-only)
//   ~/.quire/snapshots/<action id>         file contents from before each change, for the eraser
//   ~/.quire/config.json                   your settings
//   ~/.quire/standing-orders.md            tasks to run when each new chapter opens

import fs from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const HOME = process.env.QUIRE_HOME || path.join(os.homedir(), ".quire");
const BOOK = path.join(HOME, "book");
const SNAPS = path.join(HOME, "snapshots");

const DEFAULT_CONFIG = {
  owner: os.userInfo().username,
  model: "claude-opus-5-5",
  effort: "medium",
  shelves: ["~"],              // folders Claude may read and change without asking
  inkErasable: "auto",         // "auto": erasable changes ink themselves after a pause; "ask": they wait for you
  seepMs: { look: 700, erasable: 2600 },
};

export async function loadConfig() {
  await fs.mkdir(BOOK, { recursive: true });
  await fs.mkdir(SNAPS, { recursive: true });
  const file = path.join(HOME, "config.json");
  let cfg = {};
  try { cfg = JSON.parse(await fs.readFile(file, "utf8")); } catch { await fs.writeFile(file, JSON.stringify(DEFAULT_CONFIG, null, 2)); }
  const merged = { ...DEFAULT_CONFIG, ...cfg, seepMs: { ...DEFAULT_CONFIG.seepMs, ...(cfg.seepMs || {}) } };
  const home = os.homedir();
  merged.shelves = merged.shelves.map((s) => path.resolve(home, s.replace(/^~(?=$|[\\/])/, home)));
  merged.home = HOME;
  const orders = path.join(HOME, "standing-orders.md");
  if (!existsSync(orders)) await fs.writeFile(orders, STANDING_TEMPLATE);
  return merged;
}

const STANDING_TEMPLATE = `# Standing orders

Each line that starts with "- " runs once, when a new chapter (day) opens.
They're off until you remove the "#" in front of them.

#- Look in ~/Downloads for anything new since yesterday and tell me what's there.
#- Check ~/uni for deadlines in the next 7 days and list them by date.
`;

export async function standingOrders() {
  try {
    const text = await fs.readFile(path.join(HOME, "standing-orders.md"), "utf8");
    return text.split("\n").filter((l) => l.startsWith("- ")).map((l) => l.slice(2).trim()).filter(Boolean);
  } catch { return []; }
}

export function today(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function chapterNumber(date) {
  const [y, m, d] = date.split("-").map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(y, 0, 0)) / 86400000);
}

export async function listChapters() {
  const files = await fs.readdir(BOOK).catch(() => []);
  const days = files.filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map((f) => f.slice(0, 10)).sort().reverse();
  const out = [];
  for (const date of days.slice(0, 120)) {
    try {
      const ch = JSON.parse(await fs.readFile(path.join(BOOK, date + ".json"), "utf8"));
      out.push({ date, number: chapterNumber(date), entries: ch.entries.length, first: ch.entries[0]?.prompt || "" });
    } catch { /* skip unreadable chapter */ }
  }
  return out;
}

export async function loadChapter(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("bad date");
  let chapter = { date, number: chapterNumber(date), entries: [] };
  let messages = [];
  try { chapter = JSON.parse(await fs.readFile(path.join(BOOK, date + ".json"), "utf8")); } catch { /* new chapter */ }
  try { messages = JSON.parse(await fs.readFile(path.join(BOOK, `.${date}.messages.json`), "utf8")); } catch { /* fresh conversation */ }
  return { chapter, messages };
}

// Short digest of recent chapters for the system prompt (changes once a day, so it caches well).
export function previously(chapters, date) {
  const past = chapters.filter((c) => c.date < date).slice(0, 3);
  if (!past.length) return "This is the first chapter.";
  return past.map((c) => {
    try {
      const ch = JSON.parse(readFileSync(path.join(BOOK, c.date + ".json"), "utf8"));
      return `${c.date}: ` + ch.entries.slice(0, 8).map((e) => `“${e.prompt.slice(0, 90)}”`).join("; ");
    } catch { return `${c.date}: (unreadable)`; }
  }).join("\n");
}

// Debounced writer so a burst of updates becomes one write.
const timers = new Map();
export function save(chapter, messages) {
  clearTimeout(timers.get(chapter.date));
  timers.set(chapter.date, setTimeout(() => writeNow(chapter, messages).catch((e) => console.error("book write failed:", e.message)), 400));
}
export async function writeNow(chapter, messages) {
  await fs.writeFile(path.join(BOOK, chapter.date + ".json"), JSON.stringify(chapter));
  await fs.writeFile(path.join(BOOK, `.${chapter.date}.messages.json`), JSON.stringify(messages));
  await fs.writeFile(path.join(BOOK, chapter.date + ".md"), toMarkdown(chapter));
}

const MARK = { inked: "x", struck: "-", erased: "~", failed: "!", waiting: " ", pencil: " ", seeping: " " };
export function toMarkdown(ch) {
  const d = new Date(ch.date + "T12:00:00");
  const title = d.toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
  let md = `# Chapter ${ch.number} · ${title}\n`;
  for (const e of ch.entries) {
    md += `\n## ${e.time} — ${e.prompt.replace(/\n/g, " ")}\n\n`;
    for (const it of e.items) {
      if (it.kind === "prose" && it.text.trim()) md += it.text.trim() + "\n\n";
      if (it.kind === "action") {
        const obj = "`" + it.object.replace(/`/g, "'") + "`";
        const tail = it.state === "struck" ? " — struck by you" : it.state === "erased" ? " — erased" : it.result?.summary ? ` — ${it.result.summary}` : "";
        md += `- [${MARK[it.state] || " "}] ${it.verb} ${obj}${tail}\n`;
      }
      if (it.kind === "note") md += `\n> margin note on “${it.quote}”: ${it.text}\n\n`;
    }
    if (e.status === "stopped") md += "\n_(stopped)_\n";
  }
  return md;
}

// --- snapshots for the eraser ------------------------------------------------------

export async function snapshotFile(id, abs) {
  const meta = { path: abs, existed: existsSync(abs) };
  if (meta.existed) await fs.copyFile(abs, path.join(SNAPS, id));
  await fs.writeFile(path.join(SNAPS, id + ".json"), JSON.stringify(meta));
}

export async function restoreSnapshot(id) {
  const meta = JSON.parse(await fs.readFile(path.join(SNAPS, id + ".json"), "utf8"));
  if (meta.existed) await fs.copyFile(path.join(SNAPS, id), meta.path);
  else if (existsSync(meta.path)) await fs.rename(meta.path, path.join(SNAPS, id + ".erased")); // keep it, just out of the way
  return meta;
}
