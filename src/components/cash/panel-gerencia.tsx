'use client';

import { useCallback, useEffect, useState } from 'react';
import { money, type CashPanel } from '@/lib/cash/model';
import { etiquetaMes, etiquetaRubro, mesActualLima, porcentajeBarra } from '@/lib/cash/panel';
import { Clasificacion } from './clasificacion';

// Panel de gerencia: gasto por proyecto, rubro, mes y caja. Gerencia, dueño y
// contabilidad. Dos vistas distintas: la de laptop (cuadrícula y tablas) y la
// de celular (tarjetas en una columna); caja.css muestra una u otra.
export function PanelGerencia() {
  const [month, setMonth] = useState(mesActualLima());
  const [company, setCompany] = useState('');
  const [data, setData] = useState<CashPanel | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (month) params.set('month', month);
    if (company) params.set('companyId', company);
    try {
      const res = await fetch(`/api/caja/panel?${params}`, { cache: 'no-store' });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'No se pudo cargar el panel.');
      setData(body);
      setError('');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo cargar el panel.');
    } finally {
      setLoading(false);
    }
  }, [month, company]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const filtros = (
    <div className="cash-gp-filters">
      <label>
        Mes
        <input type="month" value={month} max={mesActualLima()} onChange={(e) => setMonth(e.target.value)} />
      </label>
      <label>
        Caja
        <select value={company} onChange={(e) => setCompany(e.target.value)}>
          <option value="">Todas las cajas</option>
          {data?.companies.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
      </label>
      <button type="button" className="cash-button secondary" onClick={() => setMonth('')} disabled={!month}>
        Todo el historial
      </button>
    </div>
  );

  if (loading && !data) return <div className="cash-empty" role="status">Cargando el panel…</div>;
  if (!data) return <div className="cash-error" role="alert">{error || 'Sin acceso al panel de gerencia.'}</div>;

  const periodo = data.month ? etiquetaMes(data.month) : 'todo el historial';
  const maxProyecto = Math.max(0, ...data.byProject.map((r) => r.cents));
  const maxRubro = Math.max(0, ...data.byRubro.map((r) => r.cents));
  const maxMes = Math.max(0, ...data.byMonth.map((r) => r.cents));
  const maxCaja = Math.max(0, ...data.byCompany.map((r) => r.cents));

  const pendientes = data.pending.length > 0 && (
    <section className="cash-card cash-gp-pending" aria-label="Gastos sin asignar">
      <div className="cash-section-head">
        <div>
          <h2>Gastos sin asignar</h2>
          <p>{data.unassigned.count} gasto(s), {money(data.unassigned.cents)}. Complétalos para que cuenten en cada proyecto y rubro.</p>
        </div>
      </div>
      {data.pending.map((p) => (
        <div className="cash-gp-pending-row" key={p.id}>
          <div>
            <strong>{p.concept}</strong>
            <small>{p.companyName} · {p.date} · {p.counterparty}</small>
          </div>
          <b>{money(p.amountCents)}</b>
          <Clasificacion
            entryId={p.id}
            rubro={p.rubro}
            projectId={p.projectId}
            projectGeneral={p.projectGeneral}
            projects={data.projects}
            canEdit
            onDone={() => void load()}
          />
        </div>
      ))}
    </section>
  );

  const totales = (
    <section className="cash-gp-totals" aria-label="Totales">
      <div className="cash-stat"><p>Gasto de {periodo}</p><strong>{money(data.totalCents)}</strong><small>{data.count} gasto(s) vigentes, sin anulados ni pases entre cajas</small></div>
      <div className="cash-stat"><p>Sin asignar</p><strong>{money(data.unassigned.cents)}</strong><small>{data.unassigned.count} gasto(s) sin proyecto o rubro</small></div>
    </section>
  );

  return (
    <div className="cash-gp">
      {error && <div className="cash-error" role="alert">{error}</div>}
      {filtros}
      {totales}

      {/* Vista de laptop: cuadrícula de dos columnas con barras y tablas. */}
      <div className="cash-gp-desktop">
        <div className="cash-gp-grid">
          <section className="cash-card">
            <h2>Por proyecto</h2>
            {data.byProject.length === 0 && <p className="cash-gp-none">Sin gastos en este periodo.</p>}
            {data.byProject.map((r) => (
              <div className="cash-gp-bar" key={r.key}>
                <span>{r.name}</span>
                <span className="cash-gp-track"><i style={{ width: `${porcentajeBarra(r.cents, maxProyecto)}%` }} /></span>
                <b>{money(r.cents)}</b>
              </div>
            ))}
          </section>
          <section className="cash-card">
            <h2>Por rubro</h2>
            {data.byRubro.length === 0 && <p className="cash-gp-none">Sin gastos en este periodo.</p>}
            {data.byRubro.map((r) => (
              <div className="cash-gp-bar" key={r.rubro}>
                <span>{etiquetaRubro(r.rubro)}</span>
                <span className="cash-gp-track"><i style={{ width: `${porcentajeBarra(r.cents, maxRubro)}%` }} /></span>
                <b>{money(r.cents)}</b>
              </div>
            ))}
          </section>
          <section className="cash-card">
            <h2>Por mes (12 meses)</h2>
            <div className="cash-gp-months">
              {data.byMonth.map((m) => (
                <div key={m.month} title={`${etiquetaMes(m.month)}: ${money(m.cents)}`}>
                  <i style={{ height: `${porcentajeBarra(m.cents, maxMes)}%` }} />
                  <small>{etiquetaMes(m.month).slice(0, 3)}</small>
                </div>
              ))}
            </div>
          </section>
          <section className="cash-card">
            <h2>Por caja</h2>
            <table className="cash-table">
              <thead><tr><th>CAJA</th><th>RESPONSABLE</th><th>GASTOS</th><th>MONTO</th></tr></thead>
              <tbody>
                {data.byCompany.map((c) => (
                  <tr key={c.id}>
                    <td><strong>{c.name}</strong></td>
                    <td>{c.responsible ?? 'Sin responsable'}</td>
                    <td>{c.count}</td>
                    <td>{money(c.cents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </div>

      {/* Vista de celular: una columna de tarjetas. */}
      <div className="cash-gp-mobile">
        <section className="cash-card">
          <h2>Por proyecto</h2>
          {data.byProject.length === 0 && <p className="cash-gp-none">Sin gastos en este periodo.</p>}
          {data.byProject.map((r) => (
            <div className="cash-gp-item" key={r.key}>
              <div><strong>{r.name}</strong><b>{money(r.cents)}</b></div>
              <span className="cash-gp-track"><i style={{ width: `${porcentajeBarra(r.cents, maxProyecto)}%` }} /></span>
            </div>
          ))}
        </section>
        <section className="cash-card">
          <h2>Por rubro</h2>
          {data.byRubro.map((r) => (
            <div className="cash-gp-item" key={r.rubro}>
              <div><strong>{etiquetaRubro(r.rubro)}</strong><b>{money(r.cents)}</b></div>
              <span className="cash-gp-track"><i style={{ width: `${porcentajeBarra(r.cents, maxRubro)}%` }} /></span>
            </div>
          ))}
        </section>
        <section className="cash-card">
          <h2>Por caja</h2>
          {data.byCompany.map((c) => (
            <div className="cash-gp-item" key={c.id}>
              <div><strong>{c.name}</strong><b>{money(c.cents)}</b></div>
              <small>{c.responsible ? `Responsable: ${c.responsible}` : 'Sin responsable'} · {c.count} gasto(s)</small>
              <span className="cash-gp-track"><i style={{ width: `${porcentajeBarra(c.cents, maxCaja)}%` }} /></span>
            </div>
          ))}
        </section>
        <section className="cash-card">
          <h2>Por mes</h2>
          {[...data.byMonth].reverse().map((m) => (
            <div className="cash-gp-item row" key={m.month}>
              <span>{etiquetaMes(m.month)}</span><b>{money(m.cents)}</b>
            </div>
          ))}
        </section>
      </div>

      {pendientes}
    </div>
  );
}
