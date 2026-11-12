/**
 * The source's own structure, derived without AI: sections with roles
 * (abstract, methods, references…), item metadata from Zotero, and lookups
 * from a position on the page to a paragraph or sentences.
 *
 * Used by the prompt (outline and metadata), the router (which sections a
 * question needs) and Explain mode (what was clicked or selected).
 */
import {
  getFirstPageIndex,
  getPageLabel,
  getRangeRects,
  getSentenceRects,
  KonnashDocument,
  Rect,
} from "./document";

export type Role =
  | "front-matter"
  | "abstract"
  | "keywords"
  | "summary"
  | "introduction"
  | "methods"
  | "results"
  | "discussion"
  | "conclusion"
  | "references"
  | "appendix"
  | "acknowledgements"
  | "notes";

/**
 * A section keeps two kinds of fact apart, as TEI and JATS do: what the
 * document says (its heading, if it has one) and what Konnash infers (its
 * role). Only the heading may ever be shown to a model or the reader as the
 * section's name; a section without one is described by its place
 * (sectionForModel, sectionLabel), never given an invented name.
 */
export interface Section {
  id: string;
  /**
   * The document's own words, as printed: the heading paragraph, the PDF
   * bookmark, or the word that opens the abstract. Null when the document
   * gives the section no heading: the text before the first heading, or a
   * page chunk of a PDF without structure.
   */
  heading: string | null;
  level: number;
  /** Konnash's inference of what kind of section this is, never its name */
  role: Role | null;
  /** Inclusive paragraph range */
  start: number;
  end: number;
  /** Page indexes [first, last] */
  pages: [number, number];
  tokens: number;
}

export interface SourceInfo {
  typeLabel: string;
  title: string;
  authors: string[];
  date: string;
  publication: string;
  doi: string;
}

const ROLE_PATTERNS: [Role, RegExp][] = [
  ["abstract", /^(abstract|summary of the (article|paper))\b/i],
  ["keywords", /^(key ?words|index terms)\b/i],
  ["summary", /^(highlights|key points|executive summary|summary|chapter summary|in brief|overview|key takeaways|takeaways|main points)\b/i],
  ["introduction", /^(introduction|background)\b/i],
  ["methods", /^(methods?|methodology|materials and methods|research (design|method)|study design|data and methods?|data)\b/i],
  ["results", /^(results|findings|analysis|empirical results)\b/i],
  ["discussion", /^(discussion|general discussion|implications)\b/i],
  ["conclusion", /^(conclusions?|concluding remarks|summary and conclusions?)\b/i],
  ["references", /^(references|bibliography|works cited|literature cited|reference list|sources)\b/i],
  ["appendix", /^(appendix|appendices|supplementary)/i],
  ["acknowledgements", /^acknowledg/i],
  ["notes", /^(notes|endnotes|footnotes)$/i],
];

function cleanTitle(title: string) {
  return title.replace(/^([\dIVXivx]+(\.\d+)*[.)]?|[A-Z][.)])\s+/, "").trim();
}

export function roleForTitle(title: string): Role | null {
  const clean = cleanTitle(title);
  for (const [role, re] of ROLE_PATTERNS) if (re.test(clean)) return role;
  return null;
}

function paragraphTokens(doc: KonnashDocument, start: number, end: number) {
  let chars = 0;
  for (let p = start; p <= end; p++) chars += doc.paragraphs[p].text.length;
  return Math.round(chars / 4);
}

function lastPageOf(doc: KonnashDocument, paragraph: number) {
  const pos = doc.paragraphs[paragraph].charPos;
  for (let i = pos.length - 1; i >= 0; i--) if (pos[i]) return pos[i]!.pageIndex;
  return getFirstPageIndex(doc, paragraph) ?? 0;
}

const sectionCache = new WeakMap<KonnashDocument, Section[]>();

/**
 * Sections from the PDF outline (two levels), else from headings, else page
 * chunks (which have no heading). Text before the first section has no
 * heading either; it takes the role "front-matter", and an abstract inside
 * it becomes its own section, headed by the word as printed.
 */
