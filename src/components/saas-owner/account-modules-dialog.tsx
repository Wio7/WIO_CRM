"use client";

// Which dashboard sections an account sees (accounts.disabled_modules,
// migration 066). Only the super admin can change it: the DB trigger
// rejects anyone else, so this dialog only appears in /saas-owner.

import { useState } from "react";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Switch } from "@/components/ui/switch";
import { createClient } from "@/lib/supabase/client";
import { MODULE_OPTIONS, SIMPLE_VIEW_MODULES } from "@/lib/modules";

interface AccountModulesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  accountName: string;
  disabledModules: string[];
  onSaved: (disabledModules: string[]) => void;
}

export function AccountModulesDialog({
  open,
  onOpenChange,
  accountId,
  accountName,
  disabledModules,
  onSaved,
}: AccountModulesDialogProps) {
  const [off, setOff] = useState<Set<string>>(() => new Set(disabledModules));
  const [saving, setSaving] = useState(false);

  function toggle(href: string, visible: boolean) {
    setOff((prev) => {
      const next = new Set(prev);
      if (visible) next.delete(href);
      else next.add(href);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    // Keep only known sections, in menu order, so the stored list stays tidy.
    const next = MODULE_OPTIONS.map((m) => m.href).filter((href) => off.has(href));
    const { error } = await createClient()
      .from("accounts")
      .update({ disabled_modules: next })
      .eq("id", accountId);
    setSaving(false);
    if (error) {
      toast.error(`No se pudo guardar: ${error.message}`);
      return;
    }
    toast.success(`Secciones de "${accountName}" guardadas. Se ven al recargar.`);
    onSaved(next);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Secciones de {accountName}</DialogTitle>
          <DialogDescription>
            Elige qué ve esta cuenta en el menú. Inicio y Configuración siempre quedan. Sin
            Embudos de Venta, su Inicio pasa a ser el panel simple de campañas.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setOff(new Set(SIMPLE_VIEW_MODULES))}
          >
            Vista simple: campañas y proyectos
          </Button>
          <Button size="sm" variant="outline" onClick={() => setOff(new Set())}>
            Mostrar todo
          </Button>
        </div>

        <ul className="max-h-[50vh] space-y-1 overflow-y-auto pr-1">
          {MODULE_OPTIONS.map((m) => {
            const visible = !off.has(m.href);
            return (
              <li
                key={m.href}
                className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-muted"
              >
                <span className={visible ? "text-sm text-foreground" : "text-sm text-muted-foreground"}>
                  {m.label}
                </span>
                <Switch
                  checked={visible}
                  onCheckedChange={(checked) => toggle(m.href, checked)}
                  aria-label={`Mostrar ${m.label}`}
                />
              </li>
            );
          })}
        </ul>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>
            Cancelar
          </Button>
          <Button onClick={save} disabled={saving}>
            {saving && <Loader2 className="h-4 w-4 animate-spin" />}
            Guardar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
