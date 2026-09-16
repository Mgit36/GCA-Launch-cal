'use client';

import { useMemo, useState, type ReactNode } from 'react';
import { STATUSES, type Launch, type Status } from '@/lib/types';
import { quarterOf, quarterSortKey } from '@/lib/quarter';

// Risk tiers map directly onto the real Status values rather than an invented
// stage-crossed label - Off Track and At Risk are already the two statuses that
// mean trouble, so there's no need to relabel them into something else. Backlog gets
// its own "Planned" tier rather than folding into Meeting Targets - a project that
// hasn't started yet isn't "meeting targets", it just hasn't been measured against any.
type Tier = 'offTrack' | 'atRisk' | 'planned' | 'meetingTargets' | 'unmonitored';

function tierOf(l: Launch): Tier {
  if (l.status === 'Cancelled') return 'unmonitored';
  if (l.status === 'Off Track') return 'offTrack';
  if (l.status === 'At Risk') return 'atRisk';
  if (l.status === 'Backlog') return 'planned';
  return 'meetingTargets';
}

const TIER_ORDER: Tier[] = ['offTrack', 'atRisk', 'planned', 'meetingTargets', 'unmonitored'];

const TIER_META: Record<
  Tier,
  { label: string; sub: string; barClass: string; cardClass: string; numberClass: string }
> = {
  offTrack: {
    label: 'Off Track',
    sub: 'Corrective action required',
    barClass: 'bg-red-400',
    cardClass: 'bg-red-50 border-red-200',
    numberClass: 'text-red-700',
  },
  atRisk: {
    label: 'At Risk',
    sub: 'Course correction required',
    barClass: 'bg-amber-400',
    cardClass: 'bg-amber-50 border-amber-200',
    numberClass: 'text-amber-700',
  },
  planned: {
    label: 'Planned',
    sub: 'Not yet started',
    barClass: 'bg-sky-300',
    cardClass: 'bg-sky-50 border-sky-200',
    numberClass: 'text-sky-700',
  },
  meetingTargets: {
    label: 'Meeting Targets',
    sub: 'No action needed',
    barClass: 'bg-emerald-400',
    cardClass: 'bg-emerald-50 border-emerald-200',
    numberClass: 'text-emerald-700',
  },
  unmonitored: {
    label: 'Unmonitored',
    sub: 'Cancelled, excluded from tracking',
    barClass: 'bg-neutral-300',
    cardClass: 'bg-neutral-100 border-neutral-200',
    numberClass: 'text-neutral-500',
  },
};

