-- Sen7inel Audit Log
-- Immutable pipeline decision record
-- Every gate decision is written here — no updates, no deletes

CREATE TABLE IF NOT EXISTS pipeline_runs (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    
    -- Identity
    client_id       TEXT NOT NULL,
    patch_hash      TEXT NOT NULL,
    anomaly_type    TEXT,
    
    -- Pipeline outcome
    final_status    TEXT NOT NULL,  -- GREEN | RED_* | COMPLEXITY_VIOLATION | HUMAN_ESCALATED
    pr_url          TEXT,           -- Populated if GREEN and PR created
    
    -- Gate results (JSON from verifier)
    gate_patch_size     JSONB,
    gate_complexity     JSONB,
    gate_type_check     JSONB,
    gate_lint           JSONB,
    gate_tests          JSONB,
    
    -- Review
    reviewer_response   TEXT,       -- APPROVE or full REJECT message
    reviewer_model      TEXT,       -- e.g. gemini-1.5-pro
    
    -- Metrics
    total_duration_ms   INTEGER,
    refinement_count    INTEGER DEFAULT 0,
    
    -- Raw outputs for debugging (truncated to 10KB each)
    patch_diff          TEXT,
    test_output         TEXT
);

-- No UPDATE or DELETE permissions for the sen7inel app user
-- Only INSERT and SELECT

CREATE INDEX idx_pipeline_runs_client_id ON pipeline_runs(client_id);
CREATE INDEX idx_pipeline_runs_created_at ON pipeline_runs(created_at DESC);
CREATE INDEX idx_pipeline_runs_status ON pipeline_runs(final_status);