# 🔐 Golden Caja — Aplicación Financiera & Caja Chica

## Empresas financieras

Aplica en orden `063_golden_caja.sql`, `064_cash_private_boxes_audit.sql` y `065_cash_companies.sql`. Después de iniciar sesión, `/caja` muestra las empresas autorizadas. La migración 065 conserva los movimientos previos en la empresa que lleva el nombre de la cuenta de Wio y crea cajas vacías para Cafetería, Restaurante y La Jato · Hacienda en la cuenta Golden Habitat. El propietario puede crear más empresas desde el selector. Los permisos, saldos, presupuestos, auditoría y Excel se calculan por empresa. Un empleado solo ve las empresas a las que el propietario le dio acceso y, dentro de ellas, sus propios movimientos.

La migración 065 restringe las antiguas funciones `cash_snapshot`, `cash_command` y `cash_export`; la app usa `cash_company_list`, `cash_company_snapshot`, `cash_company_command` y `cash_company_export`. La instalación en una base real y el despliegue web son pasos operativos distintos de generar el código.

> **Golden Caja** es una aplicación financiera e independiente diseñada para el control de caja chica y finanzas operativas de **Golden Habitat**, totalmente integrada a la arquitectura multi-tenant y base de datos de **Wio CRM**.

## Actualización de cajas privadas y auditoría

Después de aplicar `063_golden_caja.sql`, aplica `064_cash_private_boxes_audit.sql` en Supabase. La migración 064 hace que el propietario vea el saldo individual de cada caja y todos los movimientos, y que cada integrante autorizado vea únicamente los movimientos y presupuestos que creó. Un encargado puede editar o anular sus propios movimientos; el propietario puede corregir cualquiera. Cada edición exige un motivo, comprueba la versión del registro y guarda fecha, hora, actor, valores anteriores y nuevos en `cash_entry_audit`. Los eventos anteriores a la instalación de la migración no se reconstruyen; los cambios posteriores sí quedan registrados. La tabla de auditoría no concede acceso directo al cliente: se consulta mediante `cash_snapshot()` solo para el propietario.

La pantalla permite dictar concepto, proveedor y motivo cuando el navegador ofrece reconocimiento de voz y el usuario concede micrófono. Siempre se revisa el texto antes de guardar. **Descargar Excel** genera un archivo `.xlsx` con todos los movimientos visibles para el usuario y, para el propietario, una segunda hoja con todo el historial de cambios. Las fechas de auditoría del archivo incluyen zona UTC; la pantalla muestra hora de Lima. La lista en pantalla muestra los 100 movimientos y 200 eventos más recientes, mientras la descarga incluye el historial completo autorizado.

---

## 📸 Icono Oficial de la Aplicación

La aplicación utiliza la **Caja Fuerte con Flecha Roja Ascendente** como su icono oficial en la PWA móvil, favicon de navegador y logotipo del encabezado:

- **Ruta del icono:** `/caja-icon.png` (PNG de alta resolución).
- **Archivos PWA:** `/caja-icon-192.png`, `/caja-icon-512.png`.

---

## 🎨 Identidad Visual y Paleta de Colores (Golden Brand)

La interfaz de usuario combina elegancia, legibilidad y contraste visual usando la paleta oficial de **Golden Habitat**:

| Color | Código Hex | Uso en la Aplicación |
| :--- | :--- | :--- |
| 🍷 **Rojo Guinda / Carmesí** | `#7A0C1E` / `#9E1B2D` | Tarjeta principal de saldo, botones primarios, barras de gastos y acentos de atención. |
| ✨ **Dorado Metallic** | `#D4AF37` / `#F3E5AB` | Bordes de lujo, iconos de marca, indicador de moneda, badges y destellos de hover. |
| 🖤 **Negro Obsidiana** | `#0D0E12` | Fondo del menú lateral (sidebar) y barra de navegación de aplicaciones móviles. |
| 🐘 **Plomo Oscuro** | `#1E2028` / `#334155` | Tarjetas secundarias, títulos de secciones y tipografía principal. |
| 🌫️ **Plomo Claro** | `#E2E8F0` / `#64748B` | Bordes de separación, textos secundarios y leyendas de apoyo. |
| 📄 **Blanco Papiro** | `#FFFFFF` / `#F8FAFC` | Fondo de la mesa de trabajo (workspace) y tarjetas de datos legibles. |

