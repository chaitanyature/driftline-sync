#!/usr/bin/env node
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { Replica } from "./replica.js";

const [file, command, ...args] = process.argv.slice(2);
function run() {
  if (!file || !command) throw new Error("usage: driftline FILE init ACTOR | insert INDEX TEXT | delete INDEX COUNT | show | clock | export [CLOCK_JSON] | import PATCH_FILE");
  if (["show", "clock", "export"].includes(command)) {
    const r = Replica.restore(JSON.parse(readFileSync(file, "utf8")));
    if (command === "show") console.log(r.text);
    if (command === "clock") console.log(JSON.stringify(r.version));
    if (command === "export") console.log(JSON.stringify(r.delta(JSON.parse(args[0] ?? "[]"))));
    return;
  }
  const lock = file + ".lock";
  const fd = openSync(lock, "wx");
  const tmp = file + "." + randomUUID() + ".tmp";
  try {
    let r;
    if (command === "init") {
      if (existsSync(file)) throw new Error("document already exists");
      r = new Replica(args[0]);
    } else {
      r = Replica.restore(JSON.parse(readFileSync(file, "utf8")));
      if (command === "insert") r.insert(Number(args[0]), args[1]);
      else if (command === "delete") r.delete(Number(args[0]), Number(args[1]));
      else if (command === "import") {
        const patch = JSON.parse(readFileSync(args[0], "utf8"));
        if (!Array.isArray(patch)) throw new Error("expected patch array");
        for (const op of patch) r.receive(op);
      } else throw new Error("unknown command: " + command);
    }
    const out = openSync(tmp, "wx", 0o600);
    try { writeFileSync(out, JSON.stringify(r.checkpoint()) + "\n"); fsyncSync(out); }
    finally { closeSync(out); }
    renameSync(tmp, file);
    const dir = openSync(dirname(file), "r");
    try { fsyncSync(dir); } finally { closeSync(dir); }
  } finally {
    closeSync(fd);
    if (existsSync(tmp)) unlinkSync(tmp);
    unlinkSync(lock);
  }
}
try { run(); } catch (error) { console.error(error.message); process.exitCode = 1; }
