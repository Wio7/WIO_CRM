import type { Metadata } from 'next';
import './caja.css';
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
  return children;
}
