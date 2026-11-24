// Personal notes are UI-owned local data. They are never added to AI requests.
export const MAX_NOTE_LENGTH = 4000;

export function noteKey(tabId, machine = null) {
  if (typeof tabId !== 'string' || !tabId || /[\x00-\x1f\x7f]/.test(tabId)) return null;
  if (machine != null && (typeof machine !== 'string' || /[\x00-\x1f\x7f]/.test(machine))) return null;
  return JSON.stringify([machine || null, tabId]);
}

export function noteText(notes, key) {
  const text = key && notes?.[key]?.text;
  return typeof text === 'string' ? text : '';
}

export function notePreview(text, limit = 160) {
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
  const size = Math.max(1, Number.isFinite(limit) ? Math.floor(limit) : 160);
  const characters = [...value];
  return characters.length > size ? characters.slice(0, Math.max(0, size - 1)).join('') + '…' : value;
}

export function saveTabNote(notes, key, data, expectedVersion) {
  const current = notes && typeof notes === 'object' && !Array.isArray(notes) ? notes : {};
  const fail = error => ({ ok: false, notes: current, error });
  if (!data || noteKey(data.tabId, data.machine) !== key || !key || typeof data.text !== 'string') return fail('invalid_note');
  if ([...data.text].length > MAX_NOTE_LENGTH) return fail('too_long');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(data.text)) return fail('invalid_note');
  const previous = current[key];
  const version = Number.isInteger(previous?.version) && previous.version >= 0 ? previous.version : 0;
  if (!Number.isInteger(expectedVersion) || expectedVersion !== version) return fail('conflict');
  // Keep a versioned empty record so an older editor cannot resurrect deleted text.
  const text = data.text.trim() ? data.text : '';
  const next = { text, tabId: data.tabId, machine: data.machine || null,
    version: version + 1, updatedAt: Date.now() };
  return { ok: true, notes: { ...current, [key]: next } };
}

// Drafts never change the saved note or its version until Save is selected.
export function noteEditorValue(notes, drafts, key) {
  const saved = notes?.[key];
  const version = Number.isInteger(saved?.version) ? saved.version : 0;
  const draft = drafts?.[key];
  const restorable = typeof draft?.text === 'string' && draft.baseVersion === version;
  return { text: restorable ? draft.text : noteText(notes, key), version,
    restored: restorable, staleDraft: Boolean(draft && !restorable) };
}
export function retainNoteDraft(drafts, key, text, version, savedText) {
  const next = { ...(drafts ?? {}) };
  if (!key || typeof text !== 'string') return next;
  if (text === savedText) delete next[key];
  else next[key] = { text, baseVersion: version, updatedAt: Date.now() };
  return next;
}
