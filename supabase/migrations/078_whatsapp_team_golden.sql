-- WhatsApp team mode for Golden Habitat: Bryce and Eric write to the Golden
-- Habitat number from their own phones and are served by their assistants
-- (Golden Caja, Golden App, Golden Legal) instead of as customers. Both are
-- cash owners, so they can register expenses and income from WhatsApp.
-- Apply after 076. In Golden Caja it is 077; here 077 is the embedded signup.
BEGIN;

DO $$
DECLARE
  golden uuid;
  person record;
BEGIN
  SELECT id INTO golden FROM public.accounts WHERE name = 'Golden Habitat';
  IF golden IS NULL THEN
    RAISE EXCEPTION 'Golden Caja 077: no existe la organización Golden Habitat.';
  END IF;

  FOR person IN
    SELECT * FROM (VALUES
      ('brycebueno15@gmail.com', '+51940421629'),
      ('escalante_2010@hotmail.com', '+51936992808')
    ) AS t(email, phone)
  LOOP
    UPDATE public.profiles p SET phone = person.phone
    FROM auth.users u
    WHERE u.id = p.user_id AND lower(u.email) = person.email;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Golden Caja 077: % no tiene perfil en Wio. Que entre una vez y vuelve a aplicar.', person.email;
    END IF;

    INSERT INTO public.cash_owners(account_id, user_id, granted_by)
    SELECT golden, u.id, a.owner_user_id
    FROM auth.users u, public.accounts a
    WHERE lower(u.email) = person.email AND a.id = golden
    ON CONFLICT DO NOTHING;
  END LOOP;

  INSERT INTO public.whatsapp_team_accounts(account_id) VALUES (golden) ON CONFLICT DO NOTHING;
END $$;

COMMIT;
