Sen7inel — Guia de Configuração n8n
Pipeline Completo: Erro → Patch → Verificação → PR

Visão Geral do Workflow
[Webhook Trigger]
      ↓
[Load Client Context]
      ↓
[Build Generator Prompt]
      ↓
[Claude 3.5 Sonnet — Generate Patch]        ← iteration counter aqui
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

Nó 1 — Webhook Trigger
Tipo: Webhook
Method:    POST
Path:      /sen7inel/fix
Auth:      Header Auth
  Header:  X-Sen7inel-Signature
  Value:   {{ $env.SEN7INEL_WEBHOOK_SECRET }}
Response:  Immediately (async processing)
Body esperado (JSON):
json{
  "client_id": "example-client",
  "anomaly_type": "null_pointer_exception",
  "anomaly_description": "TypeError: Cannot read properties of null at users.ts:47",
  "stack_trace": "...",
  "affected_files": ["src/users/queries.ts"],
  "repo_path": "/opt/sen7inel/repos/example-client"
}

Nó 2 — Load Client Context
Tipo: Execute Command
Command:
cat /opt/sen7inel/client-profiles/{{ $json.client_id }}/FORBIDDEN.md
echo "---STACK---"
cat /opt/sen7inel/client-profiles/{{ $json.client_id }}/STACK.md
echo "---SKILLS---"
cat /opt/sen7inel/.agent/skills/security/flat-architecture.md
cat /opt/sen7inel/.agent/skills/meta/complexity-budget.md
Set Variables (Code node após):
javascript// Captura o output e inicializa o contador de iterações
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

Nó 3 — Build Generator Prompt
Tipo: Code (JavaScript)
javascriptconst item = items[0].json;

// Monta o prompt completo — FORBIDDEN primeiro, sempre
const systemPrompt = `
${item.client_context}

---

${require('fs').readFileSync('/opt/sen7inel/prompts/generator-claude-system-prompt.md', 'utf8')}
`.trim();

// Se é uma retry, adiciona o contexto de erro anterior
let userMessage = `
[ANOMALY]
Type: ${item.anomaly_type}
Description: ${item.anomaly_description}
Stack Trace:
${item.stack_trace ?? 'Not provided'}

[AFFECTED_CODE]
${item.affected_files.map(f => `File: ${f}`).join('\n')}
`.trim();

// Adiciona contexto de retry se existir
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

// Adiciona instrução de flatten se for complexity retry
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

Nó 4 — Claude 3.5 Sonnet (Patch Generator)
Tipo: HTTP Request
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
Code node após (extrair patch do response):
javascriptconst response = items[0].json;
const content = response.content?.[0]?.text ?? '';

// Detecta se o Claude pediu decomposição
const isDecompose = content.trim().startsWith('DECOMPOSE');

return [{
  json: {
    ...items[0].json,
    patch_content: isDecompose ? '' : content,
    decompose_requested: isDecompose,
    decompose_content: isDecompose ? content : null,
    claude_raw_response: content.slice(0, 500), // para audit log
  }
}];

Nó 5 — Gemini Adversarial Review
Tipo: HTTP Request
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
Code node após (parsear resposta binária):
javascriptconst responseText = items[0].json
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

Nó 6 — IF: Reviewer Approved?
Tipo: IF
Condition:
  Value 1:   {{ $json.reviewer_approved }}
  Operation: Equal
  Value 2:   true (Boolean)

True  → Nó 7 (Execute Fix)
False → Nó 6b (IF: Reviewer Retry?)
Nó 6b — IF: Reviewer Retry Allowed?
Condition:
  Value 1:   {{ $json.iteration }}
  Operation: Smaller Than
  Value 2:   3

