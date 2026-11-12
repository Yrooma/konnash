/**
 * Suggested prompts: recommended by Konnash, never imposed. Clicking a
 * suggestion puts its text in the question box to edit (Ctrl+click, or
 * ⌘-click on macOS, sends).
 * Settings → Konnash lets the reader edit, add, hide and reset them.
 *
 * Edits are stored as overrides per prompt, so prompts the reader never
 * touched keep following improvements to the recommendations.
 */
import { getPref, setPref } from "../utils/prefs";

export type PromptSet = "document" | "passage";

export interface PromptDef {
  id: string;
  label: string;
  text: string;
  /** Unchanged from Konnash's recommendation */
  recommended: boolean;
  /** Added by the reader */
  custom?: boolean;
  /** Hidden from the panel (still listed in Settings, with Show) */
  hidden?: boolean;
}

export interface PromptOverrides {
  document?: Record<string, { label?: string; text?: string; hidden?: boolean }>;
  passage?: Record<string, { label?: string; text?: string; hidden?: boolean }>;
  /** Reader-added document prompts */
  custom?: { id: string; label: string; text: string }[];
  /** Passage prompt run by Enter on an empty box */
  passageDefault?: string;
}

export const RECOMMENDED: Record<PromptSet, { id: string; label: string; text: string }[]> = {
  document: [
    {
      id: "overview",
      label: "Overview",
      text: `Give me an overview of this document.
Start with two to four sentences on what it is, its aim, and its main contribution or argument.
Then go through it in its own order, section by section or chapter by chapter, one or two sentences each, merging minor sections, under bold labels taken from its own headings.
Fit this to the kind of document: for an empirical paper, usually its question, method and findings; for a conceptual or review piece, the steps of its argument; for a book, its chapters.`,
    },
    { id: "findings", label: "Key findings", text: "What are the key findings, and how strong is the evidence behind each?" },
    { id: "method", label: "Method", text: "How was the study done? Describe the design, sample, data and analysis." },
    {
      id: "where",
      label: "Where should I read?",
      text: "I want to understand this document well. Which sections should I read closely, in what order, and why?",
    },
    { id: "terms", label: "Key terms", text: "Which key terms and concepts does this document rely on, and how does it define them?" },
  ],
  passage: [
    {
      id: "explain",
      label: "Explain",
      text: `Explain this passage to me, using the whole document.
Cover briefly, with bold labels, and skip any point that doesn't apply:
**In plain words**: what it says.
**Why it's here**: its role in the argument or structure at this point.
**Connections**: how it relates to other parts, such as earlier definitions or later results, with citations.
**Key terms**: as the document defines or uses them.
**When re-reading**: what to notice.`,
    },
    {
      id: "simplify",
      label: "Simplify",
      text: "Say what this passage means in simple, everyday words, as if to a first-year student, keeping its meaning exact.",
    },
    {
      id: "connect",
      label: "Connect",
      text: "How does this passage connect to the rest of the document? Show what it builds on and what builds on it, with citations.",
    },
    {
      id: "critique",
      label: "Critique",
      text: "Look at this passage critically: what does it assume, how well does the document support it, and what could be questioned?",
    },
  ],
};

export function parseOverrides(json: string): PromptOverrides {
  try {
    const data = JSON.parse(json || "{}");
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

/** Recommended prompts with the reader's edits applied */
export function resolvePrompts(set: PromptSet, overrides: PromptOverrides, includeHidden = false): PromptDef[] {
  const edits = overrides[set] || {};
  const list: PromptDef[] = [];
  for (const base of RECOMMENDED[set]) {
    const edit = edits[base.id];
    if (edit?.hidden && !includeHidden) continue;
    const label = edit?.label?.trim() || base.label;
    const text = edit?.text?.trim() || base.text;
    list.push({ id: base.id, label, text, recommended: label === base.label && text === base.text, hidden: !!edit?.hidden });
  }
  if (set === "document") {
    for (const c of overrides.custom || []) {
      if (c?.id && c.label && c.text) list.push({ id: c.id, label: c.label, text: c.text, recommended: false, custom: true });
    }
  }
  return list;
}

export function resolvePassageDefault(overrides: PromptOverrides): PromptDef {
  const passage = resolvePrompts("passage", overrides);
  return passage.find((p) => p.id === overrides.passageDefault) || passage[0] || {
    ...RECOMMENDED.passage[0],
    recommended: true,
  };
}

// ---------------------------------------------------------------------------
// Pref-backed helpers

export function getOverrides() {
  return parseOverrides(String(getPref("prompts") || "{}"));
}

function saveOverrides(overrides: PromptOverrides) {
  setPref("prompts", JSON.stringify(overrides));
}

export function getPrompts(set: PromptSet, includeHidden = false) {
  return resolvePrompts(set, getOverrides(), includeHidden);
}

export function getPassageDefault() {
  return resolvePassageDefault(getOverrides());
}

export function editPrompt(set: PromptSet, id: string, change: { label?: string; text?: string }) {
  const overrides = getOverrides();
  const custom = overrides.custom?.find((c) => c.id === id);
  if (custom) {
    Object.assign(custom, change);
  } else {
    overrides[set] = overrides[set] || {};
    overrides[set]![id] = { ...overrides[set]![id], ...change };
  }
  saveOverrides(overrides);
}

export function resetPrompt(set: PromptSet, id: string) {
  const overrides = getOverrides();
  if (overrides[set]) delete overrides[set]![id];
  saveOverrides(overrides);
}

export function removePrompt(set: PromptSet, id: string) {
  const overrides = getOverrides();
  if (overrides.custom?.some((c) => c.id === id)) {
    overrides.custom = overrides.custom.filter((c) => c.id !== id);
  } else {
    overrides[set] = overrides[set] || {};
    overrides[set]![id] = { ...overrides[set]![id], hidden: true };
  }
  saveOverrides(overrides);
}

export function showPrompt(set: PromptSet, id: string) {
  const overrides = getOverrides();
  const edit = overrides[set]?.[id];
  if (edit) {
    delete edit.hidden;
    if (!edit.label && !edit.text) delete overrides[set]![id];
  }
  saveOverrides(overrides);
}

export function addDocumentPrompt(label: string, text: string) {
  const overrides = getOverrides();
  overrides.custom = [...(overrides.custom || []), { id: `custom-${Date.now().toString(36)}`, label, text }];
  saveOverrides(overrides);
}

export function setPassageDefault(id: string) {
  const overrides = getOverrides();
  overrides.passageDefault = id;
  saveOverrides(overrides);
}

export function resetAllPrompts() {
  saveOverrides({});
}
