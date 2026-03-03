skill: infrastructure/n8n-workflow-rules
version: "1.0"
enforced_by: [workflow-linter, manual-review]
applies_to: [n8n-generation, workflow-modification]
n8n Workflow — Engineering Rules
Idempotency (Non-Negotiable)
Every workflow node must be idempotent. Running it twice must produce
the same result as running it once.
Patch application: check if already applied before applying.
PR creation: check if PR already exists for this patch hash.
DB inserts: use INSERT ... ON CONFLICT DO NOTHING or upsert.
Error Handling Pattern
Every workflow must have:

Error branch on every external API call (Claude, Gemini, GitHub)
Retry logic: max 3 retries, exponential backoff (1s, 2s, 4s)
Dead letter: failed items go to audit_log table with full context
Human escalation: Slack/WhatsApp alert after max retries exhausted

[API Node] → on_error → [Retry Node (max:3, backoff:exponential)]
                              → on_exhausted → [Log to Supabase]
                                                    → [Alert Human]
Node Naming Convention
{action}_{subject}_{detail}
Examples:
  generate_patch_claude      ✅
  claude                     ❌ (too vague)
  review_patch_gemini        ✅
  check_complexity_tsmorph   ✅
Data Passing Between Nodes

Pass only what the next node needs. No "pass everything" patterns.
Sensitive data (API keys, tokens): NEVER in workflow data payload.
Use n8n Credentials for all secrets.
Max payload size between nodes: 500KB. Larger = store in Supabase, pass ID.

Execution Context

Workflows triggered by webhooks must validate X-Sen7inel-Signature header.
All executions must log execution_id, client_id, started_at to Supabase.
Execution timeout: 10 minutes max. If longer, decompose the workflow.