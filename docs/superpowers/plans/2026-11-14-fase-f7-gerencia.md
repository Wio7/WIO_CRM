# App de Gerencia (F7) — Fase 1: tablero — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gerencia de Golden (Leandro, Eric, Kevin) ve en una app propia el estado de cobranza, caja de todos los negocios, marketing y lo pendiente de cada área, con alertas en rojo y metas del mes.

**Architecture:** Migración 097 en el ERP (solo objetos nuevos) con tres RPCs de lectura (`gerencia_my_access`, `gerencia_cobranza`, `gerencia_resumen`), la tabla `management_goals` y `gerencia_set_goal`. App Next.js nueva en `Wio7/GERENCIA-GOLDEN` copiada de `marketing-golden`, que llama a esas RPCs y reusa `cash_management_panel` (094) y `marketing_summary` (096).

**Tech Stack:** Postgres/Supabase (plpgsql, RLS), PGlite + vitest para la migración; Next.js 16.2.6, React 19, @supabase/ssr, vitest para la app.

**Spec:** `docs/superpowers/specs/2026-11-14-app-gerencia-design.md` (Fase 1).

## Global Constraints
- Migración `supabase/migrations/097_gerencia.sql`: solo objetos nuevos, idempotente, no reemplaza funciones existentes; `supabase/tests/097_casos.sql` corre como postgres y termina en ROLLBACK; prueba `src/lib/areas/gerencia-097.database.test.ts` que falla con `GERENCIA_SIN_097=1` y pasa sin él (modelo: `marketing-096.database.test.ts`).
- Toda RPC: `SECURITY DEFINER SET search_path = public, pg_temp`, `OWNER TO postgres`, `REVOKE ALL ... FROM PUBLIC, anon`, `GRANT EXECUTE ... TO authenticated`. Cuenta = `profiles.account_id` de `auth.uid()`. Acceso = `public.is_owner_or_gerencia(a)`; si no: `RAISE EXCEPTION 'Solo gerencia' USING ERRCODE = '42501'`.
- Fechas en hora de Lima: `(now() AT TIME ZONE 'America/Lima')::date`. Mes = primer día (`date_trunc('month', ...)::date`).
- Dinero en céntimos `bigint` en todo JSON (`round(x * 100)::bigint` desde `numeric` en soles). Cobranza solo moneda `PEN`; planes en otra moneda se cuentan en `otrasMonedas`.
- Planes que cuentan: `payment_plans.status = 'activo'`. Proyecto de un plan: `payment_plans.unit_id → real_estate_units.project_id`.
- Tramos con la misma regla que `src/lib/collections.ts` `tramoDe`: `"1-30" | "31-60" | "61-90" | "+90"` por los días desde la cuota vencida más antigua del cliente.
- Nombre visible de la app: **"Gerencia Golden"** (nunca "Wio Suite"). Manifiesto en URL fija `/manifest.webmanifest` (lección de Cobranzas 2c70bde).
- Celular y laptop con diseño propio cada uno; estilo Golden (vino y dorado sobre crema).

## Review Focus
1. Cuenta sin planes, sin caja y sin leads: cada RPC devuelve ceros y listas vacías, nunca `null` en totales ni división por cero (`recaudacionPct`, `cumplimientoPct` en `null` si el denominador es 0) — test en Task 2 y Task 3.
2. Pago anulado (`voided_at`) o asiento de caja revertido/transferencia entre cajas no cuenta — test en Task 2 (pago anulado) y Task 3 (reversión y `transfer_id`).
3. Usuario de cobranzas, marketing o de otra cuenta llama a las RPCs: 42501, y la meta de otra cuenta no se puede escribir ni leer — test en Task 1.
4. Proyecto de otra cuenta en `p_project`: error 22023 'Proyecto no válido' — test en Task 2.
5. En la app, una RPC que falla (sin conexión o 42501) muestra el mensaje y no deja la pantalla en blanco ni cifras viejas como si fueran actuales — test de `src/lib/gerencia/datos.ts` en Task 5.

---

### Task 1: 097 — acceso y metas

**Files:**
- Create: `supabase/migrations/097_gerencia.sql`
- Create: `supabase/tests/097_casos.sql`
- Create: `src/lib/areas/gerencia-097.database.test.ts`

