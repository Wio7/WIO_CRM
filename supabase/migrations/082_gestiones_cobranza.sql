-- ============================================================
-- 082_gestiones_cobranza.sql — Gestiones de cobranza (ERP fase 1)
--
-- Cada vez que la oficina gestiona a un moroso (llamada, WhatsApp,
-- visita) queda una fila: qué se hizo, qué respondió el cliente y, si
-- prometió pagar, la fecha y el monto de la promesa. La pantalla
-- Cobranzas muestra la última gestión de cada cliente y avisa cuando una
-- promesa venció sin pago.
--
-- Acceso:
--   · Leer: el equipo (agente o más), solo de contactos que puede ver
--     (hereda el RLS de contacts: un agente ve las gestiones de sus
--     clientes; un admin, todas).
--   · Registrar: el equipo, a su nombre, sobre contactos y planes de su
--     misma cuenta.
--   · Corregir o borrar: quien la registró o un admin. Autor, fecha y
--     cuenta no se pueden cambiar (es un registro de auditoría).
--
-- Idempotente — se puede volver a correr.
-- ============================================================

CREATE TABLE IF NOT EXISTS public.collection_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES public.accounts(id) ON DELETE CASCADE,
  contact_id      uuid NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  plan_id         uuid REFERENCES public.payment_plans(id) ON DELETE SET NULL,
  channel         text NOT NULL DEFAULT 'llamada'
                    CHECK (channel IN ('llamada', 'whatsapp', 'visita', 'correo', 'otro')),
  result          text NOT NULL DEFAULT 'contactado'
                    CHECK (result IN ('contactado', 'no_contesta', 'promesa', 'pago', 'rehusa', 'numero_errado')),
  promise_date    date,
  promise_amount  numeric(12,2),
  note            text,
  created_by      uuid DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT collection_actions_promise_has_date
    CHECK (result <> 'promesa' OR promise_date IS NOT NULL)
);

-- Restricciones añadidas después (con DO para que se pueda re-correr).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collection_actions_note_length') THEN
    ALTER TABLE public.collection_actions
      ADD CONSTRAINT collection_actions_note_length CHECK (note IS NULL OR char_length(note) <= 1000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'collection_actions_amount_positive') THEN
    ALTER TABLE public.collection_actions
      ADD CONSTRAINT collection_actions_amount_positive CHECK (promise_amount IS NULL OR promise_amount > 0);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_collection_actions_contact
  ON public.collection_actions(account_id, contact_id, created_at DESC);

-- ------------------------------------------------------------
-- Autor, fecha y cuenta no cambian al editar una gestión.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.collection_actions_keep_audit()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.account_id := OLD.account_id;
  NEW.created_by := OLD.created_by;
  NEW.created_at := OLD.created_at;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS collection_actions_keep_audit ON public.collection_actions;
CREATE TRIGGER collection_actions_keep_audit
  BEFORE UPDATE ON public.collection_actions
  FOR EACH ROW EXECUTE FUNCTION public.collection_actions_keep_audit();

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
ALTER TABLE public.collection_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS collection_actions_select ON public.collection_actions;
CREATE POLICY collection_actions_select ON public.collection_actions FOR SELECT
  USING (
    public.is_account_member(account_id, 'agent')
    -- Corre con el RLS de contacts: solo gestiones de contactos visibles.
    AND EXISTS (SELECT 1 FROM public.contacts c WHERE c.id = collection_actions.contact_id)
  );

DROP POLICY IF EXISTS collection_actions_insert ON public.collection_actions;
CREATE POLICY collection_actions_insert ON public.collection_actions FOR INSERT
  WITH CHECK (
    public.is_account_member(account_id, 'agent')
    AND created_by = auth.uid()
    AND EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = collection_actions.contact_id
        AND c.account_id = collection_actions.account_id
    )
    AND (
      collection_actions.plan_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.payment_plans p
        WHERE p.id = collection_actions.plan_id
          AND p.account_id = collection_actions.account_id
      )
    )
  );

DROP POLICY IF EXISTS collection_actions_update ON public.collection_actions;
CREATE POLICY collection_actions_update ON public.collection_actions FOR UPDATE
  USING (
    public.is_account_member(account_id, 'admin')
    OR (created_by = auth.uid() AND public.is_account_member(account_id, 'agent'))
  )
  WITH CHECK (
    (
      public.is_account_member(account_id, 'admin')
      OR (created_by = auth.uid() AND public.is_account_member(account_id, 'agent'))
    )
    AND EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = collection_actions.contact_id
        AND c.account_id = collection_actions.account_id
    )
    AND (
      collection_actions.plan_id IS NULL
      OR EXISTS (
        SELECT 1 FROM public.payment_plans p
        WHERE p.id = collection_actions.plan_id
          AND p.account_id = collection_actions.account_id
      )
    )
  );

DROP POLICY IF EXISTS collection_actions_delete ON public.collection_actions;
CREATE POLICY collection_actions_delete ON public.collection_actions FOR DELETE
  USING (
    public.is_account_member(account_id, 'admin')
    OR (created_by = auth.uid() AND public.is_account_member(account_id, 'agent'))
  );

-- PostgREST lee el esquema nuevo sin reiniciar.
NOTIFY pgrst, 'reload schema';
