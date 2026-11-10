# Fase F1 — Conexiones entre áreas: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Traspasos entre áreas con botón y bandeja "Te enviaron" / "Enviados": conexiones #3 (Cobranzas → Legal) y #10 (Cobranzas o Legal → Postventa).

**Architecture:** La base es la única que crea y cambia traspasos (tabla `module_handoffs` + RPCs SECURITY DEFINER). El traspaso guarda solo la referencia; lo que ve el área destino lo arma el servidor (`my_handoffs`). Las apps solo pintan lo que devuelve la RPC, así Golden Legal (otro repo) y el ERP muestran lo mismo sin compartir código.

**Tech Stack:** Next.js 16 + React 19, Supabase/Postgres 15 (RLS), Vitest, PGlite para pruebas de SQL.

**Spec:** `docs/superpowers/specs/2026-11-09-fase-f-apps-y-conexiones-design.md` (v2, §4, §5, §5.1, §6.1).

## Global Constraints
- Migración `supabase/migrations/085_conexiones.sql`, idempotente; la corre el dueño a mano después de la 084.
- Sin copia de datos en el traspaso: solo `entity_type` + `entity_id`; el resumen lo arma `my_handoffs` en el servidor.
- Ningún traspaso mueve dinero ni crea planes.
- Código compatible antes de aplicar 085: si falta la RPC (`PGRST202`), no se muestran botones ni bandeja de traspasos y nada falla.
- Nombres genéricos; nada "Golden" en el código del ERP. Textos de la interfaz en español.
- Laptop y celular con vistas separadas (no una vista estirada).
- Fechas en día de Lima (`hoyLima`).

**Fuera de F1 (decisión del plan):** el login dentro del `scope` de cada app y "cada persona aterriza en su app" se hacen en F4, cuando existan las rutas de las apps nuevas; en F1 solo se arregla el retorno tras el login (lista blanca) y las rutas protegidas. La pestaña de postventa que **recibe** los casos #10 es F2 (app de ventas), inmediatamente después.

## Review Focus
1. Doble clic en "Pasar a legal": queda un solo traspaso pendiente (Task 1, caso SQL).
2. Dos personas de legal aceptan a la vez: uno queda como "atendido por", el otro recibe "ya lo tomó …" (Task 1, caso SQL).
3. Un asesor de ventas o alguien de marketing no puede leer traspasos ni su resumen con la deuda (Task 1, caso SQL).
4. Enviar a postventa cuando nadie tiene el módulo postventa: el botón avisa "Todavía no hay nadie en Postventa" y no envía (Task 1 `handoff_destination_ready`, Task 3 UI).
5. Devolver sin motivo: rechazado por la base (Task 1, caso SQL).

---

### Task 1: Migración 085 (tabla, RPCs y casos SQL)

**Files:**
- Create: `supabase/migrations/085_conexiones.sql`, `supabase/tests/085_casos.sql`
- Create: `src/lib/handoffs/handoffs-085.database.test.ts` con el patrón de `src/lib/payment-plans/payments-084.database.test.ts` (PGlite): mismos stubs, más `real_estate_projects(id uuid pk, account_id uuid, name text)` y `real_estate_units(id, account_id, project_id uuid, code text, manzana text)`; aplica exactamente 043, 047, 052, 082, 083, 084, luego 085 dos veces, y corre `085_casos.sql`. Los usuarios de prueba usan correos con prefijo `t085-` y la prueba verifica que no queden.

