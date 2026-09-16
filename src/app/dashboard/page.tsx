'use client';

import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { ChatPanel } from '@/components/ChatPanel';
import { PortfolioHealth } from '@/components/PortfolioHealth';
import {
  PRODUCT_AREAS,
  TEAMS,
  STATUSES,
  PROJECT_STAGES,
  SCOPE_CHANGES,
  RELEASE_STAGES,
  RELEASE_SIZES,
  YES_NO_NA,
  SUCCESS_METRICS,
  type Launch,
  type Status,
  type ProductArea,
  type ScopeChange,
} from '@/lib/types';
import { quarterOf, quarterSortKey } from '@/lib/quarter';

const STATUS_COLORS: Record<Status, string> = {
  Backlog: 'bg-neutral-100 text-neutral-600',
  'In Progress': 'bg-blue-50 text-blue-700',
  'At Risk': 'bg-amber-50 text-amber-700',
  'Off Track': 'bg-red-50 text-red-700',
  Shipped: 'bg-emerald-50 text-emerald-700',
  Cancelled: 'bg-neutral-200 text-neutral-500',
};

function formatRelativeTime(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  const seconds = Math.round((d.getTime() - Date.now()) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 60) return 'just now';
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour');
  return rtf.format(Math.round(seconds / 86400), 'day');
}

function fmt(value: string | string[] | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '—';
  return value;
}

function fmtTimestamp(value: string | null | undefined): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toLocaleString();
}

function fieldsEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

type SortKey =
  | 'project'
  | 'dri'
  | 'product_area'
  | 'status'
  | 'project_stage'
  | 'release_stage'
  | 'launch_date'
  | 'customer_data_impact'
  | 'success_metrics'
  | 'legal_review';

type SortState = { key: SortKey; dir: 'asc' | 'desc' } | null;

const TABLE_COLUMNS: { key: SortKey; label: string }[] = [
  { key: 'project', label: 'Project' },
  { key: 'dri', label: 'DRI' },
  { key: 'product_area', label: 'Product Area' },
  { key: 'status', label: 'Status' },
  { key: 'project_stage', label: 'Project Stage' },
  { key: 'release_stage', label: 'Release Stage' },
  { key: 'launch_date', label: 'Launch Date' },
  { key: 'customer_data_impact', label: 'Customer Data Impact' },
  { key: 'success_metrics', label: 'Success Metrics' },
  { key: 'legal_review', label: 'Legal Review' },
];

// "Legal Review" isn't a real column - it's derived from two fields - so it needs its
// own comparable value rather than reading `l[key]` directly like every other column.
function sortValue(l: Launch, key: SortKey): string | number {
  if (key === 'legal_review') return l.customer_data_impact === 'Yes' || l.jurisdiction === 'Yes' ? 1 : 0;
  return (l[key] as string) ?? '';
}

type EditableKey =
  | 'project'
  | 'project_brief'
  | 'product_area'
  | 'dri'
  | 'requesting_team'
  | 'impacted_teams'
  | 'launch_date'
  | 'previous_launch_date'
  | 'status'
  | 'status_summary'
  | 'project_stage'
  | 'scope_change'
  | 'release_stage'
  | 'release_size'
  | 'dependency'
  | 'customer_data_impact'
  | 'jurisdiction'
  | 'collaborators'
  | 'success_metrics';

type FieldConfig =
  | { key: EditableKey; label: string; kind: 'text' | 'textarea' | 'date' | 'tags' }
  | { key: EditableKey; label: string; kind: 'select'; options: readonly string[]; nullable?: boolean }
  | { key: EditableKey; label: string; kind: 'multiselect'; options: readonly string[] };

