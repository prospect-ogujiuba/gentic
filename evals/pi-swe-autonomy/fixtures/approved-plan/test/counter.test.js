import assert from "node:assert/strict";
import { test } from "node:test";

import { decrement, increment, reset } from "../src/counter.js";

test("increment advances by one", () => assert.equal(increment(4), 5));
test("decrement retreats by one", () => assert.equal(decrement(4), 3));
test("reset returns zero", () => assert.equal(reset(4), 0));
