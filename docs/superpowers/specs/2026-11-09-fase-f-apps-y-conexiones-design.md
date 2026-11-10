# Fase F — Una app por área y conexiones entre áreas (diseño v2, tras revisión EGM, 2026-11-09)

Fuente: decisiones del dueño del 2026-11-07 y 2026-11-09 (ver
`2026-11-07-conexiones-entre-modulos.md` y `2026-11-09-areas-pendientes-design.md`
§0). Primera cuenta: una inmobiliaria (Golden Habitat); todo genérico por
cuenta. El personal del cliente nunca ve el nombre interno del producto: cada
app se llama con el nombre de su cuenta + el área ("Golden Cobranzas").

## 1. Por qué
Cada área trabaja por WhatsApp, Excel y cuadernos, y los casos pasan de un
área a otra "de palabra". El dueño quiere que **cada persona entre solo a la
app de su área**, simple, igual de cómoda en laptop y celular (vistas
separadas), y que **los casos pasen entre áreas con un botón** y lleguen a una
bandeja "Te enviaron", **solo entre las áreas que se conectan**.

## 2. Mapa de apps (decidido por el dueño)
| App | Quién entra | Dónde vive | Estado |
|---|---|---|---|
| Legal | área legal | repo propio (`GOLDEN LEGAN`) | existe; desde 067 solo su equipo |
| Ventas + Postventa | asesores; postventa es una pestaña | repo `golden 3d` (Vite) | existe; falta pestaña postventa |
| Caja chica | contable/administración y gerencia | ERP, ruta `/caja` (la de producción en wiocompany.com/caja; el repo `GOLDEN CAJA` tiene PRs sin desplegar) | existe; varias cajas ya existen (`065_cash_companies.sql`) |
| Cobranzas | área cobranzas | nueva | por construir |
| Contabilidad | contable/administración | nueva | por construir (necesita muestra de Caja Ica) |
| Marketing | área marketing | nueva | por construir |
| Gerencia | dueños / gerencia | nueva, completa, ve las demás | por definir con el dueño |
| Área técnica | arquitectos e ingenieros | nueva | al final |
| ERP web (`/dashboard`) | super admin, dueño y, mientras no exista su app, cobranzas | ERP | existe |

No hay área de RR. HH. (dueño, 2026-11-09): la conexión #12 del mapa de
11-07 (altas y bajas) la hace el dueño en la pantalla de equipo.

## 3. Apps nuevas dentro del repo del ERP (como `/caja`)
- Cada app = grupo de rutas con layout propio (sin el menú del ERP),
  manifiesto PWA con `scope` propio, ícono y **nombre armado desde la cuenta**
  (no fijo en código). Laptop y celular con vistas separadas.
- Reutilizan pantallas y RPCs existentes (Fase A en Cobranzas).
- **Entrada y sesión** (corrige lo que hoy hace el middleware):
  - Las rutas de cada app van a la lista protegida del middleware.
  - El retorno tras el login acepta cualquier ruta de app de una lista
    blanca (`next`), no solo `/caja`; sin `next`, cada persona va a su app
    (o a un selector si tiene varias).
  - Cada app tiene su propia pantalla de login dentro de su `scope`, para que
    en Android no se abra con barras de navegador.
  - Límite conocido: en iPhone cada app instalada guarda su propia sesión;
    quien usa dos apps inicia sesión en cada una.
- Entrar a la app de otra área muestra "Esta app es de otra área" y un botón
  a la suya. El ERP web se cierra al personal de un área **recién cuando su
  app exista**.

## 4. Acceso por app (separado del acceso a datos)
- La 084 sigue mandando sobre **los datos** (`can_access_module`: el módulo
  cobranzas abre datos a cobranzas, contabilidad y gerencia).
- **Entrar a una app** es otra regla, por área: app Cobranzas = área
  cobranzas; app Contabilidad y Caja = área contabilidad (Caja también
  gerencia); app Marketing = marketing; app Gerencia = gerencia; app Técnica =
  tecnica; Postventa = permiso explícito. Dueño y super admin, todas.
  Así contabilidad no entra a la app de Cobranzas aunque lea pagos.
- Áreas válidas: se agrega `tecnica`. Módulos válidos de
  `account_module_members`: se agrega `postventa` (los demás siguen por área).
  Lista en código + CHECK (un solo rubro hoy; si llega otro, se pasa a tabla).
- Gerencia sigue siendo **solo por área** (`is_owner_or_gerencia`), nunca por
  fila explícita.

## 5. Conexiones (traspasos)
**Tabla `module_handoffs`**: cuenta, módulo origen, módulo destino, tipo,
entidad (`entity_type`, `entity_id`), estado `pendiente | aceptado | devuelto`,
nota de quien envía, motivo de devolución, enviado por, **asignado a**
(opcional), atendido por, fechas.
- **No guarda copia de datos.** Viaja solo la referencia; lo que el área
  destino ve lo arma el servidor desde el registro original y solo con los
  campos de esa conexión (regla de 11-07: ningún módulo copia datos).
