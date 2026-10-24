// Offline tests: fake homes for every agent, and no agent CLI is ever called.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const BIN = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "agentwire.js");
let home;

function relay(args, input) {
  const env = { ...process.env, AGENTWIRE_HOME: home, PATH: "", LOCALAPPDATA: home };
  delete env.CLAUDE_CODE_SESSION_ID;
  delete env.CODEX_THREAD_ID;
  return spawnSync(process.execPath, [BIN, ...args], { env, encoding: "utf8", input });
}

const hook = (agent, event, payload) => JSON.parse(relay(["hook", agent, event], JSON.stringify(payload)).stdout);

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
  home = fs.mkdtempSync(path.join(os.tmpdir(), "agentwire-"));
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
  const out = relay(["list", "--limit", "50"]).stdout;
  assert.match(out, /Idle session/);           // latest custom title wins
  assert.doesNotMatch(out, /old title/);
  assert.match(out, /Big session/);            // found through the tail read
  assert.match(out, /Renamed/);                // later index line wins
  assert.equal(out.match(/x-desk/g).length, 1);
  assert.match(out, /x-cli .*cli/);
  assert.match(out, /a-cli .*cli /);
  assert.match(out, /a-app .*app /);
  assert.equal(out.match(/a-cli/g).length, 1); // listed in both indexes, shown once
  assert.match(out, /2026-09-15 13:42/);       // seven-digit fractions parse
  assert.match(out, /u-chat .*cli /);
  assert.equal(out.match(/u-chat/g).length, 1);
  assert.match(out, /u-editor .*editor/);
});

test("sessions that cannot take a turn now are queued, with the reason", () => {
  for (const [agent, id, why] of [
    ["claude", "c-busy", /mid-turn/],
    ["agy", "a-app", /app conversation/],
    ["cursor", "u-editor", /editor chat/],
  ]) {
    const r = relay(["send", agent, id, "hi"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /will read it at its next step/);
    assert.match(r.stdout, why);
  }
  fs.rmSync(path.join(home, ".agentwire", "inbox"), { recursive: true, force: true });
  assert.match(relay(["send", "claude", "nope", "hi"]).stderr, /no Claude transcript/);
});

test("idle, reachable sessions get a turn now", () => {
  // PATH is empty, so each accepted send stops at the missing executable
  assert.match(relay(["send", "claude", "c-idle", "hi"]).stderr, /`claude` is not on PATH/);
  assert.match(relay(["send", "agy", "a-cli", "hi"]).stderr, /`agy` is not on PATH/);
  assert.match(relay(["send", "cursor", "u-chat", "hi"]).stderr, /`cursor-agent` is not on PATH/);
  assert.match(relay(["send", "codex", "x-desk", "hi"]).stderr, /`codex` is not on PATH/);
});

test("unreachable sessions fall back to the inbox, delivered once as context", () => {
  const r = relay(["send", "claude", "c-busy", "token N1", "--from", "codex:abc"]);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /queued: claude c-busy will read it at its next step/);
  assert.match(r.stderr, /no global agentwire hook for claude/); // its folder A:\work does not exist

  assert.deepEqual(hook("claude", "Stop", { session_id: "c-busy" }), {}); // turn end never takes `next`
  const out = hook("claude", "PostToolUse", { session_id: "c-busy" });
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.match(ctx, /token N1/);
  assert.match(ctx, /not from the user/);
  assert.match(ctx, /to reply: npx agentwire-cli send codex abc/);
  assert.deepEqual(hook("claude", "PostToolUse", { session_id: "c-busy" }), {}); // only once
  assert.match(fs.readFileSync(path.join(home, ".agentwire", "deliveries.log"), "utf8"), /"from":"codex:abc"/);
});

test("only --wake lets a message make the receiver keep working", () => {
  relay(["send", "cursor", "u-editor", "token R1"]);
  assert.deepEqual(hook("cursor", "stop", { conversation_id: "u-editor" }), {}); // plain sends never wake
  assert.match(hook("cursor", "postToolUse", { conversation_id: "u-editor" }).additional_context, /token R1/);

  const r = relay(["send", "cursor", "u-editor", "token W1", "--wake"]);
  assert.match(r.stdout, /will act on it when its current turn ends/);
  assert.deepEqual(hook("cursor", "postToolUse", { conversation_id: "u-editor" }), {}); // a wake waits for turn end
  assert.match(hook("cursor", "stop", { conversation_id: "u-editor" }).followup_message, /token W1/);
});

