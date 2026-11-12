# Fase F5 — App de Administración (Caja Ica) (plan, 2026-11-11)

Decisión del dueño (2026-11-11): F5 = app del área Administración (antes
"Contabilidad"). Administración lleva la Caja Ica: estado de cuenta, abonos y
pagos por validar. Área y permisos de datos ya en producción (092: puede lo
mismo que contabilidad en los módulos `cobranzas` y `cronograma`, y el panel
de la caja chica).

Usa el marco común de apps Golden (`src/components/apps/golden-shell.tsx`,
plan `2026-11-11-apps-golden-diseno.md`): laptop con barra lateral, celular
con cabecera y barra inferior, paleta de Golden Legal.

## Muestra real
- `C:\Users\Bryce\Downloads\Estado de Cuenta - 108532321000067245.xls`
  (Caja Ica, octubre 2026, BIFF .xls, 384 movimientos). Columnas: `Fecha Hora`
  (dd/mm/aaaa hh:mm:ss), `Descripción Operación`, `Depósitos`, `Retiros`
  (negativo), `Saldo Contable`, `Saldo Disponible`, `Agencia`.
- Descripciones vistas: `TRANS. INTER. INME. (CCE)` (transferencia
  interbancaria), `Depósito conv. cobranza` + `Cargo conv. cobranza` (-1.50),
  `CONVENIOS (ABONO AHO) APP` + `CONVENIOS COM (CARGO AHO)` (-1.00),
  `Depósito CCAKAS` (efectivo). Las comisiones las paga la empresa.
- Resumen de octubre (dato del dueño): abonos S/ 87,403.27; convenio 106 /
  42,464.46; interbancarias 56 / 22,556.03; app 43 / 15,739.77; efectivo 7 /
  3,976.55.
- NO trae código de cliente: identificar al cliente queda para cuando llegue
  el reporte de abonos de la plataforma (los `C###20261110.xlsx` de Descargas
  vinieron vacíos: solo códigos de convenio).

## Tareas
1. **Migración 093** `093_estado_cuenta_banco.sql` + `supabase/tests/093_casos.sql`
   + prueba PGlite como las de 089/091/092:
   - `bank_statement_imports` (cuenta, banco 'caja_ica', n.º de cuenta,
     periodo, archivo, quién, cuándo, filas, total depósitos).
   - `bank_statement_movements` (cuenta, import, fecha_hora, descripción,
     `tipo` en {convenio, interbancaria, app, efectivo, comision, otro},
     depósito, retiro, saldo, agencia, `huella` única por cuenta para no
     duplicar al reimportar, `payment_id` nullable → `installment_payments`,
     `estado` en {por_conciliar, conciliado, no_es_cuota, revisar}, nota).
   - RLS: leer y escribir solo con `can_access_module(account_id,'cobranzas')`
     y área administración/contabilidad/gerencia o dueño (mismo criterio que
     092). RPC `import_bank_statement(jsonb)` (inserta, ignora duplicados,
     devuelve nuevos/duplicados) y `set_movement_match(...)`.
   - Idempotente. Declarar en la cabecera qué funciones crea (ninguna que ya
     exista en producción).
2. **Lector del .xls** (puro, con pruebas sobre filas reales de la muestra):
   SheetJS desde el tarball oficial `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`
   (verificar que existe esa versión; no usar el `xlsx` viejo de npm). Clasifica
   el tipo por la descripción, calcula la huella, y devuelve el resumen por
   tipo (debe dar los totales de octubre de arriba).
3. **Conciliación** (pura, con pruebas): para cada depósito, candidatos en
   `installment_payments` por mismo monto y fecha ±2 días; marca conciliado
   si hay uno solo; "revisar" si hay varios.
4. **App** `/administracion` (lista protegida en middleware, login propio,
   manifiesto, nombre "Golden Administración" / "Administración" en
   `nombreApp`, acceso por área en `src/lib/apps/acceso.ts`: administración,
   contabilidad, dueño, super admin). Secciones:
   - **Resumen**: tarjeta vino con abonos del mes, por tipo, comisiones y
     cuántos falta conciliar.
   - **Estado de cuenta**: subir el .xls, ver movimientos con filtro por tipo
     y estado; laptop en tabla, celular en tarjetas.
   - **Por validar**: depósitos sin pago en el ERP y pagos del ERP sin
     depósito; reutiliza la confirmación de pagos existente (084) sin cambiar
     sus reglas.
   - **Caja chica**: enlace a `/caja`.
   - **Bandeja**: traspasos (componente compartido de F1).
5. **Demo** `/administracion/demo` con datos inventados.
6. Pruebas, tsc, eslint, build; capturas 1280 y 375.

## Notas de implementación (2026-11-11, tras publicar las apps Golden, PR #44)
- Marco: `src/components/apps/golden-shell.tsx` + `golden-frame.tsx`, secciones con
  `src/lib/apps/secciones.ts`, fuentes con `src/lib/apps/fuentes.ts`, estilos en
  `src/app/apps-golden.css`. Copiar el patrón de `src/app/cobranzas/**` y
  `src/components/cobranzas/cobranzas-shell.tsx` (layout, login propio, manifiesto,
  ícono, demo). Dinero siempre con `dinero()` de `src/lib/cobranzas/dinero.ts`.
- Rutas públicas de demo: `APP_PUBLIC` en `src/lib/app-paths.ts` (con prueba).
- Fuera de esta fase (F5b, cuando exista la cadena de traspasos del expediente):
  contratos en firma de gerencia, legalizaciones (S/ 35) y cartas notariales por
  enviar. Ver la nota del vault "Flujo de venta, contrato y cobranza por areas
  (2026-11-11)". En F5 dejar en la sección Resumen un espacio "Próximamente".
