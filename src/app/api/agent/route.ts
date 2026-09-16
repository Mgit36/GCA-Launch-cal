import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase';
import { extractFromMessage } from '@/lib/extract';
import { matchProject } from '@/lib/matching';
import { inferBundle, formatConfirmation } from '@/lib/inference';
import { normalizeLaunchDate, parseRelativeShift, applyRelativeShift } from '@/lib/date';
import { updateLaunch } from '@/lib/launches';
import { answerQuery } from '@/lib/query';
import { generateStatusSummary, generateProjectBrief } from '@/lib/summarize';
import type { Launch } from '@/lib/types';

// DRI, GA Date, and Requesting Team are required fields (per the exercise's own list
// of must-have fields, and the schema) - if a message doesn't state them, the agent
// asks rather than silently defaulting to "Unassigned" / today / "Sales".
const REQUIRED_FIELD_LABELS = {
  dri: "who's the DRI",
  launch_date: "what's the target GA date",
  requesting_team: 'which team requested this (Legal, Sales, Marketing, Finance, or Support)',
} as const;
type RequiredFieldKey = keyof typeof REQUIRED_FIELD_LABELS;

function missingRequiredFields(fields: Record<string, string> | undefined | null): RequiredFieldKey[] {
  const f = fields ?? {};
  return (Object.keys(REQUIRED_FIELD_LABELS) as RequiredFieldKey[]).filter((key) => !f[key]);
}

// Status Summary is a running history, not a replaced snapshot: generateStatusSummary
// still writes each paragraph as a clean description of state as of *this* update
// (never "changed"/"updated" inside its own text - see summarize.ts), but here we
// stamp who/when ahead of it and prepend the whole entry onto whatever was already
// there, same "dated, attributed, newest-first, nothing overwritten" pattern
// applyFieldNotes already uses for Dependency (formatNote/prependDatedNote).
// Entries are separated by a blank line, each starting with "Last updated <date> by <name>.".
// If the most recent entry is already stamped with today's date, this session's edits have
// already produced one - it gets replaced rather than stacked, so five quick corrections in
// one sitting collapse into a single current 1-2 line entry instead of five near-duplicate
// paragraphs. A genuinely new day (or the very first update) still starts a fresh entry.
function dropTodaysEntry(previous: string | null | undefined, todayStamp: string): string | null {
  if (!previous) return null;
  if (!previous.startsWith(`Last updated ${todayStamp} by `)) return previous;
  const nextEntryStart = previous.indexOf('\n\nLast updated ', 1);
  return nextEntryStart === -1 ? null : previous.slice(nextEntryStart + 2);
}

function stampSummary(previous: string | null | undefined, paragraph: string, updatedBy: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  const entry = `Last updated ${stamp} by ${updatedBy}.\n\n${paragraph}`;
  const olderHistory = dropTodaysEntry(previous, stamp);
  return olderHistory ? `${entry}\n\n${olderHistory}` : entry;
}

function joinPhrases(phrases: string[]): string {
  if (phrases.length === 1) return phrases[0];
  if (phrases.length === 2) return `${phrases[0]} and ${phrases[1]}`;
  return `${phrases.slice(0, -1).join(', ')}, and ${phrases[phrases.length - 1]}`;
}

function phraseMissingRequired(missing: RequiredFieldKey[]): string {
  if (missing.length === 0) return '';
  return `Also — ${joinPhrases(missing.map((k) => REQUIRED_FIELD_LABELS[k]))}?`;
}

// Re-ask phrasing for when a reply still didn't answer a required field - distinct
// from phraseMissingRequired (which reads as an addendum to the bundle question),
// since this is now the whole message on its own.
function phraseStillMissing(missing: RequiredFieldKey[]): string {
  return `I still need ${joinPhrases(missing.map((k) => REQUIRED_FIELD_LABELS[k]))} before I can create this — no defaults, just need the actual answer.`;
}

