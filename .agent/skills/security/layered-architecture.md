skill: security/layered-architecture
version: "1.0"
enforced_by: [eslint, ts-morph, dependency-check]
applies_to: [patch-generation, code-review]
Layered Architecture — Security Constraints
Layer Contract
HTTP Layer      → validates input, no business logic
Service Layer   → business logic, no direct DB access
Repository Layer → DB only, no business logic
Domain Layer    → types and interfaces, zero imports from other layers
Violation = patch rejected at Gate 1.
Dependency Direction (enforced_by: dependency-check)
HTTP → Service → Repository → Domain
                           ↑
                    Only direction allowed
Cross-layer imports (e.g., HTTP importing Repository directly) = REJECT.
Hard Rules
Interfaces First

Every service must implement an interface defined in /domain/interfaces/.
No concrete class instantiation in HTTP layer — use injected interfaces.
Constructor injection only. Property injection = FORBIDDEN.

Error Handling

Services throw typed domain errors (UserNotFoundError, ValidationError).
HTTP layer catches domain errors and maps to HTTP status codes.
Never expose raw DB errors to HTTP responses.

typescript// ✅ CORRECT — Service throws typed error
if (!user) throw new UserNotFoundError(userId);

// ❌ FORBIDDEN — Leaking DB error
res.json({ error: dbError.message });
Transactions

Multi-step DB operations MUST use transactions.
Transaction scope belongs in Repository layer only.
Services orchestrate repositories, never manage DB transactions directly.

Complexity Budget

Max cyclomatic complexity per function: 10
Service methods: max 30 lines
Repository methods: max 20 lines (just DB, nothing else)