"use client";

import { useEffect, useState, useMemo } from "react";
import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import { useRouter } from "next/navigation";
import {
  Building2,
  Search,
  Trash2,
  ToggleLeft,
  ToggleRight,
  Activity,
  ShieldAlert,
  CheckCircle,
  XCircle,
  ExternalLink,
  ChevronRight,
  TrendingUp,
  Plus,
  Mail,
  User,
  Lock,
  Loader2,
  X,
  UserPlus
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { SaasInviteDialog } from "@/components/saas-owner/saas-invite-dialog";

interface Account {
  id: string;
  name: string;
  status: string;
  created_at: string;
  default_currency: string;
}

export default function SaasOwnerPage() {
  const { isSuperAdmin, loading: authLoading } = useAuth();
  const router = useRouter();
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [togglingId, setTogglingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [inviteTarget, setInviteTarget] = useState<Account | null>(null);

  // Invitation / Account Creation modal state
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [newAccount, setNewAccount] = useState({
    accountName: "",
    ownerName: "",
    email: "",
    password: ""
  });

  const supabase = createClient();

  useEffect(() => {
    if (!authLoading && !isSuperAdmin) {
      router.push("/dashboard");
    }
  }, [isSuperAdmin, authLoading, router]);

  const fetchAccounts = async () => {
    try {
      setLoading(true);
      const { data, error } = await supabase
        .from("accounts")
        .select("id, name, status, created_at, default_currency")
        .order("created_at", { ascending: false });

      if (error) throw error;
      setAccounts(data || []);
    } catch (err: any) {
      console.error("Error fetching accounts:", err.message);
      toast.error("Error al cargar las cuentas");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isSuperAdmin) {
      fetchAccounts();
    }
  }, [isSuperAdmin]);

  const handleToggleStatus = async (account: Account) => {
    const nextStatus = account.status === "active" ? "inactive" : "active";
    try {
      setTogglingId(account.id);
      const { error } = await supabase
        .from("accounts")
        .update({ status: nextStatus })
        .eq("id", account.id);

      if (error) throw error;

      setAccounts(prev =>
        prev.map(acc => (acc.id === account.id ? { ...acc, status: nextStatus } : acc))
      );
      toast.success(`Cuenta "${account.name}" ${nextStatus === "active" ? "activada" : "desactivada"}`);
    } catch (err: any) {
      console.error("Error toggling status:", err.message);
      toast.error("Error al actualizar el estado");
    } finally {
      setTogglingId(null);
    }
  };

  const handleDeleteAccount = async (account: Account) => {
    const confirmDelete = window.confirm(
      `¿Estás seguro de que deseas eliminar permanentemente la cuenta "${account.name}"? Esta acción borrará todos sus datos, contactos, configuraciones y usuarios asociados de Supabase Auth de manera irreversible.`
    );
    if (!confirmDelete) return;

    try {
      setDeletingId(account.id);
      const response = await fetch("/api/admin/accounts/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountId: account.id }),
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Error al eliminar");

      setAccounts(prev => prev.filter(acc => acc.id !== account.id));
      toast.success(`Cuenta "${account.name}" eliminada exitosamente`);
    } catch (err: any) {
      console.error("Error deleting account:", err.message);
      toast.error(err.message || "Error al eliminar la cuenta");
    } finally {
      setDeletingId(null);
    }
  };

  const handleCreateAccountSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAccount.accountName.trim() || !newAccount.ownerName.trim() || !newAccount.email.trim() || !newAccount.password.trim()) {
      toast.error("Por favor completa todos los campos requeridos");
      return;
    }

    try {
      setIsCreating(true);
      const response = await fetch("/api/admin/accounts/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(newAccount),
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Error al crear la cuenta");

      toast.success(`Cuenta "${newAccount.accountName}" creada exitosamente`);
      setIsCreateModalOpen(false);
      setNewAccount({
        accountName: "",
        ownerName: "",
        email: "",
        password: ""
      });
      fetchAccounts();
    } catch (err: any) {
      console.error("Error creating account:", err.message);
      toast.error(err.message || "Error al crear la cuenta");
    } finally {
      setIsCreating(false);
    }
  };

  const filteredAccounts = useMemo(() => {
    return accounts.filter(acc =>
      acc.name.toLowerCase().includes(search.toLowerCase()) ||
      acc.id.toLowerCase().includes(search.toLowerCase())
    );
  }, [accounts, search]);

  const stats = useMemo(() => {
    const total = accounts.length;
    const active = accounts.filter(a => a.status === "active").length;
    const inactive = total - active;
    return { total, active, inactive };
  }, [accounts]);

  if (authLoading || !isSuperAdmin) {
    return (
      <div className="flex h-screen items-center justify-center bg-[#070708]">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Verificando Credenciales...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto bg-[#070708] text-white p-6 lg:p-10 space-y-8 relative">
      {/* Background neon glows */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none opacity-10">
        <div className="absolute top-[5%] right-[10%] w-[40%] h-[40%] bg-primary/30 rounded-full blur-[140px]" />
        <div className="absolute bottom-[5%] left-[10%] w-[40%] h-[40%] bg-rose-500/30 rounded-full blur-[140px]" />
      </div>

      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 relative z-10">
        <div>
          <h1 className="text-3xl font-black tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white via-neutral-200 to-neutral-400">
            ADMINISTRACIÓN SAAS GLOBAL
          </h1>
          <p className="text-muted-foreground text-xs uppercase tracking-widest mt-1 font-bold">
            Panel Maestro de Control de Cuentas y Tenants — Wio CRM
          </p>
        </div>
        <div className="flex items-center gap-3">
          <Button 
            onClick={() => setIsCreateModalOpen(true)}
            className="bg-primary hover:bg-primary/95 text-[#070708] hover:text-black font-black rounded-xl h-10 px-5 text-xs uppercase tracking-widest flex items-center gap-2 shadow-lg shadow-primary/10 transition-all duration-300 active:scale-95"
          >
            <Plus className="h-4 w-4 stroke-[3]" />
            Nueva Cuenta / Proyecto
          </Button>
          <Button 
            onClick={fetchAccounts} 
            variant="outline" 
            className="border-white/5 bg-white/5 hover:bg-white/10 text-white rounded-xl h-10 px-4 text-xs uppercase tracking-widest font-bold"
          >
            Refrescar
          </Button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 relative z-10">
        {/* Card 1 */}
        <div className="bg-[#121214] border border-white/5 rounded-3xl p-6 relative overflow-hidden group shadow-lg">
          <div className="absolute inset-0 bg-gradient-to-tr from-primary/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-muted-foreground text-[10px] uppercase font-bold tracking-widest">Total Cuentas</p>
              <h3 className="text-3xl font-black mt-2 text-white">{stats.total}</h3>
            </div>
            <div className="h-12 w-12 rounded-2xl bg-primary/10 text-primary border border-primary/20 flex items-center justify-center shadow-inner">
              <Building2 className="h-5 w-5" />
            </div>
          </div>
          <div className="flex items-center gap-2 mt-4 text-[10px] text-muted-foreground">
            <TrendingUp className="h-3 w-3 text-primary animate-pulse" />
            <span>Actualizado en tiempo real</span>
          </div>
        </div>

        {/* Card 2 */}
        <div className="bg-[#121214] border border-white/5 rounded-3xl p-6 relative overflow-hidden group shadow-lg">
          <div className="absolute inset-0 bg-gradient-to-tr from-emerald-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-muted-foreground text-[10px] uppercase font-bold tracking-widest">Cuentas Activas</p>
              <h3 className="text-3xl font-black mt-2 text-white">{stats.active}</h3>
            </div>
            <div className="h-12 w-12 rounded-2xl bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 flex items-center justify-center shadow-inner">
              <CheckCircle className="h-5 w-5" />
            </div>
          </div>
          <div className="flex items-center gap-2 mt-4 text-[10px] text-emerald-500">
            <div className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-ping" />
            <span>Acceso activo a la plataforma</span>
          </div>
        </div>

        {/* Card 3 */}
        <div className="bg-[#121214] border border-white/5 rounded-3xl p-6 relative overflow-hidden group shadow-lg">
          <div className="absolute inset-0 bg-gradient-to-tr from-rose-500/5 to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-500 pointer-events-none" />
          <div className="flex items-center justify-between">
            <div>
              <p className="text-muted-foreground text-[10px] uppercase font-bold tracking-widest">Cuentas Suspendidas</p>
              <h3 className="text-3xl font-black mt-2 text-white">{stats.inactive}</h3>
            </div>
            <div className="h-12 w-12 rounded-2xl bg-rose-500/10 text-rose-500 border border-rose-500/20 flex items-center justify-center shadow-inner">
              <XCircle className="h-5 w-5" />
            </div>
          </div>
          <div className="flex items-center gap-2 mt-4 text-[10px] text-rose-500">
            <ShieldAlert className="h-3 w-3 text-rose-500 animate-pulse" />
            <span>Acceso bloqueado temporalmente</span>
          </div>
        </div>
      </div>

      {/* Control Panel Section */}
      <div className="bg-[#121214] border border-white/5 rounded-[2rem] p-6 space-y-6 relative z-10 shadow-2xl">
        {/* Search & Actions */}
        <div className="flex flex-col md:flex-row md:items-center gap-4 justify-between">
          <div className="relative w-full md:max-w-md">
            <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Buscar por nombre de cuenta o identificador..."
              className="pl-10 h-11 bg-[#0d0d0f] border-white/5 rounded-xl text-white placeholder-muted-foreground focus-visible:ring-primary focus-visible:ring-offset-0 focus-visible:border-primary transition-all text-xs"
            />
          </div>
          <div className="text-[10px] text-muted-foreground uppercase font-bold tracking-widest">
            {filteredAccounts.length} de {accounts.length} cuentas encontradas
          </div>
        </div>

        {/* Accounts Table/List */}
        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-xs text-muted-foreground uppercase tracking-widest font-bold">Cargando Tenants...</p>
          </div>
        ) : filteredAccounts.length === 0 ? (
          <div className="text-center py-16 border border-dashed border-white/5 rounded-3xl bg-[#0d0d0f]">
            <Building2 className="h-10 w-10 text-muted-foreground/30 mx-auto" />
            <p className="mt-4 text-sm text-muted-foreground">No se encontraron cuentas registradas</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-white/5 text-[10px] text-muted-foreground uppercase font-bold tracking-wider">
                  <th className="py-4 px-4">Cuenta / Identificador</th>
                  <th className="py-4 px-4">Moneda</th>
                  <th className="py-4 px-4">Creada el</th>
                  <th className="py-4 px-4">Estado</th>
                  <th className="py-4 px-4 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/5 text-xs">
                {filteredAccounts.map(account => (
                  <tr key={account.id} className="group hover:bg-white/[0.01] transition-colors">
                    <td className="py-4 px-4 space-y-1">
                      <div className="font-bold text-white group-hover:text-primary transition-colors flex items-center gap-1.5 text-sm">
                        {account.name}
                      </div>
                      <div className="text-[10px] font-mono text-muted-foreground/60 select-all">
                        {account.id}
                      </div>
                    </td>
                    <td className="py-4 px-4">
                      <span className="bg-white/5 border border-white/10 px-2 py-0.5 rounded-md text-[10px] font-bold text-muted-foreground">
                        {account.default_currency || "USD"}
                      </span>
                    </td>
                    <td className="py-4 px-4 text-muted-foreground/80">
                      {new Date(account.created_at).toLocaleDateString("es-ES", {
                        year: "numeric",
                        month: "long",
                        day: "numeric",
                      })}
                    </td>
                    <td className="py-4 px-4">
                      <span
                        className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider ${
                          account.status === "active"
                            ? "bg-emerald-500/10 text-emerald-500 border border-emerald-500/20"
                            : "bg-rose-500/10 text-rose-500 border border-rose-500/20"
                        }`}
                      >
                        <span className={`h-1.5 w-1.5 rounded-full ${account.status === "active" ? "bg-emerald-500" : "bg-rose-500"}`} />
                        {account.status === "active" ? "Activo" : "Inactivo"}
                      </span>
                    </td>
                    <td className="py-4 px-4 text-right">
                      <div className="flex items-center justify-end gap-2">
                        {/* Invite by Email Button */}
                        <Button
                          onClick={() => setInviteTarget(account)}
                          variant="ghost"
                          className="h-9 w-9 rounded-xl border border-primary/10 bg-primary/5 hover:bg-primary/20 p-0 text-primary"
                          title="Invitar por correo a esta cuenta"
                        >
                          <UserPlus className="h-4 w-4" />
                        </Button>

                        {/* Toggle Status Button */}
                        <Button
                          onClick={() => handleToggleStatus(account)}
                          disabled={togglingId === account.id}
                          variant="ghost"
                          className="h-9 w-9 rounded-xl border border-white/5 bg-white/5 hover:bg-white/10 p-0 text-muted-foreground hover:text-white"
                          title={account.status === "active" ? "Desactivar Acceso" : "Activar Acceso"}
                        >
                          {togglingId === account.id ? (
                            <div className="h-4 w-4 animate-spin rounded-full border border-current border-t-transparent" />
                          ) : account.status === "active" ? (
                            <ToggleRight className="h-5 w-5 text-emerald-500" />
                          ) : (
                            <ToggleLeft className="h-5 w-5 text-muted-foreground/50" />
                          )}
                        </Button>

                        {/* Delete Button */}
                        <Button
                          onClick={() => handleDeleteAccount(account)}
                          disabled={deletingId === account.id}
                          variant="ghost"
                          className="h-9 w-9 rounded-xl border border-rose-500/10 bg-rose-500/5 hover:bg-rose-500/20 p-0 text-rose-400 hover:text-rose-300"
                          title="Eliminar Cuenta"
                        >
                          {deletingId === account.id ? (
                            <div className="h-4 w-4 animate-spin rounded-full border border-current border-t-transparent" />
                          ) : (
                            <Trash2 className="h-4 w-4" />
                          )}
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Creation Modal */}
      <Dialog open={isCreateModalOpen} onOpenChange={setIsCreateModalOpen}>
        <DialogContent className="bg-[#121214] border border-white/5 text-white max-w-md rounded-[2rem] p-6 shadow-2xl relative">
          <div className="absolute right-4 top-4">
            <Button
              onClick={() => setIsCreateModalOpen(false)}
              variant="ghost"
              className="h-8 w-8 rounded-full border border-white/5 bg-white/5 hover:bg-white/10 p-0 text-muted-foreground hover:text-white"
            >
              <X className="h-4 w-4" />
            </Button>
          </div>

          <DialogHeader className="space-y-2">
            <DialogTitle className="text-xl font-black bg-clip-text text-transparent bg-gradient-to-r from-white to-neutral-400">
              CREAR NUEVA CUENTA / PROYECTO
            </DialogTitle>
            <DialogDescription className="text-xs text-muted-foreground">
              Registra un nuevo tenant en Wio CRM y configura las credenciales de su propietario inicial.
            </DialogDescription>
          </DialogHeader>

          <form onSubmit={handleCreateAccountSubmit} className="space-y-4 mt-4">
            {/* Account Name */}
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-widest font-black text-muted-foreground flex items-center gap-1.5">
                <Building2 className="h-3.5 w-3.5 text-primary" />
                Nombre de la Cuenta
              </label>
              <Input
                value={newAccount.accountName}
                onChange={e => setNewAccount(prev => ({ ...prev, accountName: e.target.value }))}
                placeholder="Ej. Aurex, Golden Habitat..."
                className="h-11 bg-[#0d0d0f] border-white/5 rounded-xl text-white placeholder-muted-foreground/45 focus-visible:ring-primary focus-visible:ring-offset-0 text-xs"
                required
              />
            </div>

            {/* Owner Name */}
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-widest font-black text-muted-foreground flex items-center gap-1.5">
                <User className="h-3.5 w-3.5 text-primary" />
                Nombre del Propietario
              </label>
              <Input
                value={newAccount.ownerName}
                onChange={e => setNewAccount(prev => ({ ...prev, ownerName: e.target.value }))}
                placeholder="Ej. Luis Bryce, Bryan..."
                className="h-11 bg-[#0d0d0f] border-white/5 rounded-xl text-white placeholder-muted-foreground/45 focus-visible:ring-primary focus-visible:ring-offset-0 text-xs"
                required
              />
            </div>

            {/* Owner Email */}
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-widest font-black text-muted-foreground flex items-center gap-1.5">
                <Mail className="h-3.5 w-3.5 text-primary" />
                Correo Electrónico
              </label>
              <Input
                type="email"
                value={newAccount.email}
                onChange={e => setNewAccount(prev => ({ ...prev, email: e.target.value }))}
                placeholder="ejemplo@wiocrm.com"
                className="h-11 bg-[#0d0d0f] border-white/5 rounded-xl text-white placeholder-muted-foreground/45 focus-visible:ring-primary focus-visible:ring-offset-0 text-xs"
                required
              />
            </div>

            {/* Owner Password */}
            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-widest font-black text-muted-foreground flex items-center gap-1.5">
                <Lock className="h-3.5 w-3.5 text-primary" />
                Contraseña de Acceso
              </label>
              <Input
                type="password"
                value={newAccount.password}
                onChange={e => setNewAccount(prev => ({ ...prev, password: e.target.value }))}
                placeholder="Mínimo 6 caracteres"
                className="h-11 bg-[#0d0d0f] border-white/5 rounded-xl text-white placeholder-muted-foreground/45 focus-visible:ring-primary focus-visible:ring-offset-0 text-xs"
                required
                minLength={6}
              />
            </div>

            <DialogFooter className="pt-4 border-t border-white/5 flex gap-2">
              <Button
                type="button"
                onClick={() => setIsCreateModalOpen(false)}
                variant="outline"
                className="border-white/5 bg-white/5 hover:bg-white/10 text-white rounded-xl h-11 text-xs uppercase tracking-widest font-bold flex-1"
              >
                Cancelar
              </Button>
              <Button
                type="submit"
                disabled={isCreating}
                className="bg-primary hover:bg-primary/95 text-[#070708] hover:text-black font-black rounded-xl h-11 text-xs uppercase tracking-widest flex-1 flex items-center justify-center gap-2"
              >
                {isCreating ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Creando...
                  </>
                ) : (
                  "Crear Cuenta"
                )}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* Invite Modal */}
      {inviteTarget && (
        <SaasInviteDialog
          open={!!inviteTarget}
          onOpenChange={(open) => {
            if (!open) setInviteTarget(null);
          }}
          accountId={inviteTarget.id}
          accountName={inviteTarget.name}
        />
      )}
    </div>
  );
}
