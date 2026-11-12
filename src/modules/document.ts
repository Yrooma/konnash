/**
 * Konnash document model.
 *
 * Builds numbered paragraphs (P1, P2, …) and sentences (S1, S2, …) from
 * Zotero's own structured document text (Zotero.SDT, the same layout
 * analysis that powers Read Aloud), keeping the exact on-page position of
 * every character so that any sentence or range can be highlighted.
 */

/** [x1, y1, x2, y2] in PDF user space (origin bottom-left) */
export type Rect = [number, number, number, number];

/** Same shape as a Zotero reader position for PDFs */
export interface ReaderPosition {
  pageIndex: number;
  rects: Rect[];
  nextPageRects?: Rect[];
}

interface CharPos {
  pageIndex: number;
  rect: Rect;
}

export interface KParagraph {
  id: string;
  index: number;
  /** SDT block type: paragraph, heading, listitem, caption, table, math */
  kind: string;
  /** Footnotes, captions and other text outside the main flow */
  auxiliary: boolean;
  text: string;
  /** Global indexes into KonnashDocument.sentences */
  sentences: number[];
  /** Position of each character of `text`, null for whitespace */
  charPos: (CharPos | null)[];
}

export interface KSentence {
  id: string;
  index: number;
  paragraph: number;
  /** Character range in the paragraph text */
  start: number;
  end: number;
  text: string;
}

export interface OutlineEntry {
  title: string;
  level: number;
  /** Paragraph index where the section starts, if it could be found */
  paragraph: number | null;
}

/**
 * A cross-reference Zotero found in the text: words in one sentence ("Table
 * 2", "(Chu et al., 2022)", a footnote mark) that point to another
 * paragraph (a caption, table, footnote, heading or bibliography entry).
 */
export interface KLink {
  sentence: number;
  paragraph: number;
}

export interface KonnashDocument {
  attachmentID: number;
  paragraphs: KParagraph[];
  sentences: KSentence[];
  pageCount: number;
  /** Printed page label per page index ("" when the PDF has none) */
  pageLabels: string[];
  /** Page height in PDF units per page index */
  pageHeights: number[];
  outline: OutlineEntry[];
  /** Zotero's cross-references; empty when Zotero gives none (optional data) */
  links: KLink[];
}

/** Block types that carry readable text */
const TEXT_BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "listitem",
  "caption",
  "table",
  "math",
]);

/** Abbreviations and initials after which the segmenter wrongly breaks */
const ABBREVIATION_END =
  /\b(?:e\.g|i\.e|et al|cf|vs|viz|Figs?|Eqs?|No|pp?|Dr|Prof|Mrs?|Ms|Vol|Ch|Sec|Tab|approx|resp)\.$/i;
