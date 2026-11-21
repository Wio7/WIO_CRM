-- ============================================================
-- 101 · Etapas del cliente para Golden Habitat (2026-11-21)
--
-- Lo mismo que la 100 hizo para Broker Home, ahora para Golden
-- (cuenta d74b5dfd…): sus etapas de fábrica en inglés pasan a las del
-- equipo, con su clave, y los disparadores de la 100 (mensajes y citas)
-- empiezan a moverlas solas. Requiere la 100.
--
-- Lo propio de Golden: cuando Sara aprueba una separación
-- (gh_lotes_solicitudes.estado → 'aprobada'), el cliente pasa solo a
-- "Separó / compró". La solicitud no guarda el contacto del CRM, solo el
-- celular: se busca por los últimos 9 dígitos. Si no hay coincidencia no
-- pasa nada, y si algo falla la aprobación se guarda igual.
--
-- Idempotente: se puede correr dos veces.
-- ============================================================

-- Últimos 9 dígitos de un celular peruano ("+51 959 251 023" → "959251023").
CREATE OR REPLACE FUNCTION public.celular_nueve(p text)
RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN length(d) >= 9 THEN right(d, 9) ELSE NULL END
  FROM (SELECT regexp_replace(coalesce(p, ''), '\D', '', 'g') AS d) x
$$;

-- El contacto de una cuenta con ese celular (el más reciente si hay varios).
CREATE OR REPLACE FUNCTION public.contacto_por_celular(p_account uuid, p_celular text)
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT c.id FROM contacts c
  WHERE c.account_id = p_account
    AND celular_nueve(p_celular) IS NOT NULL
    AND celular_nueve(coalesce(c.phone_normalized, c.phone)) = celular_nueve(p_celular)
  ORDER BY c.created_at DESC NULLS LAST
  LIMIT 1
$$;

REVOKE ALL ON FUNCTION public.contacto_por_celular(uuid, text) FROM PUBLIC, anon, authenticated;

-- Etapas de Golden en español.
DO $$
DECLARE
  v_pipe uuid;
BEGIN
  SELECT id INTO v_pipe FROM pipelines
  WHERE account_id = 'd74b5dfd-2999-4e2c-9a0e-10b3d540898b'
  ORDER BY created_at LIMIT 1;
  IF v_pipe IS NULL THEN RETURN; END IF;

  UPDATE pipelines SET name = 'Clientes' WHERE id = v_pipe;

  UPDATE pipeline_stages SET name = 'Nuevo', clave = 'nuevo', position = 0, color = '#64748b'
    WHERE pipeline_id = v_pipe AND (clave = 'nuevo' OR (clave IS NULL AND name = 'New Lead'));
  UPDATE pipeline_stages SET name = 'Contestó', clave = 'contesto', position = 1, color = '#0ea5e9'
    WHERE pipeline_id = v_pipe AND (clave = 'contesto' OR (clave IS NULL AND name = 'Qualified'));
  UPDATE pipeline_stages SET name = 'En seguimiento', clave = 'seguimiento', position = 2, color = '#8b5cf6'
    WHERE pipeline_id = v_pipe AND (clave = 'seguimiento' OR (clave IS NULL AND name = 'Proposal Sent'));
  UPDATE pipeline_stages SET name = 'Agendó visita', clave = 'agendo', position = 3, color = '#f59e0b'
    WHERE pipeline_id = v_pipe AND (clave = 'agendo' OR (clave IS NULL AND name = 'Negotiation'));
  UPDATE pipeline_stages SET name = 'Separó / compró', clave = 'compro', position = 5, color = '#16a34a'
    WHERE pipeline_id = v_pipe AND (clave = 'compro' OR (clave IS NULL AND name = 'Won'));

  IF NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE pipeline_id = v_pipe AND clave = 'visito') THEN
    INSERT INTO pipeline_stages (pipeline_id, name, position, color, clave) VALUES (v_pipe, 'Visitó', 4, '#14b8a6', 'visito');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE pipeline_id = v_pipe AND clave = 'perdido') THEN
    INSERT INTO pipeline_stages (pipeline_id, name, position, color, clave) VALUES (v_pipe, 'Perdido', 6, '#ef4444', 'perdido');
  END IF;
