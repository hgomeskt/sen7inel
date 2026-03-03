# Sen7inel — n8n Configuration Guide
# Complete Pipeline: Error → Patch → Verification → PR

---

## Workflow Overview
```
[Webhook Trigger]
      ↓
[Load Client Context]
      ↓
[Build Generator Prompt]
      ↓
[Claude 3.5 Sonnet — Generate Patch]        ← iteration counter here
      ↓
[Gemini Adversarial Review]
      ↓ APPROVE         ↓ REJECT (max 2x → Human Escalation)
[Execute Fix — Sandbox]
      ↓
[IF: isGreen?] ──────────────────────────────────→ [Create Pull Request]
      ↓ NO
[IF: needsComplexityFlatten?]
      ↓ YES                      ↓ NO (needsRefinement)
[Build Flatten Prompt]      [Build Refinement Prompt]
      ↓                          ↓
      └──────────────────────────┘
      ↓
[IF: iteration < 3?]
      ↓ YES              ↓ NO (max retries)
[Back to Claude]    [Human Escalation Alert]
```

---

## Node 1 — Webhook Trigger

**Type**: `Webhook`
```
Method:    POST
Path:      /sen7inel/fix
Auth:      Header Auth
  Header:  X-Sen7inel-Signature
  Value:   {{ $env.SEN7INEL_WEBHOOK_SECRET }}
Response:  Immediately (async processing)
```

**Expected body (JSON):**
```json
{
  "client_id": "example-client",
  "anomaly_type": "null_pointer_exception",
  "anomaly_description": "TypeError: Cannot read properties of null at users.ts:47",
  "stack_trace": "...",
  "affected_files": ["src/users/queries.ts"],
  "repo_path": "/opt/sen7inel/repos/example-client"
}
```

---

## Node 2 — Load Client Context

**Type**: `Execute Command`
```
Command:
cat /opt/sen7inel/client-profiles/{{ $json.client_id }}/FORBIDDEN.md
echo "---STACK---"
cat /opt/sen7inel/client-profiles/{{ $json.client_id }}/STACK.md
echo "---SKILLS---"
cat /opt/sen7inel/.agent/skills/security/flat-architecture.md
cat /opt/sen7inel/.agent/skills/meta/complexity-budget.md
```

**Set Variables** (Code node after):
```javascript
// Capture output and initialize iteration counter
return [{
  json: {
    ...items[0].json,
    client_context: items[0].json.stdout,
    iteration: 1,
    max_iterations: 3,
    patch_hash: require('crypto')
      .createHash('sha256')
      .update(items[0].json.anomaly_description + Date.now())
      .digest('hex')
      .slice(0, 16),
  }
}];
```

---

## Node 3 — Build Generator Prompt

**Type**: `Code (JavaScript)`
```javascript
const item = items[0].json;

// Build full prompt — FORBIDDEN first, always
const systemPrompt = `
${item.client_context}

---

${require('fs').readFileSync('/opt/sen7inel/prompts/generator-claude-system-prompt.md', 'utf8')}
`.trim();

// If retry, add previous error context
let userMessage = `
[ANOMALY]
Type: ${item.anomaly_type}
Description: ${item.anomaly_description}
Stack Trace:
${item.stack_trace ?? 'Not provided'}

[AFFECTED_CODE]
${item.affected_files.map(f => `File: ${f}`).join('\n')}
`.trim();

// Add retry context if it exists
if (item.refinementContext) {
  userMessage = `
[PREVIOUS_ATTEMPT_FAILED]
Iteration: ${item.iteration - 1}
${item.refinementContext.instruction}

Error Output:
${item.refinementContext.errorOutput}

[ORIGINAL_ANOMALY]
${userMessage}
`.trim();
}

// Add flatten instruction if complexity retry
if (item.flattenRequest) {
  userMessage = `
[REFACTOR_REQUIRED — DO NOT FIX NEW BUGS, ONLY FLATTEN COMPLEXITY]
${item.flattenRequest.instruction}

