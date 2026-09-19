-- ============================================================
-- 053_messenger_instagram.sql — los chats de Facebook e Instagram
--
-- La conexión con Meta vive en la 037 ("Conectar con Facebook" guarda el
-- token de cada página). Esto le añade lo que falta para conversar:
--
--   meta_pages.instagram_id     la cuenta profesional de Instagram
--                               vinculada a la página. Los mensajes de
--                               Instagram llegan con ese id, y así se sabe
--                               de qué cuenta del CRM son.
--   meta_pages.messaging_at     cuándo se suscribió la página a los
--                               mensajes (NULL = sólo recibe leads).
--   contacts.messenger_psid     quién escribe por Messenger (el id que Meta
--   contacts.instagram_id       da por página) y por Instagram. No traen
--                               celular: el contacto nace con phone = ''
--                               (el índice único de 022 ignora los vacíos).
--
-- Si la 037 no se ha corrido todavía, `meta_pages` no existe: entonces se
-- avisa y se omite esa parte en vez de tumbar la migración entera. Las
-- columnas de `contacts` se añaden igual, y al correr la 037 basta con
-- volver a pasar por aquí.
--
-- Idempotente — se puede volver a correr.
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.meta_pages') IS NULL THEN
    RAISE NOTICE 'Sin meta_pages (037 sin ejecutar): Messenger e Instagram quedan pendientes.';
  ELSE
    ALTER TABLE meta_pages ADD COLUMN IF NOT EXISTS instagram_id text;
    ALTER TABLE meta_pages ADD COLUMN IF NOT EXISTS instagram_username text;
    ALTER TABLE meta_pages ADD COLUMN IF NOT EXISTS messaging_at timestamptz;

    CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_pages_instagram
      ON meta_pages(instagram_id)
      WHERE instagram_id IS NOT NULL;
  END IF;
END $$;

ALTER TABLE contacts ADD COLUMN IF NOT EXISTS messenger_psid text;
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS instagram_id text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_messenger
  ON contacts(account_id, messenger_psid)
  WHERE messenger_psid IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_instagram
  ON contacts(account_id, instagram_id)
  WHERE instagram_id IS NOT NULL;

COMMENT ON COLUMN contacts.messenger_psid IS 'Id del usuario en Messenger para la página conectada (PSID).';
COMMENT ON COLUMN contacts.instagram_id IS 'Id del usuario en Instagram para la cuenta conectada (IGSID).';
