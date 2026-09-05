'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import { toast } from 'sonner';
import type { Contact } from '@/types';
import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { GatedButton } from '@/components/ui/gated-button';
import { LeadSourceBadge } from '@/components/contacts/lead-source-badge';
import {
  PhoneCall,
  PhoneOff,
  Play,
  Pause,
  Loader2,
  Search,
  Users,
  ShieldBan,
} from 'lucide-react';

const LIST_LIMIT = 100;
const POLL_MS = 3000;

interface SessionCounts {
  pendiente: number;
  en_progreso: number;
  completado: number;
  omitido: number;
  total: number;
}

interface DialSession {
  id: string;
  mode: string;
  status: 'activa' | 'pausada' | 'finalizada';
  started_at: string;
  current: { name: string | null; phone: string | null } | null;
  counts: SessionCounts;
}

export default function DialerPage() {
  const supabase = createClient();
  const canDial = useCan('send-messages');

  const [session, setSession] = useState<DialSession | null>(null);
  const [loadingSession, setLoadingSession] = useState(true);
  const [acting, setActing] = useState(false);

  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loadingContacts, setLoadingContacts] = useState(true);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [starting, setStarting] = useState(false);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const loadSession = useCallback(async () => {
    try {
      const res = await fetch('/api/calls/sessions');
      if (!res.ok) return;
      const data = (await res.json()) as { session: DialSession | null };
      setSession(data.session);
    } catch {
      // Transient — the poll will retry.
    } finally {
      setLoadingSession(false);
    }
  }, []);

  const loadContacts = useCallback(async () => {
    setLoadingContacts(true);
    const term = search.trim();
    let query = supabase
      .from('contacts')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(LIST_LIMIT);
    if (term) {
      const like = `%${term}%`;
      query = query.or(`name.ilike.${like},phone.ilike.${like},email.ilike.${like}`);
    }
    const { data, error } = await query;
    if (error) toast.error('No se pudieron cargar los contactos');
    setContacts(data ?? []);
    setLoadingContacts(false);
  }, [supabase, search]);

  useEffect(() => {
    void loadSession();
  }, [loadSession]);

  useEffect(() => {
    void loadContacts();
  }, [loadContacts]);

  // Poll only while a session is live — the queue advances from Twilio
  // webhooks on the server, so the UI has nothing to subscribe to.
  useEffect(() => {
    const live = session?.status === 'activa' || session?.status === 'pausada';
    if (!live) {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
      return;
    }
    pollRef.current = setInterval(() => void loadSession(), POLL_MS);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = null;
    };
  }, [session?.status, loadSession]);

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function startDialing() {
    if (selected.size === 0) return;
    setStarting(true);
    try {
      const res = await fetch('/api/calls/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_ids: Array.from(selected) }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'No se pudo iniciar el marcado');
        return;
      }
      const skipped = (data.skipped ?? []).length;
      toast.success(
        skipped > 0
          ? `Marcado iniciado — ${data.queued} en cola, ${skipped} omitido(s)`
          : `Marcado iniciado — ${data.queued} en cola`,
      );
      setSelected(new Set());
      await loadSession();
    } catch {
      toast.error('Error al iniciar el marcado');
    } finally {
      setStarting(false);
    }
  }

  async function act(action: 'pausar' | 'reanudar' | 'finalizar') {
    if (!session) return;
    if (action === 'finalizar' && !confirm('¿Finalizar la sesión de marcado?')) return;
    setActing(true);
    try {
      const res = await fetch(`/api/calls/sessions/${session.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error ?? 'No se pudo actualizar la sesión');
        return;
      }
      if (action === 'finalizar') setSession(null);
      else await loadSession();
    } catch {
      toast.error('Error al actualizar la sesión');
    } finally {
      setActing(false);
    }
  }

  const live = session && session.status !== 'finalizada';

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Marcador</h1>
        <p className="text-sm text-muted-foreground">
          Marca secuencialmente a una cola de contactos. Cuando alguien contesta, la
          llamada se puentea a tu teléfono.
        </p>
      </div>

      {loadingSession ? (
        <div className="flex h-32 items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
        </div>
      ) : live ? (
        <div className="rounded-xl border border-primary/30 bg-primary/5 p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="relative flex h-2.5 w-2.5">
                  {session.status === 'activa' && (
                    <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                  )}
                  <span
                    className={`relative inline-flex h-2.5 w-2.5 rounded-full ${
                      session.status === 'activa' ? 'bg-primary' : 'bg-amber-500'
                    }`}
                  />
                </span>
                <h2 className="font-semibold text-foreground">
                  {session.status === 'activa' ? 'Marcando' : 'Pausado'}
                </h2>
              </div>

              {session.current ? (
                <p className="mt-2 text-sm text-foreground">
                  Llamando a{' '}
                  <span className="font-medium">
                    {session.current.name || session.current.phone}
                  </span>
                  {session.current.name && (
                    <span className="ml-1 font-mono text-xs text-muted-foreground">
                      {session.current.phone}
                    </span>
                  )}
                </p>
              ) : (
                <p className="mt-2 text-sm text-muted-foreground">
                  {session.status === 'activa'
                    ? 'Preparando la siguiente llamada…'
                    : 'Sin llamada en curso.'}
                </p>
              )}
            </div>

            <div className="flex shrink-0 gap-2">
              {session.status === 'activa' ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => act('pausar')}
                  disabled={acting}
                >
                  <Pause className="mr-1 h-3.5 w-3.5" />
                  Pausar
                </Button>
              ) : (
                <Button size="sm" onClick={() => act('reanudar')} disabled={acting}>
                  <Play className="mr-1 h-3.5 w-3.5" />
                  Reanudar
                </Button>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => act('finalizar')}
                disabled={acting}
                className="text-destructive hover:text-destructive"
              >
                <PhoneOff className="mr-1 h-3.5 w-3.5" />
                Finalizar
              </Button>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['En cola', session.counts.pendiente],
              ['Completados', session.counts.completado],
              ['Omitidos', session.counts.omitido],
              ['Total', session.counts.total],
            ].map(([label, value]) => (
              <div key={label as string} className="rounded-lg border border-border bg-card p-3">
                <p className="text-xs text-muted-foreground">{label}</p>
                <p className="text-xl font-semibold text-foreground">{value}</p>
              </div>
            ))}
          </div>

          {session.counts.omitido > 0 && (
            <p className="mt-3 flex items-center gap-1.5 text-xs text-muted-foreground">
              <ShieldBan className="h-3.5 w-3.5" />
              Los omitidos son contactos sin número o en la lista &quot;no llamar&quot;.
            </p>
          )}
        </div>
      ) : (
        <>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="relative w-full max-w-sm">
              <Search className="absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Buscar por nombre, teléfono o correo..."
                className="border-border bg-card pl-8 text-foreground"
              />
            </div>
            <GatedButton
              canAct={canDial}
              gateReason="iniciar llamadas"
              onClick={startDialing}
              disabled={selected.size === 0 || starting}
            >
              {starting ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <PhoneCall className="mr-2 h-4 w-4" />
              )}
              Iniciar marcado{selected.size > 0 ? ` (${selected.size})` : ''}
            </GatedButton>
          </div>

          <div className="rounded-xl border border-border">
            {loadingContacts ? (
              <div className="flex h-48 items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-primary" />
              </div>
            ) : contacts.length === 0 ? (
              <div className="flex h-48 flex-col items-center justify-center gap-2 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
                  <Users className="h-5 w-5 text-primary" />
                </div>
                <p className="font-medium text-foreground">Sin contactos</p>
                <p className="text-sm text-muted-foreground">
                  Agrega contactos para poder marcarles.
                </p>
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {contacts.map((contact) => (
                  <li key={contact.id}>
                    <label className="flex cursor-pointer items-center gap-3 p-3 hover:bg-muted/50">
                      <Checkbox
                        checked={selected.has(contact.id)}
                        onCheckedChange={() => toggle(contact.id)}
                        aria-label={`Seleccionar ${contact.name || contact.phone}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm font-medium text-foreground">
                          {contact.name || (
                            <span className="italic text-muted-foreground">Sin nombre</span>
                          )}
                        </p>
                        <p className="font-mono text-xs text-muted-foreground">
                          {contact.phone}
                        </p>
                      </div>
                      <LeadSourceBadge source={contact.lead_source} />
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {contacts.length === LIST_LIMIT && (
            <p className="text-xs text-muted-foreground">
              Mostrando los {LIST_LIMIT} más recientes. Usa la búsqueda para acotar.
            </p>
          )}
        </>
      )}
    </div>
  );
}
