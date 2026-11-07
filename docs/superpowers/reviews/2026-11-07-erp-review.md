# Revisión del ERP (Wio Suite) — 2026-11-07

Cinco revisores sin contexto sobre `specs/2026-11-07-wio-suite-erp-as-built.md`
y el código (rango 1471f03..067b8e6): EGM design, EGM codebase-details, EGM
zoom-out, EGM implementation-readiness y superpowers code review.
Ningún hallazgo crítico de aislamiento entre cuentas.

## A. Integridad del dinero (4 de 5 revisores)
1. `installments` y `payment_plans` se pueden editar directo por cualquier
   agente (policies de 043): monto, estado, pagado. El RPC de abonos solo
   protege su camino.
2. Registrar un pago acepta cualquier monto y cierra la cuota: un pago
   parcial "perdona" la diferencia; uno mayor infla lo pagado.
3. Con la pantalla vieja tras un abono `reducir_cuota`, se registra el
   monto viejo (el guard solo mira el estado).
4. El estado del plan (pagado/activo) se actualiza desde el navegador, no
   en la base.
Plan: RPCs de pago/deshacer (SECURITY DEFINER, FOR UPDATE, monto
esperado) + trigger que bloquea cambios directos a montos/estados.
**Decisión pendiente del dueño: qué hacer con pagos parciales.**

## B. Visibilidad de agentes (2 revisores)
Montos, lotes y abonos de toda la cuenta son legibles por cualquier
agente; solo el contacto se oculta. **Decisión pendiente del dueño.**

## C. Cobranzas entre piezas (código, sin decisión) — se corrige ya
- Cuotas con voucher en revisión se tratan como deuda (mora, WhatsApp).
- "Pagadas X de N" distinto entre pantallas tras un abono.
- Planes cancelados se muestran como "Suspendido".
- CSV: inyección de fórmulas (nombres de WhatsApp).
- Deshacer pago deja el voucher (queda "en revisión").
- Ficha del plan usa la fecha del navegador, no Lima.
- Ruta de voucher del cliente: carrera con un abono.
- Botón de mora antes de cargar la configuración.
- Errores de lectura mostrados como "sin datos".
- Enlace de WhatsApp con prefijo 00.

## D. Producción (readiness)
Sin pruebas automáticas de SQL/RLS; sin deshacer abono; borrados en
cascada de historial; migraciones aplicadas sin registro; sin monitoreo
ni conciliación. Se priorizan después de A.

## E. Orden recomendado (zoom-out)
Antes de conectar Golden Legal: arreglar A, unir pagos de cuotas con
Golden Caja, cola de vouchers en revisión y estado de cuenta. La mora
quedó con reglas supuestas: confirmar la cláusula real del contrato.
