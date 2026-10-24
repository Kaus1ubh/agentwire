// Offline tests: fake homes for every agent, and no agent CLI is ever called.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "agent-relay.js");
let home;

function relay(...args) {
  const env = { ...process.env, RELAY_HOME: home, PATH: "", LOCALAPPDATA: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  return spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8" });
}

function write(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function agyDb(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("create table conversation_summaries (conversation_id, preview, last_modified_time, status, workspace_uris)");
  const insert = db.prepare("insert into conversation_summaries values (?, ?, ?, ?, ?)");
  for (const r of rows) insert.run(...r);
  db.close();
}

before(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "relay-"));
  const lines = (...objs) => objs.map((o) => JSON.stringify(o)).join("\n") + "\n";

  const claude = path.join(home, ".claude", "projects", "A--work");
  write(path.join(claude, "c-idle.jsonl"), lines(
    { type: "user", cwd: "A:\\work", entrypoint: "claude-desktop" },
    { type: "custom-title", customTitle: "old title" },
    { type: "custom-title", customTitle: "Idle session" }));
  const past = new Date(Date.now() - 3600_000);
  fs.utimesSync(path.join(claude, "c-idle.jsonl"), past, past);
  write(path.join(claude, "c-busy.jsonl"), lines({ type: "user", cwd: "A:\\work" }));
  // a large transcript: the title near the end must still be found
  write(path.join(claude, "c-big.jsonl"), lines({ type: "user", cwd: "A:\\work" }) +
    lines(...Array.from({ length: 4000 }, (_, i) => ({ type: "assistant", pad: "x".repeat(200), i }))) +
    lines({ type: "custom-title", customTitle: "Big session" }));

  const codex = path.join(home, ".codex");
  write(path.join(codex, "session_index.jsonl"), lines(
    { id: "x-desk", thread_name: "Greeting", updated_at: "2026-10-22T10:36:43Z" },
    { id: "x-cli", thread_name: "Greeting", updated_at: "2026-10-22T10:37:00Z" },
    { id: "x-desk", thread_name: "Renamed", updated_at: "2026-10-22T11:00:00Z" }));
  for (const [id, origin] of [["x-desk", "Codex Desktop"], ["x-cli", "codex-tui"]])
    write(path.join(codex, "sessions", "2026", "10", "22", `rollout-2026-10-22T16-00-00-${id}.jsonl`),
      lines({ payload: { originator: origin, cwd: "A:\\work" } }));

  const g = path.join(home, ".gemini");
  const both = ["a-cli", "cli chat", "2026-10-24 10:48:00.0+00:00", "CASCADE_RUN_STATUS_IDLE", ""];
  const app = ["a-app", "app chat", "2026-09-15 13:42:15.4536982+00:00", "CASCADE_RUN_STATUS_IDLE", ""];
  agyDb(path.join(g, "antigravity", "conversation_summaries.db"), [both, app]);
  agyDb(path.join(g, "antigravity-cli", "conversation_summaries.db"), [both, app]);
  write(path.join(g, "antigravity-cli", "conversations", "a-cli.db"), "");

  fs.mkdirSync(path.join(home, ".cursor", "chats", "ws1", "u-chat"), { recursive: true });
  for (const id of ["u-chat", "u-editor"])
    write(path.join(home, ".cursor", "projects", "empty-window", "agent-transcripts", id, `${id}.jsonl`), "{}\n");
});

after(() => fs.rmSync(home, { recursive: true, force: true }));

test("list reads every agent", () => {
  const out = relay("list", "--limit", "50").stdout;
  assert.match(out, /Idle session/);           // latest custom title wins
  assert.doesNotMatch(out, /old title/);
  assert.match(out, /Big session/);            // found through the tail read
  assert.match(out, /Renamed/);                // later index line wins
  assert.equal(out.match(/x-desk/g).length, 1);
  assert.match(out, /x-cli .*cli/);
  assert.match(out, /a-cli .*cli /);
  assert.match(out, /a-app .*app \(unreachable\)/);
  assert.equal(out.match(/a-cli/g).length, 1); // listed in both indexes, shown once
  assert.match(out, /2026-09-15 13:42/);       // seven-digit fractions parse
  assert.match(out, /cursor u-chat .*cli /);
  assert.equal(out.match(/u-chat/g).length, 1);
  assert.match(out, /u-editor .*editor \(unreachable\)/);
});

test("a Cursor editor chat is refused", () => {
  const r = relay("send", "cursor", "u-editor", "hi");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /editor chat/);
});

test("a busy or missing Claude session is refused", () => {
  let r = relay("send", "claude", "c-busy", "hi");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /mid-turn/);
  r = relay("send", "claude", "nope", "hi");
  assert.match(r.stderr, /no Claude transcript/);
});

test("an Antigravity app conversation is refused", () => {
  const r = relay("send", "agy", "a-app", "hi");
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /app conversation/);
});

test("accepted sends reach the agent CLI step", () => {
  // PATH is empty, so each accepted send stops at the missing executable
  assert.match(relay("send", "claude", "c-idle", "hi").stderr, /`claude` is not on PATH/);
  assert.match(relay("send", "agy", "a-cli", "hi").stderr, /`agy` is not on PATH/);
  assert.match(relay("send", "cursor", "u-chat", "hi").stderr, /`cursor-agent` is not on PATH/);
  const r = relay("send", "codex", "x-cli", "hi");
  assert.match(r.stderr, /CLI thread/);
  assert.match(r.stderr, /`codex` is not on PATH/);
});

test("install only targets agents that are present", () => {
  fs.rmSync(path.join(home, ".gemini", "config"), { recursive: true, force: true });
  const out = relay("install", "--dry-run").stdout;
  assert.match(out, /\.claude[\\/]skills/);
  assert.match(out, /\.cursor[\\/]skills/);
  assert.equal(fs.existsSync(path.join(home, ".claude", "skills")), false); // dry run writes nothing
});