**Interfaces:**
- Produces:
  - `public.gerencia_my_access() RETURNS jsonb` → `{"rol": "gerencia" | null, "accountId": uuid | null}`.
  - Tabla `public.management_goals(id uuid pk default gen_random_uuid(), account_id uuid not null → accounts on delete cascade, month date not null check (month = date_trunc('month', month)::date), project_id uuid null → real_estate_projects on delete cascade, kind text not null check in ('cobranza','ventas'), amount_cents bigint null check (>0), units integer null check (>0), set_by uuid → auth.users on delete set null, created_at, updated_at, check ((kind='cobranza' and amount_cents is not null and units is null) or (kind='ventas' and units is not null and amount_cents is null)), UNIQUE NULLS NOT DISTINCT (account_id, month, project_id, kind))`. RLS: SELECT solo `is_owner_or_gerencia(account_id)`; sin políticas de escritura (solo por RPC).
  - `public.gerencia_set_goal(p_month date, p_project uuid, p_kind text, p_value bigint) RETURNS void`: upsert; `p_value` null o 0 borra la meta. `p_kind` inválido → 22023.
  - `public.gerencia_goals(p_month date) RETURNS jsonb` → `[{"projectId": uuid|null, "kind": "cobranza"|"ventas", "value": bigint}]`.

- [ ] **Step 1: Casos que fallan.** En `097_casos.sql` (patrón de `096_casos.sql`: crea cuenta Golden con dueño, gerente (area 'gerencia'), cobranzas, otra cuenta; `set_config('request.jwt.claim.sub', ...)` + `SET LOCAL ROLE authenticated` por actor; `ROLLBACK` al final) y en la prueba PGlite (stubs de `marketing-096.database.test.ts` + `payment_plans`, `installments`, `installment_payments`, `plan_prepayments` según 043/084; aplicar hasta 096, luego 097 dos veces):
  - gerente: `gerencia_my_access()->>'rol' = 'gerencia'`; dueño también; cobranzas: `rol` null.
  - gerente pone meta cobranza 2026-11 total = 5000000 y por proyecto P1 = 2000000; `gerencia_goals('2026-11-01')` devuelve 2 filas; repetir el set actualiza (sigue en 2 filas); `p_value = 0` borra.
  - cobranzas llama `gerencia_set_goal` → 42501; `SELECT` directo a `management_goals` como cobranzas → 0 filas; gerente de la otra cuenta no ve las metas de Golden.
  - `p_kind = 'otra'` → 22023; mes no primer día se normaliza al primer día.
- [ ] **Step 2:** `GERENCIA_SIN_097=1 npx vitest run src/lib/areas/gerencia-097.database.test.ts` → FAIL (función no existe).
- [ ] **Step 3:** Implementar en `097_gerencia.sql` (cabecera con pedido de Bryce 2026-11-14, qué crea, "Idempotente").
- [ ] **Step 4:** `npx vitest run src/lib/areas/gerencia-097.database.test.ts` → PASS.
- [ ] **Step 5:** Commit `097: acceso de gerencia y metas del mes`.

### Task 2: 097 — `gerencia_cobranza`

**Files:** Modify `supabase/migrations/097_gerencia.sql`, `supabase/tests/097_casos.sql`, `src/lib/areas/gerencia-097.database.test.ts`.

**Interfaces:**
- Consumes: `management_goals` (Task 1); vistas `installment_balances`, `payment_plan_balances` (084).
- Produces: `public.gerencia_cobranza(p_month date DEFAULT NULL, p_project uuid DEFAULT NULL) RETURNS jsonb`:
```
{ month, projectId, projects:[{id,name}],
  cartera:{ totalCents, vigenteCents, vencidaCents, planes },
  tramos:[{ tramo:"1-30"|"31-60"|"61-90"|"+90", cents, clientes }],   -- siempre los 4, en ese orden
  mes:{ venciaCents, cobradoDeLoQueVenciaCents, cobradoTotalCents,
        recaudacionPct|null, metaCents|null, cumplimientoPct|null },
  porDia:[{ dia:"YYYY-MM-DD", cents }],                               -- solo días con pagos
  morosos:[{ contactId, name, phone, projectName, unit, diasAtraso, tramo, vencidoCents, ultimoPago|null }],  -- top 20
  otrasMonedas }
```
  Reglas: cartera = `pending_amount` (total) y `overdue_amount` (vencida) de planes activos PEN; vigente = total − vencida. `venciaCents` = suma de `installments.amount` con `due_date` en el mes y `status <> 'condonada'`; `cobradoDeLoQueVenciaCents` = venciaCents − suma de `installment_balances.remaining` de esas cuotas; `cobradoTotalCents` y `porDia` = `installment_payments.amount` no anulados con `paid_on` en el mes; `recaudacionPct = round(100 * cobradoDeLoQueVencia / vencia, 1)`; meta = `management_goals` cobranza del mes y del proyecto (o la total si `p_project` es null); `cumplimientoPct = round(100 * cobradoTotal / meta, 1)`. Morosos: un renglón por cliente (contacto), días desde su cuota vencida pendiente más antigua, orden días desc y luego monto desc; `ultimoPago` = último `paid_on` no anulado de sus planes.

