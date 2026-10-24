#!/usr/bin/env node
// Find and message local Claude Code, Codex, Antigravity and Cursor agent sessions.
// Zero dependencies: node:sqlite needs Node 22.5 or newer.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const USAGE = `agent-relay: message other coding-agent sessions on this machine

  agent-relay list [--agent NAME] [--cwd DIR] [--limit N]
  agent-relay send AGENT SESSION_ID MESSAGE [--from AGENT:ID] [--force]
  agent-relay whoami
  agent-relay install [--dry-run]

AGENT is claude, codex, agy or cursor.`;

// node:sqlite still prints an ExperimentalWarning on some Node versions
const emit = process.emitWarning;
process.emitWarning = (w, ...rest) =>
  String(w).includes("SQLite") ? undefined : emit.call(process, w, ...rest);
const { DatabaseSync } = await import("node:sqlite");

const HOME = process.env.RELAY_HOME || os.homedir();
const P = {
  claude: path.join(HOME, ".claude", "projects"),
  codex: path.join(HOME, ".codex"),
  agyCliDb: path.join(HOME, ".gemini", "antigravity-cli", "conversation_summaries.db"),
  agyAppDb: path.join(HOME, ".gemini", "antigravity", "conversation_summaries.db"),
  agyCliConversations: path.join(HOME, ".gemini", "antigravity-cli", "conversations"),
  cursorChats: path.join(HOME, ".cursor", "chats"),
  cursorProjects: path.join(HOME, ".cursor", "projects"),
};

// A Claude transcript written this recently may belong to a session mid-turn,
// and resuming one of those forks a copy instead of continuing it.
const CLAUDE_BUSY_MS = 30_000;

const exists = (p) => fs.existsSync(p);
const isDir = (p) => exists(p) && fs.statSync(p).isDirectory();
const mtime = (p) => fs.statSync(p).mtimeMs;
const ls = (dir) => (isDir(dir) ? fs.readdirSync(dir) : []);
const norm = (p) => (process.platform === "win32" ? path.resolve(p).toLowerCase() : path.resolve(p));

function fail(msg) {
  process.stderr.write(`agent-relay: ${msg}\n`);
  process.exit(1);
}

function parseTs(text) {
  // "2026-10-24 01:43:15.4536982+00:00" and similar, read as UTC; 0 if unreadable
  const m = String(text ?? "").match(/^(\d{4}-\d\d-\d\d)[ T](\d\d:\d\d:\d\d)(\.\d+)?/);
  if (!m) return 0;
  const t = Date.parse(`${m[1]}T${m[2]}${(m[3] || "").slice(0, 4)}Z`);
  return Number.isNaN(t) ? 0 : t;
}

function readSlice(file, start, length) {
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    return buf.subarray(0, fs.readSync(fd, buf, 0, length, start)).toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

function firstJsonLine(file) {
  try {
    return JSON.parse(readSlice(file, 0, 64 * 1024).split("\n")[0]);
  } catch {
    return {};
  }
}

function* walk(dir) {
  for (const entry of isDir(dir) ? fs.readdirSync(dir, { withFileTypes: true }) : []) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

function sqliteRows(file, sql) {
  if (!exists(file)) return [];
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    const rows = db.prepare(sql).all();
    db.close();
    return rows;
  } catch {
    return [];
  }
}

// ---- Claude Code -------------------------------------------------------------

function claudeSessions() {
  const rows = [];
  for (const project of ls(P.claude)) {
    for (const name of ls(path.join(P.claude, project))) {
      if (!name.endsWith(".jsonl")) continue;
      const file = path.join(P.claude, project, name);
      let title = "", cwd = "", entry = "";
      // transcripts reach megabytes: cwd sits near the start, and the title is rewritten as it
      // changes, so its latest copy sits near the end
      const size = fs.statSync(file).size, HEAD = 64 * 1024, TAIL = 256 * 1024;
      const text = size <= HEAD + TAIL ? fs.readFileSync(file, "utf8")
        : readSlice(file, 0, HEAD) + "\n" + readSlice(file, size - TAIL, TAIL);
      for (const line of text.split("\n")) {
        if (line.includes('"custom-title"')) {
          try { title = JSON.parse(line).customTitle || title; } catch {}
        } else if (!cwd && line.includes('"cwd"')) {
          try { const d = JSON.parse(line); cwd = d.cwd || ""; entry = d.entrypoint || ""; } catch {}
        }
      }
      const updated = mtime(file);
      rows.push({
        agent: "claude", id: name.slice(0, -6), title, cwd,
        surface: entry === "claude-desktop" ? "desktop" : entry || "cli",
        updated, state: Date.now() - updated < CLAUDE_BUSY_MS ? "maybe-busy" : "idle",
      });
    }
  }
  return rows;
}

const claudeFile = (id) =>
  ls(P.claude).map((p) => path.join(P.claude, p, `${id}.jsonl`)).find(exists);

// ---- Codex -------------------------------------------------------------------

// rollout-2026-10-22T16-06-37-<id>.jsonl: the timestamp is fixed width
const ROLLOUT_PREFIX = "rollout-2026-10-22T16-06-37-".length;

function codexRollouts() {
  const map = new Map();
  for (const file of walk(path.join(P.codex, "sessions"))) {
    const base = path.basename(file);
    if (base.startsWith("rollout-") && base.endsWith(".jsonl")) map.set(base.slice(ROLLOUT_PREFIX, -6), file);
  }
  return map;
}

function codexSessions() {
  const index = path.join(P.codex, "session_index.jsonl");
  if (!exists(index)) return [];
  const latest = new Map();
  for (const line of fs.readFileSync(index, "utf8").split("\n")) {
    try { const d = JSON.parse(line); latest.set(d.id, d); } catch {} // later lines update earlier ones
  }
  const rollouts = codexRollouts();
  const rows = [];
  for (const [id, d] of latest) {
    const file = rollouts.get(id);
    if (!file) continue; // indexed, but its rollout was archived or deleted
    const meta = firstJsonLine(file).payload || {};
    const origin = meta.originator || "";
    rows.push({
      agent: "codex", id, title: d.thread_name || "", cwd: meta.cwd || "",
      surface: origin === "Codex Desktop" ? "desktop" : origin.startsWith("codex") ? "cli" : origin || "?",
      updated: mtime(file), // the index only moves on rename; the rollout moves every turn
      state: "",
    });
  }
  return rows;
}

// ---- Antigravity -------------------------------------------------------------

// both indexes list both kinds; only a CLI trajectory file means `agy --conversation` works
const agyReachable = (id) => exists(path.join(P.agyCliConversations, `${id}.db`));

function agySessions() {
  const sql = "select conversation_id, preview, last_modified_time, status, workspace_uris from conversation_summaries";
  const rows = new Map();
  for (const r of [...sqliteRows(P.agyAppDb, sql), ...sqliteRows(P.agyCliDb, sql)]) {
    rows.set(r.conversation_id, {
      agent: "agy", id: r.conversation_id, title: r.preview || "", cwd: r.workspace_uris || "",
      surface: agyReachable(r.conversation_id) ? "cli" : "app (unreachable)",
      updated: parseTs(r.last_modified_time),
      state: String(r.status || "").replace("CASCADE_RUN_STATUS_", "").toLowerCase(),
    });
  }
  return [...rows.values()];
}

// ---- Cursor ------------------------------------------------------------------

// ~/.cursor/chats/<workspace hash>/<chat id>/ holds meta.json (cwd, updatedAtMs) and store.db,
// whose meta table keeps hex-encoded JSON with the chat's name
function cursorChatDir(id) {
  return ls(P.cursorChats).map((w) => path.join(P.cursorChats, w, id)).find(isDir);
}

function cursorMeta(dir) {
  let meta = {};
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")); } catch {}
  let name = "";
  for (const r of sqliteRows(path.join(dir, "store.db"), "select value from meta")) {
    try {
      const raw = typeof r.value === "string" ? r.value : Buffer.from(r.value).toString("utf8");
      name = JSON.parse(/^[0-9a-f]+$/i.test(raw) ? Buffer.from(raw, "hex").toString("utf8") : raw).name || name;
    } catch {}
  }
  return { name, cwd: meta.cwd || "", updated: meta.updatedAtMs || mtime(dir) };
}

// Every chat, CLI or editor, gets ~/.cursor/projects/<workspace>/agent-transcripts/<id>/; only CLI
// chats also get a ~/.cursor/chats folder. Resuming an editor chat's ID from the CLI does not
// fail: it silently starts a new empty chat under that ID that the editor never shows.
function cursorTranscripts() {
  const map = new Map();
  for (const workspace of ls(P.cursorProjects)) {
    const dir = path.join(P.cursorProjects, workspace, "agent-transcripts");
    for (const id of ls(dir)) map.set(id, path.join(dir, id));
  }
  return map;
}

function cursorSessions() {
  const rows = [], seen = new Set();
  for (const workspace of ls(P.cursorChats)) {
    for (const id of ls(path.join(P.cursorChats, workspace))) {
      const dir = path.join(P.cursorChats, workspace, id);
      if (!isDir(dir)) continue;
      const meta = cursorMeta(dir);
      seen.add(id);
      rows.push({ agent: "cursor", id, title: meta.name, cwd: meta.cwd, surface: "cli", updated: meta.updated, state: "" });
    }
  }
  for (const [id, dir] of cursorTranscripts()) {
    if (seen.has(id)) continue;
    rows.push({ agent: "cursor", id, title: "", cwd: "", surface: "editor (unreachable)", updated: mtime(dir), state: "" });
  }
  return rows;
}

// ---- running agent CLIs ------------------------------------------------------

function which(cmd) {
  const exts = process.platform === "win32" ? (process.env.PATHEXT || ".EXE").split(";") : [""];
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    for (const ext of ["", ...exts]) {
      const full = path.join(dir, cmd + ext);
      if (dir && exists(full) && fs.statSync(full).isFile()) return full;
    }
  }
  return null;
}

function cursorCommand() {
  // Windows ships agent.cmd -> PowerShell -> node.exe index.js; going through two shells would
  // mangle quotes in the message, so call the bundled node directly
  if (process.platform === "win32") {
    const versions = path.join(process.env.LOCALAPPDATA || path.join(HOME, "AppData", "Local"), "cursor-agent", "versions");
    const latest = ls(versions).filter((v) => /^\d{4}\.\d+\.\d+-/.test(v)).sort().pop();
    if (latest && exists(path.join(versions, latest, "node.exe")))
      return [path.join(versions, latest, "node.exe"), path.join(versions, latest, "index.js")];
  }
  const bin = which("cursor-agent") || which("agent");
  return bin ? [bin] : null;
}

function run(argv, cwd) {
  const [cmd, ...args] = argv;
  if (/\.(cmd|bat)$/i.test(cmd)) fail(`${cmd} is a batch file; refusing to pass a message through cmd.exe`);
  const done = spawnSync(cmd, args, { stdio: "inherit", cwd });
  if (done.error) fail(done.error.message);
  return done.status ?? 1;
}

function tool(name) {
  const bin = which(name);
  if (!bin) fail(`\`${name}\` is not on PATH`);
  return bin;
}

