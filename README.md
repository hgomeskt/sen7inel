Sen7inel — Self-Healing Infrastructure Engine

Tooling enforces correctness. Not model inference.

Sen7inel is an autonomous self-correction engine for growing infrastructure. When an anomaly is detected in production, the system generates an AI-powered fix patch, deterministically validates it in an isolated sandbox, and opens a Pull Request — without human intervention.
No patch reaches GitHub without GREEN test status.

How It Works
Anomaly Detected
  → Load client context (.agent/skills/ + client-profiles/)
  → Claude 3.5 Sonnet generates the minimal required patch (temp: 0.1)
  → GATE 1: Static check — ESLint + ts-morph complexity analysis
  → GATE 2: Gemini 1.5 Pro adversarial review (temp: 0.0, binary response)
  → GATE 3: Ephemeral Docker sandbox applies patch and runs test suite
  → Pull Request automatically created with full audit context
Each gate can reject the patch. If rejected, the system refines and retries (maximum 3 iterations). If not approved after 3 attempts, it escalates to human review via Slack/WhatsApp.

Stack
ComponentTechnologyRoleOrchestratorn8n (Vultr VPS)Coordinates the entire pipelineGeneratorClaude 3.5 Sonnet temp: 0.1Generates the fix patchReviewerGemini 1.5 Pro temp: 0.0Binary adversarial reviewVerifierts-morph + Docker sandboxComplexity analysis + test executionDatabasePostgreSQL + SupabaseImmutable audit logProxyNginx + CertbotSSL and routing

Repository Structure
sen7inel/
├── .agent/
│   └── skills/                        # Generation constraints — Git versioned
│       ├── security/
│       │   ├── flat-architecture.md   # Rules for flat architecture clients
│       │   └── layered-architecture.md
│       ├── infrastructure/
│       │   └── n8n-workflow-rules.md
│       └── meta/
│           ├── complexity-budget.md   # LM-CC max: 10 per function
│           └── test-contract.md       # Definition of GREEN
│
├── client-profiles/
│   └── example-client/
│       ├── STACK.md                   # Versions, test commands, runtime
│       └── FORBIDDEN.md              # What to NEVER generate for this client
│
├── sandbox/
│   ├── Dockerfile                     # Ephemeral verification container
│   ├── package.json
│   ├── tsconfig.sandbox.json
│   ├── src/
│   │   └── verifier.ts               # System core — AST analysis + test runner
│   └── scripts/
│       ├── execute-fix.js            # Bridge: n8n → Docker → result
│       └── run-verification.js       # Manual runner for local testing
│
├── n8n/
│   └── workflows/
│       ├── sen7inel-pipeline.workflow.json  # Import directly into n8n
│       └── WORKFLOW-GUIDE.md               # Node-by-node configuration guide
│
├── prompts/
│   ├── generator-claude-system-prompt.md   # Generator model system prompt
│   └── reviewer-gemini-system-prompt.md    # Adversarial reviewer system prompt
│
├── infra/
│   └── init-db.sql                  # Audit log schema
│
├── docker-compose.yml
├── .env.example
└── .gitignore

Quick Start on Vultr VPS
Prerequisites

VPS Ubuntu 22.04+ (minimum 4 vCPU, 8GB RAM)
Docker + Docker Compose installed
Domain pointing to the VPS IP address

1. Clone and configure
bashcd /opt
git clone https://github.com/hgomeskt/sen7inel.git
cd sen7inel
cp .env.example .env
nano .env  # Fill ALL values before proceeding
2. Build the sandbox image
bashdocker build -t sen7inel-sandbox:latest ./sandbox
3. Start core services
bashdocker compose up -d
4. Verify services are running
bashdocker compose ps
# n8n, postgres and nginx should show as "running"
5. Access n8n
https://YOUR-DOMAIN
Login with the credentials defined in .env.
6. Import the workflow
In n8n: Workflows → Import from File → select n8n/workflows/sen7inel-pipeline.workflow.json

Environment Variables
Copy .env.example to .env and fill in:
VariableDescriptionN8N_USERn8n access usernameN8N_PASSWORDn8n password (min. 16 characters)N8N_HOSTVPS domain (e.g. sen7inel.yourdomain.com)N8N_ENCRYPTION_KEYEncryption key — generate with openssl rand -hex 32POSTGRES_USERDatabase usernamePOSTGRES_PASSWORDDatabase password (min. 16 characters)SEN7INEL_WEBHOOK_SECRETWebhook secret — generate with openssl rand -hex 32
API keys (Anthropic, Google AI, GitHub) are configured directly in n8n under Settings → Credentials — never in .env.

Non-Negotiables

No patch reaches GitHub without GREEN status — tests must pass in the isolated sandbox
The reviewer never sees the generator's reasoning — receives only the diff and constraints, preventing cross-model sycophancy
LM-CC maximum: 10 per function — cyclomatic complexity above this is rejected at Gate 1
Patches limited to 150 lines — above this, the orchestrator automatically decomposes into sub-patches
Every pipeline decision is immutably logged in Supabase — full traceability
Skills are verifiable contracts — if a rule cannot be checked by a tool, it does not exist


Verifier Exit Codes
CodeStatusAction0GREENCreates the Pull Request1RED_TEST / TYPE / LINTRefines patch and retries2COMPLEXITY_VIOLATIONFlattens logic and retries2PATCH_TOO_LARGEDecomposes into sub-patches3SYSTEM_ERRORImmediate human escalation

Adding a Client

Copy the template structure:

bashcp -r client-profiles/example-client client-profiles/CLIENT-NAME

Edit STACK.md with the client's actual versions and test commands
Edit FORBIDDEN.md with the client's specific restrictions
Commit and push — changes are automatically picked up by the pipeline


Roadmap

 Milestone 1 — Foundation: structure, Docker, n8n, sandbox
 Milestone 2 — AI Core: Claude + Gemini integration + vector store
 Milestone 3 — Verification: ephemeral sandbox + TDD enforcement
 Milestone 4 — Production: GitHub App + alerts + SLA dashboard


Philosophy
Sen7inel is built on the CLI-First principle — agents perform best with text-based interfaces, structured outputs, and deterministic feedback loops. The AI generates, the tools verify. Never the other way around.
Inspired by the "AI-Assisted Development — Velocity without Theatre" workflow by Thiago Butignon.

License
Proprietary — Hernane Gomes & Thiago Butignon · Insightloop Consultoria de TI © 2025