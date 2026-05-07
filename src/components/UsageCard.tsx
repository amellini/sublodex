import { useState } from 'react';
import type { PlanBilling, PlanUsage, WindowUsage } from '../lib/types';

type Props = { data: PlanUsage };

const WINDOW_META: Record<string, { label: string; sub?: string; tone?: 'all' | 'opus' | 'sonnet' | 'haiku' }> = {
  '5h':         { label: 'current session',   sub: '5h rolling window' },
  '5h_opus':    { label: 'session · opus',    sub: '5h opus-only',          tone: 'opus' },
  '5h_sonnet':  { label: 'session · sonnet',  sub: '5h sonnet-only',        tone: 'sonnet' },
  '7d':         { label: 'weekly · all models', sub: '7d rolling window' },
  '7d_opus':    { label: 'weekly · opus',     sub: '7d opus-only',          tone: 'opus' },
  '7d_sonnet':  { label: 'weekly · sonnet',   sub: '7d sonnet-only',        tone: 'sonnet' },
  '7d_haiku':   { label: 'weekly · haiku',    sub: '7d haiku-only',         tone: 'haiku' },
};

const ORDER = ['5h', '5h_opus', '5h_sonnet', '7d', '7d_opus', '7d_sonnet', '7d_haiku'];

export function UsageCard({ data }: Props) {
  const tier = data.subscriptionType ? data.subscriptionType.toUpperCase() : 'PRO / MAX';
  const fetched = new Date(data.fetchedAt);

  const known = ORDER.filter((k) => k in data.windows);
  const unknown = Object.keys(data.windows).filter((k) => !ORDER.includes(k));
  const allKeys = [...known, ...unknown];

  return (
    <div className="usage">
      <div className="usage__head">
        <div className="usage__title">
          <span className="usage__title-main">plan usage</span>
          <span className="usage__tier">{tier}</span>
        </div>
        <StatusPill status={data.status} type={data.rateLimitType} />
      </div>

      {allKeys.length === 0 ? (
        <div className="usage__empty">no rate-limit data returned</div>
      ) : (
        <div className="usage__rows">
          {allKeys.map((key) => {
            const meta = WINDOW_META[key] ?? { label: key, sub: 'custom window' };
            const w = data.windows[key];
            return <UsageRow key={key} meta={meta} usage={w} />;
          })}
        </div>
      )}

      {data.weeklyBreakdown && data.weeklyBreakdown.length > 0 && (
        <WeeklyBreakdown items={data.weeklyBreakdown} />
      )}

      {data.dailyRoutines && <DailyRoutines data={data.dailyRoutines} />}

      {data.overage && (
        <Overage overage={data.overage} />
      )}

      {data.billing && <BillingBlock billing={data.billing} /> }

      {!data.weeklyBreakdown && !data.dailyRoutines && !data.billing && (
        <div className="usage__missing">
          <span>more details (per-model breakdown, daily routines, monthly cap) live in the dashboard</span>
          <a href="https://claude.ai/settings/usage" target="_blank" rel="noreferrer">open dashboard ↗</a>
        </div>
      )}

      {data.debug && data.debug.length > 0 && <DebugBlock entries={data.debug} />}

      <div className="usage__foot">
        {data.fallbackAvailable && (
          <span className="usage__chip">fallback available</span>
        )}
        <span className="usage__spacer" />
        <span className="usage__time">updated {fetched.toLocaleTimeString()}</span>
      </div>
    </div>
  );
}

