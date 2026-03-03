skill: security/flat-architecture
version: "1.0"
enforced_by: [eslint, ts-morph, audit]
applies_to: [patch-generation, code-review]
Flat Architecture — Security Constraints
What "Flat" Means Here
No abstraction layers unless proven necessary. Direct data access,
minimal indirection, zero "enterprise pattern" theatre.
Hard Rules (enforced_by: ts-morph)
Database

Raw parameterized queries only. No ORM, no query builder.
All DB calls must use ? or $1 placeholders — never string interpolation.
Connection pool max: 10. Never create connections inside loops.

typescript// ✅ CORRECT
const result = await db.query('SELECT * FROM users WHERE id = $1', [userId]);

// ❌ FORBIDDEN — string interpolation
const result = await db.query(`SELECT * FROM users WHERE id = ${userId}`);

// ❌ FORBIDDEN — ORM
const user = await User.findById(userId);
Authentication

JWT validation must use jsonwebtoken.verify() with explicit algorithm.
Never use algorithm: 'none'. If not specified, REJECT the patch.
Session tokens: minimum 32 bytes entropy, crypto.randomBytes(32).

Secrets

Zero hardcoded credentials. All secrets via process.env.
process.env.X || 'fallback' is FORBIDDEN if X is a secret.
Required env vars must be validated at startup (see src/config.ts pattern).

Complexity Budget

Max cyclomatic complexity per function: 10
Max function length: 40 lines
No nested callbacks deeper than 2 levels — use async/await

What NOT to Generate

Repository pattern (this is flat architecture)
Abstract factory / dependency injection containers
Event sourcing / CQRS (unless explicitly in client STACK.md)
Middleware chains longer than 3 functions