# Apps de Golden con el diseño de Golden Legal (plan, 2026-11-11)

Pedido del dueño (2026-11-11): la app de Cobranzas no le gusta; todas las apps
de área deben verse como Golden Legal (vino y dorado sobre crema, títulos en
serif), con vista de laptop y vista de celular separadas (no una estirada).
La Caja también pasa de verde a vino y dorado.

Referencias vivas (sin login):
- https://golden-legal.vercel.app/legal/demo (laptop: barra lateral oscura con
  marca; celular: cabecera oscura con marca y título, barra inferior con
  pastilla activa).
- https://golden-caja.vercel.app/caja/demo (tarjeta vino con totales y
  subtarjetas; botones grandes; barra inferior).
- Tokens de Legal: `GOLDEN LEGAN/src/app/globals.css` (`--paper #f5f1ea`,
  `--guinda #7a0c1e`, `--guinda-deep #4c0712`, `--chrome #1d0b0f`,
  `--gold #c9a23f`, `--gold-bright #e6c877`, ok/warn/bad/info y sus `-soft`),
  fuentes IBM Plex Sans (texto) y Newsreader (títulos), radio 14 px.

## Tareas

### T1. Marco común de app (`src/components/apps/golden-shell.tsx` + `src/app/apps-golden.css`)
- Un solo componente de marco que reciben todas las apps de área: nombre
  (de `nombreApp`), ícono, secciones (href, etiqueta corta, etiqueta larga,
  ícono, badge opcional), pie (Abrir el ERP web para dueño/super admin,
  Cerrar sesión), y la misma lógica de entrada que hoy tiene
  `cobranzas-shell.tsx` (cargando, sin sesión, "Esta app es de otra área").
- Laptop (md+): barra lateral `--chrome` con marca (ícono en cuadro vino con
  borde dorado, nombre en serif, subtítulo "GOLDEN · DREAM HABITAT" en dorado
  cuando la cuenta es Golden; genérico si no), sección activa con fondo
  vino suave y texto dorado claro; contenido sobre `--paper` con título de
  página en serif.
- Celular (<md): cabecera `--chrome` con marca a la izquierda (nombre corto de
  la app en dorado pequeño + título de la sección en serif blanco) y botón de
  salir; barra inferior blanca con ícono + etiqueta y pastilla vino suave en
  la activa; controles de 44 px; `safe-area`.
- Tema: al montar, el marco fuerza modo claro (quita `dark` / `data-mode`) y
  lo restaura al salir; pone `body[data-app]` y redefine las variables de
  shadcn (`--background`, `--foreground`, `--card`, `--primary`, `--muted`,
  `--border`, `--ring`, `--destructive`, `--popover`, etc.) con la paleta de
  Legal bajo `body[data-golden-app]`, para que pantallas y diálogos (portales)
  hereden el estilo sin copiarlas. Títulos `h1/h2` en Newsreader.
- Fuentes: cargar IBM Plex Sans y Newsreader con `next/font` solo en los
  layouts de las apps (no en el ERP web).

### T2. Cobranzas sobre el marco nuevo
- `cobranzas-shell.tsx` pasa a usar el marco de T1 (mismas 5 secciones).
- Pantalla Morosos: arriba una tarjeta vino estilo Caja con el total vencido
  y subtarjetas (clientes en mora, tramos 1-30 / 31-60 / 61-90 / +90). En
  celular, lista de tarjetas (cliente, lote, días, monto, botón WhatsApp y
  ver ficha); en laptop, tabla limpia. Lo mismo para Vouchers, Gestiones,
  Del día y la ficha del cliente: cada una con su vista de celular en
  tarjetas y su vista de laptop.
- Separar datos y vista donde haga falta para que la demo (T3) use las
  mismas vistas. El ERP web (`/collections`) debe seguir funcionando igual.

### T3. Demo sin login: `/cobranzas/demo`
- Igual que `/legal/demo` y `/caja/demo`: mismas vistas con datos
  inventados (rótulo "Demostración · datos inventados"), pública en el
  middleware, sin escribir nada. Sirve para revisar el diseño y para vender.

### T4. Caja en vino y dorado
- `src/app/caja/caja.css` y la cabecera de `cash-app.tsx`: cambiar la
  paleta verde por la de Legal (tarjeta de totales vino, acentos dorados,
  fondo crema), sin tocar la lógica. `/caja/demo` debe verse bien en
  laptop y celular.

### T5. Verificación
- `npm test` (vitest), `npx tsc --noEmit`, `npx eslint` en lo tocado,
  `npm run build`.
- Capturas de `/cobranzas/demo` y `/caja/demo` en 1280 px y 375 px.

## Después (fases siguientes, con el mismo marco)
- F5 App de Administración (Caja Ica): ver
  `SegundoCerebro/Conocimiento/Estado de cuenta de la Caja Ica...`.
- F6 Marketing, F7 Gerencia, F8 Área técnica: propuesta de pantallas que el
  dueño aprueba antes de construir.
