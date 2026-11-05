"use client";

// A qué negocio pertenece una cuenta y qué apps usa (accounts.parent_account_id
// y accounts.apps, migración 081). Solo el super admin puede cambiarlo: el
// trigger de la base rechaza a cualquier otro.

import { useState } from "react";
import { toast } from "sonner";
import { Loader2, Plus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { createClient } from "@/lib/supabase/client";

export interface BusinessOption {
  id: string;
  name: string;
}

interface AccountBusinessDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: string;
  accountName: string;
  parentAccountId: string | null;
  apps: string[];
  /** Negocios a los que se puede mover (sin esta cuenta). */
  businesses: BusinessOption[];
  /** Esta cuenta tiene otras dentro: no puede pasar a colgar de un negocio. */
  hasMembers: boolean;
  /** Apps ya usadas en el CRM, para elegir con un toque. */
  suggestedApps: string[];
  onSaved: (next: { parent_account_id: string | null; apps: string[] }) => void;
}

export function AccountBusinessDialog({
  open,
  onOpenChange,
  accountId,
  accountName,
  parentAccountId,
  apps,
  businesses,
  hasMembers,
  suggestedApps,
  onSaved,
}: AccountBusinessDialogProps) {
  const [parent, setParent] = useState<string>(parentAccountId ?? "");
  const [chosen, setChosen] = useState<string[]>(apps);
  const [newApp, setNewApp] = useState("");
  const [saving, setSaving] = useState(false);

  const options = [...new Set([...suggestedApps, ...chosen])];

  function toggleApp(app: string) {
    setChosen((prev) => (prev.includes(app) ? prev.filter((a) => a !== app) : [...prev, app]));
  }

  function addApp() {
    const name = newApp.trim();
    if (!name) return;
    if (!chosen.includes(name)) setChosen((prev) => [...prev, name]);
    setNewApp("");
  }

  async function save() {
    setSaving(true);
    const next = { parent_account_id: parent || null, apps: chosen };
    const { error } = await createClient().from("accounts").update(next).eq("id", accountId);
    setSaving(false);
    if (error) {
      toast.error(`No se pudo guardar: ${error.message}`);
      return;
    }
    toast.success(`"${accountName}" guardada.`);
    onSaved(next);
    onOpenChange(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Negocio y apps de {accountName}</DialogTitle>
          <DialogDescription>
            Elige si esta cuenta es un negocio o si pertenece a uno, y en qué apps está.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <label htmlFor="account-parent" className="text-xs font-semibold text-muted-foreground">
            Pertenece a
          </label>
          <select
            id="account-parent"
            value={parent}
            onChange={(e) => setParent(e.target.value)}
            disabled={hasMembers}
            className="h-10 w-full rounded-lg border border-input bg-background px-3 text-sm"
          >
            <option value="">Ninguno: es un negocio</option>
            {businesses.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
          {hasMembers && (
            <p className="text-xs text-muted-foreground">
              Tiene cuentas dentro, así que sigue siendo un negocio. Para moverla, primero saca esas cuentas.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground">
            {parent ? "Apps que usa" : "Familia de apps del negocio"}
          </p>
          <div className="flex flex-wrap gap-2">
            {options.length === 0 && <span className="text-xs text-muted-foreground">Todavía no hay apps.</span>}
            {options.map((app) => {
              const on = chosen.includes(app);
              return (
                <button
                  key={app}
                  type="button"
                  onClick={() => toggleApp(app)}
                  aria-pressed={on}
                  className={`rounded-full border px-2.5 py-1 text-xs font-semibold transition-colors ${
                    on
                      ? "border-primary/40 bg-primary/15 text-primary"
                      : "border-white/10 bg-white/5 text-muted-foreground hover:text-foreground"
                  }`}
                >
                  {app}
                </button>
              );
            })}
          </div>
          <div className="flex gap-2">
            <Input
              value={newApp}
              onChange={(e) => setNewApp(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addApp();
                }
              }}
              placeholder="Nueva app, ej. NutriApp"
              className="h-9 text-sm"
            />
            <Button type="button" size="sm" variant="outline" onClick={addApp} className="h-9">
              <Plus className="h-4 w-4" />
              Agregar
            </Button>
          </div>
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