Functions to refactor:
${item.flattenRequest.violations.map(v =>
  `- ${v.name} in ${v.filePath}:${v.line} (CC=${v.cyclomaticComplexity}, lines=${v.lineCount})`
).join('\n')}

Max allowed CC: ${item.flattenRequest.maxAllowed}

[ORIGINAL_ANOMALY — Context only, already partially fixed]
${userMessage}
`.trim();
}

return [{
  json: {
    ...item,
    generator_system_prompt: systemPrompt,
    generator_user_message: userMessage,
  }
}];
```

---

## Node 4 — Claude 3.5 Sonnet (Patch Generator)

**Type**: `HTTP Request`
```
Method:  POST
URL:     https://api.anthropic.com/v1/messages

Headers:
  x-api-key:         {{ $credentials.anthropicApi.apiKey }}
  anthropic-version: 2023-06-01
  content-type:      application/json

Body (JSON):
{
  "model": "claude-sonnet-4-20250514",
  "max_tokens": 4096,
  "temperature": 0.1,
  "system": "{{ $json.generator_system_prompt }}",
  "messages": [
    {
      "role": "user",
      "content": "{{ $json.generator_user_message }}"
    }
  ]
}
```

**Code node after** (extract patch from response):
```javascript
const response = items[0].json;
const content = response.content?.[0]?.text ?? '';

// Detect if Claude requested decomposition
const isDecompose = content.trim().startsWith('DECOMPOSE');

return [{
  json: {
    ...items[0].json,
    patch_content: isDecompose ? '' : content,
    decompose_requested: isDecompose,
    decompose_content: isDecompose ? content : null,
    claude_raw_response: content.slice(0, 500), // for audit log
  }
}];
```

---

## Node 5 — Gemini Adversarial Review

**Type**: `HTTP Request`
```
Method:  POST
URL:     https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent

Headers:
  x-goog-api-key: {{ $credentials.googleAiApi.apiKey }}
  content-type:   application/json

Body (JSON):
{
  "system_instruction": {
    "parts": [{
      "text": "{{ $json.reviewer_system_prompt }}"
    }]
  },
  "contents": [{
    "role": "user",
    "parts": [{
      "text": "[DIFF]\n{{ $json.patch_content }}\n\n[CONSTRAINTS]\n{{ $json.client_context }}"
    }]
  }],
  "generationConfig": {
    "temperature": 0.0,
    "maxOutputTokens": 256,
    "stopSequences": ["\n\n"]
  }
}
```

**Code node after** (parse binary response):
```javascript
const responseText = items[0].json
  .candidates?.[0]?.content?.parts?.[0]?.text ?? '';

const isApproved = responseText.trim().startsWith('APPROVE');
let rejectReason = null;
let rejectCode = null;
let rejectSeverity = null;

if (!isApproved) {
  const codeMatch = responseText.match(/CODE:\s*(.+)/);
  const reasonMatch = responseText.match(/REASON:\s*(.+)/);
  const severityMatch = responseText.match(/SEVERITY:\s*(.+)/);
  rejectCode = codeMatch?.[1]?.trim() ?? 'UNKNOWN';
  rejectReason = reasonMatch?.[1]?.trim() ?? responseText.slice(0, 120);
  rejectSeverity = severityMatch?.[1]?.trim() ?? 'UNKNOWN';
}

return [{
  json: {
    ...items[0].json,
    reviewer_approved: isApproved,
    reviewer_response: responseText,
    reviewer_reject_code: rejectCode,
    reviewer_reject_reason: rejectReason,
    reviewer_reject_severity: rejectSeverity,
  }
}];
```

---

## Node 6 — IF: Reviewer Approved?

**Type**: `IF`
```
Condition:
  Value 1:   {{ $json.reviewer_approved }}
  Operation: Equal
  Value 2:   true (Boolean)

True  → Node 7 (Execute Fix)
False → Node 6b (IF: Reviewer Retry?)
```

### Node 6b — IF: Reviewer Retry Allowed?
```
Condition:
  Value 1:   {{ $json.iteration }}
  Operation: Smaller Than
  Value 2:   3

True  → Back to Node 3 (Build Generator Prompt) with reject context
False → HUMAN ESCALATION node
```

