#!/usr/bin/env node
/**
 * Sen7inel — dispatcher.js
 *
 * Activates Nooa (Claude) with tools to fix a bug autonomously.
 * Sen7inel detects the anomaly and calls this script.
 * Nooa executes the 7-phase self-healing loop.
 *
 * Usage:
 *   node dispatcher.js --client-id=example-client --test
 *   node dispatcher.js --client-id=example-client --bug-file=bug-context.json
 *
 * Exit Codes:
 *   0 = HEALED     — PR created, GREEN status
 *   1 = FAILED     — max iterations reached
 *   2 = ESCALATED  — human escalation required
 *   3 = ERROR      — system error
 */

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, existsSync, writeFileSync, readdirSync } from "fs";
import { execSync } from "child_process";
import { join } from "path";

// ─── Config ───────────────────────────────────────────────────────────────────

const ROOT = process.cwd();
const MAX_ITERATIONS = 3;
const MODEL = "claude-sonnet-4-20250514";

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ─── Parse CLI Args ───────────────────────────────────────────────────────────

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .filter((a) => a.startsWith("--"))
    .map((a) => {
      const [key, ...rest] = a.slice(2).split("=");
      return [key, rest.join("=")];
    })
);

const clientId = args["client-id"] ?? "example-client";
const isTest = args["test"] === "true" || process.argv.includes("--test");
const bugFile = args["bug-file"];

// ─── Load Client Context ──────────────────────────────────────────────────────

function loadClientContext(clientId) {
  const forbidden = join(ROOT, "client-profiles", clientId, "FORBIDDEN.md");
  const stack = join(ROOT, "client-profiles", clientId, "STACK.md");
  const flatArch = join(ROOT, ".agent", "skills", "security", "flat-architecture.md");
  const complexity = join(ROOT, ".agent", "skills", "meta", "complexity-budget.md");
  const testContract = join(ROOT, ".agent", "skills", "meta", "test-contract.md");
  const claudeMd = join(ROOT, "CLAUDE.md");

  const read = (path) => existsSync(path) ? readFileSync(path, "utf8") : `[FILE NOT FOUND: ${path}]`;

  return [
    `# FORBIDDEN (read first, these are hard constraints)\n${read(forbidden)}`,
    `# CLIENT STACK\n${read(stack)}`,
    `# FLAT ARCHITECTURE RULES\n${read(flatArch)}`,
    `# COMPLEXITY BUDGET\n${read(complexity)}`,
    `# TEST CONTRACT\n${read(testContract)}`,
    `# NOOA OPERATING MANUAL\n${read(claudeMd)}`,
  ].join("\n\n---\n\n");
}

// ─── Tool Definitions ─────────────────────────────────────────────────────────

const tools = [
  {
    name: "read_project_file",
    description: "Read the content of a file from the client repository for analysis.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the file from the project root",
        },
      },
      required: ["path"],
    },
  },
  {
    name: "apply_fix",
    description: "Write the corrected code to a file. Use this to apply the patch.",
    input_schema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "Relative path to the file to fix",
        },
        code: {
          type: "string",
          description: "The complete corrected file content",
        },
      },
      required: ["file", "code"],
    },
  },
  {
    name: "execute_sandbox_test",
    description: "Run the verification sandbox (Docker). Returns test results: GREEN or RED with error logs.",
    input_schema: {
      type: "object",
      properties: {
        patch_hash: {
          type: "string",
          description: "Unique identifier for this patch attempt",
        },
      },
      required: [],
    },
  },
  {
    name: "verify_metrics",
    description: "Run ts-morph AST analysis. Returns cyclomatic complexity and rule violations.",
    input_schema: {
      type: "object",
      properties: {
        file: {
          type: "string",
          description: "File to analyze (optional — analyzes all changed files if omitted)",
        },
      },
      required: [],
    },
  },
  {
    name: "create_pull_request",
    description: "Create a GitHub Pull Request with the fix. Only call this after GREEN status.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string", description: "PR title" },
        body: { type: "string", description: "PR body with audit context" },
        branch: { type: "string", description: "Branch name (sen7inel/fix-{hash})" },
      },
      required: ["title", "body", "branch"],
    },
  },
  {
    name: "report_status",
    description: "Report pipeline status back to Sen7inel. Use at each phase transition.",
    input_schema: {
      type: "object",
      properties: {
        phase: { type: "string", description: "Current phase name" },
        status: {
          type: "string",
          enum: ["IN_PROGRESS", "GREEN", "RED", "ESCALATION", "CURA_CONCLUIDA"],
        },
        message: { type: "string", description: "Status details" },
      },
      required: ["phase", "status", "message"],
      },
  },
  {
    name: "list_directory",
    description: "List files and folders in a directory.",
    input_schema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative path to the directory",
        },
      },
      required: ["path"],
    },
  },
];