export function getSections(doc: KonnashDocument): Section[] {
  const cached = sectionCache.get(doc);
  if (cached) return cached;
  const count = doc.paragraphs.length;
  let starts: { heading: string | null; level: number; paragraph: number }[] = [];
  const seen = new Set<number>();
  for (const entry of doc.outline) {
    if (entry.level > 1 || entry.paragraph === null || seen.has(entry.paragraph)) continue;
    seen.add(entry.paragraph);
    starts.push({ heading: entry.title, level: entry.level, paragraph: entry.paragraph });
  }
  if (starts.length < 2) {
    starts = doc.paragraphs
      .filter((p) => p.kind === "heading" && !p.auxiliary && p.text.length < 120)
      .map((p) => ({ heading: p.text.trim(), level: 0, paragraph: p.index }));
  }
  if (starts.length < 2) {
    // No structure: page chunks for routing, with no heading of their own
    starts = [];
    const pagesPer = 4;
    let lastChunk = -1;
    doc.paragraphs.forEach((p) => {
      const chunk = Math.floor((getFirstPageIndex(doc, p.index) ?? 0) / pagesPer);
      if (chunk !== lastChunk) {
        lastChunk = chunk;
        starts.push({ heading: null, level: 0, paragraph: p.index });
      }
    });
  }
  starts.sort((a, b) => a.paragraph - b.paragraph);

  const raw: Omit<Section, "id" | "pages" | "tokens">[] = [];
  if (starts.length && starts[0].paragraph > 0) {
    // Before the first heading, with an abstract split out if present
    const frontEnd = starts[0].paragraph - 1;
    const abstractAt = doc.paragraphs
      .slice(0, frontEnd + 1)
      .findIndex((p) => /^abstract\b/i.test(p.text.trim()) && p.text.length < 400);
    if (abstractAt > 0) {
      const printed = doc.paragraphs[abstractAt].text.trim().match(/^abstract\b/i)![0];
      raw.push({ heading: null, level: 0, role: "front-matter", start: 0, end: abstractAt - 1 });
      raw.push({ heading: printed, level: 0, role: "abstract", start: abstractAt, end: frontEnd });
    } else {
      raw.push({ heading: null, level: 0, role: "front-matter", start: 0, end: frontEnd });
    }
  }
  starts.forEach((s, i) => {
    const end = i + 1 < starts.length ? starts[i + 1].paragraph - 1 : count - 1;
    if (end < s.paragraph) return;
    raw.push({ heading: s.heading, level: s.level, role: s.heading ? roleForTitle(s.heading) : null, start: s.paragraph, end });
  });

  const sections = raw.map((s, i) => ({
    ...s,
    id: `s${i + 1}`,
    pages: [getFirstPageIndex(doc, s.start) ?? 0, lastPageOf(doc, s.end)] as [number, number],
    tokens: paragraphTokens(doc, s.start, s.end),
  }));
  sectionCache.set(doc, sections);
  return sections;
}

export function sectionsWithRole(doc: KonnashDocument, role: Role) {
  return getSections(doc).filter((s) => s.role === role);
}

export function sectionOfParagraph(doc: KonnashDocument, paragraph: number) {
  return getSections(doc).find((s) => paragraph >= s.start && paragraph <= s.end) || null;
}

/** All sentence indexes of the given sections, in order */
export function sentencesOfSections(doc: KonnashDocument, sections: Section[]) {
  const set = new Set<number>();
  for (const s of sections) {
    for (let p = s.start; p <= s.end; p++) doc.paragraphs[p].sentences.forEach((i) => set.add(i));
  }
  return [...set].sort((a, b) => a - b);
}

function pageRange(doc: KonnashDocument, pages: [number, number]) {
  const [a, b] = pages;
  return a === b ? `p. ${getPageLabel(doc, a)}` : `pp. ${getPageLabel(doc, a)}–${getPageLabel(doc, b)}`;
}

// ---------------------------------------------------------------------------
// Sections in words: the only ways a section becomes text

/** Stands in the outline for text the document gives no heading */
export const NO_HEADING = "(no heading)";

/**
 * A section as a model may refer to it: its heading as printed, or, when
 * the document gives it none, its place. Never a name Konnash made up.
 */
export function sectionForModel(doc: KonnashDocument, s: Section) {
  if (s.heading) return s.heading;
  return s.role === "front-matter" ? "the text before the first heading" : `the text on ${pageRange(doc, s.pages)}`;
}

/**
 * A section's name on screen. A heading is the document's own; otherwise
 * the label is Konnash's description (`own`), which views set apart.
 */
export function sectionLabel(doc: KonnashDocument, s: Section): { text: string; own: boolean } {
  if (s.heading) return { text: s.heading, own: false };
  if (s.role === "front-matter") return { text: "Before the first heading", own: true };
  const [a, b] = s.pages;
  const pages = a === b ? `Page ${getPageLabel(doc, a)}` : `Pages ${getPageLabel(doc, a)}–${getPageLabel(doc, b)}`;
  return { text: pages, own: true };
}

/**
 * The outline as the model sees it: the document's headings as printed,
 * NO_HEADING for text without one. With ids (protocol mode) each section
 * shows its paragraph range so answers can point to it. A document with no
 * headings of its own has no outline.
 */
