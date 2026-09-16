import { NextRequest, NextResponse } from 'next/server';
import { updateLaunch } from '@/lib/launches';

// Fields the dashboard's inline editor is allowed to change. Created Date, Last
// Updated, Last Update By and Change Log are system-managed and excluded even if
// present in the request body.
const EDITABLE_FIELDS = [
  'project',
  'project_brief',
  'product_area',
  'dri',
  'requesting_team',
  'impacted_teams',
  'launch_date',
  'previous_launch_date',
  'status',
  'status_summary',
  'project_stage',
  'scope_change',
  'release_stage',
  'release_size',
  'dependency',
  'customer_data_impact',
  'jurisdiction',
  'collaborators',
  'success_metrics',
] as const;

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const body = await request.json();

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

  const fields: Record<string, unknown> = {};
  for (const key of EDITABLE_FIELDS) {
    if (key in body) fields[key] = body[key];
  }

  if (Object.keys(fields).length === 0) {
    return NextResponse.json({ error: 'No editable fields in request body' }, { status: 400 });
  }

  const { data, error } = await updateLaunch(id, fields, `Edited via dashboard: ${JSON.stringify(fields)}`);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ launch: data });
}