**Set node before returning** (add rejection context):
```javascript
return [{
  json: {
    ...items[0].json,
    iteration: items[0].json.iteration + 1,
    refinementContext: {
      failedGate: 'reviewer',
      status: 'REVIEWER_REJECTED',
      errorOutput: items[0].json.reviewer_reject_reason,
      instruction: `REVIEWER_REJECTED [${items[0].json.reviewer_reject_code}]: ` +
        items[0].json.reviewer_reject_reason,
    },
    flattenRequest: null,
  }
}];
```

---

## Node 7 — Execute Fix (Sandbox)

**Type**: `Execute Command`
```
Command:
node /opt/sen7inel/sandbox/scripts/execute-fix.js \
  --client-id={{ $json.client_id }} \
  --patch-hash={{ $json.patch_hash }} \
  --repo-path={{ $json.repo_path }} \
  --iteration={{ $json.iteration }} \
  --patch-content={{ $json.patch_content }}

Working Directory: /opt/sen7inel
```

**⚠️ IMPORTANT — Execute Command options:**
```
Continue on Fail: TRUE   ← mandatory, exit codes 1/2/3 must not stop the workflow
Capture Stderr:   TRUE
```

**Code node after** (parse bridge JSON):
```javascript
const stdout = items[0].json.stdout ?? '{}';

let verifyResult;
try {
  verifyResult = JSON.parse(stdout);
} catch {
  verifyResult = {
    status: 'SYSTEM_ERROR',
    isGreen: false,
    requiresHumanEscalation: true,
    needsComplexityFlatten: false,
    needsRefinement: false,
    error: 'Failed to parse sandbox output',
  };
}

// Merge: keep original pipeline context + add verifier result
return [{
  json: {
    ...items[0].json,     // pipeline context (client_id, iteration, etc.)
    ...verifyResult,      // full verifier result + routing flags
    exit_code: items[0].json.exitCode ?? 3,
  }
}];
```

---

## Node 8 — IF: isGreen?

**Type**: `IF`
```
Condition:
  Value 1:   {{ $json.isGreen }}
  Operation: Equal
  Value 2:   true (Boolean)

True  → Node 9 (Create Pull Request)
False → Node 8b (IF: Complexity?)
```

---

## Node 8b — IF: needsComplexityFlatten?

**Type**: `IF`
```
Condition:
  Value 1:   {{ $json.needsComplexityFlatten }}
  Operation: Equal
  Value 2:   true (Boolean)

True  → Node 8c (IF: Iteration < Max?) with flattenRequest in payload
False → Node 8c (same) with refinementContext in payload
```

---

## Node 8c — IF: Iteration < Max?

**Type**: `IF`
```
Condition:
  Value 1:   {{ $json.iteration }}
  Operation: Smaller Than
  Value 2:   {{ $json.max_iterations }}   (value: 3)

True  → Set node → Increment iteration → Back to Node 3
False → HUMAN ESCALATION node
```

**Set node (increment iteration):**
```javascript
return [{
  json: {
    ...items[0].json,
    iteration: items[0].json.iteration + 1,
    // flattenRequest and refinementContext are already in the payload
    // coming from execute-fix.js — no need to recreate
  }
}];
```

---

## Node 9 — Create Pull Request

**Type**: `HTTP Request`
```
Method:  POST
URL:     https://api.github.com/repos/{{ $json.github_owner }}/{{ $json.github_repo }}/pulls

Headers:
  Authorization: Bearer {{ $credentials.githubApi.token }}
  Content-Type:  application/json
  Accept:        application/vnd.github+json

Body (JSON):
{
  "title": "[Sen7inel] Fix: {{ $json.anomaly_type }} — {{ $json.client_id }}",
  "body": "## Sen7inel Auto-Fix\n\n**Anomaly**: {{ $json.anomaly_type }}\n**Client**: {{ $json.client_id }}\n**Patch Hash**: `{{ $json.patch_hash }}`\n**Iterations**: {{ $json.iteration }}\n\n### Verification Results\n- ✅ Complexity: CC max {{ $json.complexity.maxFound }}/10\n- ✅ Type Check: passed\n- ✅ Lint: passed\n- ✅ Tests: passed\n\n### Gates Passed\n{{ $json.gates }}\n\n---\n*Generated by Sen7inel Self-Healing Pipeline*",
  "head": "sen7inel/fix-{{ $json.patch_hash }}",
  "base": "main",
  "draft": false
}
```

