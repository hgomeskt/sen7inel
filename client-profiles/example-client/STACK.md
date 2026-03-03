client_id: "example-client"
architecture: "flat"                    # flat | layered
last_updated: "2025-01-01"
updated_by: "sen7inel-onboarding"
STACK.md — Client: Example Client

This file is the single source of truth for this client's technical stack.
The AI generator reads this before generating any code.
Changes require a PR review — no silent updates.

Runtime
yamllanguage: typescript
node_version: "20.x"          # FIXED. Do not upgrade without client approval.
runtime: "node"
package_manager: "npm"        # Not yarn, not pnpm — npm.
tsconfig: "tsconfig.json"     # Path from repo root
Framework & Libraries
yamlhttp_framework: "express@4.18.2"     # Version pinned. Do not suggest upgrades.
database_client: "pg@8.11.0"         # Raw queries only (flat architecture)
validation: "zod@3.22.0"
testing: "jest@29.7.0"
test_types: "@types/jest@29.5.0"
Commands
yaml# These are the ONLY valid test commands. Do not infer alternatives.
type_check: "npx tsc --noEmit"
lint: "npx eslint src/ --max-warnings 0"
test: "npx jest --runInBand --forceExit"
test_coverage: "npx jest --coverage --coverageThreshold '{\"global\":{\"lines\":80}}'"
test_timeout_seconds: 90
build: "npx tsc -p tsconfig.build.json"
File Structure
yamlsrc_root: "./src"
entry_point: "./src/index.ts"
test_pattern: "**/*.test.ts"
test_directory: "./src/__tests__"
Environment Variables Required
yamlrequired_env_vars:
  - DATABASE_URL          # postgres://user:pass@host:5432/dbname
  - JWT_SECRET            # min 32 chars
  - NODE_ENV              # development | production | test
  - PORT                  # default: 3000
Deployment Context
yamlhosting: "vultr-vps"
os: "ubuntu-22.04"
container: "docker"
ci: "github-actions"
branch_strategy: "trunk-based"   # main is always deployable
pr_required: true                 # No direct push to main
Constraints for Code Generation

Max response payload: 1MB (enforce at HTTP layer)
All dates in UTC, stored as ISO 8601
IDs: UUID v4 only (no auto-increment integers)
Logging: console.log only (no external logging library)