import { supabase } from './supabase';
import type { Launch } from './types';

export interface UpdateLaunchResult {
  data: Launch | null;
  error: { message: string } | null;
  // True when the write was rejected because the row changed since the caller last
  // read it (see `expectedLastUpdated` below) - distinct from `error`, since it isn't
  // a failure to communicate with the DB, it's a real conflict the caller must decide
  // how to handle (surface it, re-fetch, ask the user to retry) rather than something
  // to render as a generic 500.
  conflict?: boolean;
}

/**
 * Applies a partial update to a launch: appends a change-log line, and carries
 * the pre-update launch_date into previous_launch_date whenever launch_date
 * changes - unless the caller explicitly supplied their own previous_launch_date
 * in `fields` (e.g. a manual dashboard edit), which always wins.
 *
 * `expectedLastUpdated`, when supplied, is the row's `last_updated` value as the
 * caller last read it (right before computing `fields`) - the update is scoped to
 * only apply if the row still has that exact value. Without this, two concurrent
 * updates to the same row (two chat replies, or a chat update racing a dashboard
 * edit) each read a stale snapshot, compute their own `fields`, and the second
 * write silently overwrites the first with no error - last_updated/change_log
 * recorded that something changed, but nothing ever checked whether the row was
 * still in the state the write assumed. A DB trigger bumps last_updated on every
 * update (see supabase/schema.sql), so it doubles as a version token for free.
 */
export async function updateLaunch(
  id: string,
  fields: Record<string, unknown>,
  changeLogLine: string,
  expectedLastUpdated?: string
): Promise<UpdateLaunchResult> {
  const { data: current } = await supabase.from('launches').select('change_log, launch_date').eq('id', id).single();
  const newLog = `${current?.change_log ?? ''}\n${new Date().toISOString()}: ${changeLogLine}`.trim();

  const updatePayload: Record<string, unknown> = { ...fields, change_log: newLog };
  if (fields.launch_date && current?.launch_date && !('previous_launch_date' in fields)) {
    updatePayload.previous_launch_date = current.launch_date;
  }

  let query = supabase.from('launches').update(updatePayload).eq('id', id);
  if (expectedLastUpdated) query = query.eq('last_updated', expectedLastUpdated);

  const { data, error } = await query.select();
  if (error) return { data: null, error };
  if (expectedLastUpdated && (data?.length ?? 0) === 0) {
    // The `.eq('id', ...)` alone would have matched - zero rows means the
    // `last_updated` filter is what excluded it, i.e. someone else wrote to this
    // row after the caller's read and before this write reached the DB.
    return { data: null, error: null, conflict: true };
  }
  // Notification to DRI + Collaborators would fire here in production (email/Slack).
  return { data: (data?.[0] as Launch) ?? null, error: null };
}