---

## 🖥️ Módulos y Funcionalidades de la Aplicación

### 1. 📊 **Resumen Financiero (Overview)**
- **Tarjeta de Saldo Disponible:** Muestra el saldo neto calculated a partir de todos los movimientos de caja registrados en soles (`PEN · S/`).
- **Tarjetas de Totales:** Indicadores independientes para **Total de Ingresos** (verde esmeralda) y **Total de Gastos** (rojo guinda).
- **Gráfico Financiero Interactivo (Balance Visual):** Barra comparativa dinámica que calcula en tiempo real el porcentaje relativo entre Ingresos y Gastos con leyendas de totales.
- **Acciones Rápidas:** Botones directos para **Registrar Gasto** y **Registrar Ingreso**.

### 2. 📑 **Movimientos e Historial (Movements)**
- **Tabla de Registros:** Detalle de cada operación con concepto, contraparte o proveedor, fecha de ocurrencia, persona responsable e importe en soles.
- **Buscador y Filtros:** Búsqueda en tiempo real por palabra clave y filtro por tipo (Todos, Ingresos o Gastos).
- **Invariabilidad Contable & Anulaciones:** Los movimientos no se borran; se anulan mediante la emisión de un registro de compensación inversa solicitando obligatoriamente el motivo de anulación.

### 3. 🎯 **Presupuestos (Budgets)**
- **Asignación por Categorías/Proyectos:** Creación de presupuestos (ej. Movilidad, Oficina, Materiales, Proyectos especiales).
- **Barra de Progreso y Alertas:** Progreso en dorado/carmesí que alerta en rojo guinda si un presupuesto ha superado su límite asignado.
- **Separación de Conceptos:** Asignar un presupuesto no descuenta dinero del saldo disponible en caja; el descuento real ocurre únicamente al registrar el gasto.

### 4. 🔐 **Gestión de Accesos (Access Control)**
- **Propietarios (Owners):** **Erick** y **Bryce** (`brycebueno15@gmail.com`) poseen rol `owner` con potestad exclusiva para administrar integrantes.
- **Matriz de Permisos Financieros:**
  - 👁️ **Lector (Reader):** Puede consultar únicamente sus propios saldos, presupuestos y movimientos sin editar.
  - ✍️ **Encargado de Caja (Cashier):** Puede registrar, editar y anular sus propios movimientos. No puede consultar la caja de otra persona.
  - 🚫 **Sin Acceso (None):** Bloqueo total de información financiera.

---

## 🔄 Sistema de Sincronización y Actualización

La aplicación cuenta con un doble sistema de actualización para garantizar que los datos estén al día en todo momento:

1. **Botones de Actualización Manual:**
   - 🔘 **Topbar Refresh:** Botón destacado `Actualizar` en la barra superior (web y móvil) con animación giratoria.
   - 🔘 **Sync Bar Refresh:** Acceso `Actualizar ahora` en la barra de estado.
   - 🔘 **Heading Refresh:** Botón `Actualizar datos` junto al título principal.
2. **Actualización Automática:**
   - Polling automático en segundo plano cada 15 segundos.
   - WebSockets en tiempo real conectados con Supabase para refrescar al detectar inserciones.

---

## 📱 Instalación como Aplicación Móvil (PWA)

**Golden Caja** está optimizada para instalarse en teléfonos celulares como una App Nativa:

- **Android (Google Chrome):** Toca `⋮` y selecciona **"Instalar aplicación"**.
- **iPhone / iOS (Safari):** Toca `⎋` (Compartir) y selecciona **"Agregar a inicio"**.

---

## 🛠️ Arquitectura y Tecnologías

- **Framework:** Next.js 16 (App Router, Turbopack) + React 19 + TypeScript.
- **Base de Datos & Auth:** Supabase PostgreSQL con RLS (Row Level Security) y funciones RPC (`cash_snapshot()`, `cash_command()`).
- **Estilos:** CSS3 personalizado con variables de color Golden Brand, responsive design (Mobile, Tablet, Laptop, Desktop).
- **Pruebas:** Vitest (23/23 pruebas unitarias e integración).
- **Repositorio GitHub:** [https://github.com/Wio7/GOLDEN-CAJA.git](https://github.com/Wio7/GOLDEN-CAJA.git)
- **Despliegue:** Vercel (`golden-caja.vercel.app`).
