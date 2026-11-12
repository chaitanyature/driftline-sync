import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Replica } from "../src/replica.js";

function generator(seed) {
  let x = seed;
  return n => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) % n;
  };
}

function shuffle(items, random) {
  for (let i = items.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

test("scalar offsets and visible insert intention", () => {
  const r = new Replica("a");
  r.insert(0, "A🚢Z");
  r.insert(2, "B");
  assert.equal(r.text, "A🚢BZ");
  r.delete(1, 2);
  assert.equal(r.text, "AZ");
  assert.throws(() => r.delete(1, 5));
  assert.throws(() => r.insert(1, "a\ud800b"));
  assert.equal(r.text, "AZ");
});

test("single-author edits agree with an independent array model", () => {
  const r = new Replica("local");
  const model = [];
  const rng = generator(97);
  for (let i = 0; i < 500; i++) {
    if (model.length && rng(3) === 0) {
      const index = rng(model.length);
      r.delete(index);
      model.splice(index, 1);
    } else {
      const index = rng(model.length + 1);
      const char = ["a", "ê", "🛶", "\n"][rng(4)];
      r.insert(index, char);
      model.splice(index, 0, char);
    }
    assert.equal(r.text, model.join(""));
  }
});

test("late child of a deleted anchor survives and a redundant delete commutes", () => {
  const a = new Replica("a"), b = new Replica("b");
  a.insert(0, "X");
  for (const op of a.delta()) b.receive(op);
  a.delete(0);
  b.insert(1, "!");
  b.delete(0);
  const observer = new Replica("observer");
  for (const op of [...a.delta(), ...b.delta()].reverse()) observer.receive(op);
  assert.equal(observer.text, "!");
  assert.equal(observer.pending, 0);
});

test("pure concurrent insertions have a deterministic tie break", () => {
  const a = new Replica("a"), b = new Replica("b");
  const aa = a.insert(0, "ABC"), bb = b.insert(0, "123");
  for (const op of aa) b.receive(op);
  for (const op of bb) a.receive(op);
  assert.equal(a.text, "ABC123");
  assert.equal(b.text, a.text);
  assert.deepEqual(a.delta(b.version), []);
});

test("out-of-order operations survive checkpointing and resume on a missing dependency", () => {
  const a = new Replica("a"), b = new Replica("b");
  const edits = a.insert(0, "queue");
  for (const op of edits.slice(1).reverse()) b.receive(op);
  assert.deepEqual(b.version, []);
  assert.equal(b.pending, 4);
  const restored = Replica.restore(JSON.parse(JSON.stringify(b.checkpoint())));
  restored.receive(edits[0]);
  assert.equal(restored.pending, 0);
  assert.equal(restored.text, "queue");
  assert.deepEqual(restored.version, a.version);
  const patch = restored.delta([["a", 3]]);
  assert.deepEqual(patch.map(op => op.seq), [4, 5]);
});

test("duplicate delivery is idempotent and conflicting actor histories are detected", () => {
  const a = new Replica("a");
  const [x] = a.insert(0, "x");
  assert.equal(a.receive(x), false);
  assert.throws(() => a.receive({ ...x, char: "y" }), /actor fork/);
  assert.throws(() => a.receive({ ...x, actor: "b", ref: "b@9" }), /outside causal/);
  const external = a.delta();
  external[0].char = "z";
  x.char = "y";
  assert.equal(a.delta()[0].char, "x");
});

test("long reverse chain drains without recursing into the JS stack", () => {
  const r = new Replica("reader");
  for (let n = 12000; n >= 1; n--) r.receive({
    actor: "a", seq: n, deps: n === 1 ? [] : [["a", n - 1]],
    kind: "insert", ref: n === 1 ? null : "a@" + (n - 1), char: "."
  });
  assert.equal(r.pending, 0);
  assert.equal(r.text.length, 12000);
});

test("100 seeded partitions converge after shuffled and duplicated anti-entropy", () => {
  for (let seed = 1; seed <= 100; seed++) {
    const random = generator(seed);
    const peers = ["station", "ferry", "train", "bus"].map(a => new Replica(a));
    const authored = [];
    for (let step = 0; step < 70; step++) {
      const source = peers[random(peers.length)];
      const length = [...source.text].length;
      if (length && random(4) === 0) authored.push(...source.delete(random(length)));
      else authored.push(...source.insert(random(length + 1), String.fromCharCode(65 + random(26))));
      if (random(5) < 2) {
        const sink = peers[random(peers.length)];
        const patch = shuffle(source.delta(sink.version), random);
        for (const op of patch.slice(0, random(patch.length + 1))) sink.receive(op);
      }
    }
    for (const p of peers) {
      const patch = shuffle([...authored, ...authored.filter(() => random(3) === 0)], random);
      for (const op of patch) p.receive(op);
      assert.equal(p.pending, 0, "seed " + seed);
      assert.deepEqual(p.version, peers[0].version, "seed " + seed);
      assert.equal(p.text, peers[0].text, "seed " + seed);
      assert.deepEqual(p.delta(peers[0].version), []);
    }
  }
});

test("CLI replicas exchange patches on disk", t => {
  const dir = mkdtempSync(join(tmpdir(), "driftline-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  const run = (file, ...args) => execFileSync(process.execPath, [cli, join(dir, file), ...args], { encoding: "utf8" }).trimEnd();
  run("a", "init", "a"); run("b", "init", "b");
  run("a", "insert", "0", "bridge");
  const patch = join(dir, "patch.json");
  writeFileSync(patch, run("a", "export", run("b", "clock")));
  run("b", "import", patch);
  assert.equal(run("b", "show"), "bridge");
  assert.deepEqual(JSON.parse(run("a", "export", run("b", "clock"))), []);
  const before = readFileSync(join(dir, "a"), "utf8");
  assert.throws(() => run("a", "delete", "0", "999"));
  assert.equal(readFileSync(join(dir, "a"), "utf8"), before);
});
