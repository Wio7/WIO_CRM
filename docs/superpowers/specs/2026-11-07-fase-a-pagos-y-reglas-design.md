# Fase A — Pagos protegidos, acceso por módulo y trabajo diario de cobranzas (v2)

Fecha: 2026-11-07. v2 tras revisión EGM (design, codebase-details, zoom-out).
Se construye para la cuenta de Golden Habitat y queda como esqueleto genérico
de Wio Suite: toda regla de Golden es configuración, no código.

## 1. Por qué
- Registrar un pago, lo más frecuente en la oficina, no está protegido: un
  agente edita montos y estados directo; un pago menor cierra la cuota.
- Golden permite pagar una cuota en 2-3 partes, pero el sistema no lo modela.
- Cada módulo lo deben ver solo sus personas; hoy un asesor de ventas puede
  leer cobranzas y entrar como lector a la app de legal.

## 2. Reglas de Golden (entrevistas 2026-11-07)
Ver la nota del vault "Cuestionario por areas para Wio Suite (2026-11-07)".
Resumen: pago en partes (normal 2-3, más es excepción); adelantos de cuotas
completas (siguientes en orden, o las últimas si hay promoción); abono a
capital y condonación solo gerencia; mora S/ 6 por día desde el 2.º día con
tope de 2 meses; causal de resolución con 2 cuotas o 60 días (en la práctica
esperan hasta 3-4); reprogramación una vez (la hace legal); acceso total solo
para Erick Pamo, Bryce (super admin de plataforma) y Kevin Leandro (sin
cuenta aún); cada módulo solo su área; legal ve cronogramas, no cobranzas.

## 3. Acceso por módulo (genérico)
- Acceso total: `owner` de la cuenta y super admin de plataforma. **Ser
  `admin` ya no abre todos los módulos.**
- Cada módulo se asocia a áreas: Cobranzas/Cuotas → `cobranzas`,
  `contabilidad`, `gerencia`; Legal → `legal`; Ventas → `ventas`.
- Función `can_access_module(account_id, module_key)` (SECURITY DEFINER,
  STABLE, owner postgres, reutiliza `is_account_member`): owner o super
  admin, o miembro cuya `profiles.area` está en las áreas del módulo, o con
  permiso explícito en `account_module_members(account_id, user_id,
  module_key)`.
- `profiles.area` se vuelve protegida: el guard de 067 se amplía para que
  `area` solo cambie vía `set_member_area` (hoy un agente puede ponerse
  `cobranzas` a sí mismo).
- Menú: el sidebar oculta módulos sin acceso (además de `disabled_modules`).
- Separación de lectura:
  - Cronograma (fechas y montos de cuotas, sin pagos): áreas de cobranzas,
    contabilidad, gerencia y legal.
  - Cobranza (pagos, gestiones, avisos, mora, abonos): cobranzas,
    contabilidad, gerencia.
  - Se implementa con RLS en `payment_plans`/`installments` (cronograma) y
    en `installment_payments`, `collection_actions`, `installment_reminders`,
    `plan_prepayments` (cobranza).
- `contacts_select` se amplía: quien accede a Cobranzas ve los contactos que
  tienen un plan (hoy un agente de cobranzas no vería los nombres).
- Pantallas y asistente distinguen "sin acceso" de "no es cliente": RPC
  `my_module_access()` y rama explícita en `client-summary.tsx`,
  `contact-account-tab.tsx`, `payment-plan-detail.tsx` y `assistant/tools.ts`
  (devuelve `{sin_acceso: true}`).
- Golden Legal (repo aparte, misma base): `legal_role` deja de dar "lector" a
  todo agente; solo owner, `area='legal'` o `legal_members`. La lista "Equipo
  legal" muestra solo a esas personas. Migración propia en ese repo.

## 4. Libro de pagos
- Tabla `installment_payments` (una fila por pago o parte): `account_id`,
  `plan_id`, `installment_id`, `amount > 0`, `method`, `reference`,
  `voucher_path`, `paid_on` (fecha; no futura; más de N días atrás solo
  owner/gerencia), `late_fee_at_payment`, `registered_by` (auth.users),
  `created_at`, `voided_at/voided_by/void_reason`. `ON DELETE RESTRICT`
  hacia cuotas y planes: no se borra, se anula.
- Vista `installment_balances` por cuota: `amount`, `paid_so_far`,
  `remaining`, `parts`. **Todos los lectores** pasan a usar `remaining`:
  Cobranzas, CSV, mora, WhatsApp, recordatorios, portal del cliente,
  asistente. `payment_plan_balances` se recalcula desde el libro
  (`paid_amount`, `pending_amount`, `overdue_amount` con partes).
