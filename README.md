# Sen7inel — Self-Healing Infrastructure Engine

> **Tooling enforces correctness. Not model inference.**

Sen7inel is an autonomous self-correction engine for growing infrastructure. When an anomaly is detected in production, the system generates an AI-powered fix patch, deterministically validates it in an isolated sandbox, and opens a Pull Request — without human intervention.

**No patch reaches GitHub without GREEN test status.**

---

## How It Works
```
Anomaly Detected
  → Load client context (.agent/skills/ + client-profiles/)
  → Claude 3.5 Sonnet generates the minimal required patch (temp: 0.1)
  → GATE 1: Static check — ESLint + ts-morph complexity analysis
  → GATE 2: Gemini 1.5 Pro adversarial review (temp: 0.0, binary response)
  → GATE 3: Ephemeral Docker sandbox applies patch and runs test suite
  → Pull Request automatically created with full audit context
```

Each gate can reject the patch. If rejected, the system refines and retries (maximum 3 iterations). If not approved after 3 attempts, it escalates to human review via Slack/WhatsApp.

---

## Stack

| Component | Technology | Role |
|---|---|---|
| Orchestrator | n8n (Vultr VPS) | Coordinates the entire pipeline |
| Generator | Claude 3.5 Sonnet `temp: 0.1` | Generates the fix patch |
| Reviewer | Gemini 1.5 Pro `temp: 0.0` | Binary adversarial review |
| Verifier | ts-morph + Docker sandbox | Complexity analysis + test execution |
| Database | PostgreSQL + Supabase | Immutable audit log |
| Proxy | Nginx + Certbot | SSL and routing |

---

## Repository Structure
```
sen7inel/
├── .agent/
│   └── skills/                        # Generation constraints — Git versioned
│       ├── security/
│       │   ├── flat-architecture.md
│       │   └── layered-architecture.md
│       ├── infrastructure/
│       │   └── n8n-workflow-rules.md
│       └── meta/
│           ├── complexity-budget.md   # LM-CC max: 10 per function
│           └── test-contract.md       # Definition of GREEN
├── client-profiles/
│   └── example-client/
│       ├── STACK.md                   # Versions, test commands, runtime
│       └── FORBIDDEN.md              # What to NEVER generate for this client
├── sandbox/
│   ├── Dockerfile
│   ├── src/verifier.ts               # System core — AST analysis + test runner
│   └── scripts/
│       ├── execute-fix.js            # Bridge: n8n → Docker → result
│       └── run-verification.js
├── n8n/workflows/
│   ├── sen7inel-pipeline.workflow.json
│   └── WORKFLOW-GUIDE.md
├── prompts/
│   ├── generator-claude-system-prompt.md
│   └── reviewer-gemini-system-prompt.md
├── infra/init-db.sql
├── docker-compose.yml
├── .env.example
└── .gitignore
```

---

## Quick Start on Vultr VPS

### Prerequisites
- VPS Ubuntu 22.04+ (minimum 4 vCPU, 8GB RAM)
- Docker + Docker Compose installed
- Domain pointing to the VPS IP address

### 1. Clone and configure
```bash
cd /opt
git clone https://github.com/hgomeskt/sen7inel.git
cd sen7inel
cp .env.example .env
nano .env  # Fill ALL values before proceeding
```

### 2. Build the sandbox image
```bash
docker build -t sen7inel-sandbox:latest ./sandbox
```

### 3. Start core services
```bash
docker compose up -d
```

### 4. Verify services are running
```bash
docker compose ps
# n8n, postgres and nginx should show as "running"
```

### 5. Access n8n
```
https://YOUR-DOMAIN
```

### 6. Import the workflow

In n8n: **Workflows → Import from File** → select `n8n/workflows/sen7inel-pipeline.workflow.json`

---

## Environment Variables

| Variable | Description |
|---|---|
| `N8N_USER` | n8n access username |
| `N8N_PASSWORD` | n8n password (min. 16 characters) |
| `N8N_HOST` | VPS domain (e.g. `sen7inel.yourdomain.com`) |
| `N8N_ENCRYPTION_KEY` | Generate with `openssl rand -hex 32` |
| `POSTGRES_USER` | Database username |
| `POSTGRES_PASSWORD` | Database password (min. 16 characters) |
| `SEN7INEL_WEBHOOK_SECRET` | Generate with `openssl rand -hex 32` |

> API keys (Anthropic, Google AI, GitHub) are configured in n8n under **Settings → Credentials** — never in `.env`.

---

## Non-Negotiables

1. **No patch reaches GitHub without `GREEN` status** — tests must pass in the isolated sandbox
2. **The reviewer never sees the generator's reasoning** — only the diff and constraints, preventing cross-model sycophancy
3. **LM-CC maximum: 10** per function — cyclomatic complexity above this is rejected at Gate 1
4. **Patches limited to 150 lines** — above this, the orchestrator automatically decomposes into sub-patches
5. **Every pipeline decision is immutably logged** in Supabase — full traceability
6. **Skills are verifiable contracts** — if a rule cannot be checked by a tool, it does not exist

---

## Verifier Exit Codes

| Code | Status | Action |
|---|---|---|
| `0` | `GREEN` | Creates the Pull Request |
| `1` | `RED_TEST / TYPE / LINT` | Refines patch and retries |
| `2` | `COMPLEXITY_VIOLATION` | Flattens logic and retries |
| `2` | `PATCH_TOO_LARGE` | Decomposes into sub-patches |
| `3` | `SYSTEM_ERROR` | Immediate human escalation |

---

## Adding a Client
```bash
# 1. Copy the template
cp -r client-profiles/example-client client-profiles/CLIENT-NAME

# 2. Edit with client's real stack and restrictions
nano client-profiles/CLIENT-NAME/STACK.md
nano client-profiles/CLIENT-NAME/FORBIDDEN.md

# 3. Commit and push — pipeline picks up changes automatically
git add . && git commit -m "feat: add client CLIENT-NAME" && git push
```

---

## Roadmap

- [x] Milestone 1 — Foundation: structure, Docker, n8n, sandbox
- [ ] Milestone 2 — AI Core: Claude + Gemini integration + vector store
- [ ] Milestone 3 — Verification: ephemeral sandbox + TDD enforcement
- [ ] Milestone 4 — Production: GitHub App + alerts + SLA dashboard

---

## Philosophy

Sen7inel is built on the **CLI-First** principle — agents perform best with text-based interfaces, structured outputs, and deterministic feedback loops. The AI generates, the tools verify. Never the other way around.

Inspired by the **"AI-Assisted Development — Velocity without Theatre"** workflow by Thiago Butignon.

---

## License

Proprietary — Hernane Gomes & Thiago Butignon · Insightloop Consultoria de TI © 2025
```

Depois **Ctrl+S** e no terminal:
```
git add README.md
git commit -m "docs: fix README markdown formatting"
git push