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
import {
  MODULES,
  MODULE_AREAS,
  RUBRO_TEMPLATES,
  enableWithRequirements,
  matchingTemplate,
  withDependencies,
} from "@/lib/modules";

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

  // Apagar un módulo apaga los que dependen de él; encenderlo enciende
  // los que necesita (ej. Separaciones necesita Proyectos).
  function toggle(href: string, visible: boolean) {
    setOff((prev) =>
      new Set(visible ? enableWithRequirements(prev, href) : withDependencies([...prev, href])),
    );
  }

  const template = matchingTemplate([...off]);

  async function save() {
    setSaving(true);
    // Keep only known sections, in menu order, so the stored list stays tidy.
    const next = withDependencies(off);
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
            Elige el rubro o los módulos que usa esta cuenta. Inicio y Configuración siempre
            quedan. Sin Embudos de Venta, su Inicio pasa a ser el panel simple de campañas.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Plantilla por rubro</p>
          <div className="flex flex-wrap gap-2">
            {RUBRO_TEMPLATES.map((t) => (
              <Button
                key={t.key}
                size="sm"
                variant={template === t.key ? "default" : "outline"}
                onClick={() => setOff(new Set(t.disabled))}
              >
                {t.label}
              </Button>
            ))}
          </div>
        </div>

        <div className="max-h-[50vh] space-y-3 overflow-y-auto pr-1">
          {MODULE_AREAS.map((area) => (
            <div key={area.key}>
              <p className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                {area.label}
              </p>
              <ul className="space-y-1">
                {MODULES.filter((m) => m.area === area.key).map((m) => {
                  const visible = !off.has(m.href);
                  return (
                    <li
                      key={m.href}
                      className="flex items-center justify-between rounded-lg px-2 py-1.5 hover:bg-muted"
                    >
                      <span className={visible ? "text-sm text-foreground" : "text-sm text-muted-foreground"}>
                        {m.label}
                        {m.requires && (
                          <span className="ml-1 text-xs text-muted-foreground">
                            (usa {m.requires.map((r) => MODULES.find((x) => x.href === r)?.label ?? r).join(", ")})
                          </span>
                        )}
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
            </div>
          ))}
        </div>

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
