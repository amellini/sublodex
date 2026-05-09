import type { PlanUsage } from '../lib/types';
import { relTime } from './UsageCard';

type Props = { data: PlanUsage };

type Row = { label: string; sub?: string; pct: number; resetsAt?: number };

export function UsagePop({ data }: Props) {
  const rows: Row[] = [];

  // sessione corrente (5h)
  const w5h = data.windows['5h'];
  if (w5h) rows.push({ label: 'Sessione corrente', sub: '5h', pct: w5h.utilization, resetsAt: w5h.resetsAt });

  // settimanale aggregato (7d)
  const w7d = data.windows['7d'];
  if (w7d) rows.push({ label: 'Settimanale · tutti i modelli', pct: w7d.utilization, resetsAt: w7d.resetsAt });

  // breakdown settimanale per modello (da weeklyBreakdown oppure windows 7d_*)
  if (data.weeklyBreakdown && data.weeklyBreakdown.length > 0) {
    for (const item of data.weeklyBreakdown) {
      rows.push({ label: item.name, pct: item.utilization, resetsAt: item.resetsAt });
    }
  } else {
    for (const key of ['7d_opus', '7d_sonnet', '7d_haiku']) {
      const w = data.windows[key];
      if (w && w.utilization > 0) {
        const name = key === '7d_opus' ? 'opus' : key === '7d_sonnet' ? 'sonnet' : 'haiku';
        rows.push({ label: `Settimanale · ${name}`, pct: w.utilization, resetsAt: w.resetsAt });
      }
    }
  }

  if (rows.length === 0) {
    return <div className="upop__empty">Nessun dato disponibile</div>;
  }

  return (
    <div className="upop">
      <div className="upop__head">Utilizzo del piano</div>
      {rows.map((r, i) => <PopRow key={i} row={r} />)}
    </div>
  );
}

function PopRow({ row }: { row: Row }) {
  const pct = Math.max(0, Math.min(1, row.pct));
  const tone = pct >= 0.9 ? 'danger' : pct >= 0.7 ? 'warn' : pct > 0 ? 'ok' : 'idle';
  const pctStr = `${Math.round(pct * 100)}%`;
  const reset = row.resetsAt ? relTime(row.resetsAt) : null;

  return (
    <div className="upop__row">
      <div className="upop__row-head">
        <span className="upop__label">
          {row.label}
          {row.sub && <span className="upop__sub"> · {row.sub}</span>}
        </span>
        <span className={`upop__meta upop__meta--${tone}`}>
          {pctStr}{reset && <> · tra {reset}</>}
        </span>
      </div>
      <div className="upop__bar">
        <div className={`upop__fill upop__fill--${tone}`} style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
  );
}