// If a message changes Date or Status without saying why, ask for the reason
// rather than silently applying the change - it gets logged to Dependency once given.
function reasonQuestion(fields: Record<string, string>): string | null {
  if (fields.reason) return null;
  const changingDate = !!fields.launch_date;
  const changingStatus = !!fields.status;
  if (changingDate && changingStatus) return "What's the reason for the date and status change?";
  if (changingDate) return "What's the reason for the date change?";
  if (changingStatus) return "What's the reason for the status change?";
  return null;
}

/**
 * Two-phase protocol, since every action requires explicit user confirmation
 * (locked design rule - the agent never silently applies a match or update):
 *
 * Phase 1 (no `confirm` in body): agent parses the message, runs matching +
 *   inference, and returns a PROPOSAL for the user to confirm.
 * Phase 2 (`confirm: true/false` + the original `proposal` echoed back):
 *   agent applies (or discards) the proposed action against the database.
 */
export async function POST(req: NextRequest) {
  const body = await req.json();
  const { message, confirm, proposal, correctionText } = body as {
    message?: string;
    confirm?: boolean;
    proposal?: any;
    correctionText?: string;
  };

  // ---- Phase 2: applying a previously proposed action ----
  if (proposal) {
    return handleConfirmation(proposal, confirm, correctionText);
  }

  // ---- Phase 1: parse the new message ----
  if (!message) {
    return NextResponse.json({ error: 'message is required' }, { status: 400 });
  }

  const extraction = await extractFromMessage(message);

  // "a week later" / "slipping by two weeks" are relative to the project's *current*
  // date, not today - that can't be resolved until we know which project this is, so
  // hold the raw phrase and resolve it after matching (see below).
  let deferredDateRaw: string | null = null;
  if (extraction.fields?.launch_date) {
    if (parseRelativeShift(extraction.fields.launch_date)) {
      deferredDateRaw = extraction.fields.launch_date;
      delete extraction.fields.launch_date;
    } else {
      const normalized = normalizeLaunchDate(extraction.fields.launch_date);
      if (!normalized) {
        await supabase.from('unresolved_messages').insert({
          raw_message: message,
          reason: `Could not confidently resolve launch_date value "${extraction.fields.launch_date}" to a calendar date`,
        });
        return NextResponse.json({
          type: 'unresolved',
          agentMessage: `I couldn't confidently turn "${extraction.fields.launch_date}" into a specific date — flagging it for manual follow-up.`,
        });
      }
      extraction.fields.launch_date = normalized;
    }
  }

  const { data: existingRaw } = await supabase.from('launches').select('*');
  const existing = (existingRaw ?? []) as Launch[];

  // --- Read-only question: answer directly, nothing to confirm ---
  if (extraction.intent === 'query') {
    const answer = await answerQuery(message, existing);
    return NextResponse.json({ type: 'done', agentMessage: answer });
  }

  // --- Trap case A: stale status complaint ---
  if (extraction.intent === 'stale_status_complaint') {
    const match = matchProject(extraction.project_name_guess ?? '', message, existing);
    const target = match.matches[0]?.launch;
    if (target) {
      return NextResponse.json({
        type: 'confirmation_needed',
        agentMessage: `It looks like "${target.project}" may already be shipped — should I update Status to Shipped?`,
        proposal: { kind: 'trap_a_status_update', launchId: target.id },
      });
    }
    await supabase.from('unresolved_messages').insert({
      raw_message: message,
      reason: 'Stale status complaint, no confident project match',
    });
    return NextResponse.json({
      type: 'unresolved',
      agentMessage:
        "I couldn't confidently match this to a project in the calendar — flagging it for manual follow-up.",
    });
  }

  // --- Trap case B: secondhand report, wrong owner to confirm ---
  if (extraction.intent === 'secondhand_report') {
    const match = matchProject(extraction.project_name_guess ?? '', message, existing);
    const target = match.matches[0]?.launch;
    if (target) {
      return NextResponse.json({
        type: 'confirmation_needed',
        // Note: in the real product this confirmation would route to the DRI,
        // not back to the original sender - see README for the notify-vs-confirm distinction.
        agentMessage: `This is a secondhand report, not from the DRI. Flagging "${target.project}" for ${target.dri} to confirm this status themselves rather than updating directly.`,
        proposal: { kind: 'trap_b_notify_dri', launchId: target.id, rawMessage: message },
      });
    }
    await supabase.from('unresolved_messages').insert({
      raw_message: message,
      reason: 'Secondhand report, no confident project match to notify the right DRI',
    });
    return NextResponse.json({
      type: 'unresolved',
      agentMessage: "Couldn't confidently match this to a project — flagged for manual follow-up.",
    });
  }

  if (extraction.intent === 'unclear') {
    await supabase.from('unresolved_messages').insert({
      raw_message: message,
      reason: extraction.reasoning || 'Could not classify intent',
    });
    return NextResponse.json({
      type: 'unresolved',
      agentMessage:
        "I'm not sure what to do with this — flagging it for manual review rather than guessing.",
    });
  }

  // --- Normal case: new_or_update ---
  const match = matchProject(
    extraction.project_name_guess ?? '',
    extraction.project_brief_guess ?? message,
    existing
  );

  if (deferredDateRaw) {
    if (match.tier === 'high') {
      const shifted = applyRelativeShift(match.matches[0].launch.launch_date, deferredDateRaw);
      if (!shifted) {
        await supabase.from('unresolved_messages').insert({
          raw_message: message,
          reason: `Could not resolve relative date "${deferredDateRaw}" against the matched project's current date`,
        });
        return NextResponse.json({
          type: 'unresolved',
          agentMessage: `I couldn't confidently resolve "${deferredDateRaw}" into a specific date — flagging it for manual follow-up.`,
        });
      }
      extraction.fields.launch_date = shifted;
    } else {
      // A relative shift only means something against a known current date - without
      // a single confident match, guessing which project's date to shift would be a
      // silent guess, exactly what this agent is designed never to do.
      await supabase.from('unresolved_messages').insert({
        raw_message: message,
        reason: `Relative date shift ("${deferredDateRaw}") given without a single confident project match to base it on`,
      });
      return NextResponse.json({
        type: 'unresolved',
        agentMessage: `"${deferredDateRaw}" only makes sense relative to an existing date, and I'm not confident which project this is — flagging it for manual follow-up.`,
      });
    }
  }

  if (match.tier === 'high') {
    const target = match.matches[0].launch;
    const question = reasonQuestion(extraction.fields);
    return NextResponse.json({
      type: 'confirmation_needed',
      agentMessage: `This looks like an update to "${target.project}". Confirm?${question ? ` ${question}` : ''}`,
      proposal: {
        kind: 'update_existing',
        launchId: target.id,
        fields: extraction.fields,
        reasonRequested: !!question,
      },
    });
  }

  if (match.tier === 'candidates') {
    const question = reasonQuestion(extraction.fields);
    return NextResponse.json({
      type: 'confirmation_needed',
      agentMessage: `This could be an update to one of these existing projects: ${match.matches
        .map((m) => m.launch.project)
        .join(', ')}. Or is this a new project?${question ? ` ${question}` : ''}`,
      proposal: {
        kind: 'pick_candidate_or_new',
        candidateIds: match.matches.map((m) => m.launch.id),
        fields: extraction.fields,
        newProjectName: extraction.project_name_guess,
        newProjectBrief: extraction.project_brief_guess ?? message,
        reasonRequested: !!question,
      },
    });
  }

  // tier === 'new'
  const bundle = inferBundle(extraction.project_name_guess ?? '', extraction.project_brief_guess ?? message);
  const similarNotice =
    match.matches.length > 0
      ? ` (Note: similar existing projects found: ${match.matches.map((m) => m.launch.project).join(', ')})`
      : '';
  const missing = missingRequiredFields(extraction.fields);
  const missingQuestion = missing.length ? ` ${phraseMissingRequired(missing)}` : '';

  return NextResponse.json({
    type: 'confirmation_needed',
    agentMessage: `${formatConfirmation(bundle)}${similarNotice}${missingQuestion}`,
    proposal: {
      kind: 'create_new',
      projectName: extraction.project_name_guess ?? 'Untitled Project',
      projectBrief: extraction.project_brief_guess ?? message,
      bundle,
      fields: extraction.fields,
      missingRequired: missing,
    },
  });
}

