#!/usr/bin/env node
/**
 * Sen7inel — Sandbox Runner
 * Called by n8n via Execute Command node or HTTP webhook.
 *
 * Usage:
 *   node sandbox/scripts/run-verification.js \
 *     --client-id=example-client \
 *     --patch-file=/tmp/patches/abc123.diff \
 *     --patch-hash=abc123 \
 *     --repo-path=/opt/client-repos/example-client
 *
 * Returns JSON to stdout. n8n reads this as the node output.
 * Exit code: 0 = GREEN, 1 = RED, 2 = VIOLATION, 3 = SYSTEM_ERROR
 */

import { execSync } from "child_process";
import { readFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

// ─── Parse Args ───────────────────────────────────────────────────────────────

function parseArgs() {
  const args = Object.fromEntries(
    process.argv.slice(2)
      .filter((a) => a.startsWith("--"))
      .map((a) => {
        const [key, ...rest] = a.slice(2).split("=");
        return [key, rest.join("=")];
      })
  );

  const required = ["client-id", "patch-file", "patch-hash", "repo-path"];
  for (const req of required) {
    if (!args[req]) {
      console.error(JSON.stringify({ error: `Missing required arg: --${req}` }));
      process.exit(3);
    }
  }

  return {
    clientId: args["client-id"],
    patchFile: args["patch-file"],
    patchHash: args["patch-hash"],
    repoPath: args["repo-path"],
    dryRun: args["dry-run"] === "true" || process.argv.includes("--dry-run"),
  };
}

// ─── Load Client Config from STACK.md ────────────────────────────────────────

function loadClientStack(clientId) {
  const stackPath = join(
    process.cwd(),
    "client-profiles",
    clientId,
    "STACK.md"
  );

  if (!existsSync(stackPath)) {
    throw new Error(`STACK.md not found for client: ${clientId} at ${stackPath}`);
  }

  const content = readFileSync(stackPath, "utf8");

  // Extract yaml commands block
  const extract = (key) => {
    const match = content.match(new RegExp(`${key}:\\s*"?([^"\\n]+)"?`));
    return match ? match[1].trim() : null;
  };

  return {
    testCommand: extract("test") ?? "npx jest --runInBand --forceExit",
    typeCheckCommand: extract("type_check") ?? "npx tsc --noEmit",
    lintCommand: extract("lint") ?? "npx eslint src/ --max-warnings 0",
    testTimeoutSeconds: parseInt(extract("test_timeout_seconds") ?? "90", 10),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const args = parseArgs();
const runId = randomUUID().slice(0, 8);
const resultsDir = `/tmp/sen7inel-results/${runId}`;
const containerName = `sen7inel-sandbox-${runId}`;

mkdirSync(resultsDir, { recursive: true });

let clientStack;
try {
  clientStack = loadClientStack(args.clientId);
} catch (err) {
  console.error(JSON.stringify({ error: err.message, status: "SYSTEM_ERROR" }));
  process.exit(3);
}

if (!existsSync(args.patchFile)) {
  console.error(JSON.stringify({ error: `Patch file not found: ${args.patchFile}`, status: "SYSTEM_ERROR" }));
  process.exit(3);
}

// ─── Build Docker Command ─────────────────────────────────────────────────────

const dockerCmd = [
  "docker run",
  "--rm",                                          // Auto-remove after exit
  `--name ${containerName}`,
  "--network none",                                // Zero network access
  "--read-only",                                   // Read-only filesystem
  "--tmpfs /tmp:size=100m",                        // Temp only
  "--memory 512m",                                 // 512MB RAM limit
  "--cpus 1",                                      // 1 CPU
  `--volume ${args.repoPath}:/repo:ro`,            // Repo: read-only
  `--volume ${args.patchFile}:/patch/changes.diff:ro`, // Patch: read-only
  `--volume ${resultsDir}:/results:rw`,            // Results: writable
  // Environment variables from STACK.md
  `--env CLIENT_TEST_COMMAND="${clientStack.testCommand}"`,
  `--env CLIENT_TYPE_CHECK="${clientStack.typeCheckCommand}"`,
  `--env CLIENT_LINT_COMMAND="${clientStack.lintCommand}"`,
  `--env TIMEOUT_MS="${clientStack.testTimeoutSeconds * 1000}"`,
  `--env MAX_CC=10`,
  `--env MAX_FUNCTION_LINES=40`,
  `--env MAX_PATCH_LINES=150`,
  `--env PATCH_HASH="${args.patchHash}"`,
  `--env RESULTS_PATH=/results/verification.json`,
  args.dryRun ? "--env DRY_RUN=true" : "",
  "sen7inel-sandbox:latest",
].filter(Boolean).join(" \\\n  ");

// ─── Execute ──────────────────────────────────────────────────────────────────

const startMs = Date.now();
let exitCode = 3;

try {
  execSync(dockerCmd, {
    stdio: "pipe",
    timeout: (clientStack.testTimeoutSeconds + 60) * 1000, // Test timeout + 60s overhead
    encoding: "utf8",
  });
  exitCode = 0;
} catch (err) {
  exitCode = err.status ?? 3;
}

// ─── Read Results ─────────────────────────────────────────────────────────────

const resultsFile = join(resultsDir, "verification.json");
let verificationResult;

try {
  verificationResult = JSON.parse(readFileSync(resultsFile, "utf8"));
} catch {
  verificationResult = {
    status: "SYSTEM_ERROR",
    error: "Could not read verification results from sandbox",
    patchHash: args.patchHash,
  };
}

// ─── Output for n8n ───────────────────────────────────────────────────────────

const output = {
  ...verificationResult,
  runId,
  clientId: args.clientId,
  containerName,
  totalDurationMs: Date.now() - startMs,
  // Simplified status for n8n routing
  isGreen: verificationResult.status === "GREEN",
  requiresHumanEscalation: ["SYSTEM_ERROR", "FORBIDDEN_PATTERN"].includes(verificationResult.status),
  canRetry: ["RED_TEST_FAILURE", "RED_TYPE_ERROR", "RED_LINT_ERROR"].includes(verificationResult.status),
};

// n8n reads from stdout
console.log(JSON.stringify(output, null, 2));

process.exit(exitCode);