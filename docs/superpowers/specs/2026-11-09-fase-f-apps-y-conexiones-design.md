# Fase F — Una app por área y conexiones entre áreas (diseño, 2026-11-09)

Fuente: decisiones del dueño del 2026-11-07 y 2026-11-09 (ver
`2026-11-07-conexiones-entre-modulos.md` y `2026-11-09-areas-pendientes-design.md`
§0). Primera cuenta: una inmobiliaria (Golden Habitat); todo genérico por
cuenta. El personal del cliente nunca ve el nombre interno del producto: cada
app se llama con el nombre de su cuenta + el área ("Golden Cobranzas").

## 1. Por qué
Cada área de la oficina trabaja por WhatsApp, Excel y cuadernos, y los casos
pasan de un área a otra "de palabra". El dueño quiere que **cada persona
entre solo a la app de su área**, simple, igual de cómoda en laptop y
celular, y que **los casos pasen entre áreas con un botón** y lleguen a una
bandeja "Te enviaron", solo entre las áreas que de verdad se conectan.

## 2. Mapa de apps (decidido por el dueño)
| App | Quién entra | Dónde vive | Estado |
|---|---|---|---|
| Legal | área legal | repo propio (`GOLDEN LEGAN`) | existe; desde 067 solo su equipo |
| Ventas + Postventa | asesores; postventa es una pestaña | repo `golden 3d` (Vite) | existe; falta pestaña postventa |
| Caja chica | contable/administración y gerencia | ERP, ruta `/caja` (app instalable propia) | existe; se mejora |
| Cobranzas | área cobranzas | nueva | por construir |
| Contabilidad | contable/administración | nueva | por construir (necesita muestra de Caja Ica) |
| Marketing | área marketing | nueva | por construir |
| Gerencia | dueños / gerencia | nueva, "bien completa": ve todas las demás | por definir con el dueño |
| Área técnica | arquitectos e ingenieros | nueva | al final (el dueño la define) |
| ERP web (`/dashboard`) | super admin de plataforma y dueño | ERP | existe |

## 3. Cómo se construyen las apps nuevas (decisión de diseño de Aurex)
- **Dentro del repo del ERP, como `/caja`:** cada app es un grupo de rutas
  con su propio layout (sin el menú del ERP), su manifiesto PWA con `scope`
  propio, su ícono y su nombre. Se instala en el celular como app separada.
  Precedente: `src/app/caja` con `manifest.webmanifest` de scope `/caja`.
- Rutas: `/cobranzas-app`, `/contabilidad`, `/marketing`, `/gerencia`,
  `/tecnica` (nombres finales en el plan; no chocan con rutas del ERP).
- **Laptop y celular con vistas separadas** (regla del dueño: no una vista
  estirada), como Golden Legal.
- **Reutiliza** las pantallas y RPCs de la Fase A (cola de vouchers,
  gestiones, estado de cuenta) en la app de Cobranzas; no se duplica lógica.
- **Entrada:** tras iniciar sesión, cada persona va a la app de su área
  (o a un selector si tiene más de una). Si entra a la app de otra área, ve
  "Esta app es de otra área" y un botón a la suya. El ERP web solo para
  super admin y dueño.
- Golden Legal y la app de ventas siguen en sus repos; usan la misma base y
  las mismas RPCs de conexiones.

## 4. Áreas y acceso (base de datos)
- Hoy `profiles.area` es un solo valor y `account_module_members.module_key`
  solo admite cobranzas, legal, cronograma, ventas (084). Una persona puede
  necesitar más de una app (postventa + ventas; contabilidad + caja).
- Cambio: módulos válidos = `ventas, postventa, legal, cronograma, cobranzas,
  contabilidad, caja, marketing, tecnica, gerencia`. `profiles.area` admite
  también `tecnica`. Los módulos extra se dan con `account_module_members`
  (ya existe). `my_module_access()` devuelve todos.
- Reglas por área (además de las de la 084): caja = contabilidad o gerencia;
  postventa = fila explícita; marketing = área marketing; tecnica = área
  tecnica; gerencia = área gerencia; dueño y super admin, todo.

## 5. Conexiones (traspasos)
- Tabla `module_handoffs`: cuenta, módulo origen, módulo destino, tipo,
  entidad (`entity_type`, `entity_id`), **lo que viaja** (`payload` jsonb
  mínimo y fijo por tipo), estado `pendiente | aceptado | devuelto`, nota,
  motivo de devolución, quién envió, quién atendió, fechas.