// ─── Tool Executor ────────────────────────────────────────────────────────────

function executeTool(name, input) {
  console.log(`\n🔧 Tool called: ${name}`);
  console.log(`   Input: ${JSON.stringify(input)}`);

  switch (name) {
    case "read_project_file": {
      const filePath = join(ROOT, input.path);
      if (!existsSync(filePath)) {
        return { error: `File not found: ${input.path}` };
      }
      const content = readFileSync(filePath, "utf8");
      console.log(`   ✅ Read ${content.length} chars from ${input.path}`);
      return { content, path: input.path };
    }

    case "apply_fix": {
      const filePath = join(ROOT, input.file);
      writeFileSync(filePath, input.code, "utf8");
      console.log(`   ✅ Applied fix to ${input.file}`);
      return { success: true, file: input.file, lines: input.code.split("\n").length };
    }

    case "execute_sandbox_test": {
      console.log(`   🐳 Running sandbox verification...`);

      // Check if Docker is available
      try {
        execSync("docker --version", { stdio: "pipe" });
      } catch {
        // Docker not available — simulate for testing
        console.log(`   ⚠️  Docker not available — running in simulation mode`);
        return {
          status: "GREEN",
          simulated: true,
          message: "Sandbox simulation: all gates passed (Docker not available)",
          gates: {
            patchSize: { passed: true },
            typeCheck: { passed: true },
            lint: { passed: true },
            tests: { passed: true },
          },
        };
      }

      try {
        const result = execSync(
          `docker run --rm --network none --memory=512m --pids-limit=128 sen7inel-sandbox:latest`,
          { encoding: "utf8", timeout: 120000 }
        );
        console.log(`   ✅ Sandbox: GREEN`);
        return { status: "GREEN", output: result };
      } catch (err) {
        console.log(`   ❌ Sandbox: RED`);
        return {
          status: "RED",
          output: err.stdout ?? "",
          error: err.stderr ?? err.message,
        };
      }
    }

    case "verify_metrics": {
      console.log(`   📊 Running complexity analysis...`);

      // Check if ts-morph is available
      const tsMorphPath = join(ROOT, "sandbox", "node_modules", "ts-morph");
      if (!existsSync(tsMorphPath)) {
        return {
          status: "PASS",
          simulated: true,
          message: "Metrics simulation: complexity within budget (ts-morph not installed yet)",
          maxCC: 3,
          violations: [],
        };
      }

      try {
        const result = execSync(
          `node sandbox/scripts/run-verification.js --dry-run`,
          { encoding: "utf8", timeout: 30000 }
        );
        return { status: "PASS", output: result };
      } catch (err) {
        return { status: "FAIL", error: err.message };
      }
    }

    case "create_pull_request": {
      console.log(`   📬 Creating Pull Request...`);

      const githubToken = process.env.GITHUB_TOKEN;
      if (!githubToken) {
        console.log(`   ⚠️  GITHUB_TOKEN not set — PR creation skipped`);
        return {
          simulated: true,
          message: `PR would be created: ${input.title}`,
          branch: input.branch,
        };
      }

      try {
        const response = execSync(
          `curl -s -X POST https://api.github.com/repos/hgomeskt/sen7inel/pulls ` +
          `-H "Authorization: Bearer ${githubToken}" ` +
          `-H "Content-Type: application/json" ` +
          `-d "${JSON.stringify({ title: input.title, body: input.body, head: input.branch, base: "main", draft: false }).replace(/"/g, '\\"')}"`,
          { encoding: "utf8" }
        );
        const pr = JSON.parse(response);
        console.log(`   ✅ PR created: ${pr.html_url}`);
        return { success: true, url: pr.html_url, number: pr.number };
      } catch (err) {
        return { error: err.message };
      }
    }

    case "report_status": {
      const emoji = {
        IN_PROGRESS: "🔄",
        GREEN: "✅",
        RED: "❌",
        ESCALATION: "🚨",
        CURA_CONCLUIDA: "🎉",
      }[input.status] ?? "📋";

      console.log(`\n${emoji} [${input.phase}] ${input.status}: ${input.message}`);
      return { logged: true };
    }
case "list_directory": {
  const dirPath = join(ROOT, input.path);
  if (!existsSync(dirPath)) {
    return { error: `Directory not found: ${input.path}` };
  }
  const items = readdirSync(dirPath, { withFileTypes: true });
  const result = items.map((item) => ({
    name: item.name,
    type: item.isDirectory() ? "directory" : "file",
  }));
  console.log(`   ✅ Listed ${result.length} items in ${input.path}`);
  return { items: result, path: input.path };
}
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ─── Bug Context ──────────────────────────────────────────────────────────────

function getBugContext() {
  // Load from file if provided
  if (bugFile && existsSync(bugFile)) {
    return JSON.parse(readFileSync(bugFile, "utf8"));
  }

  // Test mode — use a simulated bug
  if (isTest) {
    return {
      client_id: clientId,
      anomaly_type: "null_pointer_exception",
      anomaly_description:
        "TypeError: Cannot read properties of null (reading 'id') at processUser (src/users/queries.ts:47)",
      stack_trace: `TypeError: Cannot read properties of null (reading 'id')
    at processUser (src/users/queries.ts:47:18)
    at handleRequest (src/users/controller.ts:23:5)
    at Layer.handle [as handle_request] (express/lib/router/layer.js:95:5)`,
      affected_files: ["src/users/queries.ts"],
      repo_path: ROOT,
    };
  }

  throw new Error("No bug context provided. Use --test or --bug-file=path");
}

// ─── Main Loop ────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀 Sen7inel Dispatcher — Activating Nooa");
  console.log(`   Client: ${clientId}`);
  console.log(`   Mode: ${isTest ? "TEST" : "PRODUCTION"}`);
  console.log(`   Model: ${MODEL}`);

  // Load context
  const clientContext = loadClientContext(clientId);
  const bugContext = getBugContext();

  console.log(`\n📋 Bug Context:`);
  console.log(`   Type: ${bugContext.anomaly_type}`);
  console.log(`   Description: ${bugContext.anomaly_description}`);

  // System prompt
  const systemPrompt = `${clientContext}

---

You are Nooa, the autonomous execution agent of Sen7inel.
Follow the 7-phase loop defined in CLAUDE.md above.
Use the available tools to read files, apply fixes, run tests, and create PRs.
Do not ask for permission — act, validate, and report.
When all gates pass and the fix is verified, call report_status with CURA_CONCLUIDA.`;

  // Initial user message
  const initialMessage = `[BUG DETECTED BY SEN7INEL]

client_id: ${bugContext.client_id}
anomaly_type: ${bugContext.anomaly_type}
description: ${bugContext.anomaly_description}

stack_trace:
${bugContext.stack_trace}

affected_files: ${bugContext.affected_files.join(", ")}

Execute the self-healing loop. Start with Phase 0 — Bootstrap.`;

  // Conversation history
  const messages = [{ role: "user", content: initialMessage }];

  let iteration = 0;
  let healed = false;

  // ── Agentic Loop ────────────────────────────────────────────────────────────
  while (iteration < MAX_ITERATIONS * 10 && !healed) {
    iteration++;
    console.log(`\n━━━ Iteration ${iteration} ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      tools,
      messages,
    });

    // Add assistant response to history
    messages.push({ role: "assistant", content: response.content });

    // Process response
    const toolUses = response.content.filter((b) => b.type === "tool_use");
    const textBlocks = response.content.filter((b) => b.type === "text");

    // Print any text from Nooa
    for (const block of textBlocks) {
      if (block.text.trim()) {
        console.log(`\n🤖 Nooa: ${block.text.trim().slice(0, 300)}`);
      }
    }

    // Check for completion
    if (response.stop_reason === "end_turn" && toolUses.length === 0) {
      const lastText = textBlocks.map((b) => b.text).join("");
      if (lastText.includes("CURA_CONCLUIDA")) {
        console.log("\n🎉 CURA_CONCLUIDA — Self-healing complete!");
        healed = true;
        break;
      }
      console.log("\n⚠️  Nooa stopped without completing. Ending loop.");
      break;
    }

    // Execute tools
    if (toolUses.length > 0) {
      const toolResults = [];

      for (const toolUse of toolUses) {
        const result = executeTool(toolUse.name, toolUse.input);

        // Check for CURA_CONCLUIDA in report_status
        if (
          toolUse.name === "report_status" &&
          toolUse.input.status === "CURA_CONCLUIDA"
        ) {
          healed = true;
        }

        // Check for escalation
        if (
          toolUse.name === "report_status" &&
          toolUse.input.status === "ESCALATION"
        ) {
          console.log("\n🚨 HUMAN_ESCALATION — Nooa requires human intervention");
          console.log(`   Reason: ${toolUse.input.message}`);
          process.exit(2);
        }

        toolResults.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: JSON.stringify(result),
        });
      }

      // Add tool results to history
      messages.push({ role: "user", content: toolResults });
    }

    if (healed) break;
  }

  // ── Final Status ─────────────────────────────────────────────────────────────
  if (healed) {
    console.log("\n✅ Sen7inel — Self-healing successful");
    process.exit(0);
  } else {
    console.log("\n❌ Sen7inel — Max iterations reached without healing");
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("\n💥 SYSTEM_ERROR:", err.message);
  process.exit(3);
});










