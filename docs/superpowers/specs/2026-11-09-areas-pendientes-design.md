# Áreas pendientes de Wio Suite — diseño v2 (tras revisión EGM, 2026-11-09)

Fuente: entrevistas por área en Golden Habitat (2026-11-07 y 2026-11-09),
guardadas en el vault del dueño ("Cuestionario por areas para Wio Suite").
Complementa `2026-11-07-conexiones-entre-modulos.md` (traspasos, fase F) y la
Fase A (`2026-11-07-fase-a-pagos-y-reglas-design.md`). Golden es la primera
cuenta; todo se construye genérico: lo propio de Golden (formato de Caja Ica,
días de visita, minivan) va como **configuración por cuenta o adaptador de
importación**, nunca escrito en el código.

## 0. Regla de arquitectura (dueño, 2026-11-07, reafirmada 2026-11-09)
- **Cada área tiene su propia app**, simple e intuitiva como Golden Legal, la
  app de ventas y la caja chica, con **sus tareas** y **botones para
  delegar** a otras áreas (traspasos de la fase F). Todas leen la misma base.
- El **ERP web** sigue existiendo: es la vista completa (gerencia) y el lugar
  de las pantallas de administración. Las piezas de este documento se
  construyen en la base y en el ERP primero, y cada app de área muestra solo
  su parte.
- **Postventa no tiene app propia:** es una **vista nueva dentro de la app de
  ventas** (repo `golden 3d`), porque en Golden la persona de postventa
  también es asesor.
- **La caja chica se mejora** (ver 3.6): deja de estar diferida.
- **Cobranzas tiene app propia** (dueño, 2026-11-09), simple como Golden
  Legal: cuotas, cola de vouchers, gestiones y bandeja de traspasos. Las
  pantallas de Cobranzas del ERP web quedan para gerencia.
- **Contabilidad tiene app propia** (dueño, 2026-11-09): pagos por validar,
  conciliación con Caja Ica, boletas y carta de no adeudo. Golden Caja
  queda solo para la caja chica y los gastos.
- Cada app: solo entra la gente de su área; vista de laptop y vista de
  celular separadas (como Golden Legal).

## 1. Por qué

Cada área de Golden trabaja con WhatsApp, Excel y cuadernos. El dolor más
caro: **validar un pago tarda ~1 semana**. Los clientes pagan por la
plataforma de recaudación de Caja Ica (código por proyecto) o por
transferencia a la cuenta del proyecto; las transferencias las valida el
gerente general a mano. Además: postventa es una sola persona sin agenda,
los clientes quieren su contrato y cronograma en el celular, y gerencia
aprueba abonos, condonaciones y reprogramaciones sin registro.

## 2. Reglas de Golden (entrevistas)

- Postventa: visitas solo lunes y sábado, pedidas con 7 días de
  anticipación, un cliente por visita, si la minivan está libre. Le derivan
  casos cobranzas y legal. Respuesta oficial por retraso de obra: la decide
  legal con el área técnica.
- Aprobaciones de gerencia: por el sistema y por correo, con copia a
  administración, para que quede registro.
- Carta de no adeudo: la hace cobranzas; firman gerente general y jefa del área.
- Caja Ica: calcula su propia mora y permite exonerarla; Excel de carga
  distinto por proyecto; se carga en modo "agregar".
- Asesores: página propia en TikTok y Facebook (pauta de la empresa); venta =
  contrato físico firmado y entregado a legal; no quieren ver su comisión.

## 3. Piezas, en orden

### 3.1 Cola "Vouchers por revisar" (ya diseñada en Fase A §5, no construida)
Es la vía más barata para bajar la semana de espera. Se construye tal como
dice la Fase A, con un cambio: **quien aprueba depende del banco destino**
(configurable por cuenta). En Golden: vouchers de Caja Ica los confirma
cobranzas/contabilidad; vouchers de otros bancos, gerencia (§5.2). Aprobar no se hace solo mirando la imagen del voucher:
la cola muestra banco, fecha, monto y número de operación declarados, y el
aprobador marca que lo vio en el estado de cuenta (si no, un voucher falso
pasa con un toque).

### 3.2 Importar el reporte de abonos de Caja Ica (fase B)
Solo importación; la exportación al Excel de carga queda diferida (§4).