True  → Volta ao Nó 3 (Build Generator Prompt) com reject context
False → Nó HUMAN ESCALATION
Set node antes de voltar (adicionar contexto de rejeição):
javascriptreturn [{
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

Nó 7 — Execute Fix (Sandbox)
Tipo: Execute Command
Command:
node /opt/sen7inel/sandbox/scripts/execute-fix.js \
  --client-id={{ $json.client_id }} \
  --patch-hash={{ $json.patch_hash }} \
  --repo-path={{ $json.repo_path }} \
  --iteration={{ $json.iteration }} \
  --patch-content={{ $json.patch_content }}

Working Directory: /opt/sen7inel
⚠️ IMPORTANTE — Opções do Execute Command:
Continue on Fail: TRUE   ← obrigatório, exit codes 1/2/3 não devem parar o workflow
Capture Stderr:   TRUE
Code node após (parsear JSON do bridge):
javascriptconst stdout = items[0].json.stdout ?? '{}';

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

// Merge: mantém contexto original + adiciona resultado do verifier
return [{
  json: {
    ...items[0].json,     // contexto do pipeline (client_id, iteration, etc.)
    ...verifyResult,      // resultado completo do verifier + routing flags
    exit_code: items[0].json.exitCode ?? 3,
  }
}];

Nó 8 — IF: isGreen?
Tipo: IF
Condition:
  Value 1:   {{ $json.isGreen }}
  Operation: Equal
  Value 2:   true (Boolean)

True  → Nó 9 (Create Pull Request)
False → Nó 8b (IF: Complexity?)

Nó 8b — IF: needsComplexityFlatten?
Tipo: IF
Condition:
  Value 1:   {{ $json.needsComplexityFlatten }}
  Operation: Equal
  Value 2:   true (Boolean)

True  → Nó 8c (IF: Iteration < Max?)  com flattenRequest no payload
False → Nó 8c (mesmo) com refinementContext no payload

Nó 8c — IF: Iteration < Max?
Tipo: IF
Condition:
  Value 1:   {{ $json.iteration }}
  Operation: Smaller Than
  Value 2:   {{ $json.max_iterations }}   (valor: 3)

True  → Set node → Incrementa iteration → Volta ao Nó 3
False → Nó HUMAN ESCALATION
Set node (incrementar iteração):
javascriptreturn [{
  json: {
    ...items[0].json,
    iteration: items[0].json.iteration + 1,
    // flattenRequest e refinementContext já estão no payload
    // vindos do execute-fix.js — não precisa recriar
  }
}];

Nó 9 — Create Pull Request
Tipo: HTTP Request
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

Nó 10 — Human Escalation Alert
Tipo: HTTP Request (Slack Webhook ou WhatsApp via Evolution API)
javascript// Code node para montar o alerta
const item = items[0].json;

const statusEmoji = {
  SYSTEM_ERROR: '🔴',
  COMPLEXITY_VIOLATION: '🟡',
  RED_TEST_FAILURE: '🟠',
  REVIEWER_REJECTED: '🔵',
}[item.status] ?? '⚠️';

const message = `${statusEmoji} *Sen7inel — Escalação Humana*

*Cliente:* ${item.client_id}
*Status:* \`${item.status}\`
*Iterações tentadas:* ${item.iteration}/${item.max_iterations}
*Patch Hash:* \`${item.patch_hash}\`
*Anomalia:* ${item.anomaly_type}

*Motivo:*
${item.refinementContext?.errorOutput?.slice(0, 300) ?? item.error ?? 'Sem detalhes'}

Acesse o n8n para revisar: https://${process.env.N8N_HOST}/workflow`;

return [{ json: { text: message } }];

Nó 11 — Audit Log (Supabase)
Tipo: HTTP Request (após TODOS os branches — Green, Red, Escalation)
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

Resumo dos Exit Codes (n8n routing)
Exit CodeStatusAção no n8n 
0 GREEN→ Create Pull Request 
1 RED_TEST / TYPE / LINT→ Build Refinement Prompt → Claude
2 COMPLEXITY_VIOLATION→ Build Flatten Prompt → Claude
2 PATCH_TOO_LARGE→ Decompose → Sub-tasks
3 SYSTEM_ERROR→ Human Escalation (imediato)
Leitura do Exit Code no n8n
O Execute Command node expõe {{ $json.exitCode }}.
Use um IF node logo após com essa condição para routing primário:
exitCode == 0  → isGreen branch
exitCode == 1  → refinement branch  
exitCode == 2  → complexity/flatten branch
exitCode >= 3  → human escalation (sempre)