// Every schema field is editable inline in the side panel except the system-managed
// ones (Created Date, Last Updated, Last Update By, Change Log), which stay read-only.
const EDIT_FIELDS: FieldConfig[] = [
  { key: 'project', label: 'Project', kind: 'text' },
  { key: 'project_brief', label: 'Project Brief', kind: 'textarea' },
  { key: 'product_area', label: 'Product Area', kind: 'select', options: PRODUCT_AREAS },
  { key: 'dri', label: 'DRI', kind: 'text' },
  { key: 'requesting_team', label: 'Requesting Team', kind: 'select', options: TEAMS },
  { key: 'impacted_teams', label: 'Impacted Teams', kind: 'multiselect', options: TEAMS },
  { key: 'launch_date', label: 'Launch Date', kind: 'date' },
  { key: 'previous_launch_date', label: 'Previous Launch Date', kind: 'date' },
  { key: 'status', label: 'Status', kind: 'select', options: STATUSES },
  { key: 'status_summary', label: 'Status Summary', kind: 'textarea' },
  { key: 'project_stage', label: 'Project Stage', kind: 'select', options: PROJECT_STAGES, nullable: true },
  { key: 'scope_change', label: 'Scope Change', kind: 'select', options: SCOPE_CHANGES, nullable: true },
  { key: 'release_stage', label: 'Release Stage', kind: 'select', options: RELEASE_STAGES, nullable: true },
  { key: 'release_size', label: 'Release Size', kind: 'select', options: RELEASE_SIZES, nullable: true },
  { key: 'dependency', label: 'Dependency', kind: 'text' },
  { key: 'customer_data_impact', label: 'Customer Data Impact', kind: 'select', options: YES_NO_NA },
  { key: 'jurisdiction', label: 'Jurisdiction', kind: 'select', options: YES_NO_NA },
  { key: 'collaborators', label: 'Collaborators', kind: 'tags' },
  { key: 'success_metrics', label: 'Success Metrics', kind: 'select', options: SUCCESS_METRICS, nullable: true },
];

const inputClass =
  'w-full rounded-lg border border-neutral-300 px-2.5 py-1.5 text-sm text-neutral-800 focus:outline-none focus:ring-2 focus:ring-neutral-400';