Lo que se sabe de los archivos (muestras de Golden, 2026-11-09):
- **Estado de cuenta de la cuenta de ahorros** (PDF, por mes): fecha, hora,
  descripción, abono, cargo, saldo, canal. Tipos: "CONVENIOS (ABONO AHO) APP
  MOVIL" con su cargo de comisión S/ 1.00, y "DEPÓSITO CONV. COBRANZA" en
  agencia con cargo S/ 1.50. **No trae el código del cliente**: sirve para
  comprobar que el dinero llegó (totales por día), no para emparejar cuotas.
  Las comisiones son gasto de la empresa, no se restan del pago del cliente.
- **Excel de carga de la plataforma** (por convenio; columnas: Cod. Convenio,
  Cod. Institucion, Fecha Pago, Numero Registros, Cod. Cliente, Apellidos y
  Nombres, Relacion, Cod. Relacion, Concepto Pago, Monto, Moneda, Mora, Fecha
  Vencimiento, Prioridad, Cod. Cuenta, Direccion, MontoTotal, Exonerado). El
  **Cod. Cliente** es la clave que se guarda en el plan.
- Falta una muestra del **reporte de abonos de la plataforma** (el que se
  baja por fechas con el detalle por cliente): es la fuente de la
  importación. Sin esa muestra no se escribe el adaptador.

- **Tabla de staging** `bank_import_rows` por cuenta, con clave única
  (cuenta, origen, convenio, número de operación). Re-importar un rango que
  se solapa no crea filas nuevas: no hay pago doble.
- `installment_payments` gana una **referencia externa única** (origen +
  número de operación) que el RPC exige cuando el pago viene de importación.
- El **código de Caja Ica se guarda en el plan** (`payment_plans`), así un
  cliente con dos planes se distingue.
- Emparejar: misma referencia de plan, cuota pendiente **más antigua** con
  ese saldo. Si el monto cubre varias cuotas → `register_advance_payment`.
  Si es menor → pago en partes, respetando `max_payment_parts`. Si no cuadra
  (incluye mora de Caja Ica, decisión 1) → "por revisar".
- **Confirmación en lote por una persona con sesión** (los RPC exigen
  `auth.uid()`; no hay registro automático). El pago lleva la **fecha real
  del abono** (`paid_on` de Caja Ica); el RPC debe permitir fechas antiguas
  cuando el origen es una importación conciliada, sin abrir esa puerta a la
  carga manual. `late_fee_at_payment` se calcula a la fecha del abono.
- Si la cuota tenía un voucher del portal pendiente, la importación **no lo
  consume**: el voucher queda en la cola marcado "posible duplicado" (hoy el
  RPC toma y borra el voucher cuando `p_voucher_path` es null).

### 3.3 Una sola cola de aprobaciones de gerencia (fase E, después de F)
- Tabla de pedidos con tipo (abono a capital, condonación, reprogramación,
  transferencia), **monto fijado al pedir**, motivo, quién pidió, decisión,
  quién decidió y cuándo. Nadie aprueba su propio pedido.
- Se aprueba **en el sistema**; el correo solo avisa (a quien pidió y a
  administración, sin datos de deuda si administración no tiene acceso a
  cobranzas). Responder el correo no aprueba nada. Enviar con la conexión de
  correo existente (`054_correo.sql`, `email_accounts`) si sirve para enviar.
- "Condonación" con la mora de la Fase A (solo referencia): queda como
  registro de la decisión; si la mora oficial es la de Caja Ica, la
  exoneración se hace allá (decisión 1).

### 3.4 Postventa (fase E) — vista nueva en la app de ventas
- Vive en la app de ventas (repo `golden 3d`) como una pestaña "Postventa"
  para quien tenga esa área; no en el ERP web ni en una app aparte.
- **Agenda sobre la existente** (`049_agenda.sql`: `staff_availability`,
  citas tipo visita, recordatorios). Lunes/sábado, anticipación mínima y
  "un cliente por franja" son reglas de disponibilidad de la cuenta.