- **Lectura:** solo quien tiene el módulo origen o el destino de esa fila
  (policy). Nadie escribe directo: RPCs `send_handoff`, `accept_handoff`,
  `return_handoff` (SECURITY DEFINER).
- **Sin duplicados:** índice único parcial (cuenta, tipo, entidad) mientras
  esté pendiente; un doble clic devuelve el mismo traspaso.
- **Aceptar y devolver** bloquean la fila (`FOR UPDATE`) y exigen estado
  pendiente; dos personas aceptando a la vez: gana una, la otra ve "ya lo
  tomó X". Devolver exige motivo y vuelve el caso al área origen.
- **Qué cambia en el registro**, por tipo (§5.1). Ningún traspaso mueve
  dinero ni crea planes.
- **Conexiones permitidas en código** (origen, destino, tipo); el botón solo
  aparece si la conexión existe y **el área destino tiene al menos una
  persona**; si no, el botón avisa "nadie en esa área todavía".

### 5.1 Primera entrega (F1): dos conexiones
| # | De → A | Botón | Qué ve el destino | Qué cambia |
|---|---|---|---|---|
| 3 | Cobranzas → Legal | "Pasar a legal" (cliente en causal) | cliente, contrato, deuda total, cuotas vencidas, gestiones hechas | registra la gestión "pase a legal" (ya existe en Fase A) |
| 10 | Cobranzas o Legal → Postventa | "Enviar a postventa" (reclamo o consulta) | cliente, lote, proyecto, tipo de caso, nota | abre un caso de postventa |

### 5.2 Después (cada una con su fase)
- #1 Ventas → Legal (expediente) y #2/#4 Legal ↔ Cobranzas (cronograma,
  adenda): fase C, porque requieren enlazar los cronogramas de Golden Legal
  (`legal_schedule_records`) con los planes; no son solo un botón.
- #5/#6 Cobranzas ↔ Contabilidad: con la app de Contabilidad.
- #7 pedidos a gerencia: **no es un traspaso**; es la cola de aprobaciones de
  `areas-pendientes` §3.3 (tabla propia, monto fijo, decisión, sin
  autoaprobación).
- #8 lote liberado, #9 plan pagado → postventa (depende de la carta de no
  adeudo, fase B), #11-#13 con área técnica (app aún sin definir).
- Marketing ↔ Ventas: el lead ya llega con su campaña (atribución 035); la
  venta por campaña es un reporte, no un traspaso.

## 6. Orden (pedido del dueño: conexiones → postventa → caja chica)
1. **F1 Conexiones:** tabla, RPCs, **un componente de bandeja compartido**
   ("Te enviaron" / "Enviados") que reusan todas las apps; conexiones #3 y #10;
   bandeja en Golden Legal y en las pantallas de Cobranzas del ERP; arreglos
   de entrada (middleware, login por app, retorno).
2. **F2 Postventa** en la app de ventas: pestaña con la bandeja, casos y
   agenda (lunes y sábado, 7 días, un cliente por visita) sobre la agenda
   existente (`049_agenda.sql`).
3. **F3 Caja mejorada:** proyecto y rubro por gasto y panel de gerencia por
   proyecto/rubro/mes (las cajas múltiples ya existen); nombre del menú por
   cuenta.
4. **F4 App Cobranzas**, **F5 App Contabilidad**, **F6 App Marketing**,
   **F7 App Gerencia**, **F8 App Área técnica**.

## 7. Decisiones pendientes del dueño
1. Qué ve y hace la app de Gerencia.
2. Qué hace la app de Área técnica.
3. App de Marketing: tablero de tareas diario + inversión por campaña, ¿algo más?
4. ¿El aviso de "Te enviaron" debe llegar también por WhatsApp?

## 8. Revisión EGM (2026-11-09)
`egm-design` y `egm-zoom-out` sobre v1. Corregido: efectos de aceptar y
devolver, duplicados y concurrencia, datos copiados en el traspaso (ahora
solo referencia, armado en servidor), lectura de la tabla por módulo,
entrada a apps distinta del acceso a datos (contabilidad no entra a
Cobranzas), gerencia solo por área, áreas sin personas, rutas no protegidas y
retorno del login solo a `/caja`, bandejas temporales en el ERP (ahora
componente compartido), #7 duplicado con la cola de aprobaciones, primera
entrega demasiado grande (15 → 2 conexiones), tabla de conexiones por cuenta
innecesaria con un solo rubro, cajas múltiples ya existentes, ubicación de la
caja.
