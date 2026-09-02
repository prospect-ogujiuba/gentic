import test from "node:test";
import assert from "node:assert/strict";
import { normalizePlan } from "../dist/core/normalize.js";

test("normalizes a valid dependency graph", () => {
  const plan = normalizePlan({ summary: "ship", tasks: [
    { key: "Analyze API", title: "Analyze", description: "Inspect", type: "research", priority: 90, dependsOn: [], acceptanceCriteria: ["API documented"], verification: { commands: [] } },
    { key: "Implement", title: "Implement", description: "Build", type: "implementation", priority: 80, dependsOn: ["analyze-api"], acceptanceCriteria: ["Feature works"], verification: { commands: ["npm test"] } },
  ] }, 10);
  assert.equal(plan.tasks[0].key, "analyze-api");
  assert.deepEqual(plan.tasks[1].dependsOn, ["analyze-api"]);
});

test("rejects unknown dependencies and cycles", () => {
  assert.throws(() => normalizePlan({ tasks: [{ key:"a", title:"A", description:"A", type:"implementation", dependsOn:["missing"], acceptanceCriteria:["done"], verification:{commands:[]} }] }, 10), /unknown task/i);
  assert.throws(() => normalizePlan({ tasks: [
    { key:"a", title:"A", description:"A", type:"implementation", dependsOn:["b"], acceptanceCriteria:["done"], verification:{commands:[]} },
    { key:"b", title:"B", description:"B", type:"implementation", dependsOn:["a"], acceptanceCriteria:["done"], verification:{commands:[]} },
  ] }, 10), /cycle/i);
});
