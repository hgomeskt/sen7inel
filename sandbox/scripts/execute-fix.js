#!/usr/bin/env node
/**
 * Sen7inel — execute-fix.js (Bridge Script)
 *
 * Chamado pelo n8n via "Execute Command" node.
 * Recebe o patch gerado pelo Claude, sobe o container efêmero,
 * roda o verifier.ts e retorna o JSON de resultado.
 *
 * Fluxo:
 *   n8n → execute-fix.js → docker run (sen7inel-sandbox) → verifier.ts → JSON
 *
 * Uso:
 *   node execute-fix.js \
 *     --client-id=example-client \
 *     --patch-content="$(cat patch.diff)" \
 *     --patch-hash=abc123def456 \
 *     --repo-path=/opt/sen7inel/repos/example-client \
 *     --iteration=1
 *
 * Variáveis de ambiente esperadas (setadas pelo n8n):
 *   SEN7INEL_SANDBOX_IMAGE   — imagem docker (default: sen7inel-sandbox:latest)
 *   SEN7INEL_RESULTS_DIR     — diretório base para resultados (default: /tmp/sen7inel-results)
 *   SEN7INEL_MAX_CC          — cyclomatic complexity limit (default: 10)
 *   SEN7INEL_MAX_PATCH_LINES — patch size limit (default: 150)
 *
 * Exit Codes (lidos pelo n8n para roteamento):
 *   0 = GREEN            — patch aprovado, seguir para PR
 *   1 = RED              — teste/type/lint falhou, refinar patch
 *   2 = COMPLEXITY_VIOLATION | PATCH_TOO_LARGE — achatar lógica e retentar
 *   3 = SYSTEM_ERROR     — escalar para humano imediatamente
 */

import { execSync } from "child_process";
import {
  writeFileSync,
  readFileSync,
  existsSync,
  mkdirSync,
  rmSync,
} from "fs";
import { join } from "path";
import { randomUUID } from "crypto";

// ─── Config ───────────────────────────────────────────────────────────────────

const SANDBOX_IMAGE =
  process.env.SEN7INEL_SANDBOX_IMAGE ?? "sen7inel-sandbox:latest";
const RESULTS_BASE =
  process.env.SEN7INEL_RESULTS_DIR ?? "/tmp/sen7inel-results";
const MAX_CC = process.env.SEN7INEL_MAX_CC ?? "10";
const MAX_PATCH_LINES = process.env.SEN7INEL_MAX_PATCH_LINES ?? "150";
const MAX_FUNCTION_LINES = process.env.SEN7INEL_MAX_FUNCTION_LINES ?? "40";

// ─── Parse CLI Args ───────────────────────────────────────────────────────────

