# Conexiones entre módulos (Wio Suite) — mapa y reglas

Fecha: 2026-11-07. Pedido del dueño: cada área usa su propia app dentro de
su módulo; los módulos se conectan solo con los que de verdad necesitan, con
botones que pasan la información correspondiente. Gerencia (o quien
designe) ve el CRM completo. Primera cuenta: Golden Habitat; el esqueleto
es genérico.

## 1. Apps actuales (as of 2026-11-07)
| Módulo | App de la cuenta Golden | Repo | Qué hace hoy |
|---|---|---|---|
| Ventas | Golden App (PWA de asesores) + web del CRM | `golden 3d`, `wacrm` | Lotes y planos, combi, separaciones, asistente |
| Legal | Golden Legal | `GOLDEN LEGAN` | Cronogramas con y sin interés, expedientes, Excel/PDF |
| Cobranzas | Web del CRM (Cuotas, Cobranzas) | `wacrm` | Planes, pagos, gestiones, mora, abonos |
| Contabilidad / Caja | Golden Caja | `GOLDEN CAJA` | Caja chica por voz y WhatsApp |
| Gerencia | Web del CRM completa | `wacrm` | Todo |
| Marketing, RR. HH., Postventa | (no existen aún) | — | — |

Todas comparten la misma base (Supabase del CRM) y la misma cuenta.

## 2. Principio
- Un solo registro por cosa en el núcleo: contacto (cliente), lote, plan,
  pago. Ningún módulo copia datos de otro; "pasar" = cambiar el estado del
  registro compartido + avisar al área que sigue.
- Cada paso entre áreas es un **traspaso** visible: tabla genérica
  `module_handoffs(account_id, from_module, to_module, kind, entity_type,
  entity_id, status pendiente|aceptado|devuelto, note, created_by,
  handled_by, timestamps)`. El área que recibe lo ve en su bandeja "Te
  enviaron", con botón para abrirlo, aceptarlo o devolverlo con motivo.
- Un módulo solo ve de otro lo que el traspaso le entrega (permisos de la
  Fase A por área).

## 3. Conexiones (solo las necesarias)
| # | De → A | Cuándo (botón) | Qué viaja |
|---|---|---|---|
| 1 | Ventas → Legal | Separación aprobada: "Enviar expediente a legal" | Cliente (DNI, contacto), lote, precio, inicial, cuotas, meses, asesor |
| 2 | Legal → Cobranzas | Contrato firmado: "Enviar cronograma a cobranzas" | Plan de cuotas (crea el plan) |
| 3 | Cobranzas → Legal | Causal de resolución: "Pasar a legal" | Deuda, cuotas vencidas, gestiones hechas |
| 4 | Legal → Cobranzas | Renegociación o resolución | Adenda (nuevo cronograma) o "resuelto" |
| 5 | Cobranzas → Contabilidad | Pago confirmado | Pago para boleta e ingreso en caja |
| 6 | Contabilidad → Cobranzas | Transferencia validada (conciliación) | Confirmación del pago |
| 7 | Cobranzas → Gerencia | Pedido de condonación, abono a capital o reprogramación; lista de liberaciones | Caso con monto y motivo; aprobar/rechazar |
| 8 | Gerencia → Ventas | Lote liberado | Lote vuelve a disponible en el plano |
| 9 | Cobranzas → Postventa | Plan pagado completo | Cliente para minuta/escritura/entrega; carta de no adeudo |
| 10 | Marketing → Ventas | Lead de campaña | Contacto con origen de campaña (ya existe: atribución 035) |
| 11 | Ventas → Marketing | Venta cerrada | Resultado por campaña (lectura, sin datos de pago) |
| 12 | RR. HH. → núcleo | Alta o baja de personal | Usuario, área y acceso a módulos (nada más) |
| 13 | Ventas ↔ Agenda/Combi | Visita agendada | Cita y asiento en combi (ya existe) |

## 4. Lo que NO se conecta
- RR. HH. no ve ventas, cobranzas, legal ni marketing (solo personas y accesos).
- Marketing no ve cobranzas, legal ni pagos.
- Legal no ve pagos (solo cronogramas y lo que cobranzas le pasa en #3).
- Ventas no ve cobranzas (como mucho, en el futuro, "al día / atrasado").
- Contabilidad no ve ventas ni legal, solo pagos (#5, #6).
- Gerencia ve todo en la web del CRM completa.

## 5. Encaje con las fases
- #2, #3, #7 (pedidos a gerencia) y la bandeja "Te enviaron": núcleo nuevo
  `module_handoffs` → fase propia **F (Conexiones)**, después de A.
- #1 y #2 ya están en la fase C (Golden Legal ↔ Cobranzas); usan F.
- #5 y #6 en la fase B (Contabilidad).
- #8 y #9 en la fase E (Gerencia y Postventa).
- #10, #11 y #13 ya existen en parte; se revisan en E.
- #12 en la fase E (RR. HH.: alta/baja).
- Cada app (Golden App, Golden Legal, Golden Caja) muestra su bandeja
  "Te enviaron" y sus botones de enviar; la web del CRM muestra todo a
  gerencia.