async function handleConfirmation(proposal: any, confirm: boolean | undefined, correctionText?: string) {
  switch (proposal.kind) {
    case 'trap_a_status_update': {
      if (!confirm) return NextResponse.json({ type: 'done', agentMessage: 'No change made.' });
      await updateLaunch(proposal.launchId, { status: 'Shipped' }, 'Status -> Shipped (stale-status complaint confirmed)');
      return NextResponse.json({ type: 'done', agentMessage: 'Status updated to Shipped.' });
    }

    case 'trap_b_notify_dri': {
      if (!confirm) return NextResponse.json({ type: 'done', agentMessage: 'No action taken.' });
      // In production this creates a notification to the DRI; for this POC we log it
      // to the unresolved queue tagged with the matched project, awaiting DRI confirmation.
      await supabase.from('unresolved_messages').insert({
        raw_message: proposal.rawMessage,
        reason: 'Secondhand report awaiting DRI confirmation',
        matched_project_id: proposal.launchId,
      });
      return NextResponse.json({ type: 'done', agentMessage: 'DRI notified for confirmation.' });
    }

    case 'update_existing': {
      // A bare "no" discards the update; anything else (a correction, or a plain
      // "yes") should still apply - only buildConfirmationBody's isYes maps to
      // confirm:true, so a correction always arrives as confirm:false + correctionText.
      if (confirm === false && !correctionText) {
        return NextResponse.json({ type: 'done', agentMessage: 'No change made.' });
      }
      // Re-fetch fresh, since the note must append onto whatever is *actually*
      // stored right now (possibly updated since Phase 1 proposed this), not
      // onto the fields extracted from this message.
      const { data: currentRaw } = await supabase.from('launches').select('*').eq('id', proposal.launchId).single();
      const current = currentRaw as Launch | null;
      const rawUpdateNote = proposal.fields?.status_summary;
      const scopeUpdateNote = proposal.fields?.scope_update;
      const { status_summary: _omit1, scope_update: _omitScope1, ...fieldsIn } = proposal.fields ?? {};
      const fields = pruneNullish(
        applyFieldNotes(fieldsIn, correctionText, !!proposal.reasonRequested, current)
      ) as Record<string, string>;
      // Scope changes rewrite Project Brief as a fresh, polished description of
      // current scope (see generateProjectBrief) - not appended as raw notes, the
      // way Dependency/Change Log accumulate.
      if (scopeUpdateNote && current) {
        fields.project_brief = await generateProjectBrief(current.project_brief, scopeUpdateNote);
      }
      const mergedState = { ...current, ...fields } as Launch;
      const summaryParagraph = await generateStatusSummary(
        mergedState,
        [rawUpdateNote, correctionText].filter(Boolean).join(' | ') || undefined
      );
      fields.status_summary = stampSummary(current?.status_summary, summaryParagraph, current?.dri || 'Unassigned');
      const { error } = await updateLaunch(proposal.launchId, fields, `Updated: ${JSON.stringify(fields)}`);
      if (error) return NextResponse.json({ type: 'error', agentMessage: error.message }, { status: 500 });
      return NextResponse.json({ type: 'done', agentMessage: 'Project updated.' });
    }

    case 'pick_candidate_or_new': {
      if (confirm === false && !correctionText) {
        return NextResponse.json({ type: 'done', agentMessage: 'No change made.' });
      }

      const { data: candidatesRaw } = await supabase
        .from('launches')
        .select('*')
        .in('id', proposal.candidateIds);
      const candidates = (candidatesRaw ?? []) as Launch[];

      // Reply may name the candidate in full ("SharePoint connector"), or just lead
      // with the first word or two ("sharepoint") - match either direction, but
      // require at least 3 chars so a stray short reply can't match everything.
      const lowerReply = (correctionText ?? '').toLowerCase().trim();
      const matchedCandidate = candidates.find((c) => {
        const lowerName = c.project.toLowerCase();
        return lowerReply.includes(lowerName) || (lowerReply.length >= 3 && lowerName.startsWith(lowerReply));
      });

      if (matchedCandidate) {
        const rawUpdateNote = proposal.fields?.status_summary;
        const scopeUpdateNote = proposal.fields?.scope_update;
        const { status_summary: _omit2, scope_update: _omitScope2, ...fieldsIn } = proposal.fields ?? {};
        const fields = pruneNullish(
          applyFieldNotes(fieldsIn, correctionText, !!proposal.reasonRequested, matchedCandidate)
        ) as Record<string, string>;
        if (scopeUpdateNote) {
          fields.project_brief = await generateProjectBrief(matchedCandidate.project_brief, scopeUpdateNote);
        }
        const mergedState = { ...matchedCandidate, ...fields } as Launch;
        const summaryParagraph = await generateStatusSummary(
          mergedState,
          [rawUpdateNote, correctionText].filter(Boolean).join(' | ') || undefined
        );
        fields.status_summary = stampSummary(
          matchedCandidate.status_summary,
          summaryParagraph,
          matchedCandidate.dri || 'Unassigned'
        );
        const { error } = await updateLaunch(matchedCandidate.id, fields, `Updated: ${JSON.stringify(fields)}`);
        if (error) return NextResponse.json({ type: 'error', agentMessage: error.message }, { status: 500 });
        return NextResponse.json({ type: 'done', agentMessage: `Updated "${matchedCandidate.project}".` });
      }

      // Reply didn't name one of the candidates - treat as a new project and run it
      // through the same default-inference + confirmation step "create_new" uses,
      // so Product Area/Release Size/Release Stage defaults still apply.
      const bundle = inferBundle(proposal.newProjectName ?? '', proposal.newProjectBrief ?? '');
      const missing = missingRequiredFields(proposal.fields);
      const missingQuestion = missing.length ? ` ${phraseMissingRequired(missing)}` : '';
      return NextResponse.json({
        type: 'confirmation_needed',
        agentMessage: `${formatConfirmation(bundle)}${missingQuestion}`,
        proposal: {
          kind: 'create_new',
          projectName: proposal.newProjectName ?? 'Untitled Project',
          projectBrief: proposal.newProjectBrief ?? '',
          bundle,
          fields: proposal.fields,
          missingRequired: missing,
        },
      });
    }

    case 'create_new': {
      // A bare "no" (no correction) means: don't create anything - same rule
      // update_existing and pick_candidate_or_new already follow.
      if (confirm === false && !correctionText) {
        return NextResponse.json({ type: 'done', agentMessage: 'No project created.' });
      }
      let bundle = proposal.bundle;
      let fields = proposal.fields ?? {};
      if (correctionText) {
        // Partial correction: keep whatever the correction specifies, default the rest
        // (bundle fields only - Product Area/Size/Stage have sane defaults; DRI/GA
        // Date/Requesting Team do not, see below).
        bundle = mergeCorrection(proposal.bundle, correctionText);
        const correctedDate = normalizeLaunchDate(correctionText);
        if (correctedDate) fields = { ...fields, launch_date: correctedDate };

        // The reply may also be the answer to the missing-required-field question
        // (DRI / GA date / requesting team) asked alongside the bundle question -
        // run it through the same extractor used on the original message rather
        // than hand-rolling name/team parsing.
        if (proposal.missingRequired?.length) {
          const supplied = await extractFromMessage(correctionText);
          const suppliedFields: Record<string, string> = {};
          if (supplied.fields?.dri) suppliedFields.dri = supplied.fields.dri;
          if (supplied.fields?.requesting_team) suppliedFields.requesting_team = supplied.fields.requesting_team;
          if (supplied.fields?.launch_date) {
            const normalized = normalizeLaunchDate(supplied.fields.launch_date);
            if (normalized) suppliedFields.launch_date = normalized;
          }
          fields = { ...fields, ...suppliedFields };
        }
      }

      // DRI, GA Date, and Requesting Team have no safe default - if the reply still
      // didn't answer them, ask again instead of writing "Unassigned"/today/"Sales"
      // into the record. This can loop if the user keeps not answering, which is the
      // correct tradeoff: silently fabricating required fields is worse than asking twice.
      const stillMissing = missingRequiredFields(fields);
      if (stillMissing.length > 0) {
        return NextResponse.json({
          type: 'confirmation_needed',
          agentMessage: phraseStillMissing(stillMissing),
          proposal: {
            kind: 'create_new',
            projectName: proposal.projectName,
            projectBrief: proposal.projectBrief,
            bundle,
            fields,
            missingRequired: stillMissing,
          },
        });
      }

      const dri = fields.dri;
      const rawUpdateNote = fields?.status_summary;
      const { status_summary: _omit3, scope_update: _omitScope3, ...fieldsIn } = fields ?? {};
      const notedFields = applyFieldNotes(fieldsIn, undefined, false, { project: proposal.projectName, dri });
      const insertPayload = {
        project: proposal.projectName,
        project_brief: proposal.projectBrief,
        product_area: bundle.productArea,
        release_size: bundle.releaseSize,
        release_stage: bundle.releaseStage,
        dri,
        requesting_team: fields.requesting_team,
        launch_date: fields.launch_date,
        status: fields?.status ?? 'Backlog',
        project_stage: fields?.project_stage ?? 'Discovery',
        scope_change: fields?.scope_change ?? null,
        dependency: notedFields.dependency ?? null,
        customer_data_impact: fields?.customer_data_impact ?? 'Not Applicable',
        jurisdiction: fields?.jurisdiction ?? 'Not Applicable',
      };
      const summaryParagraph = await generateStatusSummary(
        insertPayload as Launch,
        [proposal.projectBrief, rawUpdateNote].filter(Boolean).join(' | ') || undefined
      );
      const statusSummary = stampSummary(null, summaryParagraph, dri);
      const { data, error } = await supabase
        .from('launches')
        .insert({ ...insertPayload, status_summary: statusSummary, change_log: `Created ${new Date().toISOString()}` })
        .select()
        .single();
      if (error) return NextResponse.json({ type: 'error', agentMessage: error.message }, { status: 500 });
      return NextResponse.json({ type: 'done', agentMessage: `Created "${data.project}".` });
    }

    default:
      return NextResponse.json({ type: 'error', agentMessage: 'Unknown proposal kind.' }, { status: 400 });
  }
}

