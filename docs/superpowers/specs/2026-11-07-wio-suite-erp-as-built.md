# Wio Suite — ERP: lo que está construido (as-built, 2026-11-07)

Documento para revisar lo ya construido y en producción del ERP de Wio
Suite (antes "Wio CRM"). Describe intención, decisiones y cómo está hecho,
para que un revisor sin contexto pueda juzgarlo contra el código real.

## 1. Contexto y por qué

- Wio Suite es un SaaS multi-cuenta (Next.js 16 + React 19 en Vercel,
  Supabase/Postgres 15 con RLS). Cada usuario pertenece a una sola cuenta
  (`profiles.account_id`); `is_account_member(account_id, min_role)` decide
  el acceso (roles: owner > admin > agent > viewer).
- Era un CRM de ventas. Decisión del dueño (2026-11-06): convertirlo en un
  ERP con núcleo común y un módulo por área, que cada cuenta prende o apaga.
  El CRM queda como módulo de Ventas.
- Cuentas reales: una inmobiliaria que vende lotes a plazos en Perú
  (Golden Habitat, la principal), otra inmobiliaria, un estudio legal, una
  nutricionista, una barbería, un club con restaurante.
- Regla de despliegue: todo va a `main` (protegida por CI: lint, typecheck,
  test, build) y Vercel publica producción. Las migraciones SQL las corre a
  mano el dueño en el SQL Editor de Supabase; el código debe funcionar
  (degradado) antes de que se apliquen.

## 2. Núcleo: módulos por cuenta (PR #23, sin migración)

- `src/lib/modules.ts` es el registro único: cada módulo es una ruta del
  dashboard con `area` (comunicación, ventas, finanzas, agenda,
  automatización) y `requires` (dependencias). `accounts.disabled_modules`
  (migración 066, solo super admin) guarda las rutas APAGADAS.
- `isModuleDisabled(path, disabled)` bloquea una ruta si está en la lista o
  si un módulo que requiere está apagado (`withDependencies`). Rutas
  siempre activas: `/dashboard`, `/settings`, `/saas-owner`.
- Plantillas por rubro (`RUBRO_TEMPLATES`): todo, inmobiliaria, servicios
  profesionales, barbería, club, solo campañas. El diálogo del super admin
  (`account-modules-dialog.tsx`) aplica plantillas y respeta dependencias.
- El menú (`sidebar.tsx`) se agrupa por área. La protección es de interfaz
  (menú + bloqueo en `dashboard-shell.tsx`); los datos siguen protegidos por
  RLS por cuenta, no por módulo.

## 3. Ficha única del cliente: pestaña "Cuenta" (PR #25, sin migración)

- `contact-account-tab.tsx` en la ficha del contacto: separaciones y planes
  de cuotas del contacto, con total, pagado (inicial + cuotas + abonos),
  saldo, vencido y próximo pago, por moneda (`src/lib/client-account.ts`).
  Lee la vista `payment_plan_balances`. Solo si la cuenta usa Cuotas o
  Separaciones.

## 4. Cobranzas (PR #26, #28, sin migración)

- `/collections` (módulo que requiere `/payment-plans`). Lee cuotas
  `pendiente` con vencimiento < hoy (Lima) de planes `activo`, paginando
  de 1000 en 1000 con orden estable (`due_date`, `id`).
- `src/lib/collections.ts`: agrupa por cliente y moneda (sin contar dos
  veces una cuota), días de atraso, tramos 1-30/31-60/61-90/+90, deuda por
  proyecto y manzana, cuotas de clientes no visibles (RLS de contactos),
  enlace de WhatsApp con mensaje (solo celulares peruanos o con código de
  país), CSV con `;`, fechas en día de Lima.
- Último aviso automático: `installment_reminders` (052) solo enviados.
- Agentes: ven solo los NOMBRES de sus clientes (RLS de contactos). Montos, lotes y abonos de planes (payment_plans, installments, plan_prepayments) son legibles por cualquier agente de la cuenta (policies de 043). Pendiente de decisión del dueño.

