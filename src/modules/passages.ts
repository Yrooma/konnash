/**
 * Passages: a paragraph, or some of its sentences, that a question is about.
 * Stored with a text anchor so it can be found again if Zotero reprocesses
 * the PDF and paragraph ids shift.
 */
import { KonnashDocument } from "./document";
import { CitationSpan, parseCitation } from "./citations";
import { describePassage, PassageRef } from "./ai/prompt";
import { DocFile, ParagraphAnchor, StoredPassageRef } from "./docStore";
import { getSections } from "./structure";

export function anchorFor(kdoc: KonnashDocument, paragraph: number): ParagraphAnchor {
  const p = kdoc.paragraphs[paragraph];
  return { paragraph, pid: p.id, start: p.text.slice(0, 60), length: p.text.length };
}

/** Find an anchored paragraph again, even if paragraph ids have shifted */
export function resolveAnchor(kdoc: KonnashDocument, anchor: ParagraphAnchor): number | null {
  const at = kdoc.paragraphs[anchor.paragraph];
  if (at && at.text.startsWith(anchor.start)) return anchor.paragraph;
  let best: number | null = null;
  for (const p of kdoc.paragraphs) {
    if (p.text.startsWith(anchor.start)) {
      if (best === null || Math.abs(p.index - anchor.paragraph) < Math.abs(best - anchor.paragraph)) best = p.index;
    }
  }
  return best;
}

export function toStoredRef(kdoc: KonnashDocument, ref: PassageRef): StoredPassageRef {
  return { anchor: anchorFor(kdoc, ref.paragraph), sentences: ref.sentences };
}

export function fromStoredRef(kdoc: KonnashDocument, stored: StoredPassageRef): PassageRef | null {
  const paragraph = resolveAnchor(kdoc, stored.anchor);
  return paragraph === null ? null : { paragraph, sentences: stored.sentences };
}

export function passageSpan(kdoc: KonnashDocument, ref: PassageRef): CitationSpan | null {
  const spec = ref.sentences
    ? `${kdoc.sentences[ref.sentences[0]].id}–${kdoc.sentences[ref.sentences[1]].id}`
    : kdoc.paragraphs[ref.paragraph].id;
  return parseCitation(kdoc, spec).spans[0] || null;
}

/** "P27 · Transaction costs · p. 2" */
export function passageMeta(kdoc: KonnashDocument, ref: PassageRef) {
  const info = describePassage(kdoc, ref);
  return [info.label, info.section, info.page].filter(Boolean).join(" · ");
}

export interface PassageEntry {
  chatID: string;
  chatTitle: string;
  messageIndex: number;
  ref: PassageRef | null;
  stored: StoredPassageRef;
  /** What was asked: the suggestion label, or the typed question */
  asked: string;
  time: number;
}

/** Every question asked about a passage, in reading order */
export function indexPassages(kdoc: KonnashDocument, file: DocFile): PassageEntry[] {
  const entries: PassageEntry[] = [];
  for (const chat of file.chats) {
    chat.messages.forEach((m, i) => {
      if (m.role !== "user" || !m.passage) return;
      entries.push({
        chatID: chat.id,
        chatTitle: chat.title,
        messageIndex: i,
        ref: fromStoredRef(kdoc, m.passage),
        stored: m.passage,
        asked: m.label || m.text,
        time: m.time,
      });
    });
  }
  return entries.sort(
    (a, b) =>
      (a.ref?.paragraph ?? 1e9) - (b.ref?.paragraph ?? 1e9) ||
      (a.ref?.sentences?.[0] ?? 0) - (b.ref?.sentences?.[0] ?? 0) ||
      a.time - b.time,
  );
}

/** How much attention each section has had: passage questions plus routing */
export function sectionActivity(kdoc: KonnashDocument, file: DocFile) {
  const counts = new Map<string, number>();
  const sections = getSections(kdoc);
  for (const entry of indexPassages(kdoc, file)) {
    if (!entry.ref) continue;
    const s = sections.find((x) => entry.ref!.paragraph >= x.start && entry.ref!.paragraph <= x.end);
    if (s) counts.set(s.id, (counts.get(s.id) || 0) + 1);
  }
  for (const [id, n] of Object.entries(file.sectionStats)) counts.set(id, (counts.get(id) || 0) + n);
  return counts;
}

/** Paragraphs that have been asked about (for markers) */
export function askedParagraphs(kdoc: KonnashDocument, file: DocFile) {
  return new Set(indexPassages(kdoc, file).map((e) => e.ref?.paragraph).filter((p): p is number => p !== undefined));
}
