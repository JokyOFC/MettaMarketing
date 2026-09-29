// Brand usage/typography guidelines follow the same draft -> released control
// as colours and fonts (lead decision D3, PLATFORM.md §2 rule 7).
//
// brands.usage_guidelines / typography_guidelines hold the RELEASED text: the
// only text a client ever receives. The team writes a draft
// (usage_guidelines_draft, typography_guidelines_draft) that exists while
// guidelines_draft_at IS NOT NULL; the identity release copies it over the
// released text (POST /api/brands/:id/identity/release, materials.release).

const clean = (value) => (value === undefined || value === null || value === "" ? null : String(value));

/**
 * Working text of a brand row (draft when there is one, else the released
 * text) and what differs from the released text.
 * -> { usage, typography, pending, changed: { usage, typography } }
 */
export function guidelineDraft(row) {
  const hasDraft = Boolean(row?.guidelines_draft_at);
  const released = { usage: clean(row?.usage_guidelines), typography: clean(row?.typography_guidelines) };
  const usage = hasDraft ? clean(row.usage_guidelines_draft) : released.usage;
  const typography = hasDraft ? clean(row.typography_guidelines_draft) : released.typography;
  const changed = { usage: usage !== released.usage, typography: typography !== released.typography };
  return { usage, typography, pending: changed.usage || changed.typography, changed };
}

/**
 * Saves the team's draft. input: { usage?, typography? } (undefined keeps the
 * current working text). A draft equal to the released text is discarded.
 * Never touches the released columns.
 * -> { changed: bool (working text changed), pending: bool, fields: ['usage'|'typography'] }
 */
export async function saveGuidelineDraft(db, row, input, { userId, at }) {
  const current = guidelineDraft(row);
  const usage = input.usage === undefined ? current.usage : clean(input.usage);
  const typography = input.typography === undefined ? current.typography : clean(input.typography);
  const fields = [];
  if (usage !== current.usage) fields.push("usage");
  if (typography !== current.typography) fields.push("typography");
  if (!fields.length) return { changed: false, pending: current.pending, fields };
  const pending = usage !== clean(row.usage_guidelines) || typography !== clean(row.typography_guidelines);
  if (pending)
    await db.run(
      `UPDATE brands SET usage_guidelines_draft = ?, typography_guidelines_draft = ?, guidelines_draft_at = ?,
         guidelines_draft_by = ?, updated_at = ? WHERE id = ?`,
      [usage, typography, at, userId ?? null, at, row.id],
    );
  else
    await db.run(
      `UPDATE brands SET usage_guidelines_draft = NULL, typography_guidelines_draft = NULL, guidelines_draft_at = NULL,
         guidelines_draft_by = NULL, updated_at = ? WHERE id = ?`,
      [at, row.id],
    );
  return { changed: true, pending, fields };
}

/**
 * Publishes the draft (caller checks materials.release and logs/notifies).
 * -> { usage: bool, typography: bool } (what changed for the client) or null
 *    when there is nothing new.
 */
export async function releaseGuidelines(db, row, { userId, at }) {
  const draft = guidelineDraft(row);
  if (!draft.pending) return null;
  await db.run(
    `UPDATE brands SET usage_guidelines = ?, typography_guidelines = ?, usage_guidelines_draft = NULL,
       typography_guidelines_draft = NULL, guidelines_draft_at = NULL, guidelines_draft_by = NULL,
       guidelines_released_at = ?, guidelines_released_by = ?, updated_at = ? WHERE id = ?`,
    [draft.usage, draft.typography, at, userId ?? null, at, row.id],
  );
  return draft.changed;
}
