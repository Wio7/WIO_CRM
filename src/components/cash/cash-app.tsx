'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  ArrowDownLeft,
  ArrowUpRight,
  ArrowRight,
  Wallet,
  Plus,
  Search,
  RefreshCw,
  X,
  LayoutGrid,
  List,
  ChartPie,
  Users,
  Undo2,
  ShieldCheck,
  History,
  Download,
  Pencil,
  Mic,
  Building2,
} from 'lucide-react';
import { createClient } from '@/lib/supabase/client';
import {
  limaDate,
  money,
  parseAmount,
  type CashEntry,
  type CashCompany,
  type CashSnapshot,
} from '@/lib/cash/model';

type Panel = 'overview' | 'movements' | 'budgets' | 'access' | 'audit';
type Modal = 'income' | 'expense' | 'budget' | 'edit' | CashEntry | null;
const demoCompanies: CashCompany[] = [
  { id: 'demo', name: 'Golden Habitat · Inmobiliaria', role: 'owner' },
  { id: 'demo-cafe', name: 'Cafetería', role: 'owner' },
  { id: 'demo-restaurant', name: 'Restaurante', role: 'owner' },
  { id: 'demo-jato', name: 'La Jato · Hacienda', role: 'owner' },
];
export function CashApp({ demo }: { demo?: CashSnapshot }) {
  const [data, setData] = useState<CashSnapshot | null>(null);
  const [companies, setCompanies] = useState<CashCompany[]>(demo ? demoCompanies : []);
  const [selectedCompanyId, setSelectedCompanyId] = useState<string | null>(null);
  const [newCompanyName, setNewCompanyName] = useState('');
  const [panel, setPanel] = useState<Panel>('overview');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [loading, setLoading] = useState(!demo);
  const [connected, setConnected] = useState(false);
  const [updated, setUpdated] = useState('');
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [modal, setModal] = useState<Modal>(null);
  const [editing, setEditing] = useState<CashEntry | null>(null);
  const [person, setPerson] = useState('all');
  const [listening, setListening] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [uncertain, setUncertain] = useState(false);
  const pending = useRef<Record<string, unknown> | null>(null);
  const sequence = useRef(0);
  const dialog = useRef<HTMLDialogElement>(null);
  const accountId = data?.accountId;
  const companyId = data?.companyId;
  const canWrite = data?.role === 'owner' || data?.role === 'cashier';

  const refresh = useCallback(async () => {
    if (demo) return;
    const ticket = ++sequence.current;
    try {
      const url = selectedCompanyId ? `/api/caja?companyId=${encodeURIComponent(selectedCompanyId)}` : '/api/caja';
      const res = await fetch(url, { cache: 'no-store' });
      const body = await res.json();
      if (ticket !== sequence.current) return;
      if (!res.ok) {
        if ([401, 403].includes(res.status)) setData(null);
        throw new Error(
          res.status === 401
            ? 'Tu sesión terminó. Vuelve a iniciar sesión.'
            : body.error
        );
      }
      if (selectedCompanyId) setData(body);
      else setCompanies(body);
      setError('');
      setUpdated(
        new Date().toLocaleTimeString('es-PE', {
          hour: '2-digit',
          minute: '2-digit',
        })
      );
    } catch (e) {
      if (ticket === sequence.current)
        setError(
          e instanceof Error ? e.message : 'No pudimos actualizar la caja.'
        );
    } finally {
      if (ticket === sequence.current) setLoading(false);
    }
  }, [demo, selectedCompanyId]);

  function chooseCompany(company: CashCompany) {
    setError('');
    setNotice('');
    setQuery('');
    setFilter('all');
    setPerson('all');
    setPanel('overview');
    setSelectedCompanyId(company.id);
    if (demo) setData(company.id === 'demo' ? { ...demo, companyId: 'demo', accountName: company.name } : {
      ...demo, companyId: company.id, accountName: company.name, income: 0, expense: 0,
      entries: [], entryCount: 0, budgets: [], audit: [], boxes: [], members: demo.members,
    });
    else { setData(null); setLoading(true); }
  }
  function leaveCompany() {
    setSelectedCompanyId(null);
    setData(null);
    setPanel('overview');
    setPerson('all');
    setQuery('');
    setFilter('all');
    setError('');
    setLoading(!demo);
  }
  async function addCompany(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!newCompanyName.trim() || demo || saving) return;
    setSaving(true);
    try {
      const response = await fetch('/api/caja', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'company', requestId: crypto.randomUUID(), name: newCompanyName.trim() }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error);
      setNewCompanyName('');
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo crear la empresa.'); }
    finally { setSaving(false); }
  }

  useEffect(() => {
    void refresh();
    if (demo) return;
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, 15000);
    const resume = () => {
      void refresh();
    };
    window.addEventListener('online', resume);
    window.addEventListener('focus', resume);
    return () => {
      clearInterval(timer);
      window.removeEventListener('online', resume);
      window.removeEventListener('focus', resume);
      // Invalidate pending fetches; this is a request counter, not a DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      sequence.current++;
    };
  }, [refresh, demo]);

  useEffect(() => {
    if (demo || !accountId || !companyId) return;
    const client = createClient();
    const channel = client
      .channel(`cash:${companyId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'cash_entries',
          filter: `company_id=eq.${companyId}`,
        },
        () => {
          void refresh();
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'cash_budgets',
          filter: `company_id=eq.${companyId}`,
        },
        () => {
          void refresh();
        }
      )
      .subscribe((status) => setConnected(status === 'SUBSCRIBED'));
    return () => {
      void client.removeChannel(channel);
      setConnected(false);
    };
  }, [accountId, companyId, demo, refresh]);

  useEffect(() => {
    if (modal) dialog.current?.showModal();
    else dialog.current?.close();
  }, [modal]);
  function open(next: Modal) {
    pending.current = null;
    setUncertain(false);
    setFormError('');
    setModal(next);
  }
  function openEdit(entry: CashEntry) {
    setEditing(entry);
    open('edit');
  }
  function dictate(field: string) {
    type Recognition = {
      lang: string; onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
      onerror: (() => void) | null; onend: (() => void) | null; start: () => void;
    };
    const browser = window as Window & { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    const Constructor = browser.SpeechRecognition ?? browser.webkitSpeechRecognition;
    if (!Constructor) { setFormError('El dictado no está disponible en este navegador. Puedes escribir el dato.'); return; }
    const recognition = new Constructor();
    recognition.lang = 'es-PE';
    recognition.onresult = (event) => {
      const element = dialog.current?.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[name="${field}"]`);
      if (element) {
        element.value = `${element.value} ${event.results[0][0].transcript}`.trim();
        element.dispatchEvent(new Event('input', { bubbles: true }));
        element.focus();
      }
    };
    recognition.onerror = () => { setFormError('No pudimos escuchar. Comprueba el micrófono e inténtalo de nuevo.'); setListening(''); };
    recognition.onend = () => setListening('');
    setListening(field);
    recognition.start();
  }
  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!modal || saving) return;
    setFormError('');
    const values = new FormData(event.currentTarget);
    try {
      if (!pending.current) {
        const requestId = crypto.randomUUID();
        pending.current =
          typeof modal === 'object'
            ? {
                action: 'reverse',
                companyId: selectedCompanyId,
                requestId,
                entryId: modal.id,
                reason: values.get('reason'),
              }
            : modal === 'budget'
              ? {
                  action: 'budget',
                  companyId: selectedCompanyId,
                  requestId,
                  name: values.get('name'),
                  amountCents: parseAmount(String(values.get('amount'))),
                }
              : {
                  action: modal === 'edit' ? 'edit' : 'entry',
                  companyId: selectedCompanyId,
                  requestId,
                  ...(modal === 'edit' ? { entryId: editing?.id, expectedUpdatedAt: editing?.updated_at ?? editing?.created_at, reason: values.get('reason') } : { kind: modal }),
                  amountCents: parseAmount(String(values.get('amount'))),
                  concept: values.get('concept'),
                  counterparty: values.get('counterparty'),
                  date: values.get('date'),
                  budgetId:
                    modal === 'expense' || (modal === 'edit' && editing?.kind === 'expense') ? values.get('budgetId') || null : null,
                };
      }
      setSaving(true);
      if (demo) {
        setFormError(
          'Esta vista contiene ejemplos. Abre tu caja para guardar movimientos reales.'
        );
        pending.current = null;
        return;
      }
      const res = await fetch('/api/caja', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(pending.current),
      });
      const body = await res.json();
      if (!res.ok) {
        if (res.status < 500) {
          pending.current = null;
          setUncertain(false);
        } else setUncertain(true);
        throw new Error(body.error);
      }
      pending.current = null;
      setUncertain(false);
      setModal(null);
      setNotice(modal === 'edit' ? 'Cambio guardado en el historial.' : 'Registro guardado.');
      await refresh();
    } catch (e) {
      if (pending.current) setUncertain(true);
      setFormError(
        e instanceof Error
          ? e.message
          : 'No recibimos confirmación. Reintenta para comprobar el registro.'
      );
    } finally {
      setSaving(false);
    }
  }
  async function changeRole(userId: string, role: string) {
    if (demo) {
      setNotice('Los permisos de esta demostración no se modifican.');
      return;
    }
    setSaving(true);
    setNotice('');
    try {
      const res = await fetch('/api/caja', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'member', companyId: selectedCompanyId, userId, role }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error);
      setNotice('Permiso actualizado.');
      await refresh();
    } catch (e) {
      setError(
        e instanceof Error ? e.message : 'No se pudo actualizar el permiso.'
      );
    } finally {
      setSaving(false);
    }
  }

  const entries =
    data?.entries.filter(
      (e) =>
        (person === 'all' || e.created_by === person) &&
        (filter === 'all' || e.kind === filter) &&
        `${e.concept} ${e.counterparty} ${e.actor_name}`
          .toLocaleLowerCase('es')
          .includes(query.toLocaleLowerCase('es'))
    ) ?? [];
  if (!selectedCompanyId && !loading) return (
    <div className="cash-company-screen">
      <header className="cash-company-header"><span className="cash-company-logo"><Wallet size={24} /> Golden Caja</span><Link href="/dashboard">Ir a Wio CRM <ArrowUpRight size={15} /></Link></header>
      <main className="cash-company-main">
        {demo && <div className="cash-demo"><strong>Vista de demostración</strong> · Solo Golden Habitat contiene movimientos de ejemplo. <Link href="/caja">Abrir mi caja</Link></div>}
        <p className="cash-eyebrow">TU ESPACIO FINANCIERO</p>
        <h1>¿Qué empresa quieres revisar?</h1>
        <p className="cash-company-intro">Cada empresa tiene su propia caja, saldos, presupuestos e historial. Elige una para continuar.</p>
        {error && <div className="cash-error" role="alert">{error}</div>}
        <div className="cash-company-grid">{companies.map((company) => <button className="cash-company-card" key={company.id} onClick={() => chooseCompany(company)}>
          <span className="cash-company-card-icon"><Building2 size={23} /></span>
          <span className="cash-company-card-copy"><strong>{company.name}</strong><small>{company.role === 'owner' ? 'Acceso de propietario' : 'Mi caja'}</small></span>
          <ArrowRight size={19} />
        </button>)}</div>
        {!companies.length && <div className="cash-card cash-empty"><Building2 size={30} /><h2>No hay empresas habilitadas</h2><p>El propietario debe asignarte acceso a una caja.</p></div>}
        {companies.some((c) => c.role === 'owner') && !demo && <form className="cash-company-create" onSubmit={addCompany}><label htmlFor="cash-company-name">Agregar otra empresa</label><div><input id="cash-company-name" value={newCompanyName} onChange={(e) => setNewCompanyName(e.target.value)} maxLength={100} placeholder="Nombre de la empresa" required /><button className="cash-button primary" disabled={saving} type="submit"><Plus size={17} /> Crear empresa</button></div></form>}
      </main>
    </div>
  );
  const nav = [
    { id: 'overview' as const, label: 'Resumen', icon: LayoutGrid },
    { id: 'movements' as const, label: 'Movimientos', icon: List },
    { id: 'budgets' as const, label: 'Presupuestos', icon: ChartPie },
    ...(data?.role === 'owner'
      ? [{ id: 'audit' as const, label: 'Historial', icon: History }, { id: 'access' as const, label: 'Accesos', icon: Users }]
      : []),
  ];
  return (
    <div className="cash-app">
      <aside className="cash-sidebar">
        <Link href="/caja" className="cash-brand">
          <span className="cash-brand-icon">
            <Wallet size={24} />
          </span>
          <span>
            golden<span className="cash-brand-small">CAJA</span>
          </span>
        </Link>
        <p className="cash-nav-caption">ESPACIO DE TRABAJO</p>
        <nav aria-label="Caja">
          {nav.map((n) => (
            <button
              key={n.id}
              className={panel === n.id ? 'active' : ''}
              onClick={() => setPanel(n.id)}
            >
              <n.icon size={19} />
              {n.label}
              {panel === n.id && <span className="cash-nav-dot" />}
            </button>
          ))}
        </nav>
        <div className="cash-sidebar-bottom">
          <ShieldCheck size={23} />
          <strong>Todo queda registrado</strong>
          <p>El dueño puede revisar cada edición con fecha y hora.</p>
          <Link href="/dashboard">
            Ir a Wio CRM <ArrowUpRight size={14} />
          </Link>
        </div>
      </aside>
      <div className="cash-workspace">
        <header className="cash-topbar">
          <span>
            {data?.accountName ?? 'Golden Caja'}{' '}
            <span className="cash-divider">/</span> Caja principal
          </span>
          <button className="cash-switch-company" onClick={leaveCompany}><Building2 size={16} /> Cambiar empresa</button>
          <span className="cash-currency">{data?.role === 'owner' ? 'Todas las cajas' : 'Mi caja'} · PEN</span>
        </header>
        <main className="cash-main">
          {demo && (
            <div className="cash-demo">
              <strong>Vista de demostración</strong> · Datos de ejemplo, sin
              movimientos reales.{' '}
              <Link href="/caja">
                Abrir mi caja <ArrowRight size={14} />
              </Link>
            </div>
          )}
          <div className="cash-heading">
            <div>
              <p className="cash-eyebrow">CLARIDAD PARA TU DÍA A DÍA</p>
              <h1>
                {panel === 'overview'
                  ? 'Tu caja, al día.'
                  : panel === 'movements'
                    ? 'Cada movimiento cuenta.'
                    : panel === 'budgets'
                      ? 'Un plan para cada gasto.'
                      : panel === 'audit' ? 'Cada cambio, a la vista.' : 'Las personas correctas.'}
              </h1>
              <p>
                {panel === 'overview'
                  ? 'El dinero que entra, lo que sale y lo que tienes disponible.'
                  : panel === 'movements'
                    ? 'Consulta los registros y quién los realizó.'
                    : panel === 'budgets'
                      ? 'Asignar un presupuesto no descuenta dinero de tu caja.'
                      : panel === 'audit' ? 'Consulta quién cambió qué, cuándo y por qué.' : 'El acceso a ventas no concede acceso a caja.'}
              </p>
            </div>
            <div className="cash-heading-tools">{!demo && companyId && <a className="cash-button secondary" href={`/api/caja/export?companyId=${encodeURIComponent(companyId)}`}><Download size={16} /> Descargar Excel</a>}<button className="cash-icon-button" onClick={() => void refresh()} aria-label="Actualizar caja"><RefreshCw size={18} /></button></div>
          </div>
          {error && (
            <div className="cash-error" role="alert">
              {error}{' '}
              {data && 'Los datos visibles pueden estar desactualizados.'}{' '}
              {!data && <Link href="/login?next=/caja">Iniciar sesión</Link>}
            </div>
          )}
          {notice && (
            <div className="cash-notice" role="status">
              {notice}
              <button onClick={() => setNotice('')} aria-label="Cerrar aviso">
                <X size={16} />
              </button>
            </div>
          )}
          {loading && (
            <div className="cash-empty" role="status">
              Cargando tu caja…
            </div>
          )}
          {!loading && !data && (
            <section className="cash-card cash-empty">
              <Wallet size={34} />
              <h2>Tu caja necesita acceso</h2>
              <p>
                El propietario de la organización puede habilitarte como lector
                o encargado de caja.
              </p>
              <button
                className="cash-button secondary"
                onClick={() => void refresh()}
              >
                Volver a comprobar
              </button>
            </section>
          )}
          {data && (
            <>
              <div className="cash-sync">
                <span className={error ? 'cash-dot stale' : 'cash-dot'} />
                {demo
                  ? 'Datos de ejemplo'
                  : error
                    ? 'Actualización pendiente'
                    : connected
                      ? 'Conectado en tiempo real'
                      : 'Actualización automática cada 15 s'}
                {updated && !demo && <span> · Última consulta {updated}</span>}
              </div>
              {panel === 'overview' && (
                <>
                  <section className="cash-stats" aria-label="Saldo de caja">
                    <div className="cash-balance">
                      <div className="cash-balance-label">
                        <span>SALDO DISPONIBLE</span>
                        <Wallet size={22} />
                      </div>
                      <strong>{money(data.income - data.expense)}</strong>
                      <p>
                        {data.role === 'owner' ? 'Todas las cajas del equipo' : 'Solo tus movimientos'} <span>•</span> Soles peruanos
                      </p>
                      <div className="cash-balance-line" />{' '}
                      <small>
                        {data.income - data.expense < 0
                          ? 'Saldo negativo: revisa los ingresos y gastos registrados.'
                          : 'Calculado a partir de tus movimientos.'}
                      </small>
                    </div>
                    <div className="cash-stat">
                      <span className="cash-stat-icon income">
                        <ArrowDownLeft size={24} />
                      </span>
                      <p>Total de ingresos</p>
                      <strong>{money(data.income)}</strong>
                      <small>Dinero recibido, neto de anulaciones</small>
                    </div>
                    <div className="cash-stat">
                      <span className="cash-stat-icon expense">
                        <ArrowUpRight size={24} />
                      </span>
                      <p>Total de gastos</p>
                      <strong>{money(data.expense)}</strong>
                      <small>Dinero utilizado, neto de anulaciones</small>
                    </div>
                  </section>
                  {data.role === 'owner' && (data.boxes?.length ?? 0) > 0 && <section className="cash-boxes" aria-label="Cajas por persona">
                    <div className="cash-section-head"><div><h2>Cajas del equipo</h2><p>Saldo individual calculado con todos los movimientos de cada persona.</p></div></div>
                    <div className="cash-box-grid">{data.boxes?.map((box) => <button className="cash-box" key={box.userId} onClick={() => { setPerson(box.userId); setPanel('movements'); }}>
                      <span>{box.name}</span><strong>{money(box.income - box.expense)}</strong><small>{box.entryCount} movimientos · Ver detalle <ArrowRight size={13} /></small>
                    </button>)}</div>
                  </section>}
                  {canWrite && (
                    <div className="cash-actions">
                      <button
                        className="cash-button primary"
                        onClick={() => open('expense')}
                      >
                        <Plus size={19} /> Registrar gasto
                      </button>
                      <button
                        className="cash-button secondary"
                        onClick={() => open('income')}
                      >
                        <ArrowDownLeft size={19} /> Registrar ingreso
                      </button>
                      <span>Registra hoy. Mantén todo claro.</span>
                    </div>
                  )}
                </>
              )}
              {(panel === 'overview' || panel === 'movements') && (
                <section className="cash-card">
                  <div className="cash-section-head">
                    <div>
                      <h2>
                        {panel === 'overview'
                          ? 'Últimos movimientos'
                          : 'Movimientos'}
                      </h2>
                      <p>{data.entryCount} registros en el historial</p>
                    </div>
                    {panel === 'overview' ? (
                      <button
                        className="cash-text-button"
                        onClick={() => setPanel('movements')}
                      >
                        Ver movimientos <ArrowRight size={16} />
                      </button>
                    ) : (
                      canWrite && (
                        <button
                          className="cash-button primary"
                          onClick={() => open('expense')}
                        >
                          <Plus size={16} /> Gasto
                        </button>
                      )
                    )}
                  </div>
                  {panel === 'movements' && (
                    <div className="cash-filters">
                      <label className="cash-search">
                        <Search size={18} />
                        <input
                          aria-label="Buscar movimientos"
                          placeholder="Buscar concepto, persona…"
                          value={query}
                          onChange={(e) => setQuery(e.target.value)}
                        />
                      </label>
                      <select
                        aria-label="Tipo de movimiento"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                      >
                        <option value="all">Todos los movimientos</option>
                        <option value="income">Ingresos</option>
                        <option value="expense">Gastos</option>
                      </select>
                      {data.role === 'owner' && <select aria-label="Filtrar por persona" value={person} onChange={(e) => setPerson(e.target.value)}><option value="all">Todas las personas</option>{data.members.map((m) => <option key={m.user_id} value={m.user_id}>{m.name}</option>)}</select>}
                      {canWrite && (
                        <button
                          className="cash-text-button"
                          onClick={() => open('income')}
                        >
                          + Ingreso
                        </button>
                      )}
                    </div>
                  )}
                  <div className="cash-table-wrap">
                    <table className="cash-table">
                      <thead>
                        <tr>
                          <th>CONCEPTO / PERSONA</th>
                          <th>FECHA</th>
                          <th>RESPONSABLE</th>
                          <th>MONTO</th>
                          <th>
                            <span className="cash-sr-only">Acciones</span>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {entries
                          .slice(0, panel === 'overview' ? 5 : 100)
                          .map((e) => (
                            <tr key={e.id}>
                              <td>
                                <div className="cash-entry">
                                  <span className={`cash-entry-icon ${e.kind}`}>
                                    {e.kind === 'income' ? (
                                      <ArrowDownLeft size={18} />
                                    ) : (
                                      <ArrowUpRight size={18} />
                                    )}
                                  </span>
                                  <span>
                                    <strong>{e.concept}</strong>
                                    <small>
                                      {e.counterparty}
                                      {e.reversed
                                        ? ' · Anulado'
                                        : e.reversal_of
                                          ? ' · Compensación'
                                          : ''}
                                    </small>
                                    <small className="cash-compact-meta">
                                      {e.occurred_on} · {e.actor_name}
                                    </small>
                                  </span>
                                </div>
                              </td>
                              <td>
                                {new Date(
                                  `${e.occurred_on}T12:00:00`
                                ).toLocaleDateString('es-PE', {
                                  day: '2-digit',
                                  month: 'short',
                                })}
                                <small>{e.occurred_on.slice(0, 4)}</small>
                              </td>
                              <td>
                                <span className="cash-person">
                                  <span>
                                    {e.actor_name.slice(0, 1).toUpperCase()}
                                  </span>
                                  {e.actor_name}
                                </span>
                              </td>
                              <td
                                className={
                                  e.kind === 'income'
                                    ? 'cash-positive'
                                    : 'cash-negative'
                                }
                              >
                                {e.kind === 'income' ? '+' : '−'}
                                {money(e.amount_cents)}
                              </td>
                              <td>
                                {canWrite && !e.reversed && !e.reversal_of && (data.role === 'owner' || e.created_by === data.viewerId) && <button className="cash-icon-button" aria-label={`Editar ${e.concept}`} title="Editar movimiento" onClick={() => openEdit(e)}><Pencil size={16} /></button>}
                                {canWrite && !e.reversed && !e.reversal_of && (data.role === 'owner' || e.created_by === data.viewerId) && (
                                  <button
                                    className="cash-icon-button"
                                    aria-label={`Anular ${e.concept}`}
                                    title="Anular movimiento"
                                    onClick={() => open(e)}
                                  >
                                    <Undo2 size={16} />
                                  </button>
                                )}
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  {entries.length === 0 && (
                    <div className="cash-empty">
                      <Wallet size={28} />
                      <h3>
                        {query || filter !== 'all'
                          ? 'No hay coincidencias'
                          : 'Aquí empieza tu historial'}
                      </h3>
                      <p>
                        {query || filter !== 'all'
                          ? 'Prueba otro texto o tipo de movimiento.'
                          : 'Registra el dinero inicial como un ingreso para comenzar.'}
                      </p>
                      {canWrite && !query && filter === 'all' && (
                        <button
                          className="cash-button secondary"
                          onClick={() => open('income')}
                        >
                          Registrar primer ingreso
                        </button>
                      )}
                    </div>
                  )}
                  {panel === 'movements' && data.entryCount > 100 && (
                    <p className="cash-footnote">
                      Se muestran y buscan los últimos 100 registros. Los saldos
                      incluyen todo el historial.
                    </p>
                  )}
                </section>
              )}
              {(panel === 'overview' || panel === 'budgets') && (
                <section className="cash-budget-section">
                  <div className="cash-section-head">
                    <div>
                      <h2>Presupuestos</h2>
                      <p>Planea el gasto sin perder de vista tu caja.</p>
                    </div>
                    {canWrite && (
                      <button
                        className="cash-text-button"
                        onClick={() => open('budget')}
                      >
                        <Plus size={16} /> Crear presupuesto
                      </button>
                    )}
                  </div>
                  <div className="cash-budget-grid">
                    {data.budgets.map((b) => (
                      <article className="cash-card cash-budget" key={b.id}>
                        <div>
                          <span className="cash-budget-icon">
                            <ChartPie size={19} />
                          </span>
                          <span
                            className={`cash-tag ${b.spent > b.amount_cents ? 'over' : ''}`}
                          >
                            {b.spent > b.amount_cents ? 'Excedido' : 'En curso'}
                          </span>
                        </div>
                        <h3>{b.name}</h3>
                        <p>
                          <strong>{money(b.amount_cents - b.spent)}</strong>{' '}
                          disponibles
                        </p>
                        <div
                          className="cash-progress"
                          role="progressbar"
                          aria-label={`Gasto de ${b.name}`}
                          aria-valuemin={0}
                          aria-valuemax={b.amount_cents}
                          aria-valuenow={Math.min(b.amount_cents, b.spent)}
                        >
                          <span
                            style={{
                              width: `${Math.max(0, Math.min(100, (b.spent / b.amount_cents) * 100))}%`,
                              background:
                                b.spent > b.amount_cents
                                  ? '#b65f43'
                                  : undefined,
                            }}
                          />
                        </div>
                        <footer>
                          <span>Gastado {money(b.spent)}</span>
                          <span>de {money(b.amount_cents)}</span>
                        </footer>
                      </article>
                    ))}
                  </div>
                  {!data.budgets.length && (
                    <div className="cash-card cash-empty">
                      <ChartPie size={28} />
                      <h3>Dale un destino a tus gastos</h3>
                      <p>
                        Crea un presupuesto de movilidad, oficina o un proyecto.
                      </p>
                    </div>
                  )}
                </section>
              )}
              {panel === 'access' && data.role === 'owner' && (
                <section className="cash-card">
                  <div className="cash-section-head">
                    <div>
                      <h2>Acceso financiero</h2>
                      <p>
                        Los encargados registran y anulan. Los lectores solo
                        consultan.
                      </p>
                    </div>
                  </div>
                  {data.members.map((m) => (
                    <div className="cash-member" key={m.user_id}>
                      <strong>{m.name}</strong>
                      {m.role === 'owner' ? (
                        <span className="cash-tag">Propietario</span>
                      ) : (
                        <select
                          aria-label={`Permiso de ${m.name}`}
                          value={m.role}
                          disabled={saving}
                          onChange={(e) =>
                            void changeRole(m.user_id, e.target.value)
                          }
                        >
                          <option value="none">Sin acceso</option>
                          <option value="reader">Lector</option>
                          <option value="cashier">Encargado de caja</option>
                        </select>
                      )}
                    </div>
                  ))}
                </section>
              )}
              {panel === 'audit' && data.role === 'owner' && (
                <section className="cash-card">
                  <div className="cash-section-head"><div><h2>Historial de cambios</h2><p>Valores anteriores y nuevos, registrados por la base de datos.</p></div></div>
                  <div className="cash-audit-list">
                    {(data.audit ?? []).map((h) => <article className="cash-audit-item" key={h.id}>
                      <div className="cash-audit-mark"><History size={17} /></div>
                      <div><div className="cash-audit-title"><strong>{h.action === 'edited' ? 'Movimiento editado' : h.action === 'reversed' ? 'Movimiento anulado' : 'Movimiento creado'}</strong><span>{new Date(h.changed_at).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'medium', timeStyle: 'medium' })} · Lima</span></div>
                        <p><b>{h.actor_name}</b> · {h.after_data.concept}</p>
                        {h.reason && <p>Motivo: {h.reason}</p>}
                        {h.before_data && <div className="cash-audit-diff"><span>Antes: {money(h.before_data.amount_cents)} · {h.before_data.concept} · {h.before_data.counterparty} · {h.before_data.occurred_on}</span><span>Después: {money(h.after_data.amount_cents)} · {h.after_data.concept} · {h.after_data.counterparty} · {h.after_data.occurred_on}</span></div>}
                        <small>ID: {h.entry_id}</small>
                      </div>
                    </article>)}
                    {!data.audit?.length && <div className="cash-empty"><History size={28} /><h3>Aún no hay cambios registrados</h3><p>Las acciones nuevas aparecerán aquí con fecha, hora y responsable.</p></div>}
                  </div>
                  {(data.audit?.length ?? 0) >= 200 && <p className="cash-footnote">Se muestran los últimos 200 eventos. Descarga el Excel para revisar el historial completo.</p>}
                </section>
              )}
              <footer className="cash-page-footer">
                <span>GOLDEN CAJA</span>
                <p>Una caja clara. Un equipo conectado.</p>
                <ShieldCheck size={16} />
              </footer>
            </>
          )}
        </main>
      </div>
      <dialog
        ref={dialog}
        className="cash-dialog"
        onCancel={(e) => {
          e.preventDefault();
          if (!saving && !uncertain) setModal(null);
        }}
      >
        {modal && (
          <form
            onSubmit={submit}
            key={typeof modal === 'object' ? modal.id : modal}
          >
            <div className="cash-section-head">
              <h2>
                {typeof modal === 'object'
                  ? 'Anular movimiento'
                  : modal === 'budget'
                    ? 'Nuevo presupuesto'
                    : modal === 'edit' ? 'Editar movimiento'
                    : modal === 'income'
                      ? 'Registrar ingreso'
                      : 'Registrar gasto'}
              </h2>
              <button
                type="button"
                className="cash-icon-button"
                disabled={saving || uncertain}
                onClick={() => setModal(null)}
                aria-label="Cerrar formulario"
              >
                <X size={20} />
              </button>
            </div>
            {formError && (
              <div className="cash-error" role="alert">
                {formError}
              </div>
            )}
            {uncertain && (
              <p className="cash-footnote">
                Conservamos esta operación pendiente. Pulsa Reintentar para
                confirmar el resultado sin duplicarla.
              </p>
            )}
            <fieldset disabled={saving || uncertain} className="cash-fields">
              {typeof modal === 'object' ? (
                <>
                  <p>
                    Se registrará una compensación de{' '}
                    <strong>{money(modal.amount_cents)}</strong>. El original «
                    {modal.concept}» seguirá visible en el historial.
                  </p>
                  <label>
                    Motivo de anulación
                    <textarea
                      name="reason"
                      required
                      minLength={3}
                      maxLength={180}
                      autoFocus
                    />
                    <button type="button" className="cash-voice" onClick={() => dictate('reason')}><Mic size={15} /> {listening === 'reason' ? 'Escuchando…' : 'Dictar motivo'}</button>
                  </label>
                </>
              ) : (
                <>
                  <label>
                    Monto en soles
                    <input
                      name="amount"
                      inputMode="decimal"
                      placeholder="0.00"
                      required
                      autoFocus
                      autoComplete="off"
                      defaultValue={modal === 'edit' && editing ? (editing.amount_cents / 100).toFixed(2) : undefined}
                    />
                  </label>
                  {modal === 'budget' ? (
                    <label>
                      Nombre del presupuesto
                      <input
                        name="name"
                        placeholder="Ej. Movilidad del equipo"
                        required
                        maxLength={100}
                      />
                    </label>
                  ) : (
                    <>
                      <label>
                        Concepto
                        <input
                          name="concept"
                          placeholder={
                            modal === 'income'
                              ? 'Ej. Fondo inicial de caja'
                              : 'Ej. Traslado a visita de obra'
                          }
                          required
                          maxLength={200}
                          defaultValue={modal === 'edit' ? editing?.concept : undefined}
                        />
                        <button type="button" className="cash-voice" onClick={() => dictate('concept')}><Mic size={15} /> {listening === 'concept' ? 'Escuchando…' : 'Dictar concepto'}</button>
                      </label>
                      <label>
                        {modal === 'income'
                          || (modal === 'edit' && editing?.kind === 'income')
                          ? 'Procedencia del dinero'
                          : 'Destinatario o proveedor'}
                        <input name="counterparty" required maxLength={160} defaultValue={modal === 'edit' ? editing?.counterparty : undefined} />
                        <button type="button" className="cash-voice" onClick={() => dictate('counterparty')}><Mic size={15} /> {listening === 'counterparty' ? 'Escuchando…' : 'Dictar proveedor'}</button>
                      </label>
                      <label>
                        Fecha
                        <input
                          name="date"
                          type="date"
                          required
                          defaultValue={modal === 'edit' ? editing?.occurred_on : limaDate()}
                          min="2000-01-01"
                          max={limaDate()}
                        />
                      </label>
                      {(modal === 'expense' || (modal === 'edit' && editing?.kind === 'expense')) && (
                        <label>
                          Presupuesto
                          <select name="budgetId" defaultValue={modal === 'edit' ? editing?.budget_id ?? '' : ''}>
                            <option value="">Sin presupuesto</option>
                            {data?.budgets.map((b) => (
                              <option value={b.id} key={b.id}>
                                {b.name} · {money(b.amount_cents - b.spent)}{' '}
                                disponibles
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      {modal === 'edit' && <label>Motivo del cambio<textarea name="reason" required minLength={3} maxLength={180} placeholder="Explica por qué se corrige este registro" /><button type="button" className="cash-voice" onClick={() => dictate('reason')}><Mic size={15} /> {listening === 'reason' ? 'Escuchando…' : 'Dictar motivo'}</button></label>}
                    </>
                  )}
                </>
              )}
            </fieldset>
            <p className="cash-footnote">
              {modal === 'budget'
                ? 'Esta asignación no descontará dinero del saldo.'
                : 'Tu usuario quedará registrado como responsable.'}
            </p>
            <button
              type="submit"
              className="cash-button primary cash-submit"
              disabled={saving}
            >
              {saving
                ? 'Guardando…'
                : uncertain
                  ? 'Reintentar y comprobar'
                  : 'Guardar registro'}{' '}
              <ArrowRight size={17} />
            </button>
          </form>
        )}
      </dialog>
    </div>
  );
}
