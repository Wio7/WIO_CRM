# Fase F4 — App de Cobranzas (plan corto)

Spec: `specs/2026-11-09-fase-f-apps-y-conexiones-design.md` §2-§4, §6.
Sin migración: el área se lee de `profiles.area` (lectura propia, ya permitida)
y los datos siguen mandados por la 084.

1. `src/lib/apps/acceso.ts` (puro, con pruebas): quién entra a qué app, a dónde
   mandar a quien no es del área. Reutilizable por las próximas apps.
2. `src/lib/apps/nombres.ts` (puro): "Golden Cobranzas" / "Cobranzas".
3. `src/lib/app-paths.ts` + `src/middleware.ts`: `/cobranzas` protegida, login
   propio `/cobranzas/login`, retorno en lista blanca, manifiesto público.
4. Contexto de ruta base (`/collections` por defecto, `/cobranzas` en la app)
   para que las pantallas del ERP sirvan en ambas sin copiarlas.
5. App: layout, manifiesto, login, shell (lateral en laptop, barra inferior en
   celular), pantallas que reusan las del ERP + gestiones + ficha de cliente.
6. Enlace "Abrir la app de Cobranzas" en `/collections`.
7. Pruebas, tsc, eslint, build.