function UsageRow({ meta, usage }: { meta: { label: string; sub?: string; tone?: string }; usage: WindowUsage }) {
  const pct = Math.max(0, Math.min(1, usage.utilization));
  const pctStr = `${Math.round(pct * 100)}%`;
  const used = pct >= 0.9 ? 'danger' : pct >= 0.7 ? 'warn' : pct > 0 ? 'ok' : 'idle';

  return (
    <div className="usage__row">
      <div className="usage__row-head">
        <div className="usage__row-label">
          <span className={`usage__dot usage__dot--${meta.tone ?? 'default'}`} />
          <span className="usage__label">{meta.label}</span>
          {meta.sub && <span className="usage__sub">{meta.sub}</span>}
        </div>
        <div className="usage__row-meta">
          <span className={`usage__pct usage__pct--${used}`}>{pctStr}</span>
          <span className="usage__reset">resets in {relTime(usage.resetsAt)}</span>
        </div>
      </div>
      <div className="usage__bar">
        <div
          className={`usage__bar-fill usage__bar-fill--${used}`}
          style={{ width: `${pct * 100}%` }}
        />
      </div>
    </div>
  );
}

type OverageData = NonNullable<PlanUsage['overage']>;

function Overage({ overage }: { overage: OverageData }) {
  // Le reason "rejected" più comuni per un utente Pro/Max non sono errori:
  // significano solo che NON ha attivato l'utilizzo extra. Trattiamole come "off".
  const userOff = new Set([
    'org_level_disabled', 'member_level_disabled',
    'seat_tier_level_disabled', 'org_service_level_disabled',
    'overage_not_provisioned', 'no_limits_configured',
  ]);
  const isUserOff = overage.status === 'rejected' && overage.disabledReason
    && userOff.has(overage.disabledReason);

  const isAvailable = overage.status === 'allowed' || overage.status === 'allowed_warning';

  if (isUserOff) {
    return (
      <div className="usage__overage usage__overage--off">
        <span className="usage__overage-label">extra usage</span>
        <span className="usage__overage-state usage__overage-state--off">off</span>
        <span className="usage__overage-hint">
          enable in <a href="https://claude.ai/settings/usage" target="_blank" rel="noreferrer">claude.ai → settings → usage</a> to keep working when you hit a limit
        </span>
      </div>
    );
  }

  // Stati "out of credits" / "zero credit" → davvero un blocco
  if (overage.status === 'rejected') {
    return (
      <div className="usage__overage usage__overage--blocked">
        <span className="usage__overage-label">extra usage</span>
        <span className="usage__overage-state usage__overage-state--blocked">blocked</span>
        {overage.disabledReason && (
          <span className="usage__overage-reason">{prettyReason(overage.disabledReason)}</span>
        )}
      </div>
    );
  }

  return (
    <div className={`usage__overage usage__overage--${isAvailable ? 'on' : 'idle'}`}>
      <span className="usage__overage-label">extra usage</span>
      <span className={`usage__overage-state usage__overage-state--${isAvailable ? 'on' : 'idle'}`}>
        {isAvailable ? 'on' : overage.status}
      </span>
      {overage.resetsAt && (
        <span className="usage__overage-reset">resets in {relTime(overage.resetsAt)}</span>
      )}
    </div>
  );
}

