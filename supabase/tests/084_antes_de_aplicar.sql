-- ============================================================
-- 084_antes_de_aplicar.sql — revisar ANTES de correr la 084
--
-- Solo lectura. Pegar en el SQL Editor de Supabase. Muestra a cada
-- persona de la cuenta con su rol y su área, y qué módulos va a ver
-- cuando se aplique la 084 (y la 067 de Golden Legal).
--
-- Reglas de la 084:
--   · owner y super admin de plataforma: ven todo.
--   · admin ya NO ve todo: necesita área como cualquiera.
--   · Cobranzas: área cobranzas, contabilidad o gerencia.
--   · Cronograma (planes): las anteriores + legal.
--   · Legal: área legal (o fila en legal_members, 067).
--   · Ventas: área ventas o sin área.
-- ============================================================

SELECT a.name                     AS cuenta,
       p.full_name                AS persona,
       p.email,
       p.account_role             AS rol,
       COALESCE(p.area, '(sin área)') AS area,
       (a.owner_user_id = p.user_id) AS es_dueno_de_la_cuenta,
       CASE
         WHEN p.account_role = 'owner' THEN 'todo'
         ELSE concat_ws(', ',
           CASE WHEN p.area IN ('cobranzas', 'contabilidad', 'gerencia') THEN 'cobranzas' END,
           CASE WHEN p.area IN ('cobranzas', 'contabilidad', 'gerencia', 'legal') THEN 'cronograma' END,
           CASE WHEN p.area = 'legal' THEN 'legal' END,
           CASE WHEN p.area IS NULL OR p.area = 'ventas' THEN 'ventas' END)
       END                        AS vera_con_084,
       lm.role                    AS rol_en_golden_legal
  FROM public.profiles p
  JOIN public.accounts a ON a.id = p.account_id
  LEFT JOIN public.legal_members lm ON lm.account_id = p.account_id AND lm.user_id = p.user_id
 WHERE a.name ILIKE '%golden%'
 ORDER BY p.account_role, p.area NULLS FIRST, p.full_name;

-- Para corregir un área (ANTES o DESPUÉS de la 084; después, solo el
-- dueño o gerencia puede cambiar áreas):
-- UPDATE public.profiles SET area = 'cobranzas'  WHERE email = '...';
-- valores: marketing, legal, cobranzas, ventas, gerencia, contabilidad

-- Equipo legal con su rol en Golden Legal (jefe de legal = 'admin'):
-- INSERT INTO public.legal_members (account_id, user_id, role)
-- SELECT p.account_id, p.user_id, 'admin' FROM public.profiles p WHERE p.email = '...'
-- ON CONFLICT DO NOTHING;