---

## Node 10 — Human Escalation Alert

**Type**: `HTTP Request` (Slack Webhook or WhatsApp via Evolution API)
```javascript
// Code node to build the alert message
const item = items[0].json;

const statusEmoji = {
  SYSTEM_ERROR: '🔴',
  COMPLEXITY_VIOLATION: '🟡',
  RED_TEST_FAILURE: '🟠',
  REVIEWER_REJECTED: '🔵',
}[item.status] ?? '⚠️';

const message = `${statusEmoji} *Sen7inel — Human Escalation*

*Client:* ${item.client_id}
*Status:* \`${item.status}\`
*Iterations attempted:* ${item.iteration}/${item.max_iterations}
*Patch Hash:* \`${item.patch_hash}\`
*Anomaly:* ${item.anomaly_type}

*Reason:*
${item.refinementContext?.errorOutput?.slice(0, 300) ?? item.error ?? 'No details available'}

Review in n8n: https://${process.env.N8N_HOST}/workflow`;

return [{ json: { text: message } }];
```

---

## Node 11 — Audit Log (Supabase)

**Type**: `HTTP Request` (after ALL branches — Green, Red, Escalation)
```
Method:  POST
URL:     https://{{ $env.SUPABASE_URL }}/rest/v1/pipeline_runs

Headers:
  apikey:        {{ $credentials.supabaseApi.serviceKey }}
  Authorization: Bearer {{ $credentials.supabaseApi.serviceKey }}
  Content-Type:  application/json
  Prefer:        return=minimal

Body (JSON):
{
  "client_id":          "{{ $json.client_id }}",
  "patch_hash":         "{{ $json.patch_hash }}",
  "anomaly_type":       "{{ $json.anomaly_type }}",
  "final_status":       "{{ $json.status }}",
  "pr_url":             "{{ $json.html_url ?? null }}",
  "gate_complexity":    {{ JSON.stringify($json.gates?.complexity ?? {}) }},
  "gate_type_check":    {{ JSON.stringify($json.gates?.typeCheck ?? {}) }},
  "gate_lint":          {{ JSON.stringify($json.gates?.lint ?? {}) }},
  "gate_tests":         {{ JSON.stringify($json.gates?.tests ?? {}) }},
  "reviewer_response":  "{{ $json.reviewer_response?.slice(0, 500) }}",
  "reviewer_model":     "gemini-1.5-pro",
  "total_duration_ms":  {{ $json.totalDurationMs ?? 0 }},
  "refinement_count":   {{ $json.iteration - 1 }},
  "patch_diff":         "{{ $json.patch_content?.slice(0, 10000) }}"
}
```

---

## Exit Codes Summary (n8n routing)

| Exit Code | Status | Action in n8n |
|---|---|---|
| 0 | GREEN | → Create Pull Request |
| 1 | RED_TEST / TYPE / LINT | → Build Refinement Prompt → Claude |
| 2 | COMPLEXITY_VIOLATION | → Build Flatten Prompt → Claude |
| 2 | PATCH_TOO_LARGE | → Decompose → Sub-tasks |
| 3 | SYSTEM_ERROR | → Human Escalation (immediate) |

## Reading Exit Codes in n8n

The Execute Command node exposes `{{ $json.exitCode }}`.
Use an IF node right after with this condition for primary routing:
```
exitCode == 0  → isGreen branch
exitCode == 1  → refinement branch
exitCode == 2  → complexity/flatten branch
exitCode >= 3  → human escalation (always)
```