function WeeklyBreakdown({ items }: { items: NonNullable<PlanUsage['weeklyBreakdown']> }) {
  return (
    <div className="usage__rows">
      {items.map((item) => (
        <div key={item.name} className="usage__row">
          <div className="usage__row-head">
            <div className="usage__row-label">
              <span className="usage__dot usage__dot--default" />
              <span className="usage__label">{item.name}</span>
              <span className="usage__sub">weekly</span>
            </div>
            <div className="usage__row-meta">
              <span className={`usage__pct usage__pct--${item.utilization >= 0.9 ? 'danger' : item.utilization >= 0.7 ? 'warn' : 'ok'}`}>
                {Math.round(item.utilization * 100)}%
              </span>
              {item.resetsAt && (
                <span className="usage__reset">resets in {relTime(item.resetsAt)}</span>
              )}
            </div>
          </div>
          <div className="usage__bar">
            <div
              className={`usage__bar-fill usage__bar-fill--${item.utilization >= 0.9 ? 'danger' : item.utilization >= 0.7 ? 'warn' : 'ok'}`}
              style={{ width: `${Math.max(0, Math.min(1, item.utilization)) * 100}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

function DailyRoutines({ data }: { data: { used: number; total: number } }) {
  const pct = data.total > 0 ? data.used / data.total : 0;
  return (
    <div className="usage__row">
      <div className="usage__row-head">
        <div className="usage__row-label">
          <span className="usage__dot usage__dot--haiku" />
          <span className="usage__label">daily routines</span>
          <span className="usage__sub">included</span>
        </div>
        <div className="usage__row-meta">
          <span className="usage__pct usage__pct--ok">{data.used} / {data.total}</span>
        </div>
      </div>
      <div className="usage__bar">
        <div className="usage__bar-fill usage__bar-fill--ok" style={{ width: `${pct * 100}%` }} />
      </div>
    </div>
  );
}

function DebugBlock({ entries }: { entries: NonNullable<PlanUsage['debug']> }) {
  const [open, setOpen] = useState(false);
  const ok = entries.filter((e) => e.ok).length;
  return (
    <div className="usage__debug">
      <button className="usage__debug-toggle" onClick={() => setOpen((v) => !v)}>
        debug · {ok}/{entries.length} endpoints responded {open ? '−' : '+'}
      </button>
      {open && (
        <div className="usage__debug-list">
          {entries.map((e, i) => (
            <div key={i} className={`usage__debug-row ${e.ok ? 'usage__debug-row--ok' : ''}`}>
              <span className="usage__debug-status">{e.status || 'ERR'}</span>
              <span className="usage__debug-url">{e.url}</span>
              {e.sample && <pre className="usage__debug-sample">{e.sample}</pre>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BillingBlock({ billing }: { billing: PlanBilling }) {
  const cur = billing.currency ?? 'USD';
  const fmt = (n?: number) => n === undefined ? '—' : new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: cur,
    maximumFractionDigits: 2,
  }).format(n);

  const pct = billing.monthlyCap && billing.spent !== undefined
    ? Math.max(0, Math.min(1, billing.spent / billing.monthlyCap))
    : null;

  return (
    <div className="usage__billing">
      <div className="usage__billing-row">
        <span className="usage__billing-label">spent this month</span>
        <span className="usage__billing-val">
          <strong>{fmt(billing.spent)}</strong>
          {billing.monthlyCap !== undefined && (
            <span className="usage__billing-cap">/ {fmt(billing.monthlyCap)} cap</span>
          )}
        </span>
      </div>
      {pct !== null && (
        <div className="usage__bar" style={{ marginTop: 4 }}>
          <div
            className={`usage__bar-fill usage__bar-fill--${pct >= 0.9 ? 'danger' : pct >= 0.7 ? 'warn' : 'ok'}`}
            style={{ width: `${pct * 100}%` }}
          />
        </div>
      )}
      {billing.balance !== undefined && (
        <div className="usage__billing-row">
          <span className="usage__billing-label">balance</span>
          <span className="usage__billing-val">{fmt(billing.balance)}</span>
        </div>
      )}
      {billing.autoRecharge && (
        <div className="usage__billing-row">
          <span className="usage__billing-label">auto-recharge</span>
          <span className="usage__billing-val usage__billing-val--ok">on</span>
        </div>
      )}
    </div>
  );
}

function StatusPill({ status, type }: { status: string; type?: string }) {
  const cls =
    status === 'allowed' ? 'ok' :
    status === 'allowed_warning' ? 'warn' :
    status === 'rejected' ? 'danger' : 'idle';
  return (
    <span className={`usage__pill usage__pill--${cls}`}>
      {status}{type ? ` · ${type}` : ''}
    </span>
  );
}

export function relTime(unixSeconds: number): string {
  const ms = unixSeconds * 1000 - Date.now();
  if (ms <= 0) return 'now';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function prettyReason(r: string): string {
  return r.replace(/_/g, ' ');
}