// ---- commands ----------------------------------------------------------------

const LISTERS = { claude: claudeSessions, codex: codexSessions, agy: agySessions, cursor: cursorSessions };

function stamp(ms) {
  return ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "?";
}

function cmdList(opts) {
  let rows = (opts.agent ? [opts.agent] : Object.keys(LISTERS)).flatMap((a) => LISTERS[a]());
  if (opts.cwd) rows = rows.filter((r) => r.cwd && norm(r.cwd) === norm(opts.cwd));
  rows.sort((a, b) => b.updated - a.updated);
  for (const r of rows.slice(0, opts.limit)) {
    console.log(`${r.agent.padEnd(6)} ${r.id}  ${stamp(r.updated).padEnd(16)}  ${r.surface.padEnd(17)} ${r.state.padEnd(10)} ${r.title.slice(0, 50)}`);
  }
}

function sender() {
  if (process.env.CLAUDE_CODE_SESSION_ID) return `claude:${process.env.CLAUDE_CODE_SESSION_ID}`;
  if (process.env.CODEX_THREAD_ID) return `codex:${process.env.CODEX_THREAD_ID}`;
  return null;
}

function cmdSend(agent, id, message, opts) {
  const from = opts.from || sender();
  let text = message;
  if (from) {
    const [a, ...rest] = from.split(":");
    text = `[relay from ${a} ${rest.join(":")}] ${message}\n\n(reply with: npx agent-relay send ${a} ${rest.join(":")} "...")`;
  }

  if (agent === "claude") {
    const file = claudeFile(id);
    if (!file) fail(`no Claude transcript named ${id}.jsonl`);
    if (id === process.env.CLAUDE_CODE_SESSION_ID) fail("that is this session; resuming it mid-turn would fork a copy");
    if (Date.now() - mtime(file) < CLAUDE_BUSY_MS && !opts.force)
      fail(`that session wrote to its transcript in the last ${CLAUDE_BUSY_MS / 1000}s and may be mid-turn; ` +
        "resuming now would fork a copy. Retry later or pass --force.");
    return run([tool("claude"), "-p", "--resume", id, text]);
  }

  if (agent === "codex") {
    const file = codexRollouts().get(id);
    if (!file) fail(`no Codex rollout for ${id}`);
    if ((firstJsonLine(file).payload || {}).originator !== "Codex Desktop")
      process.stderr.write("agent-relay: note, this is a CLI thread; the desktop app will not show it, " +
        "and the message waits until that CLI session runs again\n");
    // "queue" hands the message to the app-server that owns the thread: it is delivered
    // straight away when the thread is idle, and on the next turn when it is busy
    return run([tool("codex"), "queue", "--thread", id, "--message", text]);
  }

  if (agent === "agy") {
    if (!agyReachable(id)) {
      if (agySessions().some((r) => r.id === id))
        fail("that is an Antigravity app conversation; the agy CLI cannot reach app conversations. " +
          "Use an agy CLI conversation or a shared file instead.");
      fail(`no agy conversation ${id}`);
    }
    return run([tool("agy"), "--conversation", id, "-p", text, "--output-format", "json"]);
  }

  if (agent === "cursor") {
    const dir = cursorChatDir(id);
    if (!dir) {
      if (cursorTranscripts().has(id))
        fail("that is a Cursor editor chat; resuming it from the CLI would start a new empty chat " +
          "under the same ID that the editor never shows. Use a Cursor CLI chat or a shared file instead.");
      fail(`no Cursor agent chat ${id}`);
    }
    const cmd = cursorCommand();
    if (!cmd) fail("`cursor-agent` is not on PATH");
    // resume from the chat's own folder; Cursor asks for that folder to be trusted once, and
    // agent-relay never answers that on the user's behalf
    const { cwd } = cursorMeta(dir);
    return run([...cmd, "--resume", id, "-p", text, "--output-format", "text"], cwd && isDir(cwd) ? cwd : undefined);
  }
}