// Applies a partial correction from free-text reply (e.g. "not Pilot, it's Beta")
// against the inferred bundle - overrides only what's mentioned, keeps the rest.
function mergeCorrection(bundle: any, correctionText: string) {
  const merged = { ...bundle };
  const lower = correctionText.toLowerCase();
  if (lower.includes('beta')) merged.releaseStage = 'Beta';
  else if (lower.includes('pilot')) merged.releaseStage = 'Pilot';
  else if (lower.includes(' ga') || lower.includes('general availability')) merged.releaseStage = 'GA';

  if (lower.includes('small')) merged.releaseSize = 'Small';
  else if (lower.includes('medium')) merged.releaseSize = 'Medium';
  else if (lower.includes('extra large')) merged.releaseSize = 'Extra Large';
  else if (lower.includes('large')) merged.releaseSize = 'Large';
  // "Assume you get one word, no context, no second chance" (per the brief) - a bare
  // single-letter reply like "M" or "S" answering a release-size question never
  // matches the full-word checks above, so it silently fell through to the inferred
  // default and ignored the user's actual answer. Check XL before L so "xl" doesn't
  // also satisfy the L branch.
  else if (/\bxl\b/.test(lower)) merged.releaseSize = 'Extra Large';
  else if (/\bl\b/.test(lower)) merged.releaseSize = 'Large';
  else if (/\bm\b/.test(lower)) merged.releaseSize = 'Medium';
  else if (/\bs\b/.test(lower)) merged.releaseSize = 'Small';

  return merged;
}

