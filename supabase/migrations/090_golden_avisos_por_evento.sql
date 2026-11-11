-- ============================================================
-- 090_golden_avisos_por_evento.sql — un aviso por solicitud Y evento
--
-- La 088 reservaba un solo aviso por solicitud ("Lote separado"). Ahora el
-- mismo endpoint avisa tres etapas del lote (Golden App):
--   solicitada  "Lote en proceso"  (el asesor pidió el lote)
--   aprobada    "Lote separado"    (un aprobador aprobó)   <- las filas de 088
--   vendida     "Lote vendido"     (un aprobador cerró la venta)
-- La clave primaria pasa de (solicitud_id) a (solicitud_id, evento): cada
-- etapa se avisa una sola vez, aunque la llamen diez veces. Las filas que ya
-- existían quedan como 'aprobada', que es lo que eran.
--
-- Requiere la 088. Idempotente: se puede volver a correr.
-- ============================================================
ALTER TABLE golden_separacion_avisos
  ADD COLUMN IF NOT EXISTS evento text NOT NULL DEFAULT 'aprobada';

ALTER TABLE golden_separacion_avisos
  DROP CONSTRAINT IF EXISTS golden_separacion_avisos_evento_check;
ALTER TABLE golden_separacion_avisos
  ADD CONSTRAINT golden_separacion_avisos_evento_check
  CHECK (evento IN ('solicitada', 'aprobada', 'vendida'));

DO $$
BEGIN
  -- Sólo si la clave primaria todavía es la de la 088 (solicitud_id solo).
  IF EXISTS (
    SELECT 1
      FROM pg_constraint c
     WHERE c.conrelid = 'golden_separacion_avisos'::regclass
       AND c.contype = 'p'
       AND array_length(c.conkey, 1) = 1
  ) THEN
    ALTER TABLE golden_separacion_avisos DROP CONSTRAINT golden_separacion_avisos_pkey;
    ALTER TABLE golden_separacion_avisos
      ADD CONSTRAINT golden_separacion_avisos_pkey PRIMARY KEY (solicitud_id, evento);
  END IF;
END $$;
