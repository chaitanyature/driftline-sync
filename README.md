# Driftline Sync

An offline-first text replication library in JavaScript. Each device edits its own copy and exchanges operation deltas when a link becomes available. Delivery may be duplicated, delayed or reordered. No server assigns a global sequence number.

## Run the partition demo

Node.js 20+. The package has zero external dependencies.

```sh
npm run demo
npm test
```

The demo starts both editors at `Gate 2`. A shore operator changes the gate to 4 while an offline ferry adds ` at 09:10` after the old digit. After reverse-order and duplicate delivery, both editors show `Gate 4 at 09:10`.

## Exchange documents on disk

```sh
node src/cli.js shore.json init shore
node src/cli.js boat.json init boat
node src/cli.js shore.json insert 0 'Harbor 🚢'
node src/cli.js shore.json export > patch.json
node src/cli.js boat.json import patch.json
node src/cli.js boat.json insert 7 ' open'
node src/cli.js boat.json export "$(node src/cli.js shore.json clock)" > return.json
node src/cli.js shore.json import return.json
node src/cli.js shore.json show
# Harbor 🚢 open
```

Each file holds one device identity. Give every independently writing device a distinct actor ID. To bootstrap a new device, initialize its own ID and import a full delta from a peer. The CLI syncs an atomic replacement and uses an exclusive lock file around writes. If a process dies holding the lock, verify the writer is gone before removing `FILE.lock`.

## Protocol

An operation has an actor, contiguous per-actor sequence, causal version vector, kind, and a referenced insertion. An insertion also carries one Unicode scalar. Position APIs count scalars, so an emoji outside the BMP occupies one position. A combining accent or a joined emoji sequence can occupy multiple positions.

- **Causal delivery.** A receiver indexes blocked operations by a missing dependency. Delivering that dependency wakes only its waiters. The advertised version includes the contiguous applied prefix for each actor. A checkpoint retains buffered operations.
- **Stable positions.** An insertion attaches to a permanent anchor. A delete hides that node, leaving descendants reachable. Siblings are ordered by descending causal Lamport time and ascending actor ID to resolve ties. Traversal is iterative.
- **Anti-entropy.** `a.delta(b.version)` sends the per-actor suffixes absent on B. Replaying an identical operation is idempotent. Reusing an ID for different content raises a fork error when the histories meet.
- **Convergence.** Given the same valid operations, every replica builds the same parent links and sibling order. Deletion accumulates monotonically. These properties determine a unique visible traversal independently of network order.

```js
import { Replica } from "./src/replica.js";
const a = new Replica("east");
const b = new Replica("west");
a.insert(0, "hello");
for (const op of a.delta(b.version).reverse()) b.receive(op);
console.log(b.text);  // hello
```

## Trade-offs and tests

The engine retains the operation log and tombstones. Safe garbage collection needs a membership and causal-stability protocol. A delta is proportional to the missing suffixes plus their encoded vectors. Resolving an edit index currently walks visible nodes. Sibling insertion can shift an array. The file CLI serializes the entire checkpoint at each change. Replicas assume a trusted peer set and eventual delivery to converge.

The suite compares local edits with an array model, restarts a replica with missing dependencies, drains a 12,000-operation reverse chain, and reconciles four peers across 100 deterministic partition schedules. The CLI round-trip test uses real files and separate Node processes.