- [ ] **Step 1: Casos que fallan.** Datos: P1 con 2 clientes; cliente A con cuota vencida hace 95 días (S/ 300) y otra hace 10 días (S/ 300); cliente B al día; un pago de S/ 150 anulado en el mes; un pago válido de S/ 300 en el mes a una cuota que vencía en el mes; un plan en USD. Asserts: `tramos` = 4 renglones y A cae en `+90` con 60000; `mes.cobradoTotalCents` excluye el anulado; `otrasMonedas = 1`; sin meta → `metaCents` y `cumplimientoPct` null; con meta 60000 → `cumplimientoPct = 50.0`; cuenta vacía → `cartera.totalCents = 0`, `recaudacionPct` null; `p_project` de otra cuenta → 22023; cobranzas → 42501.
- [ ] **Step 2:** con `GERENCIA_SIN_097=1` → FAIL.
- [ ] **Step 3:** Implementar `gerencia_cobranza`.
- [ ] **Step 4:** PASS.
- [ ] **Step 5:** Commit `097: resumen de cobranza para gerencia`.

### Task 3: 097 — `gerencia_resumen` (portada, alertas y áreas)

**Files:** Modify los tres archivos de Task 2.

**Interfaces:**
- Consumes: `gerencia_cobranza` (Task 2), `management_goals`.
- Produces: `public.gerencia_resumen(p_month date DEFAULT NULL) RETURNS jsonb`:
```
{ month,
  kpis:{ cobrado:{cents, prevCents, metaCents|null},
         morosidadPct|null,                -- vencida / total de cartera
         cartera90Cents,
         cajaGasto:{cents, prevCents},      -- todas las cajas de la cuenta
         leads:{count, prevCount},
         separaciones:{count, prevCount, metaUnits|null},
         pendientesAreas },
  alertas:[{ clave, nivel:"rojo"|"ambar", titulo, detalle, ruta }],
  areas:[{ area, pendientes, masAntiguoDias|null }] }
```
  Gasto de caja: `cash_entries` de la cuenta, `kind='expense'`, `reversal_of IS NULL`, sin otra fila que lo revierta, `to_jsonb(e)->>'transfer_id' IS NULL` (criterio de 094:76), `occurred_on` en el mes. Leads: `contacts.created_at` en el mes (Lima). Separaciones: `reservations` del mes con `status <> 'rechazada'`. Alertas (en este orden, solo las que aplican):
  - `cartera90` rojo si `cartera90Cents > 0` → ruta `/cobranza?tramo=%2B90`.
  - `meta_cobranza` rojo si hay meta, el mes es el actual y `cobrado/meta < (día/días del mes) − 0.10` → `/cobranza`.
  - `banco` ámbar si hay `bank_statement_movements` en `por_conciliar` o `revisar` con `fecha` de hace más de 7 días → `/areas`.
  - `traspasos` ámbar si hay `module_handoffs` `pendiente` con más de 3 días → `/areas`.
  - `caja` ámbar si `prevCents > 0` y `cents > prevCents * 1.2` → `/caja`.
  Áreas (siempre estos 5, en este orden): `cobranzas` (cuotas `pendiente` con `voucher_path` + traspasos recibidos pendientes), `legal` y `postventa` (traspasos recibidos pendientes), `administracion` (movimientos por conciliar), `marketing` (`marketing_pieces` en `en_revision`); `masAntiguoDias` desde el `created_at`/`fecha` más antiguo cuando existe.

- [ ] **Step 1: Casos que fallan.** Gasto de caja: un gasto, su reversión y una transferencia → solo cuenta el gasto no revertido; mes anterior con gasto 100 y actual 130 → alerta `caja`; traspaso pendiente de hace 4 días → alerta `traspasos` y `areas[legal].pendientes = 1`; movimiento de banco por conciliar de hace 8 días → alerta `banco`; cuenta vacía → `alertas = []`, `areas` con 5 renglones en 0, `morosidadPct` null; cobranzas → 42501.
- [ ] **Step 2:** FAIL con `GERENCIA_SIN_097=1`.
- [ ] **Step 3:** Implementar `gerencia_resumen`.
- [ ] **Step 4:** PASS; además `npx vitest run src/lib/areas` completo (096 sigue verde).
- [ ] **Step 5:** Commit `097: portada de gerencia con alertas y areas`.
- [ ] **Step 6:** Revisión EGM de la 097 (egm-codebase-details + egm-design); corregir; PR a `main` de Wio7/WIO_CRM; con CI verde, fusionar; copiar la 097 a `Wio\CRM WIO\097-gerencia-2026-11-14.sql` para Bryce.

