import assert from "node:assert/strict";
import { Replica } from "../src/replica.js";

const harbor = new Replica("harbor");
const ferry = new Replica("ferry");
harbor.insert(0, "Gate 2");
for (const op of harbor.delta()) ferry.receive(op);

// The ferry goes offline. One editor corrects the gate, the other adds a time.
harbor.delete(5);
harbor.insert(5, "4");
ferry.insert(6, " at 09:10");
console.log("shore:", harbor.text, "\nonboard:", ferry.text);
const toFerry = harbor.delta(ferry.version);
const toHarbor = ferry.delta(harbor.version);
for (const op of toHarbor.reverse()) harbor.receive(op);
for (const op of [...toFerry].reverse()) ferry.receive(op);
for (const op of toFerry) ferry.receive(op); // transport repeats a delivery
assert.equal(harbor.text, "Gate 4 at 09:10");
assert.equal(harbor.text, ferry.text);
console.log("reconnected:", ferry.text, "\nclock:", JSON.stringify(ferry.version));