- Tabla `module_connections` por cuenta: qué tipos de traspaso existen
  (origen → destino). Se siembra por plantilla de rubro (inmobiliaria). **Solo
  existen los botones de las conexiones listadas**; las demás áreas no se ven.
- RPCs `send_handoff`, `accept_handoff`, `return_handoff` (SECURITY DEFINER):
  validan que la conexión exista, que quien envía tenga el módulo origen y
  quien atiende el destino. Nadie edita la tabla directo.
- Cada app muestra **"Te enviaron"** (pendientes de su área, con contador) y
  **"Enviados"** (con su estado). Abrir un traspaso lleva a la ficha que
  corresponde dentro de esa app, mostrando solo lo que viajó.
- Aviso: contador en la app; WhatsApp interno queda para después.

Conexiones iniciales (plantilla inmobiliaria):
| # | De → A | Botón / cuándo | Qué viaja |
|---|---|---|---|
| 1 | Ventas → Legal | Separación aprobada: "Enviar expediente" | cliente, lote, precio, inicial, cuotas, meses, asesor |
| 2 | Legal → Cobranzas | Contrato firmado: "Enviar cronograma" | plan de cuotas |
| 3 | Cobranzas → Legal | Causal: "Pasar a legal" | deuda, cuotas vencidas, gestiones |
| 4 | Legal → Cobranzas | Adenda o resolución | nuevo cronograma o "resuelto" |
| 5 | Cobranzas → Contabilidad | Pago confirmado | pago para boleta |
| 6 | Contabilidad → Cobranzas | Transferencia validada | confirmación del pago |
| 7 | Cobranzas / Legal → Gerencia | Pedido: abono, condonación, reprogramación | caso, monto fijo, motivo |
| 8 | Gerencia → Ventas | Lote liberado | lote |
| 9 | Cobranzas → Postventa | Plan pagado completo | cliente, lote, carta de no adeudo |
| 10 | Cobranzas / Legal → Postventa | Reclamo o consulta del cliente | cliente, tipo, nota |
| 11 | Postventa → Área técnica | Consulta de avance o reclamo técnico | proyecto, lote, nota |
| 12 | Área técnica → Postventa | Respuesta / fotos de avance | texto, fotos |
| 13 | Legal ↔ Área técnica | Respuesta oficial por retraso de obra | proyecto, texto |
| 14 | Marketing → Ventas | Lead de campaña | contacto con origen (ya existe atribución) |
| 15 | Ventas → Marketing | Venta cerrada | resultado por campaña, sin pagos |

Lo que NO se conecta: igual que el mapa del 2026-11-07 (marketing no ve
pagos; legal no ve pagos; ventas no ve cobranzas; contabilidad no ve ventas
ni legal).

## 6. Orden (pedido del dueño: conexiones → postventa → caja chica)
1. **F1 Núcleo de conexiones:** módulos ampliados, `module_connections`,
   `module_handoffs`, RPCs, componente de bandeja; bandeja y botones en el
   ERP web (gerencia y cobranzas mientras no exista su app), en Golden Legal
   y en la app de ventas (las conexiones 1, 2, 3, 4, 7, 9, 10).
2. **F2 Postventa** en la app de ventas: pestaña con bandeja, casos y agenda
   (lunes y sábado, 7 días, un cliente por visita; sobre la agenda
   existente `049_agenda.sql`).
3. **F3 Caja mejorada:** proyecto y rubro por gasto, varias cajas, panel de
   gerencia; renombrar "Golden Caja" del menú a un nombre por cuenta.
4. **F4 App Cobranzas** (reusa Fase A). **F5 App Contabilidad** (cuando
   llegue la muestra de Caja Ica). **F6 App Marketing.** **F7 App Gerencia.**
   **F8 App Área técnica.**

## 7. Decisiones pendientes del dueño
1. Qué ve y hace la app de Gerencia (el dueño lo retoma con preguntas).
2. Qué hace la app de Área técnica (el dueño pregunta a su jefe).
3. App de Marketing: tablero de tareas diario + inversión por campaña, ¿algo más?
4. ¿El aviso de "Te enviaron" debe llegar también por WhatsApp?

## 8. Fuera
Importación de Caja Ica (espera la muestra), boletas SUNAT, renders 3D.
