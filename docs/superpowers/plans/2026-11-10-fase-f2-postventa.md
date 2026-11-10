# Plan F2 Postventa (ERP, migración 086)

Diseño: `docs/superpowers/specs/2026-11-09-fase-f-apps-y-conexiones-design.md` §6.2 y `2026-11-09-areas-pendientes-design.md` §3.4.

1. Pruebas primero: `supabase/tests/086_casos.sql` + `src/lib/handoffs/postventa-086.database.test.ts` (PGlite; aplica 043-085 y 049). Deben fallar sin la 086.
2. `supabase/migrations/086_postventa.sql`:
   - `postventa_cases` (referencia al traspaso y al contacto, estado nuevo|agendado|resuelto, cita opcional, nota de resolución). Solo los RPC escriben; lectura por RLS (postventa, dueño o gerencia).
   - `accept_handoff` extendido de forma compatible: al aceptar un traspaso a postventa crea el caso.
   - RPC `postventa_cases_list`, `postventa_schedule_visit` (lunes/sábado, 7 días, una visita por franja de `staff_availability`), `postventa_resolve_case` (nota obligatoria).
   - `my_module_access()` suma `postventa`.
   - Fila de Alejandro en `account_module_members` y renombre de su perfil.
3. Correr suite, build; commits pequeños.