export default function Dashboard() {
  const [launches, setLaunches] = useState<Launch[]>([]);
  const [loading, setLoading] = useState(true);
  const [legalOnly, setLegalOnly] = useState(false);
  const [statusFilter, setStatusFilter] = useState<Status | 'All'>('All');
  const [quarterFilter, setQuarterFilter] = useState('All');
  const [productAreaFilter, setProductAreaFilter] = useState<ProductArea | 'All'>('All');
  const [scopeChangeFilter, setScopeChangeFilter] = useState<ScopeChange | 'All'>('All');
  const [dependencyOnly, setDependencyOnly] = useState(false);
  const [slippedOnly, setSlippedOnly] = useState(false);
  const [sort, setSort] = useState<SortState>(null);

  // `original` is the last-saved record behind the open panel; `draft` is the
  // in-progress edit. Comparing the two drives the dirty state and the diff sent
  // to the server on save.
  const [original, setOriginal] = useState<Launch | null>(null);
  const [draft, setDraft] = useState<Launch | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [changedFields, setChangedFields] = useState<Set<EditableKey>>(new Set());
  const [tab, setTab] = useState<'launches' | 'health'>('health');

  // A ref, not state, so refetchLaunches (a stable useCallback with no deps -
  // its identity is handed to ChatPanel as a prop) always sees whichever panel
  // is open *right now* instead of the one open when the callback was created.
  const originalRef = useRef<Launch | null>(null);
  useEffect(() => {
    originalRef.current = original;
  }, [original]);

  const refetchLaunches = useCallback(() => {
    fetch('/api/launches')
      .then((r) => r.json())
      .then((d) => {
        const list: Launch[] = d.launches ?? [];
        setLaunches(list);

        // If the panel currently open belongs to a record the chat just changed,
        // refresh it in place instead of leaving it showing stale data until the
        // user closes and reopens it.
        const openOriginal = originalRef.current;
        if (!openOriginal) return;
        const updated = list.find((l) => l.id === openOriginal.id);
        if (!updated || fieldsEqual(updated, openOriginal)) return;

        const changed = new Set<EditableKey>();
        for (const f of EDIT_FIELDS) {
          if (!fieldsEqual(updated[f.key], openOriginal[f.key])) changed.add(f.key);
        }
        setChangedFields(changed);
        setOriginal(updated);
        // Only pull the refresh into fields the user hasn't started editing
        // themselves (draft still matches the old baseline there) - an in-progress
        // manual edit is never silently overwritten by an incoming chat update.
        setDraft((prevDraft) => {
          if (!prevDraft) return prevDraft;
          const merged = { ...prevDraft };
          for (const f of EDIT_FIELDS) {
            if (fieldsEqual(prevDraft[f.key], openOriginal[f.key])) {
              (merged as Record<string, unknown>)[f.key] = updated[f.key];
            }
          }
          return merged;
        });
      });
  }, []);

  useEffect(() => {
    fetch('/api/launches')
      .then((r) => r.json())
      .then((d) => setLaunches(d.launches ?? []))
      .finally(() => setLoading(false));
  }, []);

  const quarters = useMemo(() => {
    const set = new Set(launches.map((l) => quarterOf(l.launch_date)));
    return Array.from(set).sort((a, b) => quarterSortKey(a) - quarterSortKey(b));
  }, [launches]);

  const filtered = useMemo(() => {
    return launches.filter((l) => {
      if (statusFilter !== 'All' && l.status !== statusFilter) return false;
      if (legalOnly && l.customer_data_impact !== 'Yes' && l.jurisdiction !== 'Yes') return false;
      if (quarterFilter !== 'All' && quarterOf(l.launch_date) !== quarterFilter) return false;
      if (productAreaFilter !== 'All' && l.product_area !== productAreaFilter) return false;
      if (scopeChangeFilter !== 'All' && l.scope_change !== scopeChangeFilter) return false;
      if (dependencyOnly && !l.dependency) return false;
      if (slippedOnly && !(l.previous_launch_date && l.previous_launch_date !== l.launch_date)) return false;
      return true;
    });
  }, [launches, statusFilter, legalOnly, quarterFilter, productAreaFilter, scopeChangeFilter, dependencyOnly, slippedOnly]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    // Array.prototype.sort is stable (ES2019+), so equal keys keep their relative
    // order from `filtered` rather than needing a manual tie-break.
    return [...filtered].sort((a, b) => {
      const av = sortValue(a, sort.key);
      const bv = sortValue(b, sort.key);
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sort]);

  function toggleSort(key: SortKey) {
    setSort((s) => {
      if (!s || s.key !== key) return { key, dir: 'asc' };
      return s.dir === 'asc' ? { key, dir: 'desc' } : null;
    });
  }

  const hasActiveFilters =
    statusFilter !== 'All' ||
    legalOnly ||
    quarterFilter !== 'All' ||
    productAreaFilter !== 'All' ||
    scopeChangeFilter !== 'All' ||
    dependencyOnly ||
    slippedOnly;

  function resetFilters() {
    setStatusFilter('All');
    setLegalOnly(false);
    setQuarterFilter('All');
    setProductAreaFilter('All');
    setScopeChangeFilter('All');
    setDependencyOnly(false);
    setSlippedOnly(false);
  }

  function openPanel(l: Launch) {
    setOriginal(l);
    setDraft({ ...l });
    setSaveError(null);
    setChangedFields(new Set());
  }

  function closePanel() {
    setOriginal(null);
    setDraft(null);
    setSaveError(null);
    setChangedFields(new Set());
  }

  function update(key: EditableKey, value: unknown) {
    setDraft((d) => (d ? { ...d, [key]: value } : d));
  }

  function toggleArrayValue(key: EditableKey, value: string) {
    setDraft((d) => {
      if (!d) return d;
      const current = (d[key] as string[] | null) ?? [];
      const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
      return { ...d, [key]: next };
    });
  }

  const isDirty = useMemo(() => {
    if (!original || !draft) return false;
    return EDIT_FIELDS.some((f) => !fieldsEqual(draft[f.key], original[f.key]));
  }, [original, draft]);

  const isValid = Boolean(draft?.project?.trim() && draft?.project_brief?.trim() && draft?.dri?.trim());

  async function handleSave() {
    if (!original || !draft || !isDirty || !isValid) return;

    const changed: Record<string, unknown> = {};
    for (const f of EDIT_FIELDS) {
      if (!fieldsEqual(draft[f.key], original[f.key])) {
        const value = draft[f.key];
        // Empty text on a nullable field means "clear it", not "save an empty string".
        changed[f.key] = value === '' ? null : value;
      }
    }

    setSaving(true);
    setSaveError(null);
    try {
      const res = await fetch(`/api/launches/${original.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        // `_expectedLastUpdated` is this save's optimistic-lock token, not a field
        // edit - the server rejects the write (409) if the row has moved on since
        // `original` was read, instead of silently overwriting whatever changed.
        body: JSON.stringify({ ...changed, _expectedLastUpdated: original.last_updated }),
      });

      if (res.status === 409) {
        // Someone else's write landed first - pull the real current state in rather
        // than leaving the panel showing what's now a stale, rejected draft. Reuses
        // refetchLaunches' existing merge: fields the user hasn't touched pick up the
        // incoming values (and get highlighted), fields they were mid-edit on don't.
        refetchLaunches();
        setSaveError('This project was changed by someone else while you had it open. Review the updated fields below and save again.');
        return;
      }

      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? 'Failed to save changes');

      const updated: Launch = data.launch;
      setLaunches((ls) => ls.map((l) => (l.id === updated.id ? updated : l)));
      setOriginal(updated);
      setDraft({ ...updated });
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save changes');
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-[#faf9f7] px-8 py-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="font-serif text-2xl text-neutral-900">GC Portfolio Calendar</h1>
        </div>

        <div className="mb-5 inline-flex rounded-lg border border-neutral-200 bg-white p-1">
          <button
            type="button"
            onClick={() => setTab('health')}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === 'health' ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:text-neutral-900'
            }`}
          >
            Portfolio Health
          </button>
          <button
            type="button"
            onClick={() => setTab('launches')}
            className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
              tab === 'launches' ? 'bg-neutral-900 text-white' : 'text-neutral-600 hover:text-neutral-900'
            }`}
          >
            Initiatives
          </button>
        </div>

        {tab === 'launches' ? (
          <>
            <div className="mb-4 flex flex-wrap items-center gap-3">
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
                value={productAreaFilter}
                onChange={(e) => setProductAreaFilter(e.target.value as ProductArea | 'All')}
                className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900"
              >
                <option value="All">All product areas</option>
                {PRODUCT_AREAS.map((a) => (
                  <option key={a} value={a}>
                    {a}
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
              <select
                value={scopeChangeFilter}
                onChange={(e) => setScopeChangeFilter(e.target.value as ScopeChange | 'All')}
                className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm text-neutral-900"
              >
                <option value="All">All scope changes</option>
                {SCOPE_CHANGES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
              <label className="flex items-center gap-2 text-sm text-neutral-700">
                <input
                  type="checkbox"
                  checked={dependencyOnly}
                  onChange={(e) => setDependencyOnly(e.target.checked)}
                />
                Has open dependency
              </label>
              <label className="flex items-center gap-2 text-sm text-neutral-700">
                <input type="checkbox" checked={slippedOnly} onChange={(e) => setSlippedOnly(e.target.checked)} />
                Date slipped
              </label>
              <label className="flex items-center gap-2 text-sm text-neutral-700">
                <input type="checkbox" checked={legalOnly} onChange={(e) => setLegalOnly(e.target.checked)} />
                Legal review needed only
              </label>
              {hasActiveFilters && (
                <button
                  type="button"
                  onClick={resetFilters}
                  className="text-xs text-neutral-400 underline hover:text-neutral-700"
                >
                  Reset filters
                </button>
              )}
              <span className="text-xs text-neutral-400">
                {sorted.length} of {launches.length} initiatives
              </span>
            </div>

            {loading ? (
              <p className="text-sm text-neutral-400">Loading…</p>
            ) : (
              <div className="overflow-x-auto rounded-xl border border-neutral-200 bg-white">
                <table className="w-full text-left text-sm">
                  <thead className="border-b border-neutral-200 bg-neutral-50 text-neutral-500">
                    <tr>
                      {TABLE_COLUMNS.map((c) => (
                        <th
                          key={c.key}
                          onClick={() => toggleSort(c.key)}
                          className={`cursor-pointer select-none whitespace-nowrap px-4 py-2.5 font-medium hover:text-neutral-700 ${
                            c.key === 'project' ? 'min-w-60' : ''
                          }`}
                        >
                          <span className="inline-flex items-center gap-1">
                            {c.label}
                            {sort?.key === c.key && <span aria-hidden>{sort.dir === 'asc' ? '▲' : '▼'}</span>}
                          </span>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((l) => (
                      <tr
                        key={l.id}
                        onClick={() => openPanel(l)}
                        className="cursor-pointer border-b border-neutral-100 last:border-0 hover:bg-neutral-50"
                      >
                        <td className="min-w-60 px-4 py-2.5 font-medium text-neutral-900">{l.project}</td>
                        <td className="px-4 py-2.5 text-neutral-600">{l.dri}</td>
                        <td className="px-4 py-2.5 text-neutral-600">{l.product_area}</td>
                        <td className="px-4 py-2.5">
                          <span className={`rounded-full px-2 py-0.5 text-xs ${STATUS_COLORS[l.status]}`}>
                            {l.status}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-neutral-600">{l.project_stage ?? '—'}</td>
                        <td className="px-4 py-2.5 text-neutral-600">{l.release_stage ?? '—'}</td>
                        <td className="px-4 py-2.5 text-neutral-600">{l.launch_date}</td>
                        <td className="px-4 py-2.5 text-neutral-600">{l.customer_data_impact}</td>
                        <td className="px-4 py-2.5 text-neutral-600">{l.success_metrics ?? '—'}</td>
                        <td className="px-4 py-2.5 text-neutral-600">
                          {l.customer_data_impact === 'Yes' || l.jurisdiction === 'Yes' ? '⚠️ Yes' : 'No'}
                        </td>
                      </tr>
                    ))}
                    {sorted.length === 0 && (
                      <tr>
                        <td colSpan={TABLE_COLUMNS.length} className="px-4 py-6 text-center text-neutral-400">
                          No initiatives match this filter.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : loading ? (
          <p className="text-sm text-neutral-400">Loading…</p>
        ) : (
          <PortfolioHealth launches={launches} />
        )}
      </div>

      {original && draft && (
        <>
          <div className="fixed inset-0 z-40 bg-black/30" onClick={closePanel} />
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSave();
            }}
            className="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-neutral-200 bg-white shadow-xl"
          >
            <div className="flex-1 overflow-y-auto p-6">
              <div className="mb-5 flex items-start justify-between gap-4">
                <div>
                  <h2 className="font-serif text-lg text-neutral-900">{draft.project || 'Untitled Project'}</h2>
                  <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
                    <span className={`rounded-full px-2 py-0.5 ${STATUS_COLORS[draft.status]}`}>{draft.status}</span>
                    <span>{draft.product_area}</span>
                    <span>·</span>
                    <span>{draft.dri || 'Unassigned'}</span>
                    <span>·</span>
                    <span>{draft.release_stage ?? '—'}</span>
                    <span>·</span>
                    <span>{draft.launch_date}</span>
                    <span>·</span>
                    <span>
                      Updated {formatRelativeTime(original.last_updated)} by {fmt(original.last_update_by)}
                    </span>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={closePanel}
                  className="shrink-0 text-neutral-400 hover:text-neutral-900"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-4 text-sm">
                {EDIT_FIELDS.map((f) => (
                  <div
                    key={f.key}
                    className={
                      changedFields.has(f.key)
                        ? 'rounded-lg bg-amber-50 p-2 ring-1 ring-amber-300'
                        : undefined
                    }
                  >
                    <label className="mb-1 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-neutral-400">
                      {f.label}
                      {changedFields.has(f.key) && (
                        <span className="rounded-full bg-amber-400 px-1.5 py-0.5 text-[10px] font-semibold normal-case tracking-normal text-white">
                          updated
                        </span>
                      )}
                    </label>

                    {f.kind === 'text' && (
                      <input
                        type="text"
                        className={inputClass}
                        value={(draft[f.key] as string | null) ?? ''}
                        onChange={(e) => update(f.key, e.target.value)}
                      />
                    )}

                    {f.kind === 'textarea' && (
                      <textarea
                        className={inputClass}
                        rows={2}
                        value={(draft[f.key] as string | null) ?? ''}
                        onChange={(e) => update(f.key, e.target.value)}
                      />
                    )}

                    {f.kind === 'date' && (
                      <input
                        type="date"
                        className={inputClass}
                        value={(draft[f.key] as string | null) ?? ''}
                        onChange={(e) => update(f.key, e.target.value)}
                      />
                    )}

                    {f.kind === 'tags' && (
                      <input
                        type="text"
                        className={inputClass}
                        placeholder="Comma-separated"
                        value={((draft[f.key] as string[] | null) ?? []).join(', ')}
                        onChange={(e) =>
                          update(
                            f.key,
                            e.target.value
                              .split(',')
                              .map((v) => v.trim())
                              .filter(Boolean)
                          )
                        }
                      />
                    )}

                    {f.kind === 'select' && (
                      <select
                        className={inputClass}
                        value={(draft[f.key] as string | null) ?? ''}
                        onChange={(e) => update(f.key, e.target.value || null)}
                      >
                        {f.nullable && <option value="">—</option>}
                        {f.options.map((o) => (
                          <option key={o} value={o}>
                            {o}
                          </option>
                        ))}
                      </select>
                    )}

                    {f.kind === 'multiselect' && (
                      <div className="flex flex-wrap gap-1.5">
                        {f.options.map((o) => {
                          const active = ((draft[f.key] as string[] | null) ?? []).includes(o);
                          return (
                            <button
                              key={o}
                              type="button"
                              onClick={() => toggleArrayValue(f.key, o)}
                              className={`rounded-full px-2.5 py-1 text-xs ${
                                active
                                  ? 'bg-neutral-900 text-white'
                                  : 'border border-neutral-300 text-neutral-600 hover:border-neutral-400'
                              }`}
                            >
                              {o}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </div>
                ))}

                <div className="border-t border-neutral-200 pt-4">
                  <div className="text-xs font-medium uppercase tracking-wide text-neutral-400">Created Date</div>
                  <div className="mt-0.5 text-neutral-500">{fmtTimestamp(original.created_date)}</div>
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-neutral-400">Last Updated</div>
                  <div className="mt-0.5 text-neutral-500">
                    {fmtTimestamp(original.last_updated)} by {fmt(original.last_update_by)}
                  </div>
                </div>
                <div>
                  <div className="text-xs font-medium uppercase tracking-wide text-neutral-400">Change Log</div>
                  <div className="mt-0.5 whitespace-pre-wrap rounded-lg bg-neutral-50 p-3 text-xs text-neutral-600">
                    {original.change_log || '—'}
                  </div>
                </div>
              </div>
            </div>

            <div className="border-t border-neutral-200 p-4">
              {saveError && <p className="mb-2 text-xs text-red-600">{saveError}</p>}
              {!isValid && <p className="mb-2 text-xs text-red-600">Project, Project Brief and DRI are required.</p>}
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs text-neutral-400">{isDirty ? 'Unsaved changes' : 'No changes'}</span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={closePanel}
                    className="rounded-lg border border-neutral-300 px-4 py-2 text-sm text-neutral-700 hover:bg-neutral-50"
                  >
                    Close
                  </button>
                  <button
                    type="submit"
                    disabled={!isDirty || !isValid || saving}
                    className="rounded-lg bg-neutral-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
                  >
                    {saving ? 'Saving…' : 'Save changes'}
                  </button>
                </div>
              </div>
            </div>
          </form>
        </>
      )}

      <button
        type="button"
        onClick={() => setChatOpen((v) => !v)}
        className="fixed bottom-6 right-6 z-50 flex h-14 w-14 items-center justify-center rounded-full bg-neutral-900 text-xl text-white shadow-xl hover:bg-neutral-800"
        aria-label={chatOpen ? 'Close chat' : 'Open chat'}
      >
        {chatOpen ? '✕' : '💬'}
      </button>
      {chatOpen && <ChatPanel onClose={() => setChatOpen(false)} onDataChanged={refetchLaunches} />}
    </main>
  );
}
