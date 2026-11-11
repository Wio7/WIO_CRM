import type { Metadata } from 'next';
import './caja.css';
import { clasesFuentesGolden } from '@/lib/apps/fuentes';
export const viewport = { themeColor: '#1d0b0f' };
export const metadata: Metadata = {
  title: { absolute: 'Golden Caja' },
  description: 'Tu caja, clara y al día.',
  manifest: '/caja/manifest.webmanifest',
  icons: { icon: '/caja-icon.svg', apple: '/caja-icon-192.png' },
  appleWebApp: {
    capable: true,
    title: 'Golden Caja',
    statusBarStyle: 'default',
  },
  robots: { index: false, follow: false },
};
export default function CashLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Fuentes de Golden (Plex y Newsreader), como en Golden Legal.
  return <div className={clasesFuentesGolden}>{children}</div>;
}