// Extraction returns null (not just an absent key) for any field it didn't find
// stated in the message - that means "not mentioned", not "clear this field", so
// it must never reach the update payload (a nullable column would get silently
// wiped, and a NOT NULL column like launch_date would reject the write outright).
function pruneNullish(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && value !== undefined) out[key] = value;
  }
  return out;
}

// A correction that reads as a blocker/dependency note (e.g. "waiting on legal
// review", "blocked by infra") goes to Dependency instead of Status Summary.
const DEPENDENCY_HINT = /\b(waiting on|blocked (by|on)|blocker|depends on|dependency|pending)\b/i;

// Corrections are often phrased as "<Project name> - <the actual update>" (e.g. when
// picking a candidate by name). The project is already implied by which record this is,
// so strip it out rather than baking it into every note.
function stripProjectName(text: string, projectName?: string | null): string {
  const trimmed = text.trim();
  if (!projectName) return trimmed;
  const escaped = projectName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stripped = trimmed.replace(new RegExp(escaped, 'gi'), '').trim();
  const cleaned = stripped.replace(/^[\s\-:,.]+/, '').replace(/[\s\-:,.]+$/, '');
  return cleaned || trimmed;
}

function formatNote(updatedBy: string, note: string): string {
  const stamp = new Date().toISOString().slice(0, 10);
  return `[${stamp}] Updated by ${updatedBy} - ${note}`;
}

