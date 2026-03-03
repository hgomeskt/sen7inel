skill: meta/complexity-budget
version: "1.0"
enforced_by: [ts-morph, pre-commit-hook]
applies_to: [all-generated-code]
Complexity Budget — LM-CC Enforcement
Why This Exists
Research (DynaCode benchmark) shows LLM code generation accuracy drops
measurably when asked to generate or modify high-complexity code.
This budget is an engineering constraint, not a style preference.
Hard Limits
MetricLimitAction if violatedCyclomatic Complexity / fn10REJECT at Gate 1Function length (lines)40REJECT at Gate 1File avg complexity6WARNING + alertPatch size (total lines diff)150Auto-decompose into sub-patchesNesting depth3REJECT at Gate 1Parameters per function4REJECT (use object param)
Auto-Decomposition Rule
When a required fix exceeds 150 lines, the orchestrator MUST:

Break the fix into sequential sub-patches (each < 150 lines)
Each sub-patch goes through the FULL pipeline independently
Only commit when ALL sub-patches are GREEN
Sub-patches are atomic — partial application is forbidden

Cyclomatic Complexity Reference
CC = number of linearly independent paths through the code.
Each if, else if, case, for, while, catch, &&, || adds 1.
typescript// CC = 1 (single path)
function add(a: number, b: number): number {
  return a + b;
}

// CC = 3 (base + 2 branches)
function classify(score: number): string {
  if (score > 90) return 'A';        // +1
  if (score > 70) return 'B';        // +1
  return 'C';
}

// CC = 11 — REJECTED ❌
// Split into sub-functions, each CC ≤ 10
Measurement Tool
bash# Run in sandbox before any review
npx ts-morph-complexity check ./src --max-cc 10 --max-lines 40