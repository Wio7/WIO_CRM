# Fase A — Pagos protegidos y acceso por módulo: plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Libro de pagos con pagos en partes y adelantos protegidos en la base, acceso por módulo según área, y las pantallas diarias de cobranza.

**Architecture:** La base es la única que mueve dinero (RPCs SECURITY DEFINER + trigger por `current_user`). Las vistas `installment_balances` y `payment_plan_balances` son la única fuente de saldos. La lógica pura de TS (mora por contrato, causal, adelantos) tiene pruebas y las pantallas solo la usan.

**Tech Stack:** Next.js 16 + React 19, Supabase/Postgres 15 (RLS), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-07-fase-a-pagos-y-reglas-design.md` (v2, §9 respuestas del dueño).

## Global Constraints
- Migración `supabase/migrations/084_pagos_protegidos.sql`, idempotente; la corre el dueño a mano.
- Acceso total: `owner` y super admin de plataforma; `admin` NO abre todos los módulos.
- Áreas: Cobranzas → `cobranzas`, `contabilidad`, `gerencia`; cronograma también `legal`.
- Golden: mora `diaria` S/ 6, gracia 1 día, tope 60 días, **por contrato**, solo referencia; partes máx 3 (aviso); resolución 2 cuotas / 60 días.
- Fechas en día de Lima (`hoyLima`). Céntimos enteros en cálculos de dinero.
- Código compatible antes de aplicar 084: si falta el RPC, aviso "falta aplicar la migración 084"; nunca escribir dinero directo.
- Nombres genéricos (Wio Suite); nada "Golden" en código.

## Review Focus
1. Voucher del cliente por una parte: aprobarlo registra solo ese monto y la cuota queda pendiente con `remaining` correcto (Task 2, Task 4).
2. Cliente con 3 cuotas vencidas: mora = S/ 6 × días desde la más antigua, una sola vez por plan, tope S/ 360 (Task 1).
3. Agente que se pone `area='cobranzas'` a sí mismo: rechazado por la base (Task 2, caso SQL).
4. Asesor de ventas en la bandeja/asistente: ve "sin acceso", nunca "no es cliente" (Task 4).
5. Pantalla vieja tras un pago parcial: registrar más de lo que falta es rechazado (Task 2, caso SQL).

---

### Task 1: Lógica pura (saldos, mora por contrato, causal, adelantos)

**Files:**
- Modify: `src/lib/late-fees.ts`, `src/lib/collections.ts`
- Create: `src/lib/advance-payments.ts`
- Test: `src/lib/late-fees.test.ts`, `src/lib/collections.test.ts`, `src/lib/advance-payments.test.ts`

**Interfaces:**
- Produces: `LateFeeType` += `"diaria"`; `LateFeeSettings` += `capDays: number`; `contractLateFee(oldestOverdueDue: string | null, today: string, s: LateFeeSettings): number`; `lateFeesByDebtor` pasa a calcular por plan (`plan_id`) con `contractLateFee` para `diaria`; `OverdueInstallment` += `remaining?: number | string` (si viene, se usa en lugar de `amount`); `inResolution(d: Debtor, s: { installments: number; days: number }): boolean`; `validateAdvance(pending: {id:string;number:number;due_date:string}[], selected: string[], today: string): { ok: true; mode: "siguientes" | "ultimas" } | { ok: false; error: string }`.

- [ ] **Step 1: Tests**
  - `contractLateFee('2026-10-01','2026-11-07',{type:'diaria',value:6,graceDays:1,capDays:60})` → `6 * 36 = 216`.
  - Tope: vencida hace 90 días → `360`. Dentro de gracia (1 día) → `0`.
  - `lateFeesByDebtor` con 2 cuotas vencidas del mismo plan y `diaria` → S/ 6 × días de la más antigua, no doble.
  - `buildDebtors` con `remaining: 200` en una cuota de 500 → `overdueAmount` 200.
  - `inResolution`: 2 cuotas → true; 1 cuota y 61 días → true; 1 cuota 30 días → false; `{installments:0,days:0}` → false.
  - `validateAdvance`: siguientes en orden (1,2,3 de 5 pendientes futuras) ok `siguientes`; últimas (4,5) ok `ultimas`; salteadas (1,3) error; incluye vencida → error.
- [ ] **Step 2: Ver fallar** `npx vitest run src/lib/late-fees.test.ts src/lib/collections.test.ts src/lib/advance-payments.test.ts`
- [ ] **Step 3: Implementar** las firmas de arriba; `settingsFromAccount` lee `late_fee_cap_days`.
- [ ] **Step 4: Ver pasar** (mismo comando) y `npx tsc --noEmit -p .`
- [ ] **Step 5: Commit** `feat(cobranzas): mora por contrato, saldos por cuota, causal y adelantos`

### Task 2: Migración 084 + casos SQL

**Files:**
- Create: `supabase/migrations/084_pagos_protegidos.sql`, `supabase/tests/084_casos.sql`

**Interfaces:**
- Produces (SQL): tabla `installment_payments`; vistas `installment_balances(installment_id, plan_id, account_id, amount, paid_so_far, remaining, parts)` y `payment_plan_balances` recalculada desde el libro (mismas columnas + `prepaid_amount`, agrega `adelantada_count`); funciones `can_access_module(uuid, text) → boolean`, `my_module_access() → jsonb` (`{"cobranzas":bool,"legal":bool,"cronograma":bool,"ventas":bool}`); RPCs `register_installment_payment(p_installment_id uuid, p_amount numeric, p_method text, p_reference text, p_voucher_path text, p_paid_on date) → uuid`, `register_advance_payment(p_plan_id uuid, p_installment_ids uuid[], p_method text, p_reference text, p_voucher_path text, p_paid_on date) → int`, `void_installment_payment(p_payment_id uuid, p_reason text) → void`, `create_payment_plan(p jsonb) → uuid`, `reject_client_voucher(p_installment_id uuid, p_reason text) → void`; `apply_prepayment` recreada (solo owner/gerencia, rechaza cuotas con partes); columnas en `accounts`: `late_fee_cap_days int default 0`, `max_payment_parts int default 1`, `resolution_installments int default 0`, `resolution_days int default 0`; `payment_plans.collection_terms jsonb`; `accounts_late_fee_valid` con `diaria`; `account_module_members(account_id, user_id, module_key)`; `collection_actions.result` += `ultimatum`, `pase_legal`; `installments.declared_amount numeric` (monto que el cliente declara en su voucher).
- Reglas: trigger `BEFORE INSERT OR UPDATE` en `installments`/`payment_plans` bloquea columnas de dinero cuando `current_user IN ('authenticated','anon')`; guard de `profiles.area` (solo vía `set_member_area`); RLS cronograma vs cobranza según spec §3; `contacts_select` + contactos con plan para quien accede a Cobranzas; backfill `legacy=true`.
- Golden queda configurado con un `UPDATE ... WHERE name ILIKE '%golden%'` **comentado** al final (el dueño lo corre).

- [ ] **Step 1: Escribir `supabase/tests/084_casos.sql`** (script con `DO` blocks y `RAISE EXCEPTION` si falla): pago parcial 200 de 500 → `remaining` 300 y estado pendiente; completar 300 → pagada; pagar 600 sobre 500 → error; anular → pendiente; abono sobre cuota con parte → error; `UPDATE installments SET amount` como `authenticated` → error; agente `UPDATE profiles SET area='cobranzas'` → error; agente de ventas `SELECT installment_payments` → 0 filas.
- [ ] **Step 2: Escribir la migración** según Interfaces y spec §3-§6.
- [ ] **Step 3: Revisión manual** contra `067` (patrón `current_user`, `OWNER TO postgres`, REVOKE anon) y `083`. (Sin Postgres local: se valida al correrla el dueño, junto con el script de casos.)
- [ ] **Step 4: Commit** `feat(db): 084 libro de pagos, acceso por módulo y reglas de cobranza`

### Task 3: Ficha del plan (pagar en partes, adelantos, anular)

**Files:**
- Modify: `src/components/payment-plans/payment-plan-detail.tsx`, `src/components/payment-plans/payment-plan-form.tsx`
- Create: `src/lib/payment-plans/rpc.ts`
- Test: `src/lib/payment-plans/rpc.test.ts`

**Interfaces:**
- Consumes: RPCs de Task 2; `validateAdvance` de Task 1.
- Produces: `registerPayment`, `registerAdvance`, `voidPayment`, `createPlan` en `rpc.ts`, cada uno `(supabase, args) → Promise<{ ok: true } | { ok: false; missing084: boolean; message: string }>`; `isMissing084(error)`.

- [ ] **Step 1: Tests de `rpc.ts`** con un cliente falso: RPC inexistente (`PGRST202`) → `missing084: true`; error normal → mensaje.
- [ ] **Step 2: Ver fallar / implementar / ver pasar.**
- [ ] **Step 3: UI**: monto por defecto = `remaining`; muestra partes pagadas y aviso si supera `max_payment_parts`; "Adelantar cuotas" con selección múltiple; "Anular pago" con motivo; quita `guardarCuota`, `sincronizarEstado` y el cambio de moneda directo (moneda solo si no hay pagos, vía RPC o deshabilitado); `payment-plan-form` usa `createPlan`.
- [ ] **Step 4: `npx tsc --noEmit -p .`, `npx eslint` de los archivos, commit** `feat(cuotas): pagos en partes, adelantos y anulación por RPC`

### Task 4: Lectores con saldo real y "sin acceso"

**Files:**
- Modify: `src/app/(dashboard)/collections/page.tsx`, `src/lib/payment-plans/reminders.ts`, `src/app/api/client/plan/route.ts`, `src/app/api/client/voucher/route.ts`, `src/lib/assistant/tools.ts`, `src/components/inbox/client-summary.tsx`, `src/components/contacts/contact-account-tab.tsx`, `src/hooks/use-auth.tsx`, `src/components/layout/sidebar.tsx`, `src/lib/modules.ts`
- Test: `src/lib/modules.test.ts`

**Interfaces:**
- Consumes: `installment_balances`, `my_module_access()`.
- Produces: `useAuth().moduleAccess: Record<string, boolean> | null`; `MODULES[].accessKey?: "cobranzas" | "legal" | "ventas"`; `isModuleVisible(href, disabled, moduleAccess)`.

- [ ] **Step 1: Test** `isModuleVisible('/collections', [], {cobranzas:false})` → false; `null` (084 sin aplicar) → true (no ocultar antes de la migración).
- [ ] **Step 2: Ver fallar / implementar / ver pasar.**
- [ ] **Step 3: Lectores**: Cobranzas, recordatorios (texto con `remaining`), portal (`monto` por cuota = `remaining`, `pagado` = `paid_so_far`), asistente y bandeja y pestaña Cuenta devuelven/mostrar "sin acceso" cuando `moduleAccess.cobranzas === false`; ruta de voucher guarda `declared_amount` del campo `monto`.
- [ ] **Step 4: `npx vitest run`, `tsc`, commit** `feat: saldos por cuota en todos los lectores y acceso por módulo`

### Task 5: Pantallas diarias (vouchers, reporte, estado de cuenta, causal)

**Files:**
- Create: `src/app/(dashboard)/collections/vouchers/page.tsx`, `src/app/(dashboard)/collections/daily/page.tsx`, `src/components/collections/account-statement.tsx`, `src/lib/payments-report.ts`
- Modify: `src/app/(dashboard)/collections/page.tsx`, `src/lib/collection-actions.ts`
- Test: `src/lib/payments-report.test.ts`

**Interfaces:**
- Produces: `summarizePayments(rows: {amount:number|string; method:string|null; registered_by:string|null; voided_at:string|null; currency:string}[]) → { byMethod: Record<string, number>; total: number; voided: number }`; `paymentsCsv(rows) → string`.

- [ ] **Step 1: Tests** de `summarizePayments` (anulados no suman al total, sí a `voided`) y `paymentsCsv` (separador `;`, fórmulas neutralizadas).
- [ ] **Step 2: Ver fallar / implementar / ver pasar.**
- [ ] **Step 3: UI**: cola de vouchers (aprobar → `register_installment_payment` con `declared_amount` o `remaining`; rechazar → `reject_client_voucher`); reporte diario con filtro de fecha y CSV; estado de cuenta imprimible en la ficha del contacto; badge "en causal" con `inResolution`; resultados `ultimatum` y `pase_legal` en el diálogo de gestión.
- [ ] **Step 4: `vitest`, `tsc`, `next build`, commit** `feat(cobranzas): cola de vouchers, reporte diario, estado de cuenta y causal`

### Task 6: Golden Legal solo para su equipo (repo `GOLDEN LEGAN`)

**Files:**
- Create: `supabase/migrations/067_legal_solo_equipo.sql` (en el repo de Golden Legal)
- Modify: test de base de ese repo si cubre `legal_role`

- [ ] **Step 1:** `legal_role` devuelve NULL para agentes sin `area='legal'` ni fila en `legal_members` (owner y super admin siguen); "Equipo legal" lista solo owner + `area='legal'` + `legal_members`.
- [ ] **Step 2:** Pruebas del repo (`npm test`) y commit/PR a su `main`.

### Task 7: Revisión y publicación
- [ ] Revisión de código superpowers sobre todo el rango; corregir hallazgos.
- [ ] PR a `Wio7/WIO_CRM` y a Golden Legal; fusionar tras CI; entregar 084 + script de casos + `UPDATE` de configuración de Golden al dueño.
