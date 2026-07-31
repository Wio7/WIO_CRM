-- ============================================================
-- 034_automation_assignment_state.sql — Round-robin assignment state
--
-- Backs the `assign_conversation` automation step's round_robin mode
-- with real, persistent rotation. Before this, the engine's round_robin
-- was a stub that always returned the first account member (see the
-- comment in src/lib/automations/engine.ts), so leads never actually
-- rotated between advisors.
--
-- Per automation *step* we keep a JSONB map of how many times each
-- candidate agent has been picked. Selection chooses the candidate with
-- the smallest count (ties broken by the caller's array order), then
-- increments it — an even, order-stable round-robin that also tolerates
-- the pool changing over time. The `count/weight` generalization to
-- weighted distribution is a future extension needing no new migration.
--
-- Concurrency: two leads arriving in the same instant must not both land
-- on the same agent. `pick_round_robin_agent` does the read-modify-write
-- under a row lock (SELECT ... FOR UPDATE), mirroring the atomic-counter
-- rationale in 007_automations_increment_counter.sql.
--
-- Service-role only — like automation_pending_executions (006), all
-- access is server-side via the service-role key; no user-facing policy.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS automation_assignment_state (
  step_id UUID PRIMARY KEY
    REFERENCES automation_steps(id) ON DELETE CASCADE,
  -- { "<agent user_id>": <times picked>, ... }
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE automation_assignment_state ENABLE ROW LEVEL SECURITY;
-- No SELECT/INSERT/UPDATE/DELETE policy for authenticated users — all
-- access is server-side via the service-role key (RPC below).

-- ============================================================
-- pick_round_robin_agent(step_id, candidates[])
--
-- Atomically picks the next agent for a round-robin assign step:
--   1. Ensure a state row exists for the step, then lock it.
--   2. Among p_candidates, pick the one with the lowest recorded count
--      (missing = 0); ties resolve to the earliest in the array, so the
--      caller controls tie-break order.
--   3. Increment that agent's count and persist.
-- Returns the chosen agent's user_id, or NULL if p_candidates is empty.
-- ============================================================
CREATE OR REPLACE FUNCTION pick_round_robin_agent(
  p_step_id UUID,
  p_candidates UUID[]
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_counts   JSONB;
  v_chosen   UUID;
  v_best     BIGINT;
  v_cand     UUID;
  v_count    BIGINT;
  v_idx      INT;
BEGIN
  IF p_candidates IS NULL OR array_length(p_candidates, 1) IS NULL THEN
    RETURN NULL;
  END IF;

  -- Ensure the row exists, then take a row lock for the read-modify-write.
  INSERT INTO automation_assignment_state (step_id)
    VALUES (p_step_id)
    ON CONFLICT (step_id) DO NOTHING;

  SELECT counts INTO v_counts
    FROM automation_assignment_state
    WHERE step_id = p_step_id
    FOR UPDATE;

  -- Pick the candidate with the smallest count; first in array wins ties.
  FOR v_idx IN 1 .. array_length(p_candidates, 1) LOOP
    v_cand := p_candidates[v_idx];
    v_count := COALESCE((v_counts ->> v_cand::text)::bigint, 0);
    IF v_chosen IS NULL OR v_count < v_best THEN
      v_chosen := v_cand;
      v_best := v_count;
    END IF;
  END LOOP;

  UPDATE automation_assignment_state
    SET counts = jsonb_set(
          v_counts,
          ARRAY[v_chosen::text],
          to_jsonb(v_best + 1),
          true
        ),
        updated_at = NOW()
    WHERE step_id = p_step_id;

  RETURN v_chosen;
END;
$$;

-- Only the service role (engine) may call this. Lock everyone else out so
-- an authenticated user can't skew someone else's rotation via RPC.
REVOKE ALL ON FUNCTION pick_round_robin_agent(UUID, UUID[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION pick_round_robin_agent(UUID, UUID[]) FROM anon;
REVOKE ALL ON FUNCTION pick_round_robin_agent(UUID, UUID[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION pick_round_robin_agent(UUID, UUID[]) TO service_role;