// Prior entries are never overwritten - the new note is prepended so the field
// always reads newest-first, and every past dated entry stays intact below it.
function prependDatedNote(existing: string | null | undefined, newNote: string): string {
  return existing ? `${newNote}\n${existing}` : newNote;
}

// Formats whatever this turn contributes to Dependency as a dated, attributed log
// line, and prepends it onto the field's current value - Dependency stays a running
// log (never overwritten). Status Summary is handled separately: it's an LLM-generated
// executive brief of current state, not accumulated notes, so this function never
// touches it - `fields.status_summary`, when present, is the raw text a caller should
// instead feed to generateStatusSummary as context, not write to the DB directly.
function applyFieldNotes(
  fields: Record<string, string>,
  correctionText: string | undefined,
  reasonRequested: boolean,
  current: { project?: string; dri?: string; dependency?: string | null } | null
) {
  const merged: Record<string, string> = { ...fields };
  const updatedBy = current?.dri || 'Unassigned';

  // A reason stated in the original message ("pushed to Nov 16 because vendor is
  // delayed") is itself a Dependency-worthy note - always log it there.
  if (merged.reason) {
    merged.dependency = prependDatedNote(
      current?.dependency,
      formatNote(updatedBy, stripProjectName(merged.reason, current?.project))
    );
    delete merged.reason;
  }

  if (correctionText) {
    if (reasonRequested) {
      // The whole reply is the answer to "what's the reason for the change?" -
      // always Dependency, regardless of phrasing.
      merged.dependency = prependDatedNote(
        merged.dependency ?? current?.dependency,
        formatNote(updatedBy, stripProjectName(correctionText, current?.project))
      );
    } else if (DEPENDENCY_HINT.test(correctionText)) {
      merged.dependency = prependDatedNote(
        merged.dependency ?? current?.dependency,
        formatNote(updatedBy, stripProjectName(correctionText, current?.project))
      );
    }
    const correctedDate = normalizeLaunchDate(correctionText);
    if (correctedDate) merged.launch_date = correctedDate;
  } else if (fields.dependency) {
    merged.dependency = prependDatedNote(
      current?.dependency,
      formatNote(updatedBy, stripProjectName(fields.dependency, current?.project))
    );
  }

  return merged;
}