**Interfaces:**
- Consumes: de la 084 `can_access_module(uuid, text)`, `has_full_access(uuid)`, `account_module_members`, `profiles.area`, `collection_actions` (082/084, resultado `pase_legal`), `payment_plan_balances`.
- Produces:
  - Áreas: recrear `profiles_area_check` y `set_member_area` (084:77-78, lista fija de áreas) con `'tecnica'`. `account_module_members`: `DROP CONSTRAINT IF EXISTS account_module_members_module_key_check` y volver a crearla con `'postventa'`. `can_access_module(..., 'postventa')` = solo fila explícita (o acceso total).
  - `sent_by`, `handled_by`, `assigned_to` referencian `auth.users(id) ON DELETE SET NULL`; los nombres salen de `profiles.full_name`.
  - Tabla `module_handoffs(id uuid pk, account_id, kind text, from_module text, to_module text, entity_type text, entity_id uuid, topic text null, note text null, status text check in ('pendiente','aceptado','devuelto') default 'pendiente', return_reason text null, sent_by uuid, assigned_to uuid null, handled_by uuid null, created_at, handled_at)`. Índice único parcial `(account_id, kind, entity_id) WHERE status = 'pendiente'`.
  - Tipos (fijos en la RPC; tabla de verdad en `src/lib/handoffs/kinds.ts`, Task 2):
    - `pase_legal`: cobranzas → legal, `entity_type 'payment_plan'`.
    - `postventa_desde_cobranzas`: cobranzas → postventa, `entity_type 'contact'`, `topic` en (`ubicacion`, `avance_obra`, `entrega`, `documentos`, `otro`).
    - `postventa_desde_legal`: legal → postventa, igual que el anterior.
  - RPCs (SECURITY DEFINER, dueño postgres, `search_path = public`):
    - `send_handoff(p_kind text, p_entity_id uuid, p_note text default null, p_topic text default null) returns uuid` — valida tipo, entidad de la cuenta del usuario, módulo origen (`can_access_module`), topic válido si es postventa; no duplica: `INSERT … ON CONFLICT (account_id, kind, entity_id) WHERE status = 'pendiente' DO NOTHING RETURNING id` y, si no insertó, `SELECT` del pendiente existente. Efecto `pase_legal`, **solo cuando insertó**: agrega en `collection_actions` el resultado `pase_legal` del contacto del plan (canal `otro`, nota = `p_note`).
    - `accept_handoff(p_id uuid) returns void` — `FOR UPDATE`; exige `status='pendiente'` y módulo destino; si ya no está pendiente: error `'Ya lo tomó %'` con el nombre de `handled_by`.
    - `return_handoff(p_id uuid, p_reason text) returns void` — módulo destino; motivo no vacío (`'Escribe el motivo'`); estado `devuelto`.
    - `my_handoffs(p_module text, p_box text) returns setof jsonb` — `p_box` en (`recibidos`, `enviados`); solo filas cuyo origen (enviados) o destino (recibidos) es `p_module` y el usuario tiene ese módulo; cada fila: `id, kind, status, topic, note, return_reason, sent_by_name, handled_by_name, created_at, handled_at, summary`. `summary` por tipo: `pase_legal` → `{contact_id, plan_id, cliente, telefono, deuda_total, cuotas_vencidas, gestiones: [últimas 5 {fecha, resultado, nota}]}`; postventa → `{contact_id, cliente, telefono, lote, proyecto}`. Fuentes: `deuda_total = payment_plan_balances.pending_amount`, `cuotas_vencidas = payment_plan_balances.overdue_count`; `lote`/`proyecto` = planes del contacto → `payment_plans.unit_id` → `real_estate_units.manzana || '-' || code` y `real_estate_projects.name`, con `string_agg(DISTINCT …)`. Orden: `created_at DESC`.
    - `handoff_destination_ready(p_kind text) returns boolean` — hay al menos una persona de la cuenta con el módulo destino, contando **solo** filas de `account_module_members` con ese `module_key` y, para legal, también `profiles.area = 'legal'`. El dueño y el super admin **no cuentan** (si no, siempre sería true).
  - RLS en `module_handoffs`: SELECT solo si el usuario tiene el módulo origen o destino de la fila; sin INSERT/UPDATE/DELETE para `authenticated`/`anon` (REVOKE como en la 084).

- [ ] **Step 1: Escribir `supabase/tests/085_casos.sql`** con el patrón de `084_casos.sql` (DO blocks, `RAISE EXCEPTION 'FALLO …'`, ROLLBACK al final, termina en `SELECT '085: todos los casos OK' AS resultado`): cobranzas envía `pase_legal` dos veces → 1 fila pendiente y 1 gestión `pase_legal`; legal acepta → `aceptado`; segunda aceptación → error que contiene `Ya lo tomó`; devolver sin motivo → error; asesor de ventas `SELECT` en `module_handoffs` → 0 filas y `my_handoffs('legal','recibidos')` → 0 filas; `handoff_destination_ready('postventa_desde_cobranzas')` → false sin filas postventa, true tras agregar una; `send_handoff('postventa_desde_cobranzas', contacto, null, 'xx')` → error de topic; legal envía `postventa_desde_legal` → ok.
- [ ] **Step 2: Escribir `handoffs-085.database.test.ts`** (aplica 085 dos veces y corre los casos; espera `'085: todos los casos OK'`). Ver fallar: `npx vitest run src/lib/handoffs/handoffs-085.database.test.ts` → FAIL (falta 085).
- [ ] **Step 3: Escribir `085_conexiones.sql`** según Interfaces.
- [ ] **Step 4: Ver pasar** (mismo comando) y `npx vitest run src/lib/payment-plans` sigue verde.
- [ ] **Step 5: Commit** `feat(db): 085 traspasos entre áreas`

