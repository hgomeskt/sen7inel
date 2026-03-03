# ============================================================
# Sen7inel Sandbox — Ephemeral Verification Container
# One container per patch verification. Destroyed after use.
# ============================================================

FROM node:20-alpine AS base

# Security: run as non-root user
RUN addgroup -g 1001 -S sandbox && \
    adduser -u 1001 -S sandbox -G sandbox

# Install system deps for git operations
RUN apk add --no-cache git bash

WORKDIR /sandbox

# ============================================================
# Verifier layer — ts-morph + test runner dependencies
# These are FIXED versions. Do not auto-update.
# ============================================================
FROM base AS verifier-deps

COPY sandbox/package.json sandbox/package-lock.json ./
RUN npm ci --only=production && \
    npm cache clean --force

# ============================================================
# Runtime layer
# ============================================================
FROM base AS runtime

# Copy verifier runtime
COPY --from=verifier-deps /sandbox/node_modules ./node_modules
COPY sandbox/src/ ./src/
COPY sandbox/tsconfig.sandbox.json ./tsconfig.json

# The client repo will be mounted at /repo at runtime
# The patch file will be mounted at /patch/changes.diff
RUN mkdir -p /repo /patch /results && \
    chown -R sandbox:sandbox /sandbox /repo /patch /results

USER sandbox

# Entrypoint: called by n8n with env vars set
# ENV vars expected:
#   CLIENT_TEST_COMMAND     — from client's STACK.md
#   CLIENT_TYPE_CHECK       — from client's STACK.md  
#   CLIENT_LINT_COMMAND     — from client's STACK.md
#   MAX_CC                  — cyclomatic complexity limit (default: 10)
#   MAX_PATCH_LINES         — patch size limit (default: 150)
#   PATCH_HASH              — for audit logging

ENTRYPOINT ["node", "--experimental-specifier-resolution=node", "src/entrypoint.js"]