// Menú del dashboard: lo comparten la barra lateral (PC) y la barra inferior (celular).
import {
  Bell,
  Bot,
  Building2,
  CalendarCheck,
  CalendarDays,
  GitBranch,
  HandCoins,
  LayoutDashboard,
  MessageSquare,
  PhoneCall,
  PhoneIncoming,
  Radio,
  ShoppingBag,
  Ticket,
  Users,
  Wallet,
  Workflow,
  Zap,
} from "lucide-react";

export interface NavItem {
  href: string;
  label: string;
  icon: typeof LayoutDashboard;
  /**
   * When true, the nav row renders a small "Beta" chip after the label.
   * Purely informational — doesn't affect routing or access.
   */
  beta?: boolean;
}

export const navItems: NavItem[] = [
  { href: "/dashboard", label: "Panel Principal", icon: LayoutDashboard },
  { href: "/inbox", label: "Bandeja de Entrada", icon: MessageSquare },
  { href: "/notifications", label: "Notificaciones", icon: Bell },
  { href: "/contacts", label: "Contactos", icon: Users },
  { href: "/pipelines", label: "Embudos de Venta", icon: GitBranch },
  { href: "/projects", label: "Proyectos", icon: Building2 },
  { href: "/reservations", label: "Separaciones", icon: CalendarCheck },
  { href: "/payment-plans", label: "Cuotas", icon: Wallet },
  { href: "/collections", label: "Cobranzas", icon: HandCoins },
  { href: "/caja", label: "Golden Caja", icon: Wallet },
  { href: "/calendar", label: "Calendario", icon: CalendarDays },
  { href: "/coupons", label: "Cupones y referidos", icon: Ticket },
  { href: "/store", label: "Tienda", icon: ShoppingBag },
  { href: "/dialer", label: "Marcador", icon: PhoneCall },
  { href: "/calls", label: "Llamadas", icon: PhoneIncoming },
  { href: "/broadcasts", label: "Difusiones", icon: Radio },
  { href: "/automations", label: "Automatizaciones", icon: Zap },
  { href: "/flows", label: "Flujos", icon: Workflow, beta: true },
  { href: "/agents", label: "Agentes IA", icon: Bot },
];