- RPCs (SECURITY DEFINER, plan `FOR UPDATE`, mismo error si el plan no
  existe o es ajeno, plan debe estar `activo`):
  - `register_installment_payment(installment_id, amount, method, reference,
    voucher_path, paid_on)`: rechaza si supera `remaining`. Si completa la
    cuota la pasa a `pagada`. Si ya hay `max_payment_parts` partes, avisa
    (owner/gerencia pueden seguir). Mueve el voucher del cliente de la cuota
    al pago y lo limpia de la cuota. Recalcula estado del plan.
  - `register_advance_payment(plan_id, installment_ids[], ...)`: varias
    cuotas completas en una transacción; valida que sean las siguientes en
    orden o las últimas.
  - `void_installment_payment(payment_id, reason)`: anula; la cuota vuelve a
    `pendiente` si queda incompleta; el plan `pagado` vuelve a `activo` (no
    reabre cancelados ni suspendidos).
  - `apply_prepayment` (083) se recrea: solo owner/gerencia; rechaza cuotas
    con pagos parciales activos.
- Protección de columnas: trigger `BEFORE INSERT OR UPDATE` en
  `installments` y `payment_plans` que rechaza cambios a columnas de dinero
  y estado (`amount`, `status`, `paid_amount`, `paid_at`, `due_date`,
  `registered_by`, `payment_id`, `total_amount`, `down_payment`,
  `monthly_amount`, `installments_count`, `currency`) cuando
  `current_user` es `authenticated`/`anon` (patrón de 067). RPCs y
  service role pasan. Inserts de usuario solo con `status='pendiente'` y sin
  datos de pago.
- Crear un plan pasa a RPC `create_payment_plan(...)` (quién puede: ver
  pregunta 3).
- Copia histórica: una fila por cuota `pagada` con
  `COALESCE(paid_amount, amount)`, método, operación, voucher; marcada
  `legacy = true` (puede no cuadrar con el monto). `adelantada` y
  `condonada` no se copian.

## 5. Trabajo diario (lo que más usa la oficina)
- Cola "Vouchers por revisar": cuotas con voucher del cliente; aprobar =
  registrar pago (con el voucher); rechazar = limpiar con motivo.
- Reporte diario de pagos: por fecha, método, quién registró, anulados; CSV.
- Estado de cuenta por cliente (pantalla + PDF/imprimible desde el libro).
- Badge "en causal de resolución" calculado (no guardado) con los umbrales
  de la cuenta; "Ultimátum enviado" y "Pase a legal" como resultados nuevos
  de `collection_actions` (con fecha) — sin envío automático (eso es fase D).

## 6. Configuración por cuenta
- Un solo lugar: columnas en `accounts` (donde ya está la mora de 083):
  `late_fee_type` suma `diaria`; nuevo `late_fee_cap_days`;
  `max_payment_parts` (aviso, por defecto 1); `resolution_installments` y
  `resolution_days` (0 = sin badge).
- Al crear un plan se copian sus términos (`collection_terms jsonb`) para
  que cambiar la configuración no altere contratos ya firmados; los cálculos
  leen el plan y si falta, la cuenta.
- Golden: `diaria`, 6, gracia 1, tope 60, partes 3, resolución 2/60.

## 7. Despliegue
- 084 idempotente. Código compatible antes de aplicarla: intenta el RPC y,
  si no existe, avisa "falta aplicar la migración 084" (sin escribir directo).
- Pruebas: lógica pura en TS con TDD; script SQL de casos (pago parcial y
  completo, exceso, anulación, abono con parciales, agente con área
  falsificada, update directo bloqueado) para correr tras aplicar la 084.

## 8. Fuera de alcance
Boletas y carta de no adeudo (B), importador y enlace con legal (C), avisos
por API de WhatsApp y sorteos (D), paneles de gerencia y liberaciones (E),
reprogramación (la hace legal).

## 9. Respuestas del dueño (2026-11-07)
1. Mora **por contrato** (por plan): S/ 6 por día desde el 2.º día después
   del vencimiento de la cuota vencida más antigua, tope 60 días (máx. S/ 360
   por plan), aunque deba varias cuotas.
2. Mora **solo de referencia**: el pago va completo a la cuota; la mora se
   muestra en Cobranzas y en el estado de cuenta. `late_fee_at_payment`
   guarda la mora que había al momento del pago, como dato.
3. Los planes los **crea legal** (con el contrato). `create_payment_plan` lo
   pueden usar legal, cobranzas y owner. El camino normal será Golden Legal →
   "Enviar a Cobranzas" (fase C).
4. El voucher del cliente **puede ser una parte**: el portal envía el monto
   declarado (el campo `monto` ya existe en la ruta del voucher); aprobarlo
   registra ese monto como parte de la cuota.

## 10. Orden de construcción
1. 084 SQL: libro de pagos, vistas, RPCs, protección de columnas, acceso por
   módulo, configuración; + script de casos SQL.
2. Lógica TS con TDD: saldos por cuota, mora por contrato con tope,
   causal de resolución, validación de adelantos.
3. Pantallas: ficha del plan (pagar en partes, adelantos, anular), Cobranzas
   con `remaining` y mora por contrato, cola de vouchers, reporte diario,
   estado de cuenta; lectores (portal, recordatorios, asistente, bandeja)
   con `remaining` y "sin acceso".
4. Golden Legal: `legal_role` y "Equipo legal" solo para su equipo.