test("each agent gets its own hook output shape", () => {
  relay(["send", "agy", "a-app", "token G1"]);
  assert.match(hook("agy", "PreInvocation", { conversationId: "a-app" }).injectSteps[0].ephemeralMessage, /token G1/);
  relay(["send", "cursor", "u-editor", "token E1"]);
  const r = hook("cursor", "beforeSubmitPrompt", { conversation_id: "u-editor" });
  assert.equal(r.continue, true);
  assert.match(r.additional_context, /token E1/);
  assert.deepEqual(hook("cursor", "beforeSubmitPrompt", { conversation_id: "u-editor" }), { continue: true });
});

test("Claude's hook ignores Cursor, which also runs .claude/settings.json hooks", () => {
  relay(["send", "claude", "c-busy", "token X1"]);
  assert.deepEqual(hook("claude", "PostToolUse", { session_id: "c-busy", cursor_version: "3.20" }), {});
  assert.match(hook("claude", "PostToolUse", { session_id: "c-busy" }).hookSpecificOutput.additionalContext, /token X1/);
});

test("a hook never breaks its agent", () => {
  assert.equal(relay(["hook", "claude", "Stop"], "not json").stdout, "{}");
  assert.equal(relay(["hook", "cursor", "beforeSubmitPrompt"], "").stdout, '{"continue":true}');
});

test("oversized messages and floods are refused", () => {
  assert.match(relay(["send", "cursor", "u-editor", "x".repeat(17 * 1024)]).stderr, /over 16 KB/);
  for (let i = 0; i < 20; i++) relay(["send", "agy", "a-app", `m${i}`]);
  assert.match(relay(["send", "agy", "a-app", "one too many"]).stderr, /20 messages are already waiting/);
});

test("install writes hooks, keeps other hooks, and uninstall removes only ours", () => {
  const project = path.join(home, "proj");
  write(path.join(project, ".claude", "settings.json"),
    JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] }, model: "x" }));
  assert.equal(relay(["install", "--hooks", "--project", project]).status, 0);

  const claude = JSON.parse(fs.readFileSync(path.join(project, ".claude", "settings.json"), "utf8"));
  assert.equal(claude.model, "x");
  assert.equal(claude.hooks.Stop.length, 2);
  assert.match(JSON.stringify(claude.hooks.PostToolUse), /agentwire\.mjs\\" hook claude PostToolUse/);
  const cursor = JSON.parse(fs.readFileSync(path.join(project, ".cursor", "hooks.json"), "utf8"));
  assert.match(cursor.hooks.stop[0].command, /hook cursor stop/);
  const agy = JSON.parse(fs.readFileSync(path.join(project, ".agents", "hooks.json"), "utf8"));
  // no shell runs these, so no quotes: a relative path to a copy beside the config
  assert.equal(agy.agentwire.PreInvocation[0].command, "node agentwire-hook.mjs hook agy PreInvocation");
  assert.equal(cursor.hooks.stop[0].command, "node .cursor/agentwire-hook.mjs hook cursor stop");
  assert.ok(fs.existsSync(path.join(project, ".agents", "agentwire-hook.mjs")));
  assert.ok(fs.existsSync(path.join(project, ".cursor", "agentwire-hook.mjs")));
  assert.ok(fs.existsSync(path.join(home, ".agentwire", "bin", "agentwire.mjs")));

  assert.match(relay(["install", "--hooks", "--project", project]).stdout, /unchanged/); // idempotent
  relay(["uninstall", "--project", project]);
  const left = JSON.parse(fs.readFileSync(path.join(project, ".claude", "settings.json"), "utf8"));
  assert.deepEqual(left.hooks, { Stop: [{ hooks: [{ type: "command", command: "echo mine" }] }] });
  assert.equal(JSON.parse(fs.readFileSync(path.join(project, ".agents", "hooks.json"), "utf8")).agentwire, undefined);
  assert.equal(fs.existsSync(path.join(project, ".agents", "agentwire-hook.mjs")), false);
});

test("install --dry-run writes nothing", () => {
  const out = relay(["install", "--hooks", "--dry-run"]).stdout;
  assert.match(out, /would install .*\.claude[\\/]skills/);
  assert.match(out, /would write .*\.cursor[\\/]hooks\.json/);
  assert.equal(fs.existsSync(path.join(home, ".claude", "skills")), false);
  assert.equal(fs.existsSync(path.join(home, ".cursor", "hooks.json")), false);
});