function cmdWhoami() {
  const me = sender();
  if (me) return console.log(me.replace(":", " "));
  const here = norm(process.cwd());
  const rows = [...codexSessions(), ...agySessions(), ...cursorSessions()].filter((r) => r.cwd && norm(r.cwd) === here);
  if (!rows.length) return console.log("unknown");
  const r = rows.reduce((a, b) => (b.updated > a.updated ? b : a));
  console.log(`unknown; newest session in this folder is ${r.agent} ${r.id} (${r.title.slice(0, 40)})`);
}

function cmdInstall(opts) {
  const src = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "skills", "agent-relay", "SKILL.md");
  const targets = [
    [".claude", path.join(HOME, ".claude", "skills", "agent-relay")],
    [".codex", path.join(HOME, ".codex", "skills", "agent-relay")],
    [".gemini", path.join(HOME, ".gemini", "config", "skills", "agent-relay")],
    [".cursor", path.join(HOME, ".cursor", "skills", "agent-relay")],
  ];
  for (const [marker, dest] of targets) {
    if (!isDir(path.join(HOME, marker))) continue; // that agent is not installed
    console.log(`${opts.dryRun ? "would install" : "installed"} ${path.join(dest, "SKILL.md")}`);
    if (!opts.dryRun) {
      fs.mkdirSync(dest, { recursive: true });
      fs.copyFileSync(src, path.join(dest, "SKILL.md"));
    }
  }
}

