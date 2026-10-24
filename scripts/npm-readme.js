#!/usr/bin/env node
// npm always ships README.md, so prepack strips the <!-- github-only --> blocks and postpack restores it.
import fs from "node:fs";

// The copy lives in node_modules because npm packs every README* file, whatever "files" says.
const README = "README.md", SAVED = "node_modules/.cache/agentwire-README.md";

if (process.argv[2] === "strip") {
  if (fs.existsSync(SAVED)) throw new Error(`${SAVED} exists: a previous pack did not restore README.md`);
  const text = fs.readFileSync(README, "utf8");
  fs.mkdirSync("node_modules/.cache", { recursive: true });
  fs.copyFileSync(README, SAVED);
  fs.writeFileSync(README, text.replace(/<!-- github-only -->[\s\S]*?<!-- \/github-only -->\n*/g, ""));
} else if (process.argv[2] === "restore") {
  if (fs.existsSync(SAVED)) fs.renameSync(SAVED, README);
} else {
  throw new Error("usage: npm-readme.js strip|restore");
}
