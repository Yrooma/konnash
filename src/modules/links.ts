/**
 * Zotero's cross-references (KonnashDocument.links: "Table 2", "(Chu et
 * al., 2022)", a footnote mark → the paragraph they point to), put to use
 * for the model only. Zotero's reader already previews these links in the
 * PDF, so nothing here is shown on screen.
 *
 * Optional data, used lightly: a document without links answers exactly as
 * before.
 */
import { getFirstPageIndex, getPageLabel, KonnashDocument } from "./document";

interface LinkIndex {
  /** Sentence → paragraphs it points to */
  from: Map<number, number[]>;
  /** Paragraph → sentences that point to it */
  to: Map<number, number[]>;
}

const indexCache = new WeakMap<KonnashDocument, LinkIndex>();

function getIndex(doc: KonnashDocument): LinkIndex {
  let index = indexCache.get(doc);
  if (index) return index;
  index = { from: new Map(), to: new Map() };
  for (const link of doc.links || []) {
    const out = index.from.get(link.sentence) || [];
    out.push(link.paragraph);
    index.from.set(link.sentence, out);
    const back = index.to.get(link.paragraph) || [];
    back.push(link.sentence);
    index.to.set(link.paragraph, back);
  }
  indexCache.set(doc, index);
  return index;
}

/** Paragraphs the given sentences point to, outside `exclude`, in reading order */
export function linkedFrom(doc: KonnashDocument, sentences: Iterable<number>, exclude = new Set<number>()) {
  const index = getIndex(doc);
  const found = new Set<number>();
  for (const s of sentences) {
    for (const p of index.from.get(s) || []) if (!exclude.has(p)) found.add(p);
  }
  return [...found].sort((a, b) => a - b);
}

/** Sentences that point to the given paragraph, in reading order */
export function linkedTo(doc: KonnashDocument, paragraph: number) {
  return [...new Set(getIndex(doc).to.get(paragraph) || [])].sort((a, b) => a - b);
}

function paragraphTokens(doc: KonnashDocument, p: number) {
  return Math.round(doc.paragraphs[p].text.length / 4) + 2;
}

/**
 * A partial selection plus the paragraphs it points to, within a token
 * budget: captions, tables, notes and equations first, then bibliography
 * entries (list items), each group in reading order.
 */
export function withLinkedParagraphs(doc: KonnashDocument, selection: number[], budget: number) {
  const inSelection = new Set(selection.map((i) => doc.sentences[i].paragraph));
  const targets = linkedFrom(doc, selection, inSelection);
  const ordered = [
    ...targets.filter((p) => doc.paragraphs[p].kind !== "listitem"),
    ...targets.filter((p) => doc.paragraphs[p].kind === "listitem"),
  ];
  const added: number[] = [];
  let used = 0;
  for (const p of ordered) {
    const cost = paragraphTokens(doc, p);
    if (used + cost > budget) continue;
    used += cost;
    added.push(p);
  }
  if (!added.length) return { selection, added: 0 };
  const all = new Set(selection);
  for (const p of added) doc.paragraphs[p].sentences.forEach((i) => all.add(i));
  return { selection: [...all].sort((a, b) => a - b), added: added.length };
}

function excerpt(text: string, max: number) {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean;
}

function pageOf(doc: KonnashDocument, paragraph: number) {
  const page = getFirstPageIndex(doc, paragraph);
  return page === null ? "" : `p. ${getPageLabel(doc, page)}`;
}

const KIND_WORDS: Record<string, string> = { caption: "caption", table: "table", math: "equation", heading: "heading" };

const MAX_TARGETS = 8;
const MAX_MENTIONS = 5;

/**
 * Lines for a passage question: what the passage points to, and where the
 * document points to it. Empty when Zotero found no links there.
 */
export function describePassageLinks(
  doc: KonnashDocument,
  paragraph: number,
  sentences: number[],
  mode: "native" | "protocol",
) {
  const lines: string[] = [];
  const targets = linkedFrom(doc, sentences, new Set([paragraph])).slice(0, MAX_TARGETS);
  if (targets.length) {
    lines.push("It points to these places in the document:");
    for (const p of targets) {
      const para = doc.paragraphs[p];
      // A caption, table or equation says so; an entry or a note speaks for itself
      const kind = KIND_WORDS[para.kind] || "";
      const where = [mode === "protocol" ? para.id : "", kind, pageOf(doc, p)].filter(Boolean).join(", ");
      lines.push(`- ${where}: "${excerpt(para.text, 300)}"`);
    }
  }
  const own = new Set(doc.paragraphs[paragraph].sentences);
  const mentions = linkedTo(doc, paragraph).filter((s) => !own.has(s)).slice(0, MAX_MENTIONS);
  if (mentions.length) {
    if (lines.length) lines.push("");
    if (mode === "protocol") {
      lines.push(`The document points to it from: ${mentions.map((s) => doc.sentences[s].id).join(", ")}.`);
    } else {
      lines.push("The document points to it from:");
      for (const s of mentions) {
        const where = pageOf(doc, doc.sentences[s].paragraph);
        lines.push(`- ${where ? `${where}: ` : ""}"${excerpt(doc.sentences[s].text, 200)}"`);
      }
    }
  }
  return lines.join("\n");
}