const INITIAL_END = /(?:^|[\s(])\p{Lu}\.$/u;

// textMap header flags, as in Zotero's structured-document-text module
const HEADER_LAST_IS_SOFT_HYPHEN = 1 << 0;
const HEADER_AXIS_DIR_SHIFT = 1;

const documentCache = new Map<number, Promise<KonnashDocument | null>>();

/**
 * Load (and cache) the Konnash document for a PDF attachment
 */
export function getDocument(
  attachmentID: number,
): Promise<KonnashDocument | null> {
  let promise = documentCache.get(attachmentID);
  if (!promise) {
    promise = loadDocument(attachmentID);
    documentCache.set(attachmentID, promise);
    promise.catch(() => documentCache.delete(attachmentID));
  }
  return promise;
}

export function clearDocumentCache() {
  documentCache.clear();
}

async function loadDocument(
  attachmentID: number,
): Promise<KonnashDocument | null> {
  const SDT = (Zotero as any).SDT;
  if (!SDT?.getReader) {
    throw new Error(
      "This Zotero version has no structured document text (Zotero.SDT)",
    );
  }
  const packReader = await SDT.getReader(attachmentID, { isPriority: true });
  if (!packReader) {
    return null;
  }
  const structure = await packReader.materialize();
  return buildDocument(attachmentID, structure);
}

// ---------------------------------------------------------------------------
// Building

interface LeafBlock {
  ref: number[];
  block: any;
  flowClass?: string;
}

export function buildDocument(
  attachmentID: number,
  structure: any,
): KonnashDocument {
  const content: any[] = structure?.content || [];
  const leaves: LeafBlock[] = [];
  const walk = (block: any, ref: number[], flowClass?: string) => {
    flowClass = block.flowClass ?? flowClass;
    const children: any[] = block.content || [];
    const hasChildBlocks = children.some((child) => child.text === undefined);
    if (!hasChildBlocks) {
      leaves.push({ ref, block, flowClass });
      return;
    }
    children.forEach((child, i) => {
      if (child.text === undefined) {
        walk(child, [...ref, i], flowClass);
      }
    });
  };
  content.forEach((block, i) => walk(block, [i]));

  const leafByRef = new Map(leaves.map((leaf) => [leaf.ref.join(","), leaf]));
  const visited = new Set<string>();
  const paragraphs: KParagraph[] = [];
  const sentences: KSentence[] = [];
  // Top-level block index where each paragraph starts, for outline lookup
  const paragraphStarts: number[] = [];
  // Zotero's block paths → paragraph, and the links found in each paragraph
  const paragraphOfPath = new Map<string, number>();
  const pendingLinks: { paragraph: number; at: number; refs: unknown[] }[] = [];

  for (const leaf of leaves) {
    const key = leaf.ref.join(",");
    if (visited.has(key)) {
      continue;
    }
    const chain = getPartChain(leaf, leafByRef);
    chain.forEach((part) => visited.add(part.ref.join(",")));
    const root = chain[0];
    if (root.flowClass === "excluded" || !TEXT_BLOCK_TYPES.has(root.block.type)) {
      continue;
    }

    const { text, charPos, links } = assembleText(chain);
    if (!text.trim()) {
      continue;
    }
    for (const part of chain) {
      // The block itself and the blocks that contain it (a list, a table)
      for (let depth = part.ref.length; depth > 0; depth--) {
        const key = part.ref.slice(0, depth).join(",");
        if (!paragraphOfPath.has(key)) paragraphOfPath.set(key, paragraphs.length);
      }
    }
    for (const link of links) pendingLinks.push({ paragraph: paragraphs.length, ...link });
    const paragraph: KParagraph = {
      id: `P${paragraphs.length + 1}`,
      index: paragraphs.length,
      kind: root.block.type,
      auxiliary: root.flowClass === "auxiliary",
      text,
      sentences: [],
      charPos,
    };
    for (const [start, end] of splitSentences(text)) {
      const sentence: KSentence = {
        id: `S${sentences.length + 1}`,
        index: sentences.length,
        paragraph: paragraph.index,
        start,
        end,
        text: text.slice(start, end),
      };
      sentences.push(sentence);
      paragraph.sentences.push(sentence.index);
    }
    paragraphs.push(paragraph);
    paragraphStarts.push(root.ref[0]);
  }

  const pages: any[] = structure?.catalog?.pages || [];
  return {
    attachmentID,
    paragraphs,
    sentences,
    pageCount: pages.length,
    pageLabels: pages.map((page) =>
      typeof page?.label === "string" && /[\p{L}\p{N}]/u.test(page.label)
        ? page.label
        : "",
    ),
    pageHeights: pages.map((page) =>
      Array.isArray(page?.viewRect) ? page.viewRect[3] - page.viewRect[1] : 792,
    ),
    outline: buildOutline(structure?.catalog?.outline || [], paragraphStarts),
    links: resolveLinks(pendingLinks, paragraphs, sentences, paragraphOfPath),
  };
}

/**
 * Zotero's inline links (a text node's `refs`: block paths) as sentence →
 * paragraph pairs. Optional data: anything unexpected is skipped, and a
 * document without links simply has none.
 */
function resolveLinks(
  pending: { paragraph: number; at: number; refs: unknown[] }[],
  paragraphs: KParagraph[],
  sentences: KSentence[],
  paragraphOfPath: Map<string, number>,
): KLink[] {
  const links: KLink[] = [];
  const seen = new Set<string>();
  for (const { paragraph, at, refs } of pending) {
    const from = paragraphs[paragraph];
    if (!from.sentences.length) continue;
    // The sentence holding the linked words
    let sentence = from.sentences[0];
    for (const i of from.sentences) {
      if (sentences[i].start <= at) sentence = i;
    }
    for (const ref of refs) {
      if (!Array.isArray(ref) || !ref.every((n) => Number.isInteger(n))) continue;
      const target = paragraphOfPath.get(ref.join(","));
      if (target === undefined || target === paragraph) continue;
      const key = `${sentence}>${target}`;
      if (seen.has(key)) continue;
      seen.add(key);
      links.push({ sentence, paragraph: target });
    }
  }
  return links;
}

/**
 * Section headings from the PDF outline, each mapped to the first
 * paragraph at or after the heading's block.
 */
function buildOutline(items: any[], paragraphStarts: number[]) {
  const entries: OutlineEntry[] = [];
  const walk = (list: any[], level: number) => {
    for (const item of list) {
      if (typeof item?.title !== "string" || !item.title.trim()) continue;
      let paragraph: number | null = null;
      if (Array.isArray(item.ref) && Number.isInteger(item.ref[0])) {
        const index = paragraphStarts.findIndex((start) => start >= item.ref[0]);
        paragraph = index === -1 ? null : index;
      }
      entries.push({ title: item.title.trim(), level, paragraph });
      if (Array.isArray(item.children)) walk(item.children, level + 1);
    }
  };
  walk(items, 0);
  return entries;
}

/**
 * A paragraph split across columns or pages is stored as several blocks
 * linked with previousPart/nextPart. Return the whole chain in order.
 */
function getPartChain(
  leaf: LeafBlock,
  leafByRef: Map<string, LeafBlock>,
): LeafBlock[] {
  let root = leaf;
  const seen = new Set<string>([leaf.ref.join(",")]);
  while (Array.isArray(root.block.previousPart)) {
    const prev = leafByRef.get(root.block.previousPart.join(","));
    if (!prev || seen.has(prev.ref.join(","))) break;
    seen.add(prev.ref.join(","));
    root = prev;
  }
  const chain = [root];
  const chainSeen = new Set<string>([root.ref.join(",")]);
  let current = root;
  while (Array.isArray(current.block.nextPart)) {
    const next = leafByRef.get(current.block.nextPart.join(","));
    if (!next || chainSeen.has(next.ref.join(","))) break;
    chainSeen.add(next.ref.join(","));
    chain.push(next);
    current = next;
  }
  return chain;
}

function assembleText(chain: LeafBlock[]) {
  let text = "";
  let charPos: (CharPos | null)[] = [];
  // Where in the text each linked text node starts, with its targets
  const links: { at: number; refs: unknown[] }[] = [];
  chain.forEach((part, partIndex) => {
    let partText = "";
    const partPos: (CharPos | null)[] = [];
    const partLinks: { at: number; refs: unknown[] }[] = [];
    for (const node of part.block.content || []) {
      if (typeof node.text !== "string") continue;
      if (Array.isArray(node.refs) && node.refs.length) partLinks.push({ at: partText.length, refs: node.refs });
      const runData = node.anchor?.textMap
        ? buildRunData(parseTextMap(node.anchor.textMap))
        : null;
      const fallback = getFallbackPos(node, part.block);
      let runIndex = 0;
      for (const ch of node.text) {
        if (isWhitespaceChar(ch)) {
          partPos.push(null);
        } else if (runData) {
          partPos.push(runData[runIndex++] ?? null);
        } else {
          partPos.push(fallback);
        }
      }
      partText += node.text;
    }
    if (partIndex > 0) {
      // Join parts the same way Zotero does (getLogicalBlockText)
      const firstChar = partText.charAt(0);
      if (text.endsWith("-") && firstChar >= "a" && firstChar <= "z") {
        text = text.slice(0, -1);
        charPos = charPos.slice(0, -1);
      } else if (
        /[\p{L}\p{N}]$/u.test(text) &&
        /^[\p{L}\p{N}]/u.test(partText)
      ) {
        text += " ";
        charPos.push(null);
      }
    }
    for (const link of partLinks) links.push({ at: text.length + link.at, refs: link.refs });
    text += partText;
    charPos = charPos.concat(partPos);
  });
  // for…of iterates code points; keep charPos aligned with UTF-16 indexes
  return { text, charPos: alignToUTF16(text, charPos), links };
}

function alignToUTF16(text: string, perCodePoint: (CharPos | null)[]) {
  if (perCodePoint.length === text.length) {
    return perCodePoint;
  }
  const aligned: (CharPos | null)[] = [];
  let i = 0;
  for (const ch of text) {
    const pos = perCodePoint[i++] ?? null;
    for (let k = 0; k < ch.length; k++) aligned.push(pos);
  }
  return aligned;
}

function getFallbackPos(node: any, block: any): CharPos | null {
  const pageRect = node.anchor?.pageRects?.[0] ?? block.anchor?.pageRects?.[0];
  if (!pageRect) return null;
  return {
    pageIndex: pageRect[0],
    rect: pageRect.slice(1, 5) as Rect,
  };
}

function isWhitespaceChar(ch: string) {
  return ch === " " || ch === "\n" || ch === "\t";
}

function parseTextMap(textMap: string): any[] {
  try {
    const parsed = JSON.parse(textMap);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * One entry per non-whitespace character: its page and box.
 * Mirrors buildRunData() in Zotero's structured-document-text module.
 */
function buildRunData(runs: any[]): CharPos[] {
  const data: CharPos[] = [];
  for (const run of runs) {
    if (!Array.isArray(run) || run.length < 6) continue;
    const [header, pageIndex, minX, minY, maxX, maxY, ...widths] = run;
    const axisDir = (header >> HEADER_AXIS_DIR_SHIFT) & 0b11;
    const vertical = axisDir === 1 || axisDir === 3;
    const start = vertical ? minY : minX;
    const end = vertical ? maxY : maxX;
    const spans: [number, number][] = [];
    if (!widths.length) {
      spans.push([start, end]);
    } else {
      let pos = start;
      for (const w of widths) {
        if (Array.isArray(w)) {
          pos += w[0];
          spans.push([pos, pos + w[1]]);
          pos += w[1];
        } else {
          spans.push([pos, pos + w]);
          pos += w;
        }
      }
    }
    if (header & HEADER_LAST_IS_SOFT_HYPHEN) {
      spans.pop();
    }
    for (const [a, b] of spans) {
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      data.push({
        pageIndex,
        rect: vertical ? [minX, a, maxX, b] : [a, minY, b, maxY],
      });
    }
  }
  return data;
}

// ---------------------------------------------------------------------------
// Sentences

/**
 * Split paragraph text into sentence ranges [start, end), trimmed of
 * surrounding whitespace.
 */
export function splitSentences(text: string): [number, number][] {
  const Segmenter = (Intl as any).Segmenter;
  const raw: [number, number][] = [];
  if (Segmenter) {
    const segmenter = new Segmenter("en", { granularity: "sentence" });
    for (const seg of segmenter.segment(text)) {
      raw.push([seg.index, seg.index + seg.segment.length]);
    }
  } else {
    const re = /[^.!?]+(?:[.!?]+["'”’)\]]*|$)/g;
    let m;
    while ((m = re.exec(text)) && m[0]) {
      raw.push([m.index, m.index + m[0].length]);
    }
  }

  // Undo breaks after abbreviations like "e.g." or "et al."
  const merged: [number, number][] = [];
  for (const range of raw) {
    const prev = merged[merged.length - 1];
    const prevText = prev ? text.slice(prev[0], prev[1]).trimEnd() : "";
    if (prev && (ABBREVIATION_END.test(prevText) || INITIAL_END.test(prevText))) {
      prev[1] = range[1];
    } else {
      merged.push([...range]);
    }
  }

  const result: [number, number][] = [];
  for (let [start, end] of merged) {
    while (start < end && /\s/.test(text[start])) start++;
    while (end > start && /\s/.test(text[end - 1])) end--;
    if (end > start) result.push([start, end]);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Positions

/**
 * Line rects for a character range of a paragraph, grouped by page in
 * reading order.
 */
export function getRangeRects(
  paragraph: KParagraph,
  start: number,
  end: number,
): Map<number, Rect[]> {
  // Merge character boxes that sit on the same line into one rect
  const lines = new Map<string, { pageIndex: number; rect: Rect }>();
  for (let i = start; i < end; i++) {
    const pos = paragraph.charPos[i];
    if (!pos) continue;
    const [x1, y1, x2, y2] = pos.rect;
    const key = `${pos.pageIndex}|${y1.toFixed(1)}|${y2.toFixed(1)}`;
    const line = lines.get(key);
    if (line) {
      line.rect[0] = Math.min(line.rect[0], x1);
      line.rect[2] = Math.max(line.rect[2], x2);
    } else {
      lines.set(key, { pageIndex: pos.pageIndex, rect: [x1, y1, x2, y2] });
    }
  }
  const byPage = new Map<number, Rect[]>();
  for (const { pageIndex, rect } of lines.values()) {
    const rects = byPage.get(pageIndex) || [];
    rects.push(rect.map((v) => Math.round(v * 1000) / 1000) as Rect);
    byPage.set(pageIndex, rects);
  }
  return byPage;
}

/**
 * Combine per-page rects into one reader position. The reader can show at
 * most two consecutive pages per position; anything beyond is dropped.
 */
export function toReaderPosition(
  byPage: Map<number, Rect[]>,
): ReaderPosition | null {
  const pages = [...byPage.keys()].sort((a, b) => a - b);
  if (!pages.length) return null;
  const pageIndex = pages[0];
  const position: ReaderPosition = {
    pageIndex,
    rects: byPage.get(pageIndex)!,
  };
  const next = byPage.get(pageIndex + 1);
  if (next) {
    position.nextPageRects = next;
  }
  return position;
}

export function mergeRectMaps(maps: Map<number, Rect[]>[]) {
  const merged = new Map<number, Rect[]>();
  for (const map of maps) {
    for (const [pageIndex, rects] of map) {
      merged.set(pageIndex, (merged.get(pageIndex) || []).concat(rects));
    }
  }
  return merged;
}

export function getSentenceRects(doc: KonnashDocument, sentenceIndex: number) {
  const sentence = doc.sentences[sentenceIndex];
  const paragraph = doc.paragraphs[sentence.paragraph];
  return getRangeRects(paragraph, sentence.start, sentence.end);
}

export function getParagraphRects(doc: KonnashDocument, paragraphIndex: number) {
  const paragraph = doc.paragraphs[paragraphIndex];
  return getRangeRects(paragraph, 0, paragraph.text.length);
}

export function getFirstPageIndex(
  doc: KonnashDocument,
  paragraphIndex: number,
): number | null {
  const pos = doc.paragraphs[paragraphIndex].charPos.find((p) => p);
  return pos ? pos.pageIndex : null;
}

/** "p. 12" style label for a page index; falls back to the page number */
export function getPageLabel(doc: KonnashDocument, pageIndex: number) {
  return doc.pageLabels[pageIndex] || String(pageIndex + 1);
}

/** Page index where a sentence starts */
export function getSentencePageIndex(
  doc: KonnashDocument,
  sentenceIndex: number,
): number | null {
  const sentence = doc.sentences[sentenceIndex];
  const paragraph = doc.paragraphs[sentence.paragraph];
  for (let i = sentence.start; i < sentence.end; i++) {
    const pos = paragraph.charPos[i];
    if (pos) return pos.pageIndex;
  }
  return null;
}

/** The section outline as indented lines with paragraph ids */
export function getOutlineText(doc: KonnashDocument) {
  return doc.outline
    .map((entry) => {
      const id = entry.paragraph === null ? "" : ` (${doc.paragraphs[entry.paragraph].id})`;
      return `${"  ".repeat(entry.level)}${entry.title}${id}`;
    })
    .join("\n");
}
