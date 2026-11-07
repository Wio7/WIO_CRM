-- ============================================================
-- 082_gestiones_cobranza.sql — Gestiones de cobranza (ERP fase 1)
--
-- Cada vez que la oficina gestiona a un moroso (llamada, WhatsApp,
-- visita) queda una fila: qué se hizo, qué respondió el cliente y, si
-- prometió pagar, la fecha y el monto de la promesa. La pantalla
-- Cobranzas muestra la última gestión de cada cliente y avisa cuando una
-- promesa venció sin pago.
--
-- Mismo criterio de acceso que payment_plans (043): el equipo (agente o
-- más) lee y registra; corrige o borra quien la registró o un admin.
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

CREATE INDEX IF NOT EXISTS idx_collection_actions_contact
  ON public.collection_actions(account_id, contact_id, created_at DESC);

ALTER TABLE public.collection_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS collection_actions_select ON public.collection_actions;
CREATE POLICY collection_actions_select ON public.collection_actions FOR SELECT
  USING (public.is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS collection_actions_insert ON public.collection_actions;
CREATE POLICY collection_actions_insert ON public.collection_actions FOR INSERT
  WITH CHECK (
    public.is_account_member(account_id, 'agent')
    AND created_by = auth.uid()
    -- El contacto tiene que ser de la misma cuenta.
    AND EXISTS (
      SELECT 1 FROM public.contacts c
      WHERE c.id = contact_id AND c.account_id = collection_actions.account_id
    )
  );

DROP POLICY IF EXISTS collection_actions_update ON public.collection_actions;
CREATE POLICY collection_actions_update ON public.collection_actions FOR UPDATE
  USING (
    public.is_account_member(account_id, 'admin')
    OR (created_by = auth.uid() AND public.is_account_member(account_id, 'agent'))
  )
  WITH CHECK (public.is_account_member(account_id, 'agent'));

DROP POLICY IF EXISTS collection_actions_delete ON public.collection_actions;
CREATE POLICY collection_actions_delete ON public.collection_actions FOR DELETE
  USING (
    public.is_account_member(account_id, 'admin')
    OR (created_by = auth.uid() AND public.is_account_member(account_id, 'agent'))
  );

-- PostgREST lee el esquema nuevo sin reiniciar.
NOTIFY pgrst, 'reload schema';
