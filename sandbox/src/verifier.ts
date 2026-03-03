/**
 * Sen7inel Sandbox Verifier
 * 
 * Execution order (fail-fast):
 *   1. Patch size check (line count)
 *   2. Apply git patch to /repo
 *   3. ts-morph: complexity analysis (AST-based, not text)
 *   4. Type check (tsc --noEmit)
 *   5. Lint (eslint)
 *   6. Test suite (client-defined command)
 * 
 * Output: writes JSON result to /results/verification.json
 * Exit code: 0 = GREEN, 1 = RED, 2 = COMPLEXITY_VIOLATION, 3 = SYSTEM_ERROR
 */

import { Project, SyntaxKind, Node, FunctionDeclaration, MethodDeclaration, ArrowFunction } from "ts-morph";
import { execSync, ExecSyncOptionsWithStringEncoding } from "child_process";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

// ─── Types ────────────────────────────────────────────────────────────────────

export type VerificationStatus =
  | "GREEN"
  | "RED_TEST_FAILURE"
  | "RED_TYPE_ERROR"
  | "RED_LINT_ERROR"
  | "COMPLEXITY_VIOLATION"
  | "PATCH_TOO_LARGE"
  | "FORBIDDEN_PATTERN"
  | "SYSTEM_ERROR";

export interface FunctionComplexity {
  name: string;
  filePath: string;
  line: number;
  cyclomaticComplexity: number;
  lineCount: number;
}

export interface VerificationResult {
  status: VerificationStatus;
  patchHash: string;
  timestamp: string;
  durationMs: number;
  complexity: {
    violations: FunctionComplexity[];
    maxFound: number;
    avgFound: number;
    withinBudget: boolean;
  };
  gates: {
    patchSize: { passed: boolean; linesChanged: number; limit: number };
    complexity: { passed: boolean; violationCount: number };
    typeCheck: { passed: boolean; output: string };
    lint: { passed: boolean; output: string };
    tests: { passed: boolean; output: string; exitCode: number };
  };
  error?: string;
}

// ─── Config ───────────────────────────────────────────────────────────────────

interface Config {
  repoPath: string;
  patchPath: string;
  resultsPath: string;
  testCommand: string;
  typeCheckCommand: string;
  lintCommand: string;
  maxCC: number;
  maxFunctionLines: number;
  maxPatchLines: number;
  patchHash: string;
  timeoutMs: number;
  dryRun: boolean;
}

