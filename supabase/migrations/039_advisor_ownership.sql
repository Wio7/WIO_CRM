-- ============================================================
-- 039_advisor_ownership.sql — Each advisor works their own clients
--
-- For sales teams (the Golden App advisors): a lead that comes in is
-- handed to ONE agent, and only that agent (plus admins/owners) can see
-- the conversation. Also adds the push-subscription store the Golden
-- App uses to wake the advisor's phone when their client writes.
--
-- Everything is opt-in PER ACCOUNT. Both switches default to false, so
-- every other account on this deployment keeps today's behaviour
-- (every member sees every conversation, nothing is auto-assigned):
--
--   accounts.agents_see_only_assigned
--     Agents/viewers see only conversations assigned to them. Admins
--     and owners still see everything. A conversation an agent opens
--     themselves is assigned to them (otherwise they couldn't see it).
--
--   accounts.auto_assign_new_conversations
--     Conversations created by the system (WhatsApp webhook, public
--     API, Meta Lead Ads, automations) are assigned round-robin among
--     the account's members with role 'agent'.
--
-- Turn them on for one account with:
--   UPDATE accounts
--      SET agents_see_only_assigned = true,
--          auto_assign_new_conversations = true
--    WHERE id = '<account id>';
--
-- Note: the AI auto-reply stands down on assigned conversations
-- (src/lib/ai/auto-reply.ts), so auto-assignment turns it off in
-- practice for new leads of that account.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. Per-account switches
-- ============================================================
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS agents_see_only_assigned BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS auto_assign_new_conversations BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- 2. can_access_conversation(account_id, assigned_agent_id, min_role)
--
-- Membership (at least min_role) AND one of:
--   · the caller is admin/owner of the account,
--   · the conversation is assigned to the caller,
--   · the account doesn't restrict agents to their own conversations.
-- ============================================================
CREATE OR REPLACE FUNCTION can_access_conversation(
  p_account_id UUID,
  p_assigned_agent_id UUID,
  p_min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT is_account_member(p_account_id, p_min_role)
    AND (
      is_account_member(p_account_id, 'admin')
      OR p_assigned_agent_id = auth.uid()
      OR NOT COALESCE(
        (SELECT a.agents_see_only_assigned FROM accounts a WHERE a.id = p_account_id),
        false
      )
    );
$$;

ALTER FUNCTION can_access_conversation(UUID, UUID, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_access_conversation(UUID, UUID, account_role_enum)
  TO authenticated, service_role;

-- ============================================================
-- 3. RLS — conversations, messages, message_reactions
--
-- Same shape as 017, with is_account_member(...) swapped for
-- can_access_conversation(...). INSERT is unchanged (agents may open
-- conversations); the trigger in section 4 assigns what they open.
-- UPDATE's WITH CHECK only requires membership, so an agent can hand a
-- conversation off to a teammate.
-- ============================================================
DROP POLICY IF EXISTS conversations_select ON conversations;
CREATE POLICY conversations_select ON conversations FOR SELECT
  USING (can_access_conversation(account_id, assigned_agent_id));

DROP POLICY IF EXISTS conversations_update ON conversations;
CREATE POLICY conversations_update ON conversations FOR UPDATE
  USING (can_access_conversation(account_id, assigned_agent_id, 'agent'))
  WITH CHECK (is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS conversations_delete ON conversations;
CREATE POLICY conversations_delete ON conversations FOR DELETE
  USING (can_access_conversation(account_id, assigned_agent_id, 'agent'));

DROP POLICY IF EXISTS messages_select ON messages;
CREATE POLICY messages_select ON messages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_access_conversation(c.account_id, c.assigned_agent_id)
  )
);

DROP POLICY IF EXISTS messages_modify ON messages;
CREATE POLICY messages_modify ON messages FOR ALL USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_access_conversation(c.account_id, c.assigned_agent_id, 'agent')
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_access_conversation(c.account_id, c.assigned_agent_id, 'agent')
  )
);

DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
CREATE POLICY message_reactions_select ON message_reactions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND can_access_conversation(c.account_id, c.assigned_agent_id)
  )
);

DROP POLICY IF EXISTS message_reactions_modify ON message_reactions;
CREATE POLICY message_reactions_modify ON message_reactions FOR ALL USING (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND can_access_conversation(c.account_id, c.assigned_agent_id, 'agent')
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND can_access_conversation(c.account_id, c.assigned_agent_id, 'agent')
  )
);

-- ============================================================
-- 4. Automatic assignment of new conversations
-- ============================================================