- Bandeja de casos derivados por cobranzas y legal (traspasos de la fase F).
- Entrega de lote (conexión #9): depende de la carta de no adeudo, que viene
  de la fase B; se construye después de ella.
- Requiere migración: agregar `postventa` a los módulos permitidos
  (`account_module_members.module_key`) y permitir más de un área por
  persona (hoy `profiles.area` es un solo valor; la persona de postventa de
  Golden también es asesor).

### 3.5 Portal: contrato en PDF
- El portal ya muestra cuotas y voucher; el estado de cuenta en PDF ya está
  en la Fase A. Se agrega la descarga del contrato reutilizando
  `legal_documents.pdf_url` (`033_legal_documents.sql`) si legal ya lo sube ahí.

### 3.6 Caja chica mejorada (app de caja, repo `GOLDEN CAJA`)
Pedido de gerencia (entrevista de compras/caja, 2026-11-09): ver cuánto
cuesta cada proyecto y cada negocio.
- Cada gasto lleva **proyecto** y **rubro** (personal, marketing, obra,
  combi, proveedores, otros); se pueden registrar por WhatsApp como hoy y la
  app propone proyecto y rubro a partir del texto.
- **Varias cajas** por cuenta (la general que entrega el gerente general y
  las de otros negocios del dueño), cada una con su responsable.
- **Panel de gerencia:** gasto por proyecto, por rubro y por mes, y por caja.
- Requiere migración en la caja: `cash_entries` hoy no tiene proyecto ni
  rubro (`063_golden_caja.sql`).
- Cotizaciones de proveedores (3-4 por compra): fuera por ahora.

## 4. Diferido o fuera
- Exportar el Excel de carga de Caja Ica (falta el formato por proyecto).
- Respuestas rápidas por partes para asesores (existe `message_templates`;
  revisar si basta), calificación previa, marketing con tablero de tareas
  (mejor una herramienta lista que código propio), fotos de avance de obra, respuestas oficiales (legal aún no las
  definió), cotizaciones de proveedores.
- Boletas SUNAT (fase 4), reemplazar Caja Ica, comisiones visibles, renders 3D.
- Menor: `src/lib/modules.ts` rotula `/caja` como "Golden Caja"; debe ser genérico.

## 5. Decisiones del dueño
1. **Mora oficial ante el cliente: la de Caja Ica** (decidido 2026-11-09;
   reemplaza a la regla de la Fase A §9.1 como cifra oficial). Consecuencias:
   - Al importar, un abono que trae cuota + mora se parte: la cuota va al
     libro de pagos con el RPC; la mora se guarda como **mora cobrada según
     Caja Ica** (dato aparte, no reduce la deuda de la cuota).
   - La exoneración de mora se hace en Caja Ica; la cola de aprobaciones
     solo registra la decisión de gerencia.
   - El cálculo del ERP (S/ 6 por día, tope 60 días) queda como **estimado**
     para cobranzas entre importaciones, rotulado así en pantalla (decisión
     de Aurex, a confirmar). Si el reporte de Caja Ica no trae la mora por
     separado, esas filas van a "por revisar".
2. **Quién confirma (decidido 2026-11-09, audios de Golden):**
   - Pagos que llegan a **Caja Ica** (por código de convenio, app o agencia):
     se ven en el estado de cuenta de Caja Ica, así que los confirma el
     área que usa esa plataforma (cobranzas y contabilidad) **sin pasar por
     gerencia**.
   - Transferencias a **otros bancos** (Interbank, BCP, BBVA): solo
     **gerencia**, porque esas cuentas reciben también otros ingresos y
     solo gerencia ve su estado de cuenta. Estas van a la cola de 3.1.
3. **Contrato en el portal (decidido 2026-11-09):** se muestra el
   **escaneado firmado**, gratis, **desde que se firma**. Solo la copia
   legalizada en papel se cobra (S/ 35). El PDF sin firmas como "copia
   informativa" queda por decidir; adendas y cesiones, por confirmar con
   legal. La **carta de no adeudo** por ahora solo se entrega en oficina
   (no va al portal).
   Formato actual de la carta ("Constancia de cancelación"): texto de no
   deuda sobre el compromiso de arras por manzana/lote/proyecto, tabla de
   montos, firmas del gerente general y de la jefa de cobranzas, y una hoja
   "Detalle de abonos" con fecha, número de operación y monto de cada pago,
   más un correlativo. El ERP puede generarla desde el plan pagado y el
   libro de pagos (la referencia externa de 3.2 da el número de operación);
   la firma sigue en oficina.

## 6. Revisión EGM (2026-11-09)
Revisores: `egm-design` y `egm-zoom-out`. Críticos de v1 corregidos aquí:
re-importación sin clave única (pago doble), RPC que rechaza fechas de más de
7 días para cobranzas, importación que consumía el voucher del portal.
Importantes: emparejamiento (mora, dos planes, cuotas iguales, varias
cuotas, partes), quién confirma, cola de aprobación sin tabla ni monto fijo,
aprobación por correo falsificable, `postventa` fuera de la lista de
módulos, reglas de Golden escritas en duro, piezas que ya existen
(agenda, correo, PDF legal, plantillas) y orden (3.5-3.7 de v1 diferidas).