### Task 4: App — esqueleto en `GERENCIA-GOLDEN`

**Files:**
- Create: repo local `Wio\CRM WIO\gerencia-golden` (clonar `Wio7/GERENCIA-GOLDEN`), copiando de `marketing-golden` todo menos `src/**/marketing*`, `src/hooks/use-marketing.tsx`, `src/lib/storage/*`, `src/app/(app)/{calendario,leads,tareas}`, `src/app/demo/{calendario,leads,tareas}`.
- Create: `src/lib/gerencia/acceso.ts`, `src/hooks/use-gerencia.tsx`, `src/components/gerencia/gerencia-shell.tsx`.
- Modify: `src/lib/apps/nombres.ts` (`gerencia: { golden: "Gerencia Golden", generico: "Gerencia" }`), `src/app/manifest.webmanifest/route.ts` (nombre fijo), `src/app/icono/[size]/route.tsx` (ícono propio: gráfico de barras con check, vino y dorado), `package.json` (`name: "gerencia-golden"`, dev port 3125), `README.md`.

**Interfaces:**
- Produces: `type SeccionClave = "inicio" | "cobranza" | "caja" | "marketing" | "areas" | "metas"`; `RUTA_SECCION = { inicio:"/", cobranza:"/cobranza", caja:"/caja", marketing:"/marketing", areas:"/areas", metas:"/metas" }`; `seccionDeRuta(pathname): SeccionClave | null`; `useGerencia(): { estado: "cargando" | "sin-acceso" | "listo", accountId: string | null }` (llama `gerencia_my_access`). `GerenciaShell` = `GoldenFrame` con las 6 secciones, `instalarScope="/"`, Mi cuenta.

- [ ] **Step 1:** Tests: `seccionDeRuta("/cobranza?tramo=x")` → `"cobranza"`; `"/x"` → null; `nombreApp("gerencia","Golden Habitat")` → `"Gerencia Golden"`; manifiesto devuelve `name: "Gerencia Golden"`, `id: "/"`; `app-paths` deja públicas `/login`, `/demo`, `/manifest.webmanifest`, `/icono/192`.
- [ ] **Step 2:** `npx vitest run` → FAIL.
- [ ] **Step 3:** Implementar; sin acceso → pantalla "Esta app es de otra área" (como Marketing).
- [ ] **Step 4:** `npx tsc --noEmit`, `npx eslint`, `npx vitest run` → verde.
- [ ] **Step 5:** Commit `Gerencia Golden: esqueleto (login, marco, instalar, Mi cuenta)`.

### Task 5: App — lógica pura y datos

**Files:** Create `src/lib/gerencia/{tipos.ts,formato.ts,kpis.ts,datos.ts,demo-datos.ts,gerencia.test.ts}`.

**Interfaces:**
- Consumes: JSON de Tasks 1–3 (tipos espejo en `tipos.ts`: `Cobranza`, `Resumen`, `Meta`).
- Produces: `soles(cents: number): string` ("S/ 1,234.50"); `delta(actual: number, previo: number): { pct: number | null; sentido: "sube" | "baja" | "igual" }` (pct null si previo = 0); `semaforoMeta(valor: number, meta: number | null, avanceMes: number): "verde" | "ambar" | "rojo" | null` (null sin meta; rojo si valor/meta < avanceMes − 0.10, ámbar si < avanceMes, si no verde); `avanceDelMes(hoy: string, mes: string): number` (1 si el mes ya pasó); `cargar<T>(rpc: string, args: object): Promise<{ ok: true; data: T } | { ok: false; mensaje: string }>` (42501 → "No tienes acceso de gerencia", otro error → "No se pudo cargar. Revisa tu conexión."); `DEMO_RESUMEN`, `DEMO_COBRANZA`.
- [ ] **Step 1:** Tests con valores: `soles(123450)` → `"S/ 1,234.50"`; `delta(130,100).pct` → 30; `delta(5,0).pct` → null; `semaforoMeta(40,100,0.6)` → `"rojo"`; `semaforoMeta(55,100,0.6)` → `"ambar"`; `semaforoMeta(70,100,0.6)` → `"verde"`; `avanceDelMes("2026-11-15","2026-11-01")` → 0.5; `avanceDelMes("2026-12-02","2026-11-01")` → 1; `cargar` con error `{code:"42501"}` → `{ok:false, mensaje:"No tienes acceso de gerencia"}`.
- [ ] **Step 2:** FAIL. **Step 3:** Implementar. **Step 4:** PASS. **Step 5:** Commit `Gerencia: calculos y datos`.