export function describeOutline(doc: KonnashDocument, withIds: boolean) {
  const sections = getSections(doc);
  if (!sections.some((s) => s.heading)) return "";
  return sections
    .map((s) => {
      const ids = withIds ? ` [${doc.paragraphs[s.start].id}–${doc.paragraphs[s.end].id}]` : "";
      const size = s.tokens >= 1000 ? `, ~${Math.round(s.tokens / 100) / 10}k tokens` : "";
      return `${"  ".repeat(s.level)}${s.heading ?? NO_HEADING}${ids} (${pageRange(doc, s.pages)}${size})`;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Item metadata from Zotero

export function getSourceInfo(attachment: Zotero.Item): SourceInfo {
  const item: any = attachment.parentItem || attachment;
  const field = (name: string) => {
    try {
      return String(item.getField(name) || "");
    } catch {
      return "";
    }
  };
  let typeLabel = "";
  try {
    typeLabel = (Zotero.ItemTypes as any).getLocalizedString(item.itemType) || item.itemType;
  } catch {
    typeLabel = String(item.itemType || "");
  }
  const authors = (item.getCreators?.() || []).map((c: any) =>
    c.name || [c.firstName, c.lastName].filter(Boolean).join(" "),
  );
  return {
    typeLabel,
    title: field("title"),
    authors,
    date: field("date"),
    publication: field("publicationTitle") || field("bookTitle") || field("publisher") || field("university"),
    doi: field("DOI"),
  };
}

export function describeSource(info: SourceInfo | undefined, doc: KonnashDocument) {
  const lines: string[] = [];
  if (info?.typeLabel) lines.push(`Type: ${info.typeLabel}`);
  if (info?.title) lines.push(`Title: ${info.title}`);
  if (info?.authors.length) lines.push(`Authors: ${info.authors.join("; ")}`);
  const published = [info?.date, info?.publication].filter(Boolean).join(", ");
  if (published) lines.push(`Published: ${published}`);
  if (info?.doi) lines.push(`DOI: ${info.doi}`);
  lines.push(`Length: ${doc.pageCount} pages`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// From a position on the page to paragraphs and sentences

type PageIndex = Map<number, { paragraph: number; rect: Rect }[]>;
const pageIndexCache = new WeakMap<KonnashDocument, PageIndex>();

function getPageIndex(doc: KonnashDocument): PageIndex {
  let index = pageIndexCache.get(doc);
  if (index) return index;
  index = new Map();
  for (const p of doc.paragraphs) {
    for (const [pageIndex, rects] of getRangeRects(p, 0, p.text.length)) {
      const list = index.get(pageIndex) || [];
      rects.forEach((rect) => list.push({ paragraph: p.index, rect }));
      index.set(pageIndex, list);
    }
  }
  pageIndexCache.set(doc, index);
  return index;
}

function center(rect: number[]) {
  return [(rect[0] + rect[2]) / 2, (rect[1] + rect[3]) / 2];
}

/** The paragraph at a point on a page (PDF coordinates), or the nearest line */
export function paragraphAtPoint(doc: KonnashDocument, pageIndex: number, x: number, y: number) {
  const lines = getPageIndex(doc).get(pageIndex) || [];
  let best: { paragraph: number; distance: number } | null = null;
  for (const { paragraph, rect } of lines) {
    const dx = x < rect[0] ? rect[0] - x : x > rect[2] ? x - rect[2] : 0;
    const dy = y < rect[1] ? rect[1] - y : y > rect[3] ? y - rect[3] : 0;
    const distance = Math.hypot(dx, dy);
    if (!best || distance < best.distance) best = { paragraph, distance };
    if (distance === 0) break;
  }
  return best && best.distance <= 12 ? best.paragraph : null;
}

export function locateParagraph(
  doc: KonnashDocument,
  position: { pageIndex: number; rects: number[][] } | null | undefined,
) {
  if (!position?.rects?.length) return null;
  const [x, y] = center(position.rects[0]);
  return paragraphAtPoint(doc, position.pageIndex, x, y);
}

function intersects(a: number[], b: number[]) {
  return a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
}

/** Global sentence range [first, last] overlapped by a text selection */
export function locateSentences(
  doc: KonnashDocument,
  position: { pageIndex: number; rects: number[][]; nextPageRects?: number[][] } | null | undefined,
): [number, number] | null {
  if (!position?.rects?.length) return null;
  const parts: [number, number[][]][] = [[position.pageIndex, position.rects]];
  if (position.nextPageRects?.length) parts.push([position.pageIndex + 1, position.nextPageRects]);
  let first = Infinity;
  let last = -Infinity;
  for (const [pageIndex, rects] of parts) {
    const candidates = new Set<number>();
    for (const rect of rects) {
      const [x, y] = center(rect);
      const p = paragraphAtPoint(doc, pageIndex, x, y);
      if (p !== null) candidates.add(p);
    }
    for (const p of candidates) {
      for (const s of doc.paragraphs[p].sentences) {
        const sentenceRects = getSentenceRects(doc, s).get(pageIndex) || [];
        if (sentenceRects.some((sr) => rects.some((r) => intersects(sr, r)))) {
          first = Math.min(first, s);
          last = Math.max(last, s);
        }
      }
    }
  }
  return Number.isFinite(first) ? [first, last] : null;
}