function parseArgs() {
  const args = Object.fromEntries(
    process.argv
      .slice(2)
      .filter((a) => a.startsWith("--"))
      .map((a) => {
        const [key, ...rest] = a.slice(2).split("=");
        return [key, rest.join("=")];
      })
  );

  const required = ["client-id", "patch-hash", "repo-path"];
  for (const req of required) {
    if (!args[req]) {
      fatal(`Missing required argument: --${req}`, "MISSING_ARG");
    }
  }

  // patch-content pode vir como arg ou via stdin
  let patchContent = args["patch-content"] ?? "";
  if (!patchContent && !process.stdin.isTTY) {
    try {
      patchContent = readFileSync("/dev/stdin", "utf8");
    } catch {
      // stdin vazio é ok para dry-run
    }
  }

  return {
    clientId: args["client-id"],
    patchContent,
    patchHash: args["patch-hash"],
    repoPath: args["repo-path"],
    iteration: parseInt(args["iteration"] ?? "1", 10),
    dryRun: args["dry-run"] === "true" || process.argv.includes("--dry-run"),
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fatal(message, code = "SYSTEM_ERROR") {
  const output = {
    status: "SYSTEM_ERROR",
    error: message,
    errorCode: code,
    isGreen: false,
    requiresHumanEscalation: true,
    canRetry: false,
  };
  console.log(JSON.stringify(output, null, 2));
  process.exit(3);
}

function loadClientStack(clientId) {
  const stackPath = join(
    process.cwd(),
    "client-profiles",
    clientId,
    "STACK.md"
  );
  if (!existsSync(stackPath)) {
    fatal(`STACK.md not found for client: ${clientId}`, "MISSING_STACK");
  }

  const content = readFileSync(stackPath, "utf8");
  const extract = (key) => {
    const match = content.match(new RegExp(`${key}:\\s*"?([^"\\n]+)"?`));
    return match ? match[1].trim() : null;
  };

  return {
    testCommand:
      extract("test") ?? "npx jest --runInBand --forceExit",
    typeCheckCommand: extract("type_check") ?? "npx tsc --noEmit",
    lintCommand: extract("lint") ?? "npx eslint src/ --max-warnings 0",
    testTimeoutSeconds: parseInt(
      extract("test_timeout_seconds") ?? "90",
      10
    ),
  };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const args = parseArgs();
const runId = `${args.patchHash.slice(0, 8)}-i${args.iteration}-${randomUUID().slice(0, 4)}`;
const runDir = join(RESULTS_BASE, runId);
const patchFile = join(runDir, "changes.diff");
const resultsFile = join(runDir, "verification.json");

// Setup run directory
mkdirSync(runDir, { recursive: true });

// Write patch to temp file
if (args.patchContent) {
  writeFileSync(patchFile, args.patchContent, "utf8");
} else if (!args.dryRun) {
  fatal("No patch content provided (--patch-content or stdin)", "NO_PATCH");
} else {
  writeFileSync(patchFile, "", "utf8"); // empty for dry-run
}

// Load client config
const clientStack = loadClientStack(args.clientId);

// Verify repo exists
if (!existsSync(args.repoPath) && !args.dryRun) {
  fatal(`Repo path not found: ${args.repoPath}`, "MISSING_REPO");
}

// ─── Build Docker Command ─────────────────────────────────────────────────────

const containerName = `sen7inel-sandbox-${runId}`;

const dockerCmd = [
  "docker run",
  "--rm",
  `--name ${containerName}`,
  "--network none",              // Zero network access — patches não podem exfiltrar
  "--read-only",                 // Filesystem read-only
  "--tmpfs /tmp:size=100m,noexec", // Temp com noexec (sem execução de binários plantados)
  "--memory=512m",
  "--memory-swap=512m",          // Sem swap — previne thrashing
  "--cpus=1.0",
  "--pids-limit=128",            // Previne fork bombs
  `--volume ${args.repoPath}:/repo:ro`,
  `--volume ${patchFile}:/patch/changes.diff:ro`,
  `--volume ${runDir}:/results:rw`,
  `--env CLIENT_TEST_COMMAND="${clientStack.testCommand}"`,
  `--env CLIENT_TYPE_CHECK="${clientStack.typeCheckCommand}"`,
  `--env CLIENT_LINT_COMMAND="${clientStack.lintCommand}"`,
  `--env TIMEOUT_MS="${clientStack.testTimeoutSeconds * 1000}"`,
  `--env MAX_CC="${MAX_CC}"`,
  `--env MAX_FUNCTION_LINES="${MAX_FUNCTION_LINES}"`,
  `--env MAX_PATCH_LINES="${MAX_PATCH_LINES}"`,
  `--env PATCH_HASH="${args.patchHash}"`,
  `--env REPO_PATH=/repo`,
  `--env PATCH_FILE=/patch/changes.diff`,
  `--env RESULTS_PATH=/results/verification.json`,
  args.dryRun ? "--env DRY_RUN=true" : "",
  SANDBOX_IMAGE,
]
  .filter(Boolean)
  .join(" \\\n  ");

// ─── Execute Container ────────────────────────────────────────────────────────

const startMs = Date.now();
let dockerExitCode = 3;

try {
  execSync(dockerCmd, {
    stdio: "pipe",
    timeout: (clientStack.testTimeoutSeconds + 90) * 1000,
    encoding: "utf8",
  });
  dockerExitCode = 0;
} catch (err) {
  dockerExitCode = err.status ?? 3;
}

// ─── Read & Enrich Results ────────────────────────────────────────────────────

let verificationResult;
try {
  verificationResult = JSON.parse(readFileSync(resultsFile, "utf8"));
} catch {
  verificationResult = {
    status: "SYSTEM_ERROR",
    error: "Sandbox produced no results — container may have crashed",
    patchHash: args.patchHash,
    gates: {},
    complexity: { violations: [], maxFound: 0 },
  };
}

// Enrich with bridge metadata
const output = {
  // Core result (passed through from verifier)
  ...verificationResult,

  // Bridge metadata
  runId,
  clientId: args.clientId,
  iteration: args.iteration,
  totalDurationMs: Date.now() - startMs,

  // ── Routing flags for n8n IF nodes ──────────────────────────────────────
  // n8n lê esses campos para rotear entre branches sem lógica custom

  isGreen: verificationResult.status === "GREEN",

  // Complexity: reenviar ao Claude com instrução de flatten
  needsComplexityFlatten:
    verificationResult.status === "COMPLEXITY_VIOLATION" ||
    verificationResult.status === "PATCH_TOO_LARGE",

  // Red gates: patch tem bugs — refinar com contexto de erro
  needsRefinement: ["RED_TEST_FAILURE", "RED_TYPE_ERROR", "RED_LINT_ERROR"].includes(
    verificationResult.status
  ),

  // Escalar para humano — não tentar de novo automaticamente
  requiresHumanEscalation: ["SYSTEM_ERROR", "FORBIDDEN_PATTERN"].includes(
    verificationResult.status
  ),

  // Payload de refatoração: enviado de volta ao Claude se needsComplexityFlatten
  flattenRequest:
    verificationResult.status === "COMPLEXITY_VIOLATION"
      ? {
          instruction:
            "REFACTOR_FOR_COMPLEXITY: The following functions exceed the cyclomatic complexity budget (max: 10). " +
            "Flatten the logic using early returns, extract named predicates, and split into smaller functions. " +
            "Do NOT change behavior — only structure.",
          violations: verificationResult.complexity?.violations ?? [],
          maxAllowed: parseInt(MAX_CC, 10),
        }
      : null,

  // Payload de refinamento: contexto de erro para re-geração
  refinementContext:
    verificationResult.status !== "GREEN"
      ? buildRefinementContext(verificationResult)
      : null,
};

// ─── Output & Cleanup ─────────────────────────────────────────────────────────

console.log(JSON.stringify(output, null, 2));

// Limpar run directory após sucesso (manter em caso de erro para debug)
if (output.isGreen) {
  try {
    rmSync(runDir, { recursive: true, force: true });
  } catch {
    // Não crítico
  }
}

process.exit(dockerExitCode);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildRefinementContext(result) {
  const failedGate = Object.entries(result.gates ?? {}).find(
    ([, v]) => !v.passed
  );

  if (!failedGate) return null;

  const [gateName, gateData] = failedGate;

  return {
    failedGate: gateName,
    status: result.status,
    // Output truncado a 1500 chars — suficiente para o modelo entender o erro
    errorOutput: (gateData.output ?? "").slice(0, 1500),
    instruction: getRefinementInstruction(result.status, gateName),
  };
}

function getRefinementInstruction(status, gateName) {
  const instructions = {
    RED_TYPE_ERROR:
      "TYPE_ERROR: The patch introduced TypeScript type errors. Fix the types without changing runtime behavior.",
    RED_LINT_ERROR:
      "LINT_ERROR: The patch violates ESLint rules. Fix the violations without changing logic.",
    RED_TEST_FAILURE:
      "TEST_FAILURE: The patch caused test failures. Review the failing tests and correct the implementation.",
    COMPLEXITY_VIOLATION:
      "COMPLEXITY: Functions exceed cyclomatic complexity limit of 10. Flatten logic with early returns and extracted predicates.",
    PATCH_TOO_LARGE:
      "PATCH_TOO_LARGE: Patch exceeds 150 line limit. Respond with DECOMPOSE and list the sub-tasks.",
  };
  return instructions[status] ?? `UNKNOWN_FAILURE: Gate ${gateName} failed. Review and correct.`;
}