### Task 2: Lógica TS de traspasos

**Files:**
- Create: `src/lib/handoffs/kinds.ts`, `src/lib/handoffs/rpc.ts`
- Test: `src/lib/handoffs/kinds.test.ts`, `src/lib/handoffs/rpc.test.ts`

**Interfaces:**
- Consumes: RPCs de Task 1; `isMissing084`-style detección en `src/lib/payment-plans/rpc.ts` (reusar su helper de PostgREST, no copiarlo).
- Produces:
  - `HandoffKind = "pase_legal" | "postventa_desde_cobranzas" | "postventa_desde_legal"`; `HandoffModule = "cobranzas" | "legal" | "postventa"`; `HandoffTopic = "ubicacion" | "avance_obra" | "entrega" | "documentos" | "otro"`.
  - `HANDOFF_KINDS: Record<HandoffKind, { from: HandoffModule; to: HandoffModule; button: string; entityType: "payment_plan" | "contact" }>` con botones `"Pasar a legal"`, `"Enviar a postventa"`, `"Enviar a postventa"`.
  - `TOPIC_LABELS: Record<HandoffTopic, string>` = Ubicación, Avance de obra, Entrega, Documentos, Otro. `kindsFrom(module) → HandoffKind[]`.
  - `HandoffRow` (forma de `my_handoffs`), `sendHandoff(supabase, {kind, entityId, note?, topic?})`, `acceptHandoff(supabase, id)`, `returnHandoff(supabase, id, reason)`, `listHandoffs(supabase, module, box)`, `destinationReady(supabase, kind)`: cada uno `Promise<{ ok: true; data? } | { ok: false; missing085: boolean; message: string }>`.

- [ ] **Step 1: Tests** — `kindsFrom("cobranzas")` = `["pase_legal","postventa_desde_cobranzas"]`; `kindsFrom("legal")` = `["postventa_desde_legal"]`; `kindsFrom("postventa")` = `[]`; rpc con cliente falso: `PGRST202` → `missing085: true`; error normal → `message`; `returnHandoff` con motivo vacío no llama a la RPC y devuelve `{ok:false, message:"Escribe el motivo"}`.
- [ ] **Step 2: Ver fallar** `npx vitest run src/lib/handoffs/kinds.test.ts src/lib/handoffs/rpc.test.ts`.
- [ ] **Step 3: Implementar** `kinds.ts` y `rpc.ts`.
- [ ] **Step 4: Ver pasar** (mismo comando) y `npx tsc --noEmit -p .`.
- [ ] **Step 5: Commit** `feat: lógica de traspasos entre áreas`

### Task 3: Bandeja y botones en el ERP + entrada a apps

**Files:**
- Create: `src/components/handoffs/handoff-inbox.tsx` (bandeja compartida: pestañas "Te enviaron" / "Enviados", tarjeta con resumen, Aceptar, Devolver con motivo; layout de laptop en tabla/lista ancha y de celular en tarjetas apiladas), `src/components/handoffs/send-handoff-button.tsx` (botón + diálogo con nota y, si es postventa, tema; desactivado con aviso "Todavía no hay nadie en Postventa" si `destinationReady` es false), `src/app/(dashboard)/collections/bandeja/page.tsx`, `src/lib/app-paths.ts`
- Modify: `src/app/(dashboard)/collections/page.tsx` (por fila `Debtor`: "Pasar a legal" con `entityId={d.worstPlan.planId}`, solo si `enCausal(d)` y `d.worstPlan` no es null; "Enviar a postventa" con `entityId={d.contactId}`; enlace "Bandeja" con contador de recibidos pendientes), `src/middleware.ts`, `src/app/(auth)/login/page.tsx` (línea ~95 también compara con `"/caja"`: usar `safeNextPath`)
- Test: `src/lib/app-paths.test.ts`