// ---- argument parsing --------------------------------------------------------

function parse(argv) {
  const opts = { limit: 20 }, pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--agent") opts.agent = argv[++i];
    else if (a === "--cwd") opts.cwd = argv[++i];
    else if (a === "--limit") opts.limit = Number(argv[++i]);
    else if (a === "--from") opts.from = argv[++i];
    else if (a === "--force") opts.force = true;
    else if (a === "--dry-run") opts.dryRun = true;
    else if (a === "-h" || a === "--help") { console.log(USAGE); process.exit(0); }
    else pos.push(a);
  }
  return { cmd: pos[0], args: pos.slice(1), opts };
}

const { cmd, args, opts } = parse(process.argv.slice(2));
if (opts.agent && !LISTERS[opts.agent]) fail(`unknown agent ${opts.agent}`);
if (cmd === "list") cmdList(opts);
else if (cmd === "whoami") cmdWhoami();
else if (cmd === "install") cmdInstall(opts);
else if (cmd === "send") {
  const [agent, id, message] = args;
  if (!LISTERS[agent] || !id || message === undefined) fail(`usage: agent-relay send AGENT SESSION_ID MESSAGE`);
  process.exit(cmdSend(agent, id, message, opts));
} else {
  console.log(USAGE);
  process.exit(cmd ? 1 : 0);
}
