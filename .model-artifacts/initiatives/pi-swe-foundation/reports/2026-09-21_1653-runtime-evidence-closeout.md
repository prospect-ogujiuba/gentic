# W-1–W-4 runtime evidence closeout

Topic: pi-swe-foundation

## Provenance

Pi runtime sessions loaded the project `pi-swe` extension and `@gotgenes/pi-permission-system`. Verification used `swe prepare_verification` followed by the exact ordinary `bash` tool command. No verification used internal `pi.exec`. The compact authoritative receipts are in `../workflow.json`; this report is supporting interpretation, not another task authority.

Model review receipts are explicitly `pi-model-self-review`. They are not independent review or human approval.

## Semantics closed before completion

- Obligations now declare required evidence kinds (`machine-command`, `model-review`) and optional `red-green` ordering.
- Completion checks the latest required kind independently, current contract fingerprint, unchanged verification source, and current source freshness.
- `record_review` binds a bounded source snapshot, dimensions, summary, runtime session, and self-review provenance.
- Runtime tool-call IDs are treated as bounded opaque values rather than domain identifiers.
- Prepared verification remains bound to its initiative even when another initiative becomes selected.
- Tool guidance states that verification uses ordinary bash, never internal `pi.exec`, and that model review is self-review rather than independent review.

## Runtime observations

The stored RED for W-4/O-5 is `E-ea9157c1-4db0-44bf-9ece-6636650f0828`. A later failed observation, `E-b5eafb08-89d8-4683-9cac-fbf4f5b3a7b7`, exposed a fixture that retained real initiative evidence after reducing the work graph. Both failures were preserved; neither was rewritten into a pass.

Passing machine observations:

- W-1/O-1: `E-3ddef2f4-2b70-4ce7-a0e1-218ed47b8046` — typecheck plus retained pi-todo/package boundary tests.
- W-2/O-2,O-3: `E-c38cc636-3f4c-4215-9ebe-15efa6b9b880` — domain and store tests.
- W-3/O-3,O-4: `E-77bcb6fb-5b1f-477f-97c7-7c09c34b9566` — evidence and runtime tests after the attribution fix. The earlier pass remains stored but is stale and was not used for completion.
- W-4/O-4,O-5: `E-61c967b0-078e-408f-bfa0-940008d1323d` — runtime and evidence tests after all fixes.

Review observations:

- W-1/O-1: passing self-review `E-475b24ae-b49e-4d25-b971-55096783fd90` found no blocking retirement-boundary issue.
- W-4/O-5: failed self-review `E-5f079bbb-568f-44f6-8dfe-66fbf39efe1d` found mutable-selection evidence misattribution. The finding was fixed with regression coverage.
- W-4/O-5: passing re-review `E-1912f590-2421-41cf-bfc6-3c32aa57c7bc` found no remaining blocker in the reviewed dimensions.

W-1, W-2, W-3, and W-4 were completed through the runtime service only after their completion gates returned no blockers. W-5 remained pending and was not started during closeout.