// Hovering any count backed by a project list reveals which projects it is -
// counts should never be a dead end the viewer has to go re-derive by eye.
function HoverProjects({
  items,
  className,
  align = 'left',
  children,
}: {
  items: Launch[];
  className?: string;
  align?: 'left' | 'right';
  children: ReactNode;
}) {
  if (items.length === 0) return <div className={className}>{children}</div>;
  return (
    <div className={`group relative cursor-help ${className ?? ''}`}>
      {children}
      <div
        className={`pointer-events-none absolute top-full z-20 mt-1 hidden w-64 rounded-lg border border-neutral-200 bg-white p-2.5 text-xs font-normal normal-case tracking-normal text-neutral-700 shadow-lg group-hover:block ${
          align === 'right' ? 'right-0' : 'left-0'
        }`}
      >
        <div className="mb-1 font-medium text-neutral-400">
          {items.length} project{items.length === 1 ? '' : 's'}
        </div>
        <ul className="max-h-48 space-y-1 overflow-y-auto">
          {items.map((l) => (
            <li key={l.id} className="truncate">
              {l.project}
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

const hasLegalReview = (l: Launch) => l.customer_data_impact === 'Yes' || l.jurisdiction === 'Yes';
const hasDependency = (l: Launch) => !!l.dependency;
const hasScopeChange = (l: Launch) => !!l.scope_change;
const hasSlipped = (l: Launch) => !!l.previous_launch_date && l.previous_launch_date !== l.launch_date;
const isMonitored = (l: Launch) => !!l.status_summary && l.status_summary.trim().length > 0;

function Donut({ pct }: { pct: number }) {
  const r = 52;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - pct / 100);
  return (
    <div className="relative h-32 w-32">
      <svg viewBox="0 0 120 120" className="h-32 w-32 -rotate-90">
        <circle cx="60" cy="60" r={r} fill="none" stroke="#e5e7eb" strokeWidth="12" />
        <circle
          cx="60"
          cy="60"
          r={r}
          fill="none"
          stroke="#2563eb"
          strokeWidth="12"
          strokeDasharray={c}
          strokeDashoffset={offset}
          strokeLinecap="round"
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-semibold text-blue-600">{pct}%</span>
        <span className="text-[11px] text-neutral-400">monitored</span>
      </div>
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="flex items-center justify-between border-t border-neutral-100 py-2 text-sm first:border-t-0">
      <span className="text-neutral-600">{label}</span>
      <span className="font-medium text-neutral-900">{value}</span>
    </div>
  );
}

function CoverageRow({
  label,
  color,
  items,
  expanded,
  onToggle,
}: {
  label: string;
  color: string;
  items: Launch[];
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className={`rounded-lg border p-3 ${color}`}>
      <button type="button" onClick={onToggle} className="flex w-full items-center justify-between text-left">
        <span className="flex items-center gap-2 text-sm font-medium text-neutral-800">
          <span aria-hidden>{expanded ? '▾' : '▸'}</span>
          {items.length} {label}
        </span>
      </button>
      {expanded && (
        <ul className="mt-2 space-y-1 pl-5 text-xs text-neutral-600">
          {items.length === 0 ? (
            <li className="text-neutral-400">None</li>
          ) : (
            items.map((l) => <li key={l.id}>{l.project}</li>)
          )}
        </ul>
      )}
    </div>
  );
}

export function PortfolioHealth({ launches }: { launches: Launch[] }) {
  const [quarterFilter, setQuarterFilter] = useState('All');
  const [statusFilter, setStatusFilter] = useState<Status | 'All'>('All');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const quarters = useMemo(() => {
    const set = new Set(launches.map((l) => quarterOf(l.launch_date)));
    return Array.from(set).sort((a, b) => quarterSortKey(a) - quarterSortKey(b));
  }, [launches]);

  const filtered = useMemo(
    () =>
      launches.filter((l) => {
        if (quarterFilter !== 'All' && quarterOf(l.launch_date) !== quarterFilter) return false;
        if (statusFilter !== 'All' && l.status !== statusFilter) return false;
        return true;
      }),
    [launches, quarterFilter, statusFilter]
  );

  const byTier = useMemo(() => {
    const map: Record<Tier, Launch[]> = {
      offTrack: [],
      atRisk: [],
      planned: [],
      meetingTargets: [],
      unmonitored: [],
    };
    for (const l of filtered) map[tierOf(l)].push(l);
    return map;
  }, [filtered]);

  const total = filtered.length;
  const atRiskCount = byTier.offTrack.length + byTier.atRisk.length;
  const atRiskPct = total > 0 ? Math.round((atRiskCount / total) * 100) : 0;

  const byProductArea = useMemo(() => {
    const map = new Map<string, Launch[]>();
    for (const l of filtered) map.set(l.product_area, [...(map.get(l.product_area) ?? []), l]);
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [filtered]);

  const monitoredCount = filtered.filter(isMonitored).length;
  const monitoredPct = total > 0 ? Math.round((monitoredCount / total) * 100) : 0;

  const signals = [
    { key: 'legal', label: 'Legal Review', dot: 'bg-red-500', items: filtered.filter(hasLegalReview) },
    { key: 'dependency', label: 'Dependency Blocker', dot: 'bg-amber-500', items: filtered.filter(hasDependency) },
    { key: 'scope', label: 'Scope Change', dot: 'bg-purple-500', items: filtered.filter(hasScopeChange) },
    { key: 'slipped', label: 'Date Slipped', dot: 'bg-blue-500', items: filtered.filter(hasSlipped) },
  ];

  const shipped = filtered.filter((l) => l.status === 'Shipped');
  const active = filtered.filter((l) => l.status !== 'Shipped' && l.status !== 'Cancelled');
  const cancelled = filtered.filter((l) => l.status === 'Cancelled');
  const blocked = filtered.filter(hasDependency);

  function toggle(key: string) {
    setExpanded((e) => ({ ...e, [key]: !e[key] }));
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={quarterFilter}
          onChange={(e) => setQuarterFilter(e.target.value)}
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900"
        >
          <option value="All">All quarters</option>
          {quarters.map((q) => (
            <option key={q} value={q}>
              {q}
            </option>
          ))}
        </select>
        <select
          value={statusFilter}
          onChange={(e) => setStatusFilter(e.target.value as Status | 'All')}
          className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900"
        >
          <option value="All">All statuses</option>
          {STATUSES.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
        <span className="text-xs text-neutral-400">{total} launches match this filter</span>
      </div>

      {total === 0 ? (
        <p className="rounded-xl border border-neutral-200 bg-white p-8 text-center text-sm text-neutral-400">
          No launches match this filter.
        </p>
      ) : (
        <>
          <div className="flex h-2 overflow-hidden rounded-full">
            {TIER_ORDER.map((t) =>
              byTier[t].length === 0 ? null : (
                <div
                  key={t}
                  className={TIER_META[t].barClass}
                  style={{ width: `${(byTier[t].length / total) * 100}%` }}
                />
              )
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
            {TIER_ORDER.map((t, i) => (
              <HoverProjects
                key={t}
                items={byTier[t]}
                align={i >= TIER_ORDER.length / 2 ? 'right' : 'left'}
                className={`rounded-xl border p-4 ${TIER_META[t].cardClass}`}
              >
                <div className={`text-2xl font-semibold ${TIER_META[t].numberClass}`}>{byTier[t].length}</div>
                <div className="mt-1 text-xs font-medium uppercase tracking-wide text-neutral-500">
                  {TIER_META[t].label}
                </div>
                <div className="text-xs text-neutral-400">{TIER_META[t].sub}</div>
              </HoverProjects>
            ))}
          </div>

          <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
            <div className="rounded-xl border border-neutral-200 bg-white p-4">
              <div className="mb-3 text-xs font-medium uppercase tracking-wide text-neutral-400">
                Coverage by Product Area
              </div>
              <div className="space-y-2">
                {byProductArea.map(([area, items]) => {
                  const risky = items.filter((l) => tierOf(l) === 'offTrack' || tierOf(l) === 'atRisk');
                  return (
                    <div key={area} className="rounded-lg bg-neutral-50 p-2.5">
                      <div className="flex items-center justify-between text-sm">
                        <span className="font-medium text-neutral-800">{area}</span>
                        <HoverProjects items={items} align="right" className="text-neutral-400">
                          {items.length}
                        </HoverProjects>
                      </div>
                      {risky.length > 0 && (
                        <HoverProjects
                          items={risky}
                          align="left"
                          className="mt-1 inline-block text-xs text-red-600 underline decoration-dotted"
                        >
                          ⚠ {risky.length} at risk
                        </HoverProjects>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>

            <div className="rounded-xl border border-neutral-200 bg-white p-4">
              <div className="mb-3 text-xs font-medium uppercase tracking-wide text-neutral-400">
                Portfolio Intelligence
              </div>
              <div className="space-y-3 text-sm text-neutral-700">
                <div className="border-l-2 border-red-400 pl-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-red-600">Risk Exposure</div>
                  <p className="mt-0.5 text-neutral-600">
                    {atRiskCount === 0
                      ? 'No launches are currently At Risk or Off Track.'
                      : `${atRiskCount} launch${atRiskCount === 1 ? '' : 'es'} need attention: ${byTier.offTrack.length} Off Track, ${byTier.atRisk.length} At Risk.`}
                  </p>
                </div>
                <div className="border-l-2 border-amber-400 pl-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-amber-600">
                    Blocked on Dependencies
                  </div>
                  <p className="mt-0.5 text-neutral-600">
                    {blocked.length === 0
                      ? 'No launches currently have an open dependency.'
                      : `${blocked.length} launch${blocked.length === 1 ? ' has' : 'es have'} an open dependency: ${blocked
                          .slice(0, 3)
                          .map((l) => l.project)
                          .join(', ')}${blocked.length > 3 ? ', …' : ''}.`}
                  </p>
                </div>
                <div className="border-l-2 border-neutral-300 pl-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
                    Outside Monitoring Scope
                  </div>
                  <p className="mt-0.5 text-neutral-600">
                    {cancelled.length === 0
                      ? 'No cancelled launches in this filter.'
                      : `${cancelled.length} launch${cancelled.length === 1 ? '' : 'es'} cancelled and excluded from active tracking.`}
                  </p>
                </div>
                <p className="border-t border-neutral-100 pt-2 text-xs text-neutral-400">
                  Total: {total} launches · {atRiskPct}% at risk or off track
                </p>
              </div>
            </div>

            <div className="rounded-xl border border-neutral-200 bg-white p-4">
              <div className="mb-3 text-xs font-medium uppercase tracking-wide text-neutral-400">Signal Coverage</div>
              <div className="flex justify-center">
                <Donut pct={monitoredPct} />
              </div>
              <StatRow label="Monitored (has Status Summary)" value={monitoredCount} />
              <StatRow label="No signal data" value={total - monitoredCount} />
              <StatRow label="Total" value={total} />
              <div className="mt-3 text-xs font-medium uppercase tracking-wide text-neutral-400">Signals Active</div>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {signals.map((s) => (
                  <HoverProjects
                    key={s.key}
                    items={s.items}
                    className="flex items-center gap-1.5 rounded-full border border-neutral-200 px-2.5 py-1 text-xs text-neutral-600"
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
                    {s.label} · {s.items.length}
                  </HoverProjects>
                ))}
              </div>
            </div>
          </div>

          <div className="rounded-xl border border-neutral-200 bg-white p-4">
            <div className="mb-3 text-xs font-medium uppercase tracking-wide text-neutral-400">Coverage Summary</div>
            <div className="grid grid-cols-1 gap-2 md:grid-cols-3">
              <CoverageRow
                label="Completed launches"
                color="border-emerald-200 bg-emerald-50"
                items={shipped}
                expanded={!!expanded.shipped}
                onToggle={() => toggle('shipped')}
              />
              <CoverageRow
                label="Active tracked launches"
                color="border-blue-200 bg-blue-50"
                items={active}
                expanded={!!expanded.active}
                onToggle={() => toggle('active')}
              />
              <CoverageRow
                label="Cancelled / excluded"
                color="border-neutral-200 bg-neutral-100"
                items={cancelled}
                expanded={!!expanded.cancelled}
                onToggle={() => toggle('cancelled')}
              />
            </div>
          </div>
        </>
      )}
    </div>
  );
}
