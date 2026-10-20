export function GET() {
  return Response.json(
    {
      id: '/caja',
      name: 'Golden Caja',
      short_name: 'Caja',
      lang: 'es-PE',
      start_url: '/caja',
      scope: '/caja',
      display: 'standalone',
      background_color: '#f6f5ef',
      theme_color: '#173e35',
      icons: [
        { src: '/caja-icon-192.png', sizes: '192x192', type: 'image/png' },
        { src: '/caja-icon-512.png', sizes: '512x512', type: 'image/png' },
        {
          src: '/caja-icon.svg',
          sizes: 'any',
          type: 'image/svg+xml',
          purpose: 'any',
        },
      ],
    },
    { headers: { 'Content-Type': 'application/manifest+json' } }
  );
}
