import { supabase } from './supabase';
import type { Launch } from './types';

/**
 * Applies a partial update to a launch: appends a change-log line, and carries
 * the pre-update launch_date into previous_launch_date whenever launch_date
 * changes - unless the caller explicitly supplied their own previous_launch_date
 * in `fields` (e.g. a manual dashboard edit), which always wins.
 */
export async function updateLaunch(
  id: string,
  fields: Record<string, unknown>,
  changeLogLine: string
): Promise<{ data: Launch | null; error: { message: string } | null }> {
  const { data: current } = await supabase.from('launches').select('change_log, launch_date').eq('id', id).single();
  const newLog = `${current?.change_log ?? ''}\n${new Date().toISOString()}: ${changeLogLine}`.trim();

  const updatePayload: Record<string, unknown> = { ...fields, change_log: newLog };
  if (fields.launch_date && current?.launch_date && !('previous_launch_date' in fields)) {
    updatePayload.previous_launch_date = current.launch_date;
  }

  const { data, error } = await supabase.from('launches').update(updatePayload).eq('id', id).select().single();
  // Notification to DRI + Collaborators would fire here in production (email/Slack).
  return { data: (data as Launch) ?? null, error };
}