END $$;

-- Separación aprobada → Separó / compró.
CREATE OR REPLACE FUNCTION public.etapa_por_separacion()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_contacto uuid;
BEGIN
  IF NEW.estado = 'aprobada' AND OLD.estado IS DISTINCT FROM 'aprobada' THEN
    v_contacto := contacto_por_celular('d74b5dfd-2999-4e2c-9a0e-10b3d540898b', NEW.cliente_telefono);
    IF v_contacto IS NOT NULL THEN
      PERFORM mover_etapa_cliente('d74b5dfd-2999-4e2c-9a0e-10b3d540898b', v_contacto, NULL, 'compro', false);
    END IF;
  END IF;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'etapa_por_separacion: %', SQLERRM;
  RETURN NEW;
END $$;

-- Solo si la tabla de separaciones existe en esta base (vive en WioSuite
-- desde la unión del 2026-11-15).
DO $$
BEGIN
  IF to_regclass('public.gh_lotes_solicitudes') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS etapa_por_separacion ON public.gh_lotes_solicitudes;
    CREATE TRIGGER etapa_por_separacion AFTER UPDATE OF estado ON public.gh_lotes_solicitudes
      FOR EACH ROW EXECUTE FUNCTION public.etapa_por_separacion();
  END IF;
END $$;

-- Relleno de Golden: chats → Nuevo / Contestó, citas → Agendó / Visitó,
-- separaciones aprobadas → Separó. Solo avanza: correrlo dos veces no cambia nada.
DO $$
DECLARE
  r record;
  v_contacto uuid;
BEGIN
  FOR r IN
    SELECT c.account_id, c.contact_id, c.id AS conversation_id,
           CASE WHEN EXISTS (
             SELECT 1 FROM messages mc WHERE mc.conversation_id = c.id AND mc.sender_type = 'customer'
               AND EXISTS (SELECT 1 FROM messages ma WHERE ma.conversation_id = c.id
                             AND ma.sender_type IN ('agent', 'bot') AND ma.created_at <= mc.created_at))
           THEN 'contesto' ELSE 'nuevo' END AS clave
    FROM conversations c
    WHERE c.account_id = 'd74b5dfd-2999-4e2c-9a0e-10b3d540898b' AND c.contact_id IS NOT NULL
      AND EXISTS (SELECT 1 FROM messages m WHERE m.conversation_id = c.id AND m.sender_type = 'customer')
  LOOP
    PERFORM mover_etapa_cliente(r.account_id, r.contact_id, r.conversation_id, r.clave, false);
  END LOOP;

  FOR r IN
    SELECT account_id, contact_id, status FROM appointments
    WHERE account_id = 'd74b5dfd-2999-4e2c-9a0e-10b3d540898b' AND contact_id IS NOT NULL AND status <> 'cancelada'
  LOOP
    PERFORM mover_etapa_cliente(r.account_id, r.contact_id, NULL,
      CASE r.status WHEN 'cumplida' THEN 'visito' ELSE 'agendo' END, false);
  END LOOP;

  IF to_regclass('public.gh_lotes_solicitudes') IS NOT NULL THEN
    FOR r IN EXECUTE 'SELECT cliente_telefono FROM public.gh_lotes_solicitudes WHERE estado = ''aprobada''' LOOP
      v_contacto := contacto_por_celular('d74b5dfd-2999-4e2c-9a0e-10b3d540898b', r.cliente_telefono);
      IF v_contacto IS NOT NULL THEN
        PERFORM mover_etapa_cliente('d74b5dfd-2999-4e2c-9a0e-10b3d540898b', v_contacto, NULL, 'compro', false);
      END IF;
    END LOOP;
  END IF;
END $$;