-- Per-account round-robin state: { "<agent user_id>": <times picked> }.
-- Service-role/definer only, like automation_assignment_state (034).
CREATE TABLE IF NOT EXISTS account_assignment_state (
  account_id UUID PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  counts JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE account_assignment_state ENABLE ROW LEVEL SECURITY;

-- pick_account_agent(account_id)
--   Picks the 'agent' member with the fewest assignments so far, under a
--   row lock so two leads arriving together can't land on the same one.
--   An agent with no history starts at the current minimum instead of 0,
--   so someone added later doesn't receive every lead until caught up.
--   Ties go to the longest-standing member. NULL when there are no agents.
CREATE OR REPLACE FUNCTION pick_account_agent(p_account_id UUID)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_counts JSONB;
  v_min    BIGINT;
  v_best   BIGINT;
  v_chosen UUID;
  v_count  BIGINT;
  v_agent  RECORD;
BEGIN
  INSERT INTO account_assignment_state (account_id)
    VALUES (p_account_id)
    ON CONFLICT (account_id) DO NOTHING;

  SELECT counts INTO v_counts
    FROM account_assignment_state
    WHERE account_id = p_account_id
    FOR UPDATE;

  SELECT MIN((v_counts ->> p.user_id::text)::BIGINT) INTO v_min
    FROM profiles p
    WHERE p.account_id = p_account_id
      AND p.account_role = 'agent'
      AND v_counts ? p.user_id::text;

  FOR v_agent IN
    SELECT p.user_id
      FROM profiles p
      WHERE p.account_id = p_account_id
        AND p.account_role = 'agent'
      ORDER BY p.created_at, p.user_id
  LOOP
    v_count := COALESCE((v_counts ->> v_agent.user_id::text)::BIGINT, v_min, 0);
    IF v_chosen IS NULL OR v_count < v_best THEN
      v_chosen := v_agent.user_id;
      v_best := v_count;
    END IF;
  END LOOP;

  IF v_chosen IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE account_assignment_state
     SET counts = jsonb_set(v_counts, ARRAY[v_chosen::text], to_jsonb(v_best + 1)),
         updated_at = NOW()
   WHERE account_id = p_account_id;

  RETURN v_chosen;
END;
$$;

ALTER FUNCTION pick_account_agent(UUID) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION pick_account_agent(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION pick_account_agent(UUID) TO service_role;

-- BEFORE INSERT: fill assigned_agent_id when nobody set it.
--   · A signed-in agent (not admin) of a restricted account → themselves.
--   · The system (no auth.uid(): webhook, API, automations) of an
--     auto-assign account → round-robin agent.
-- The AFTER trigger from 027 then notifies the chosen agent.
CREATE OR REPLACE FUNCTION assign_new_conversation()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_restrict BOOLEAN;
  v_auto     BOOLEAN;
BEGIN
  IF NEW.assigned_agent_id IS NOT NULL THEN
    RETURN NEW;
  END IF;

  SELECT agents_see_only_assigned, auto_assign_new_conversations
    INTO v_restrict, v_auto
    FROM accounts
    WHERE id = NEW.account_id;

  IF auth.uid() IS NOT NULL THEN
    IF COALESCE(v_restrict, false)
       AND NOT is_account_member(NEW.account_id, 'admin') THEN
      NEW.assigned_agent_id := auth.uid();
    END IF;
    RETURN NEW;
  END IF;

  IF COALESCE(v_auto, false) THEN
    NEW.assigned_agent_id := pick_account_agent(NEW.account_id);
  END IF;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  -- Never block a lead from being stored because assignment failed.
  RAISE WARNING 'assign_new_conversation failed for account %: %', NEW.account_id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION assign_new_conversation() OWNER TO postgres;

DROP TRIGGER IF EXISTS assign_new_conversation ON conversations;
CREATE TRIGGER assign_new_conversation
  BEFORE INSERT ON conversations
  FOR EACH ROW EXECUTE FUNCTION assign_new_conversation();

-- ============================================================
-- 5. Push subscriptions (Golden App notifications)
--
-- One row per browser/device. Rows are written through the SECURITY
-- DEFINER RPC below, so a device that changes hands (logout → another
-- advisor logs in) is re-pointed to the new user instead of failing on
-- the unique endpoint. Users can read and delete their own rows.
-- The server sends pushes with the service-role key.
-- ============================================================
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user ON push_subscriptions(user_id);

ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS push_subscriptions_select ON push_subscriptions;
CREATE POLICY push_subscriptions_select ON push_subscriptions FOR SELECT
  USING (auth.uid() = user_id);

DROP POLICY IF EXISTS push_subscriptions_delete ON push_subscriptions;
CREATE POLICY push_subscriptions_delete ON push_subscriptions FOR DELETE
  USING (auth.uid() = user_id);

CREATE OR REPLACE FUNCTION save_push_subscription(
  p_endpoint TEXT,
  p_p256dh TEXT,
  p_auth TEXT,
  p_user_agent TEXT DEFAULT NULL
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_endpoint IS NULL OR p_endpoint !~ '^https://' THEN
    RAISE EXCEPTION 'invalid endpoint';
  END IF;

  INSERT INTO push_subscriptions (user_id, account_id, endpoint, p256dh, auth, user_agent)
  VALUES (
    auth.uid(),
    (SELECT account_id FROM profiles WHERE user_id = auth.uid()),
    p_endpoint,
    p_p256dh,
    p_auth,
    left(p_user_agent, 300)
  )
  ON CONFLICT (endpoint) DO UPDATE
    SET user_id = EXCLUDED.user_id,
        account_id = EXCLUDED.account_id,
        p256dh = EXCLUDED.p256dh,
        auth = EXCLUDED.auth,
        user_agent = EXCLUDED.user_agent,
        last_seen_at = NOW();
END;
$$;

ALTER FUNCTION save_push_subscription(TEXT, TEXT, TEXT, TEXT) OWNER TO postgres;
REVOKE EXECUTE ON FUNCTION save_push_subscription(TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION save_push_subscription(TEXT, TEXT, TEXT, TEXT) TO authenticated;
