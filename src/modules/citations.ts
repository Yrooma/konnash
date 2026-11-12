/**
 * Citations point at evidence in one document: a sentence (S12), a run of
 * sentences (S12–S16), a paragraph (P4) or a run of paragraphs (P4–P6).
 * One citation may combine several places: "S12–S16, S88".
 */
import {
  getParagraphRects,
  getSentenceRects,
  KonnashDocument,
  mergeRectMaps,
  ReaderPosition,
  toReaderPosition,
} from "./document";

export interface CitationSpan {
  /** Normalized label, e.g. "S12–S16" or "P4" */
  label: string;
  /** Inclusive global sentence range */
  firstSentence: number;
  lastSentence: number;
  /** True when the citation names whole paragraphs */
  wholeParagraphs: boolean;
}

export interface SpanHighlight {
  /** Light layer: the paragraphs around the evidence (context) */
  context: ReaderPosition | null;
  /** Dark layer: the evidence itself */
  evidence: ReaderPosition | null;
}

const ITEM_RE = /^([SP])\s*(\d+)(?:\s*[-–—]\s*(?:([SP])\s*)?(\d+))?$/i;

/**
 * Parse "S12–S16, S88; P4" into spans. Unknown or out-of-range parts are
 * reported in `errors` instead of being silently dropped.
 */
export function parseCitation(doc: KonnashDocument, spec: string) {
  const spans: CitationSpan[] = [];
  const errors: string[] = [];
  const items = spec
    .split(/[,;+]|\band\b/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const item of items) {
    const m = item.match(ITEM_RE);
    if (!m) {
      errors.push(`"${item}" is not a sentence (S12) or paragraph (P4) id`);
      continue;
    }
    const kind = m[1].toUpperCase();
    const from = parseInt(m[2]);
    const to = m[4] ? parseInt(m[4]) : from;
    if (m[3] && m[3].toUpperCase() !== kind) {
      errors.push(`"${item}" mixes sentence and paragraph ids`);
      continue;
    }
    if (to < from) {
      errors.push(`"${item}" ends before it starts`);
      continue;
    }
    if (kind === "S") {
      if (from < 1 || to > doc.sentences.length) {
        errors.push(`"${item}" is outside S1–S${doc.sentences.length}`);
        continue;
      }
      spans.push({
        label: from === to ? `S${from}` : `S${from}–S${to}`,
        firstSentence: from - 1,
        lastSentence: to - 1,
        wholeParagraphs: false,
      });
    } else {
      if (from < 1 || to > doc.paragraphs.length) {
        errors.push(`"${item}" is outside P1–P${doc.paragraphs.length}`);
        continue;
      }
      const first = doc.paragraphs[from - 1].sentences[0];
      const lastParagraph = doc.paragraphs[to - 1].sentences;
      const last = lastParagraph[lastParagraph.length - 1];
      if (first === undefined || last === undefined) {
        errors.push(`"${item}" has no text`);
        continue;
      }
      spans.push({
        label: from === to ? `P${from}` : `P${from}–P${to}`,
        firstSentence: first,
        lastSentence: last,
        wholeParagraphs: true,
      });
    }
  }
  return { spans, errors };
}

export function getSpanText(doc: KonnashDocument, span: CitationSpan) {
  const parts: string[] = [];
  for (let i = span.firstSentence; i <= span.lastSentence; i++) {
    parts.push(doc.sentences[i].text);
  }
  return parts.join(" ");
}

export function getSpanParagraphs(doc: KonnashDocument, span: CitationSpan) {
  const first = doc.sentences[span.firstSentence].paragraph;
  const last = doc.sentences[span.lastSentence].paragraph;
  const indexes: number[] = [];
  for (let p = first; p <= last; p++) indexes.push(p);
  return indexes;
}

export function getSpanHighlight(
  doc: KonnashDocument,
  span: CitationSpan,
): SpanHighlight {
  const evidenceMaps = [];
  for (let i = span.firstSentence; i <= span.lastSentence; i++) {
    evidenceMaps.push(getSentenceRects(doc, i));
  }
  const evidence = toReaderPosition(mergeRectMaps(evidenceMaps));
  const contextMaps = getSpanParagraphs(doc, span).map((p) =>
    getParagraphRects(doc, p),
  );
  let context = toReaderPosition(mergeRectMaps(contextMaps));
  // The reader draws one position per layer; keep both on the same pages
  if (context && evidence && context.pageIndex !== evidence.pageIndex) {
    const merged = mergeRectMaps(contextMaps);
    const aligned = new Map(
      [...merged].filter(
        ([page]) =>
          page === evidence.pageIndex || page === evidence.pageIndex + 1,
      ),
    );
    context = toReaderPosition(aligned);
  }
  return { context, evidence };
}
