client_id: "example-client"
enforced_by: [system-prompt-injection, ts-morph, reviewer]
severity: HARD_BLOCK                   # Any violation = immediate REJECT, no refinement
last_updated: "2025-01-01"
FORBIDDEN.md — Example Client

This file is injected at the TOP of every system prompt sent to the generator.
These are absolute constraints. If the model violates any of these,
the patch is REJECTED at Gate 1 with code FORBIDDEN_PATTERN.
No refinement loop. No second chance. Escalate to human.


🚫 NEVER Generate — Security
FORBIDDEN: Any form of eval(), new Function(), or dynamic code execution
FORBIDDEN: SQL string concatenation (use parameterized queries ONLY)
FORBIDDEN: process.env.X || 'hardcoded_fallback' where X is a secret
FORBIDDEN: console.log with sensitive data (passwords, tokens, PII)
FORBIDDEN: JWT algorithm: 'none' or algorithm not explicitly specified
FORBIDDEN: HTTP endpoints without authentication (except /health, /metrics)
FORBIDDEN: Returning stack traces to HTTP clients (production mode)
🚫 NEVER Generate — Architecture (Client: Flat)
FORBIDDEN: ORM usage (TypeORM, Prisma, Sequelize, Knex)
FORBIDDEN: Repository pattern or abstract data access layers
FORBIDDEN: Dependency injection containers (tsyringe, inversify, etc.)
FORBIDDEN: Decorator-based frameworks (@Injectable, @Controller, etc.)
FORBIDDEN: Event sourcing or CQRS patterns
FORBIDDEN: Importing from more than 2 levels of indirection
🚫 NEVER Generate — Code Quality
FORBIDDEN: any TypeScript type (defeats the purpose of TypeScript)
FORBIDDEN: @ts-ignore or @ts-expect-error comments
FORBIDDEN: Disabling ESLint rules inline (// eslint-disable)
FORBIDDEN: TODO/FIXME comments in generated patches (fix it or don't)
FORBIDDEN: test.skip() or it.skip() (all tests must run)
FORBIDDEN: Cyclomatic complexity > 10 in any single function
FORBIDDEN: Functions longer than 40 lines
🚫 NEVER Modify — Protected Files
FORBIDDEN_MODIFICATIONS:
  - package.json (version changes require separate approved PR)
  - tsconfig.json
  - .env, .env.*, any environment files
  - docker-compose.yml
  - GitHub Actions workflows (.github/)
  - This file (FORBIDDEN.md)
  - STACK.md
🚫 NEVER Remove — Required Patterns
REQUIRED_PRESENT:
  - Input validation on all HTTP endpoints (zod schema)
  - Error handling in all async functions (try/catch or .catch())
  - Request logging middleware on all routes
  - Health check endpoint at GET /health

How Violations Are Handled
Violation TypeActionSecurity violationREJECT + Human alert (immediate)Architecture violationREJECT + refinement blockedCode quality violationREJECT + return to generatorProtected file modifiedREJECT + Human alert (immediate)