-- ============================================================
-- 031_saas_features.sql — SaaS Owner Dashboard & Agent Isolation
-- ============================================================

-- 1. Add status to accounts table
ALTER TABLE public.accounts 
  ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive'));

-- 2. Helper to check if the current user is a global Super Admin
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE(auth.jwt() ->> 'email', '') = 'wiocompany7@gmail.com';
$$;

-- 3. Re-define is_account_member helper to check status and super-admin bypass
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

-- 4. Update accounts RLS policies
DROP POLICY IF EXISTS accounts_select ON public.accounts;
DROP POLICY IF EXISTS accounts_update ON public.accounts;

CREATE POLICY accounts_select ON public.accounts FOR SELECT
  USING (is_account_member(id) OR COALESCE(auth.jwt() ->> 'email', '') = 'wiocompany7@gmail.com');

CREATE POLICY accounts_update ON public.accounts FOR UPDATE
  USING (is_account_member(id, 'admin') OR COALESCE(auth.jwt() ->> 'email', '') = 'wiocompany7@gmail.com')
  WITH CHECK (is_account_member(id, 'admin') OR COALESCE(auth.jwt() ->> 'email', '') = 'wiocompany7@gmail.com');

CREATE POLICY accounts_delete ON public.accounts FOR DELETE
  USING (COALESCE(auth.jwt() ->> 'email', '') = 'wiocompany7@gmail.com');

-- 5. Update contacts RLS policies (Agent/Viewer isolation)
DROP POLICY IF EXISTS contacts_select ON public.contacts;
DROP POLICY IF EXISTS contacts_insert ON public.contacts;
DROP POLICY IF EXISTS contacts_update ON public.contacts;
DROP POLICY IF EXISTS contacts_delete ON public.contacts;

CREATE POLICY contacts_select ON public.contacts FOR SELECT
  USING (
    COALESCE(auth.jwt() ->> 'email', '') = 'wiocompany7@gmail.com'
    OR is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'viewer')
      AND (
        user_id = auth.uid()
        OR EXISTS (
          SELECT 1 FROM public.conversations c
          WHERE c.contact_id = contacts.id
            AND c.assigned_agent_id = auth.uid()
        )
      )
    )
  );

CREATE POLICY contacts_insert ON public.contacts FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

CREATE POLICY contacts_update ON public.contacts FOR UPDATE
  USING (
    COALESCE(auth.jwt() ->> 'email', '') = 'wiocompany7@gmail.com'
    OR is_account_member(account_id, 'admin')
    OR (is_account_member(account_id, 'agent') AND user_id = auth.uid())
  )
  WITH CHECK (
    COALESCE(auth.jwt() ->> 'email', '') = 'wiocompany7@gmail.com'
    OR is_account_member(account_id, 'admin')
    OR (is_account_member(account_id, 'agent') AND user_id = auth.uid())
  );

CREATE POLICY contacts_delete ON public.contacts FOR DELETE
  USING (
    COALESCE(auth.jwt() ->> 'email', '') = 'wiocompany7@gmail.com'
    OR is_account_member(account_id, 'admin')
  );

-- 6. Update conversations RLS policies (Agent/Viewer isolation)
DROP POLICY IF EXISTS conversations_select ON public.conversations;
DROP POLICY IF EXISTS conversations_insert ON public.conversations;
DROP POLICY IF EXISTS conversations_update ON public.conversations;
DROP POLICY IF EXISTS conversations_delete ON public.conversations;

CREATE POLICY conversations_select ON public.conversations FOR SELECT
  USING (
    COALESCE(auth.jwt() ->> 'email', '') = 'wiocompany7@gmail.com'
    OR is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'viewer')
      AND (assigned_agent_id = auth.uid() OR assigned_agent_id IS NULL)
    )
  );

CREATE POLICY conversations_insert ON public.conversations FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));

CREATE POLICY conversations_update ON public.conversations FOR UPDATE
  USING (
    COALESCE(auth.jwt() ->> 'email', '') = 'wiocompany7@gmail.com'
    OR is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND (assigned_agent_id = auth.uid() OR assigned_agent_id IS NULL)
    )
  )
  WITH CHECK (
    COALESCE(auth.jwt() ->> 'email', '') = 'wiocompany7@gmail.com'
    OR is_account_member(account_id, 'admin')
    OR (
      is_account_member(account_id, 'agent')
      AND (assigned_agent_id = auth.uid() OR assigned_agent_id IS NULL)
    )
  );

CREATE POLICY conversations_delete ON public.conversations FOR DELETE
  USING (
    COALESCE(auth.jwt() ->> 'email', '') = 'wiocompany7@gmail.com'
    OR is_account_member(account_id, 'admin')
  );