### Task 6: App — Inicio y Cobranza

**Files:** Create `src/app/(app)/page.tsx`, `src/app/(app)/cobranza/page.tsx`, `src/components/gerencia/{inicio-view.tsx,cobranza-view.tsx,kpi-card.tsx,alertas.tsx}`, `src/app/demo/{page.tsx,cobranza/page.tsx}`, `src/app/gerencia.css`.

**Interfaces:** Consumes `gerencia_resumen`, `gerencia_cobranza`, `semaforoMeta`, `delta`, `soles`, `DEMO_*`.
- Inicio: arriba las alertas (rojo primero) como botones a su `ruta`; debajo 6 tarjetas: Cobrado del mes (vs meta y vs mes anterior), Morosidad %, Cartera +90, Gasto de caja (vs mes anterior), Leads y Separaciones (vs mes anterior y meta), Pendientes de áreas. Cada tarjeta lleva a su sección. Selector de mes.
- Cobranza: filtro de proyecto y mes en la URL (`?mes=2026-11&proyecto=<id>&tramo=%2B90`); 4 tramos clicables que filtran la lista; recaudación del mes y barra de cumplimiento; cobrado por día; lista de morosos con botón WhatsApp (`https://wa.me/<phone>`) y búsqueda.
- Celular: una columna, tarjetas apiladas, tabla de morosos como tarjetas. Laptop: grilla de 3 columnas y tabla.
- [ ] **Step 1:** Test de componente puro opcional no requerido; verificación visual en Step 3.
- [ ] **Step 2:** Implementar con estados cargando / error (mensaje de `cargar`, sin cifras) / listo.
- [ ] **Step 3:** `npx next build --webpack`; `/demo` y `/demo/cobranza` revisadas a 375 px y 1280 px en el navegador; filtro de tramo cambia la lista.
- [ ] **Step 4:** Commit `Gerencia: Inicio y Cobranza`.

### Task 7: App — Caja, Marketing, Áreas y Metas

**Files:** Create `src/app/(app)/{caja,marketing,areas,metas}/page.tsx`, `src/components/gerencia/{caja-view.tsx,marketing-view.tsx,areas-view.tsx,metas-view.tsx}`, `src/app/demo/{caja,marketing,areas,metas}/page.tsx`.

**Interfaces:** Consumes `cash_management_panel(p_month, p_company)` (094, jsonb con `byCompany`, `byProject`, `byRubro`, `byMonth`), `marketing_summary(p_month, p_project)` (096), `gerencia_resumen().areas`, `gerencia_goals`, `gerencia_set_goal`.
- Caja: total del mes, por negocio (`byCompany`), por proyecto y rubro, 12 meses; tocar un negocio filtra con `p_company`.
- Marketing: leads por canal, gasto, costo por lead y por separación, tendencia (reusar el layout de `marketing-golden/src/components/marketing/resumen-view.tsx`).
- Áreas: un renglón por área con pendientes y "hace N días"; ámbar si `masAntiguoDias > 3`.
- Metas: por mes, una fila "Total" y una por proyecto, con meta de cobranza (S/) y de ventas (lotes); guardar llama `gerencia_set_goal` y muestra "Guardado".
- [ ] **Step 1:** Implementar las 4 vistas y sus demos.
- [ ] **Step 2:** tsc, eslint, vitest, build verdes; demos revisadas a 375 px y 1280 px.
- [ ] **Step 3:** Commit `Gerencia: Caja, Marketing, Areas y Metas`.

### Task 8: Publicar y anotar
- [ ] **Step 1:** `next start` + `curl /login` (manifiesto `/manifest.webmanifest`), `curl /manifest.webmanifest` (`"name":"Gerencia Golden"`).
- [ ] **Step 2:** Push a `main` de `Wio7/GERENCIA-GOLDEN`; avisar a Bryce que conecte Vercel (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`) y corra `097-gerencia-2026-11-14.sql`.
- [ ] **Step 3:** Vault: [[ERP de Golden Habitat]] (Recent Activity), `Diario/2026-11-14.md`, `Logs/2026-11-14.md`.