## 5. Gestiones de cobranza (PR #27, #28, migración 082 aplicada)

- Tabla `collection_actions`: canal, resultado, promesa (fecha, monto),
  nota, autor, fecha. RLS: lee el equipo (agente+) solo de contactos que
  puede ver; registra a su nombre sobre contacto y plan de su cuenta;
  corrige o borra el autor o un admin; trigger que impide cambiar autor,
  fecha y cuenta.
- Pantalla: botón Gestión (historial + formulario), columna Seguimiento,
  promesas vigentes/vencidas y filtro de vencidas.

## 6. Mora y abonos (PR #29, migración 083 aplicada)

Diseño: `2026-11-07-mora-y-abonos-design.md`. Reglas elegidas por el
asistente (el dueño pidió avanzar sin preguntas).

- Mora por cuenta (`accounts.late_fee_type/value/grace_days`), apagada por
  defecto, fija o % mensual × días/30 desde el vencimiento una vez pasada
  la gracia. Informativa (no se guarda ni se cobra sola). La configuran
  admins (policy `accounts_update`).
- Abono a capital: solo cuotas pendientes, que vencen de hoy (Lima) en
  adelante y sin voucher en revisión. Modos `reducir_plazo` (desde la
  última hacia atrás) y `reducir_cuota` (reparto en céntimos). La app
  calcula (`src/lib/prepayments.ts`) y el RPC `apply_prepayment`
  (SECURITY DEFINER, permiso explícito agente+, bloqueos FOR UPDATE)
  revalida y aplica; `plan_prepayments` no tiene INSERT/DELETE directo.
  Cuotas cubiertas → estado `adelantada`.
- `payment_plan_balances`: `paid_amount` incluye abonos, nueva columna
  `prepaid_amount`, atraso según el día de Lima.
- Registrar o deshacer un pago solo aplica si la cuota sigue en el estado
  esperado (evita pisar cambios con la pantalla vieja).

## 7. Límites conocidos (decididos o pendientes)

- Mora no se agrega al CSV; no se registra mora cobrada.
- `payment_plans.monthly_amount` no cambia tras `reducir_cuota` (la app del
  cliente y el asistente siguen mostrando la cuota original).
- La app del cliente (otro repo) recibe el estado `adelantada` sin saber
  mostrarlo todavía.
- No hay forma de deshacer un abono desde la pantalla.
- Golden Legal (otra app de la misma cuenta y la misma base) guarda
  cronogramas en `legal_schedule_records`; todavía no se conectan con
  Cuotas/Cobranzas (siguiente pieza).

## 8. Archivos

`src/lib/{modules,client-account,collections,collection-actions,late-fees,prepayments}.ts`
(+ `.test.ts`), `src/components/contacts/contact-account-tab.tsx`,
`src/components/collections/*`, `src/components/payment-plans/{prepayment-dialog,payment-plan-detail}.tsx`,
`src/app/(dashboard)/collections/page.tsx`, `src/components/layout/sidebar.tsx`,
`src/components/saas-owner/account-modules-dialog.tsx`,
`supabase/migrations/{082_gestiones_cobranza,083_mora_y_abonos}.sql`.
Contexto: `supabase/migrations/{043,047,052,066,067}*.sql`.

## 9. Corrección tras la revisión EGM + superpowers (2026-11-07)

- "pagado + saldo = total" NO está garantizado en la base: las policies de
  043 dejan a cualquier agente editar montos y estados de cuotas y planes
  directo, y registrar un pago acepta cualquier monto. El RPC de abonos
  solo protege su propio camino. Ver `docs/superpowers/reviews/2026-11-07-erp-review.md` (A).
- Cobranzas ya no trata como deuda las cuotas con voucher en revisión.
