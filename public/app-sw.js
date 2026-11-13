// Service worker de las apps de área (Cobranzas, Administración...).
// Se registra con el scope de cada app (ej. /cobranzas) para que Chrome
// ofrezca "Instalar app". No guarda nada en caché: las páginas van siempre
// a la red; si no hay conexión, muestra un aviso simple.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
            '<title>Sin conexión</title><body style="font-family:system-ui;padding:32px;text-align:center;color:#3a2a2e;background:#f5f1ea">' +
            "<h1 style=\"font-size:20px\">Sin conexión</h1><p>Revisa tu internet y vuelve a intentar.</p></body>",
          { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } },
        ),
    ),
  );
});
