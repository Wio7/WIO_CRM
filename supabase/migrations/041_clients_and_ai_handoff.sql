-- ============================================================
-- 041_clients_and_ai_handoff.sql — Clients as viewers, AI until the advisor writes
--
-- Two per-account switches. Both default to false, so every other
-- account on this deployment keeps today's behaviour:
--
--   accounts.viewers_are_clients
--     The account uses the 'viewer' role for CLIENTS (people browsing
--     the Golden App catalogue), not for read-only staff. When on, a
--     viewer no longer counts as a member for is_account_member(), so
--     every policy gated on it — contacts, deals, notes, conversations,
--     messages, broadcasts, whatsapp_config, AI config, reservations,
--     legal documents, the team roster… — stops returning rows to them.
--     A viewer still reads their own profile row (profiles_select checks
--     auth.uid() = user_id first), and their own push subscriptions and
--     notifications (auth.uid() policies).
--
--   accounts.ai_replies_until_agent_responds
--     With auto-assignment (039) every new lead has an advisor from the
--     first message, and the AI auto-reply stands down on assigned
--     conversations, so in practice it never answered. When on, the AI
--     keeps answering an assigned conversation until a human sends the
--     first message in it (messages.sender_type = 'agent').
--     Read by src/lib/ai/auto-reply.ts.
--
-- Turn them on for one account with:
--   UPDATE accounts
--      SET viewers_are_clients = true,
--          ai_replies_until_agent_responds = true
--    WHERE id = '<account id>';
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. Per-account switches
-- ============================================================
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS viewers_are_clients BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_replies_until_agent_responds BOOLEAN NOT NULL DEFAULT false;

-- ============================================================
-- 2. is_account_member — viewers of a client account are not members
--
-- Same body as 031, plus one condition. Every RLS policy and function
-- that checks membership goes through here, so this single change
-- closes every read path for clients, including tables added later.
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_account_member(
  target_account_id UUID,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.profiles p
    JOIN public.accounts a ON a.id = p.account_id
    WHERE p.user_id = auth.uid()
      AND p.account_id = target_account_id
      -- Account must be active, OR the user is a global Super Admin
      AND (a.status = 'active' OR COALESCE(auth.jwt() ->> 'email', '') = 'wiocompany7@gmail.com')
      -- In a client account, a viewer is a client: no access to CRM data
      AND NOT (p.account_role = 'viewer' AND a.viewers_are_clients)
      AND CASE p.account_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
        >=
          CASE min_role
            WHEN 'owner'  THEN 4
            WHEN 'admin'  THEN 3
            WHEN 'agent'  THEN 2
            WHEN 'viewer' THEN 1
          END
  ) OR COALESCE(auth.jwt() ->> 'email', '') = 'wiocompany7@gmail.com';
$$;

-- ============================================================
-- 3. Index for the AI hand-off check
--
-- "Has a human written in this conversation yet?" runs on every inbound
-- message of an assigned conversation.
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_messages_agent_by_conversation
  ON messages(conversation_id)
  WHERE sender_type = 'agent';
