# Mora y abonos a capital (Wio Suite, ERP fase 1)

Fecha: 2026-11-07. Pedido de Bryce: "Mora y abonos". Bryce pidió seguir sin
preguntas; las reglas de abajo son decisiones de Aurex, configurables por
cuenta, y se pueden cambiar.

## Por qué
La oficina de cobranzas (Golden Habitat) necesita saber cuánto recargo le
corresponde a un moroso y registrar cuando un cliente adelanta plata de su
lote, sin rehacer el cronograma a mano.

## Mora
- Configurable por cuenta (columnas en `accounts`): `late_fee_type`
  (`ninguna` | `fija` | `porcentaje_mensual`), `late_fee_value`,
  `late_fee_grace_days`. Por defecto `ninguna`: nada cambia para nadie.
- Solo admins de la cuenta la configuran (policy `accounts_update`).
- Cálculo por cuota vencida y pendiente:
  - dentro de los días de gracia: 0;
  - `fija`: `late_fee_value` una vez por cuota;
  - `porcentaje_mensual`: `cuota × value% × días de atraso / 30`
    (días desde el vencimiento, una vez pasada la gracia).
- Es informativa: se muestra en Cobranzas (por cliente y total). No se
  suma sola a la deuda ni se guarda. Cobrarla o condonarla lo decide la
  oficina (registrar la mora cobrada queda para después).

## Abono a capital
- Planes de Wio no tienen interés (monto fijo por cuota), así que "recálculo"
  = cambiar los montos de las cuotas futuras.
- Solo cuotas **pendientes con vencimiento de hoy en adelante**. Las
  vencidas se pagan primero (la pantalla avisa si hay).
- El abono no puede superar la suma de esas cuotas.
- Dos modos, los elige la oficina:
  - `reducir_plazo`: cubre desde la última cuota hacia atrás; las que
    quedan en 0 pasan a estado `adelantada`.
  - `reducir_cuota`: reparte el abono entre las cuotas futuras (en
    céntimos exactos; ninguna baja de 0).
- Se registra en `plan_prepayments` (monto, modo, método, operación, nota,
  autor, detalle antes/después) para auditoría.
- Se aplica con un RPC `apply_prepayment` (transacción, SECURITY DEFINER con permiso explícito; ver 083):
  recibe los montos nuevos calculados en la app y valida en la base que
  las cuotas sean del plan, pendientes y futuras, que ninguna suba ni baje
  de 0 y que la suma rebajada sea exactamente el abono.
- La vista `payment_plan_balances` suma los abonos a `paid_amount` (y
  expone `prepaid_amount`), así todas las pantallas cuadran:
  pagado + saldo = total.
- Estado nuevo de cuota: `adelantada` (no es `pagada` ni `condonada`).

## Fuera de alcance (por ahora)
Interés compensatorio (método francés), registrar mora cobrada, deshacer
un abono desde la pantalla, estado de cuenta en PDF.

## Migración
`083_mora_y_abonos.sql`, idempotente.