**Interfaces:**
- Consumes: Task 2.
- Produces: `<HandoffInbox module={HandoffModule} />`, `<SendHandoffButton kind={HandoffKind} entityId={string} />`; `APP_PATHS = ["/caja"] as const`; `safeNextPath(next: string | null): string` (devuelve `next` si para algún `base` de `APP_PATHS` o `/dashboard` se cumple `next === base || next.startsWith(base + "/")`; si no, `/dashboard`).

- [ ] **Step 1: Test** `safeNextPath("/caja")` = `/caja`; `safeNextPath("/caja/demo")` = `/caja/demo`; `safeNextPath("/cajaevil")` = `/dashboard`; `safeNextPath("https://evil.com")` = `/dashboard`; `safeNextPath("//evil.com")` = `/dashboard`; `safeNextPath(null)` = `/dashboard`.
- [ ] **Step 2: Ver fallar / implementar `app-paths.ts` / ver pasar** `npx vitest run src/lib/app-paths.test.ts`.
- [ ] **Step 3: Middleware y login:** usar `safeNextPath` en la redirección tras login en el middleware y en `login/page.tsx` (reemplazan el `=== '/caja'`); agregar `/caja` y `/collections` a `protectedPaths`; la redirección de una ruta protegida a `/login` pone `next=<pathname>`.
- [ ] **Step 4: UI** según Files; con `missing085` no se muestran botones ni el enlace "Bandeja".
- [ ] **Step 5:** `npx vitest run`, `npx tsc --noEmit -p .`, `npx eslint` de los archivos tocados; commit `feat(cobranzas): pasar a legal, enviar a postventa y bandeja`

### Task 4: Bandeja en Golden Legal (repo `GOLDEN LEGAN`)

**Files:**
- Create: `src/app/api/legal/handoffs/route.ts` (GET `?box=recibidos|enviados` → `my_handoffs('legal', box)`; POST `{action:'accept'|'return'|'send_postventa', id?, reason?, contactId?, topic?, note?}` → RPC correspondiente), `src/components/legal/handoffs-view.tsx`
- Modify: `src/components/legal/legal-app.tsx` (sección nueva `{ id: 'handoffs', label: 'Te enviaron', short: 'Bandeja', subtitle: 'Casos de otras áreas', usesData: false }` con contador de pendientes)
- Test: `src/app/api/legal/handoffs/route.test.ts` (patrón de `src/app/api/legal/route.test.ts`)

**Interfaces:**
- Consumes: RPCs de Task 1 (misma base). Forma de fila = `HandoffRow` de Task 2 (repetir el tipo localmente; repos separados).
- Produces: en un `pase_legal` recibido, botón "Enviar a postventa" que llama `send_postventa` con el contacto del resumen (`summary.contact_id`; **Task 1 debe incluir `contact_id` en el `summary` de `pase_legal`**).

- [ ] **Step 1: Tests de la ruta** (con `vi.mock('@/lib/auth/account')` para `getCurrentAccount` / `toErrorResponse`, como `src/app/api/legal/route.test.ts`): POST sin el mismo chequeo de Origin que `api/legal/route.ts` → 403; sin sesión → 401; `box` inválido → 400; `return` sin motivo → 400 `"Escribe el motivo"`; RPC ausente (`PGRST202`) → 200 con `{ missing: true, items: [] }`.
- [ ] **Step 2: Ver fallar / implementar / ver pasar** `npm test`.
- [ ] **Step 3: UI** de la sección (laptop y celular separados, como las secciones existentes); con `missing: true` la sección no aparece.
- [ ] **Step 4:** `npm test`, typecheck y lint del repo; commit `feat: bandeja de traspasos en legal`

### Task 5: Revisión y publicación
- [ ] Revisión final (superpowers + EGM codebase-details) sobre todo el rango de los dos repos; corregir hallazgos.
- [ ] PR a `Wio7/WIO_CRM`, fusionar tras CI y verificar GitHub + Vercel; push de Golden Legal a su `main`; entregar al dueño 085 + `085_casos.sql`.
