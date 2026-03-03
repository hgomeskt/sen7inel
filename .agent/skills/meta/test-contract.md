skill: meta/test-contract
version: "1.0"
enforced_by: [sandbox-runner, ci]
applies_to: [all-patches]
Test Contract — GREEN is Truth
The Contract
A patch does not exist until its tests are GREEN.
No exceptions. No "it should work". No "tests will be added later".
Requirements for Every Patch

Existing tests must stay GREEN — regressions = REJECT
New behavior must have tests — untested new code = REJECT
Test command comes from client's STACK.md — not inferred by model
Tests run in isolation — no external network calls in unit tests

Test Categories (in order of execution)
1. Type check:   tsc --noEmit          (< 10s)
2. Lint:         eslint src/            (< 15s)
3. Complexity:   ts-morph CC check     (< 5s)
4. Unit tests:   {client.testCommand}  (< 60s)
5. Integration:  {client.integrationCommand} (optional, < 120s)
All must pass. First failure stops execution (fail-fast).
What "GREEN" Means
typescriptinterface TestResult {
  exitCode: 0;           // Non-zero = RED, always
  testsTotal: number;    // Must be > 0 (no empty test suites)
  testsPassed: number;   // Must equal testsTotal
  testsFailed: 0;        // Zero tolerance
  duration: number;      // Must be < timeout defined in STACK.md
}
Forbidden Test Patterns

test.skip() added by the patch = REJECT
expect(true).toBe(true) (vacuous test) = REJECT (detected by ts-morph)
Mocking the function being tested = WARNING (reviewer must approve)
setTimeout in tests without jest.useFakeTimers = REJECT