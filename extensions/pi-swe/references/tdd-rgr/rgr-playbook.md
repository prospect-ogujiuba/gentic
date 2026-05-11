# RGR Playbook

Use Red/Green/Refactor to keep implementation behavior-first and reversible.

## 1. Pick the next behavior

Name one observable behavior, not a component to rewrite. Good behavior statements include:

- input or precondition
- action or call
- expected observable result

## 2. Choose the test level

Prefer the lowest level that proves the behavior honestly:

- **Unit**: pure logic, formatting, classifiers, policies.
- **Integration**: module boundaries, persistence, extension events, adapters.
- **End-to-end**: command/resource discovery or user-visible workflow.
- **Characterization**: existing behavior is unclear and must be pinned before change.

## 3. Red

Create one failing test or characterization. The failure should be specific enough to identify the missing behavior.

## 4. Green

Write the smallest production change that passes the test. Avoid adjacent cleanup and future behavior.

## 5. Refactor

After green, improve only touched design while keeping the same tests green.

## 6. Verify

Run the focused test first. Add nearby or broader verification only when touched boundaries, integration points, or regression risk justify it.
