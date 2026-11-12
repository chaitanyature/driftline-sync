/**
 * An operation-based replicated growable array. Node IDs survive deletes.
 * A version vector is a sorted list of [actor, contiguous sequence number].
 */
const actorPattern = /^[A-Za-z0-9_-]{1,64}$/;

function actorName(value) {
  if (typeof value !== "string" || !actorPattern.test(value)) {
    throw new TypeError("actor must be 1..64 ASCII letters, digits, underscores or hyphens");
  }
  return value;
}

function integer(value, label, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) throw new TypeError("invalid " + label);
  return value;
}

const compare = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const id = (actor, seq) => actor + "@" + seq;

function vector(entries) {
  if (!Array.isArray(entries)) throw new TypeError("expected a version vector");
  const map = new Map();
  for (const pair of entries) {
    if (!Array.isArray(pair) || pair.length !== 2) throw new TypeError("invalid clock entry");
    const [actor, n] = pair;
    if (map.has(actorName(actor))) throw new TypeError("duplicate clock entry");
    map.set(actor, integer(n, "clock", 1));
  }
  return new Map([...map].sort(([a], [b]) => compare(a, b)));
}

function normalize(raw) {
  if (!raw || typeof raw !== "object") throw new TypeError("expected an operation");
  const actor = actorName(raw.actor);
  const seq = integer(raw.seq, "sequence", 1);
  const deps = vector(raw.deps);
  if ((deps.get(actor) ?? 0) !== seq - 1) throw new TypeError("own predecessor missing");
  const kind = raw.kind;
  if (kind !== "insert" && kind !== "delete") throw new TypeError("invalid operation kind");
  const ref = raw.ref;
  if (ref === null) {
    if (kind === "delete") throw new TypeError("cannot delete root");
  } else {
    const match = typeof ref === "string" && /^([A-Za-z0-9_-]{1,64})@([1-9][0-9]*)$/.exec(ref);
    if (!match || !Number.isSafeInteger(Number(match[2])) || (deps.get(match[1]) ?? 0) < Number(match[2])) {
      throw new TypeError("reference outside causal context");
    }
  }
  const op = { actor, seq, deps: [...deps], kind, ref };
  if (kind === "insert") {
    if (typeof raw.char !== "string" || [...raw.char].length !== 1 || /^[\uD800-\uDFFF]$/u.test(raw.char)) {
      throw new TypeError("insert requires one Unicode scalar");
    }
    op.char = raw.char;
  }
  return op;
}

function position(value, length) {
  integer(value, "position");
  if (value > length) throw new RangeError("position outside document");
}

export class Replica {
  #history = new Map();
  #nodes = new Map();
  #root = [];
  #pending = new Map();
  #waiters = new Map();
  #actor;

  constructor(actor) { this.#actor = actorName(actor); }
  get actor() { return this.#actor; }

  get version() {
    return [...this.#history].map(([actor, log]) => [actor, log.length])
      .sort(([a], [b]) => compare(a, b));
  }
  get pending() { return this.#pending.size; }

  *#visible() {
    const stack = [...this.#root].reverse();
    while (stack.length) {
      const node = stack.pop();
      if (!node.deleted) yield node;
      for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
    }
  }

  get text() { return Array.from(this.#visible(), node => node.char).join(""); }

  #log(actor) { return this.#history.get(actor) ?? []; }

  #local(kind, ref, char) {
    const seq = this.#log(this.actor).length + 1;
    const op = { actor: this.actor, seq, deps: this.version, kind, ref };
    if (kind === "insert") op.char = char;
    this.receive(op);
    return op;
  }

  insert(index, text) {
    if (typeof text !== "string" || /[\uD800-\uDFFF]/u.test(text)) throw new TypeError("invalid Unicode text");
    const visible = [...this.#visible()];
    position(index, visible.length);
    let anchor = index ? visible[index - 1].id : null;
    const edits = [];
    for (const char of text) {
      const op = this.#local("insert", anchor, char);
      edits.push(op);
      anchor = id(op.actor, op.seq);
    }
    return edits;
  }

  delete(index, count = 1) {
    const visible = [...this.#visible()];
    position(index, visible.length);
    integer(count, "count");
    position(index + count, visible.length);
    return visible.slice(index, index + count).map(node => this.#local("delete", node.id));
  }

  receive(raw) {
    const op = normalize(raw);
    const key = id(op.actor, op.seq);
    const known = this.#log(op.actor)[op.seq - 1]?.op ?? this.#pending.get(key);
    if (known) {
      if (JSON.stringify(known) !== JSON.stringify(op)) throw new Error("actor fork at " + key);
      return false;
    }
    this.#pending.set(key, op);
    const queue = [op];
    const invalid = [];
    for (let i = 0; i < queue.length; i++) {
      const next = queue[i];
      const nextKey = id(next.actor, next.seq);
      const missing = next.deps.find(([a, n]) => this.#log(a).length < n);
      if (missing) {
        const waitKey = id(...missing);
        const waiting = this.#waiters.get(waitKey) ?? [];
        waiting.push(next);
        this.#waiters.set(waitKey, waiting);
        continue;
      }
      this.#pending.delete(nextKey);
      if (next.ref !== null && !this.#nodes.has(next.ref)) {
        invalid.push(nextKey);
        continue;
      }
      this.#apply(next, nextKey);
      const ready = this.#waiters.get(nextKey) ?? [];
      this.#waiters.delete(nextKey);
      for (const waiter of ready) queue.push(waiter);
    }
    if (invalid.length) throw new TypeError("reference identifies a non-insert operation in " + invalid.join(", "));
    return true;
  }

  #apply(op, key) {
    let time = 1;
    for (const [a, n] of op.deps) time = Math.max(time, this.#log(a)[n - 1].time + 1);
    if (op.kind === "delete") {
      this.#nodes.get(op.ref).deleted = true;
    } else {
      const node = { id: key, actor: op.actor, char: op.char, time, deleted: false, children: [] };
      const siblings = op.ref === null ? this.#root : this.#nodes.get(op.ref).children;
      // Fresher insertions immediately follow their anchor. Concurrent ties use actor order.
      let lo = 0, hi = siblings.length;
      while (lo < hi) {
        const mid = Math.floor((lo + hi) / 2);
        const other = siblings[mid];
        if (other.time > time || (other.time === time && other.actor < op.actor)) lo = mid + 1;
        else hi = mid;
      }
      siblings.splice(lo, 0, node);
      this.#nodes.set(key, node);
    }
    const log = this.#log(op.actor);
    log.push({ op, time });
    this.#history.set(op.actor, log);
  }

  delta(peerVersion = []) {
    const peer = vector(peerVersion);
    const result = [];
    for (const [a] of this.version) {
      const log = this.#log(a);
      for (let i = peer.get(a) ?? 0; i < log.length; i++) result.push(structuredClone(log[i].op));
    }
    return result;
  }

  checkpoint() {
    return { format: 1, actor: this.actor, ops: [...this.delta(), ...structuredClone([...this.#pending.values()])] };
  }

  static restore(state) {
    if (!state || state.format !== 1 || !Array.isArray(state.ops)) throw new TypeError("invalid checkpoint");
    const replica = new Replica(state.actor);
    for (const op of state.ops) replica.receive(op);
    return replica;
  }
}