function loadConfig(): Config {
  return {
    repoPath: process.env.REPO_PATH ?? "/repo",
    patchPath: process.env.PATCH_FILE ?? "/patch/changes.diff",
    resultsPath: process.env.RESULTS_PATH ?? "/results/verification.json",
    testCommand: process.env.CLIENT_TEST_COMMAND ?? "npx jest --runInBand --forceExit",
    typeCheckCommand: process.env.CLIENT_TYPE_CHECK ?? "npx tsc --noEmit",
    lintCommand: process.env.CLIENT_LINT_COMMAND ?? "npx eslint src/ --max-warnings 0",
    maxCC: parseInt(process.env.MAX_CC ?? "10", 10),
    maxFunctionLines: parseInt(process.env.MAX_FUNCTION_LINES ?? "40", 10),
    maxPatchLines: parseInt(process.env.MAX_PATCH_LINES ?? "150", 10),
    patchHash: process.env.PATCH_HASH ?? "unknown",
    timeoutMs: parseInt(process.env.TIMEOUT_MS ?? "90000", 10),
    dryRun: process.argv.includes("--dry-run"),
  };
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function run(
  command: string,
  cwd: string,
  timeoutMs: number
): { exitCode: number; stdout: string; stderr: string } {
  const opts: ExecSyncOptionsWithStringEncoding = {
    cwd,
    timeout: timeoutMs,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  };
  try {
    const stdout = execSync(command, opts) as unknown as string;
    return { exitCode: 0, stdout: stdout ?? "", stderr: "" };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: e.status ?? 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

function countPatchLines(patchPath: string): number {
  if (!existsSync(patchPath)) return 0;
  const content = readFileSync(patchPath, "utf8");
  // Count only added/removed lines (not context lines)
  return content.split("\n").filter((l) => l.startsWith("+") || l.startsWith("-"))
    .filter((l) => !l.startsWith("+++") && !l.startsWith("---")).length;
}

// ─── Cyclomatic Complexity ─────────────────────────────────────────────────────

/**
 * Calculate cyclomatic complexity for a function node.
 * CC = 1 + number of branching nodes.
 * Branching nodes: if, else if, for, while, do, case, catch, &&, ||, ??, ternary
 */
function calculateCC(node: FunctionDeclaration | MethodDeclaration | ArrowFunction): number {
  let cc = 1; // Base path

  const BRANCHING_KINDS = new Set([
    SyntaxKind.IfStatement,
    SyntaxKind.ForStatement,
    SyntaxKind.ForInStatement,
    SyntaxKind.ForOfStatement,
    SyntaxKind.WhileStatement,
    SyntaxKind.DoStatement,
    SyntaxKind.CaseClause,
    SyntaxKind.CatchClause,
    SyntaxKind.ConditionalExpression,    // ternary
    SyntaxKind.AmpersandAmpersandToken,  // &&
    SyntaxKind.BarBarToken,              // ||
    SyntaxKind.QuestionQuestionToken,    // ??
  ]);

  node.forEachDescendant((child) => {
    if (BRANCHING_KINDS.has(child.getKind())) {
      cc++;
    }
  });

  return cc;
}

function getFunctionName(
  node: FunctionDeclaration | MethodDeclaration | ArrowFunction
): string {
  if (Node.isFunctionDeclaration(node) || Node.isMethodDeclaration(node)) {
    return node.getName() ?? "<anonymous>";
  }
  // Arrow function: check if assigned to a variable
  const parent = node.getParent();
  if (Node.isVariableDeclaration(parent)) {
    return parent.getName();
  }
  return "<anonymous>";
}

function analyzeComplexity(
  repoPath: string,
  maxCC: number,
  maxFunctionLines: number
): { violations: FunctionComplexity[]; maxFound: number; avgFound: number } {
  const tsConfigPath = join(repoPath, "tsconfig.json");
  
  const project = new Project({
    tsConfigFilePath: existsSync(tsConfigPath) ? tsConfigPath : undefined,
    addFilesFromTsConfig: existsSync(tsConfigPath),
    skipFileDependencyResolution: true,
  });

  if (!existsSync(tsConfigPath)) {
    project.addSourceFilesAtPaths(join(repoPath, "src/**/*.ts"));
  }

  const violations: FunctionComplexity[] = [];
  const allScores: number[] = [];

  for (const sourceFile of project.getSourceFiles()) {
    const filePath = sourceFile.getFilePath();
    
    // Skip test files — we measure production code complexity
    if (filePath.includes(".test.") || filePath.includes(".spec.")) continue;

    const functions = [
      ...sourceFile.getFunctions(),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.MethodDeclaration),
      ...sourceFile.getDescendantsOfKind(SyntaxKind.ArrowFunction),
    ] as Array<FunctionDeclaration | MethodDeclaration | ArrowFunction>;

    for (const fn of functions) {
      const cc = calculateCC(fn);
      const lineCount = fn.getEndLineNumber() - fn.getStartLineNumber() + 1;
      allScores.push(cc);

      if (cc > maxCC || lineCount > maxFunctionLines) {
        violations.push({
          name: getFunctionName(fn),
          filePath: filePath.replace(repoPath, ""),
          line: fn.getStartLineNumber(),
          cyclomaticComplexity: cc,
          lineCount,
        });
      }
    }
  }

  const maxFound = allScores.length > 0 ? Math.max(...allScores) : 0;
  const avgFound = allScores.length > 0
    ? Math.round((allScores.reduce((a, b) => a + b, 0) / allScores.length) * 10) / 10
    : 0;

  return { violations, maxFound, avgFound };
}

// ─── Main Verification Flow ────────────────────────────────────────────────────

export async function verify(config: Config): Promise<VerificationResult> {
  const startMs = Date.now();
  const timestamp = new Date().toISOString();

  const result: VerificationResult = {
    status: "SYSTEM_ERROR",
    patchHash: config.patchHash,
    timestamp,
    durationMs: 0,
    complexity: { violations: [], maxFound: 0, avgFound: 0, withinBudget: true },
    gates: {
      patchSize: { passed: false, linesChanged: 0, limit: config.maxPatchLines },
      complexity: { passed: false, violationCount: 0 },
      typeCheck: { passed: false, output: "" },
      lint: { passed: false, output: "" },
      tests: { passed: false, output: "", exitCode: -1 },
    },
  };

  try {
    // ── Gate 1: Patch Size ──────────────────────────────────────────────────
    const linesChanged = countPatchLines(config.patchPath);
    result.gates.patchSize = {
      passed: linesChanged <= config.maxPatchLines,
      linesChanged,
      limit: config.maxPatchLines,
    };

    if (!result.gates.patchSize.passed) {
      result.status = "PATCH_TOO_LARGE";
      result.durationMs = Date.now() - startMs;
      return result;
    }

    // ── Apply Patch (skip in dry-run) ────────────────────────────────────────
    if (!config.dryRun && existsSync(config.patchPath)) {
      const applyResult = run(
        `git apply --check ${config.patchPath} && git apply ${config.patchPath}`,
        config.repoPath,
        15_000
      );
      if (applyResult.exitCode !== 0) {
        result.status = "SYSTEM_ERROR";
        result.error = `Patch apply failed: ${applyResult.stderr}`;
        result.durationMs = Date.now() - startMs;
        return result;
      }
    }

    // ── Gate 2: Complexity Analysis ──────────────────────────────────────────
    const complexityAnalysis = analyzeComplexity(
      config.repoPath,
      config.maxCC,
      config.maxFunctionLines
    );
    result.complexity = {
      ...complexityAnalysis,
      withinBudget: complexityAnalysis.violations.length === 0,
    };
    result.gates.complexity = {
      passed: complexityAnalysis.violations.length === 0,
      violationCount: complexityAnalysis.violations.length,
    };

    if (!result.gates.complexity.passed) {
      result.status = "COMPLEXITY_VIOLATION";
      result.durationMs = Date.now() - startMs;
      return result;
    }

    // ── Gate 3: Type Check ───────────────────────────────────────────────────
    const typeCheck = run(config.typeCheckCommand, config.repoPath, 30_000);
    result.gates.typeCheck = {
      passed: typeCheck.exitCode === 0,
      output: (typeCheck.stdout + typeCheck.stderr).slice(0, 2000),
    };

    if (!result.gates.typeCheck.passed) {
      result.status = "RED_TYPE_ERROR";
      result.durationMs = Date.now() - startMs;
      return result;
    }

    // ── Gate 4: Lint ─────────────────────────────────────────────────────────
    const lint = run(config.lintCommand, config.repoPath, 30_000);
    result.gates.lint = {
      passed: lint.exitCode === 0,
      output: (lint.stdout + lint.stderr).slice(0, 2000),
    };

    if (!result.gates.lint.passed) {
      result.status = "RED_LINT_ERROR";
      result.durationMs = Date.now() - startMs;
      return result;
    }

    // ── Gate 5: Tests ────────────────────────────────────────────────────────
    const tests = run(config.testCommand, config.repoPath, config.timeoutMs);
    result.gates.tests = {
      passed: tests.exitCode === 0,
      output: (tests.stdout + tests.stderr).slice(0, 5000),
      exitCode: tests.exitCode,
    };

    result.status = tests.exitCode === 0 ? "GREEN" : "RED_TEST_FAILURE";

  } catch (err: unknown) {
    result.status = "SYSTEM_ERROR";
    result.error = err instanceof Error ? err.message : String(err);
  }

  result.durationMs = Date.now() - startMs;
  return result;
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

const config = loadConfig();

verify(config).then((result) => {
  // Write structured result for n8n to read
  writeFileSync(config.resultsPath, JSON.stringify(result, null, 2), "utf8");

  // stdout summary for n8n HTTP response
  console.log(JSON.stringify({
    status: result.status,
    patchHash: result.patchHash,
    durationMs: result.durationMs,
    gatesPassed: Object.entries(result.gates)
      .filter(([, v]) => v.passed)
      .map(([k]) => k),
    gatesFailed: Object.entries(result.gates)
      .filter(([, v]) => !v.passed)
      .map(([k]) => k),
    complexityViolations: result.complexity.violations.length,
  }));

  // Exit codes for n8n to branch on
  const exitMap: Record<VerificationStatus, number> = {
    GREEN: 0,
    RED_TEST_FAILURE: 1,
    RED_TYPE_ERROR: 1,
    RED_LINT_ERROR: 1,
    COMPLEXITY_VIOLATION: 2,
    PATCH_TOO_LARGE: 2,
    FORBIDDEN_PATTERN: 2,
    SYSTEM_ERROR: 3,
  };

  process.exit(exitMap[result.status] ?? 3);
}).catch((err) => {
  console.error(JSON.stringify({ status: "SYSTEM_ERROR", error: String(err) }));
  process.exit(3);
});