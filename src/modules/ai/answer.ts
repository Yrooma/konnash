/**
 * One answer format for every provider: Markdown with inline citation
 * markers ([S12], [S12–S16, S88], [P4], [general]).
 *
 * The blocks a model may write (paragraphs, headings, lists, tables, block
 * quotes, code, rules) are read with markdown-it; inside every block the
 * text goes through Konnash's own layer: sentences, citation markers, bare
 * ids and uncited statements. Native citations (Anthropic) are converted
 * into the same markers, so rendering and checking work identically
 * whatever model produced them.
 */
import MarkdownIt from "markdown-it";
import { KonnashDocument, splitSentences } from "../document";
import { CitationSpan, parseCitation } from "../citations";

/**
 * How a [general] statement is marked where citations stand (panel and
 * notes): an open circle, a place with nothing in the document behind it
 */
export const GENERAL_MARK = "○";

/** A citation marker: [S12], [S12–S16], [P4], [S3, S9], [general] */
export const MARKER_RE =
  /\[\s*((?:general)|(?:[SP]\s*\d+(?:\s*[-–—]\s*[SP]?\s*\d+)?(?:\s*[,;]\s*[SP]\s*\d+(?:\s*[-–—]\s*[SP]?\s*\d+)?)*))\s*\]/gi;

export interface TextStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

export type AnswerToken =
  | ({ type: "text"; text: string } & TextStyle)
  /**
   * `inline`: an id the model wrote without brackets ("read paragraph P23"),
   * kept as the words it wrote and shown as a link (linkBareIds)
   */
  | { type: "cite"; spec: string; general: boolean; inline?: string };

export interface AnswerSentence {
  tokens: AnswerToken[];
  cited: boolean;
  /** Substantive statement with no citation and no [general] mark */
  uncited: boolean;
  /** Substantive statement whose only citations are bare ids (linkBareIds) */
  onlyBareIds?: boolean;
}

/** A run of inline text: one paragraph, heading or table cell */
export type InlineText = AnswerSentence[];

/** Column alignment in the reading direction ("start" is right in RTL) */
export type TableAlign = "start" | "center" | "end" | null;

/**
 * One block of an answer. `source` is the block's Markdown (top-level
 * blocks only): unchanged source means an unchanged block while streaming.
 */
export type AnswerBlock =
  | { kind: "paragraph"; sentences: InlineText; /** a "Read closely" line */ pointer: boolean; source: string }
  | { kind: "heading"; level: number; sentences: InlineText; source: string }
  | { kind: "list"; ordered: boolean; start: number; items: AnswerBlock[][]; source: string }
  | { kind: "table"; head: InlineText[]; align: TableAlign[]; rows: InlineText[][]; source: string }
  | { kind: "quote"; blocks: AnswerBlock[]; source: string }
  | { kind: "code"; text: string; source: string }
  | { kind: "rule"; source: string };

/**
 * Markers written after the sentence's period ("claim. [S12]") belong to
 * that sentence; move them before the punctuation so sentence splitting
 * keeps them together.
 */
export function normalizeMarkers(text: string) {
  return text.replace(
    /([.!?])((?:\s*\[\s*(?:general|[SP]\s*\d)[^\]]*\])+)/gi,
    (_m, punct: string, markers: string) => ` ${markers.trim()}${punct}`,
  );
}

/**
 * Remove inline markdown delimiters (**bold**, *italic*, `code`) from a
 * line, returning the plain text and the style of each character. Done
 * before sentence splitting, so bold that spans sentences stays bold.
 */
export function stripInlineMarkdown(line: string) {
  let plain = "";
  const styles: TextStyle[] = [];
  const state: TextStyle = {};
  let i = 0;
  const closes = (delim: string, from: number) => line.indexOf(delim, from) !== -1;
  while (i < line.length) {
    if (!state.code && line.startsWith("**", i) && (state.bold || closes("**", i + 2))) {
      state.bold = !state.bold;
      i += 2;
      continue;
    }
    if (line[i] === "`" && (state.code || closes("`", i + 1))) {
      state.code = !state.code;
      i += 1;
      continue;
    }
    if (
      !state.code &&
      line[i] === "*" &&
      line[i + 1] !== "*" &&
      (state.italic ? /\S/.test(line[i - 1] || "") : /\S/.test(line[i + 1] || "") && closes("*", i + 1))
    ) {
      state.italic = !state.italic;
      i += 1;
      continue;
    }
    plain += line[i];
    styles.push({ ...state });
    i += 1;
  }
  return { plain, styles };
}

function sameStyle(a: TextStyle, b: TextStyle) {
  return !!a.bold === !!b.bold && !!a.italic === !!b.italic && !!a.code === !!b.code;
}

/** Tokens for plain[start, end): styled text runs and citation markers */
function tokenizeRange(plain: string, styles: TextStyle[], start: number, end: number) {
  const tokens: AnswerToken[] = [];
  const pushText = (from: number, to: number) => {
    let runStart = from;
    for (let k = from + 1; k <= to; k++) {
      if (k === to || !sameStyle(styles[k], styles[runStart])) {
        if (k > runStart) {
          tokens.push({ type: "text", text: plain.slice(runStart, k), ...styles[runStart] });
        }
        runStart = k;
      }
    }
  };
  const slice = plain.slice(start, end);
  let last = 0;
  for (const m of slice.matchAll(MARKER_RE)) {
    if (m.index! > last) pushText(start + last, start + m.index!);
    const spec = m[1].replace(/\s+/g, "");
    const general = spec.toLowerCase() === "general";
    tokens.push({ type: "cite", spec: general ? "general" : spec, general });
    last = m.index! + m[0].length;
  }
  if (last < slice.length) pushText(start + last, end);
  return tokens;
}

// ---------------------------------------------------------------------------
// Ids written without brackets
//
// Models sometimes point to a place by its bare id ("read paragraph P23 in
// full, then P40"). Such an id becomes a link only where nothing else could
// be meant: after a word for paragraph or sentence, in a "Read closely"
// pointer line, or listed right after an id already linked. "P1" alone
// (in qualitative studies often a participant) stays text. Whether the id
// exists is checked later, against the document: one that doesn't is shown
// as the words the model wrote, never as an invalid citation.

const BARE_ID_RE = /(?<![A-Za-z0-9_[])([SP])\s?(\d{1,5})(?:\s*[-–—]\s*([SP])?\s?(\d{1,5}))?(?![A-Za-z0-9_\]])/g;
const PLACE_WORD_RE =
  /(?:\b(?:paragraphs?|paras?\.?|sentences?|see|cf\.?)|الفقرات|الفقرتين|الفقرتان|الفقرة|فقرة|فقرتي|الجمل|الجملتين|الجملة|جملة|انظر|راجع)\s*[:(]?\s*$/iu;
const LIST_JOIN_RE = /^\s*(?:,|،|;|؛|and|or|then|و|أو|ثم)?\s*$/iu;
/** "Read closely:" as models write it, in English or Arabic */
export const POINTER_RE = /^(?:read closely|ا?قرأ\s+عن\s+قرب|اقرأ\s+بتمعّ?ن|اقرأ\s+بعناية)(?=[\s:：،]|$)/iu;

function linkBareIds(tokens: AnswerToken[], pointer: boolean): AnswerToken[] {
  const out: AnswerToken[] = [];
  let before = "";
  for (const token of tokens) {
    if (token.type !== "text" || token.code) {
      out.push(token);
      if (token.type === "text") before += token.text;
      else before = "";
      continue;
    }
    const text = token.text;
    let last = 0;
    // Right after a citation ("[P23] and P40"), a listed id continues it
    let linkedEnd = out[out.length - 1]?.type === "cite" ? 0 : -1;
    for (const m of text.matchAll(BARE_ID_RE)) {
      const start = m.index!;
      const preceding = before + text.slice(0, start);
      const afterLinked = linkedEnd >= 0 && LIST_JOIN_RE.test(text.slice(linkedEnd, start));
      if (!pointer && !afterLinked && !PLACE_WORD_RE.test(preceding)) continue;
      const [, kind, from, toKind, to] = m;
      const spec = to ? `${kind}${from}–${toKind || kind}${to}` : `${kind}${from}`;
      if (start > last) out.push({ ...token, text: text.slice(last, start) });
      out.push({ type: "cite", spec, general: false, inline: m[0] });
      last = start + m[0].length;
      linkedEnd = last;
    }
    if (last < text.length) out.push({ ...token, text: text.slice(last) });
    before += text;
  }
  return out;
}

/** Tokens for a whole string, ignoring sentences */
export function tokenize(text: string): AnswerToken[] {
  const { plain, styles } = stripInlineMarkdown(text);
  return tokenizeRange(plain, styles, 0, plain.length);
}

/**
 * Sentences of one run of inline text (a paragraph, a heading, a table
 * cell…). `states`: whether it can state something that needs a citation
 * (headings and table header cells cannot).
 */
function inlineSentences(raw: string, states: boolean): InlineText {
  const { plain, styles } = stripInlineMarkdown(raw.replace(/\s*\n\s*/g, " ").trim());
  const pointer = POINTER_RE.test(plain);
  return splitSentences(plain).map(([start, end]) => {
    let tokens = linkBareIds(tokenizeRange(plain, styles, start, end), pointer);
    // A "Read closely" line names places: "[P3]" reads as a link named P3,
    // not a footnote number standing alone
    if (pointer) tokens = tokens.map((t) => (t.type === "cite" && !t.general && !t.inline ? { ...t, inline: t.spec } : t));
    const cited = tokens.some((t) => t.type === "cite");
    const words = tokens
      .filter((t) => t.type === "text")
      .map((t) => (t as { text: string }).text)
      .join("")
      .trim();
    // Headings, questions, lead-ins and the "Read closely" pointer state nothing
    const statement = states && words.length > 40 && !/[:?]$/.test(words) && !POINTER_RE.test(words);
    const uncited = statement && !cited;
    // Cited only by bare ids: uncited after all if none of them exists
    const onlyBareIds = statement && cited && tokens.every((t) => t.type !== "cite" || !!t.inline);
    return { tokens, cited, uncited, onlyBareIds };
  });
}

// markdown-it gives the block structure only; the text inside each block
// goes through Konnash's own inline layer above. No HTML, no link
// reference definitions ("[S12]: …" stays text), no setext headings (a
// "---" under a line is a rule) and no indented code (a model's indentation
// is not code); fenced code stays.
let parser: MarkdownIt | null = null;
function markdown() {
  if (!parser) {
    parser = new MarkdownIt("default", { html: false, linkify: false, typographer: false });
    parser.disable(["reference", "lheading", "code", "html_block", "html_inline"]);
  }
  return parser;
}

type Token = ReturnType<MarkdownIt["parse"]>[number];

/** The blocks of [from, to) in a token list, nested blocks included */
function readBlocks(tokens: Token[], from: number, to: number, lines?: string[]): AnswerBlock[] {
  const blocks: AnswerBlock[] = [];
  let i = from;
  const closing = (open: number) => {
    let depth = 0;
    for (let k = open; k < to; k++) {
      depth += tokens[k].nesting;
      if (depth === 0) return k;
    }
    return to - 1;
  };
  const source = (t: Token) => (lines && t.map ? lines.slice(t.map[0], t.map[1]).join("\n") : "");
  while (i < to) {
    const t = tokens[i];
    if (t.type === "paragraph_open") {
      const content = tokens[i + 1]?.content || "";
      const sentences = inlineSentences(content, true);
      blocks.push({ kind: "paragraph", sentences, pointer: POINTER_RE.test(stripInlineMarkdown(content.trim()).plain), source: source(t) });
      i = closing(i) + 1;
    } else if (t.type === "heading_open") {
      blocks.push({ kind: "heading", level: Number(t.tag.slice(1)) || 3, sentences: inlineSentences(tokens[i + 1]?.content || "", false), source: source(t) });
      i = closing(i) + 1;
    } else if (t.type === "bullet_list_open" || t.type === "ordered_list_open") {
      const end = closing(i);
      const items: AnswerBlock[][] = [];
      for (let k = i + 1; k < end; k++) {
        if (tokens[k].type !== "list_item_open") continue;
        const itemEnd = closing(k);
        items.push(readBlocks(tokens, k + 1, itemEnd));
        k = itemEnd;
      }
      const ordered = t.type === "ordered_list_open";
      blocks.push({ kind: "list", ordered, start: ordered ? Number(t.attrGet("start") || 1) : 1, items, source: source(t) });
      i = end + 1;
    } else if (t.type === "blockquote_open") {
      const end = closing(i);
      blocks.push({ kind: "quote", blocks: readBlocks(tokens, i + 1, end), source: source(t) });
      i = end + 1;
    } else if (t.type === "table_open") {
      const end = closing(i);
      const head: InlineText[] = [];
      const rows: InlineText[][] = [];
      const align: TableAlign[] = [];
      let inHead = false;
      let row: InlineText[] | null = null;
      for (let k = i + 1; k < end; k++) {
        const c = tokens[k];
        if (c.type === "thead_open") inHead = true;
        else if (c.type === "thead_close") inHead = false;
        else if (c.type === "tr_open") row = [];
        else if (c.type === "tr_close" && row) {
          if (!inHead) rows.push(row);
          row = null;
        } else if (c.type === "th_open" || c.type === "td_open") {
          const style = c.attrGet("style") || "";
          const cellAlign = /center/.test(style) ? "center" : /right/.test(style) ? "end" : /left/.test(style) ? "start" : null;
          const cell = inlineSentences(tokens[k + 1]?.content || "", c.type === "td_open");
          if (inHead) {
            head.push(cell);
            align.push(cellAlign);
          } else row?.push(cell);
        }
      }
      blocks.push({ kind: "table", head, align, rows, source: source(t) });
      i = end + 1;
    } else if (t.type === "fence" || t.type === "code_block") {
      blocks.push({ kind: "code", text: t.content.replace(/\n$/, ""), source: source(t) });
      i++;
    } else if (t.type === "hr") {
      blocks.push({ kind: "rule", source: source(t) });
      i++;
    } else {
      i++;
    }
  }
  return blocks;
}

/** An answer as blocks: paragraphs, headings, lists, tables, quotes, code */
export function parseAnswer(text: string): AnswerBlock[] {
  const normalized = normalizeMarkers(text);
  const tokens = markdown().parse(normalized, {});
  return readBlocks(tokens, 0, tokens.length, normalized.split("\n"));
}

/** Every run of inline text in reading order, nested blocks included */
export function blockTexts(blocks: AnswerBlock[]): InlineText[] {
  const out: InlineText[] = [];
  const walk = (list: AnswerBlock[]) => {
    for (const b of list) {
      if (b.kind === "paragraph" || b.kind === "heading") out.push(b.sentences);
      else if (b.kind === "list") b.items.forEach(walk);
      else if (b.kind === "quote") walk(b.blocks);
      else if (b.kind === "table") {
        out.push(...b.head);
        for (const row of b.rows) out.push(...row);
      }
    }
  };
  walk(blocks);
  return out;
}

/** Every sentence of an answer, in reading order */
export function answerSentences(text: string): AnswerSentence[] {
  return blockTexts(parseAnswer(text)).flat();
}

export interface CitationCheck {
  valid: number;
  invalid: string[];
  uncited: number;
  general: number;
}

/** Count valid, invalid and missing citations in an answer */
export function checkAnswer(doc: KonnashDocument, text: string): CitationCheck {
  const check: CitationCheck = { valid: 0, invalid: [], uncited: 0, general: 0 };
  for (const sentence of answerSentences(text)) {
    if (sentence.uncited) check.uncited++;
    let bareFound = false;
    for (const token of sentence.tokens) {
      if (token.type !== "cite") continue;
      if (token.general) {
        check.general++;
        continue;
      }
      const { spans, errors } = parseCitation(doc, token.spec);
      check.valid += spans.length;
      if (token.inline) {
        // A bare id that doesn't exist was just words, not a citation
        bareFound ||= spans.length > 0;
        continue;
      }
      check.invalid.push(...errors);
    }
    if (sentence.onlyBareIds && !bareFound) check.uncited++;
  }
  return check;
}

export interface NumberedSpan {
  n: number;
  span: CitationSpan;
}

/**
 * Footnote-style numbering for one answer: places are numbered in order of
 * first appearance, and citing the same place again reuses its number.
 */
export function createCitationNumberer(doc: KonnashDocument) {
  const numbers = new Map<string, number>();
  const list: NumberedSpan[] = [];
  return {
    list,
    number(spec: string) {
      const { spans, errors } = parseCitation(doc, spec);
      const items = spans.map((span) => {
        let n = numbers.get(span.label);
        if (!n) {
          n = numbers.size + 1;
          numbers.set(span.label, n);
          list.push({ n, span });
        }
        return { n, span };
      });
      return { items, errors };
    },
  };
}

/** Plain words of a sentence (no markers), e.g. for annotation comments */
export function sentenceWords(sentence: AnswerSentence) {
  return sentence.tokens
    .filter((t) => t.type === "text")
    .map((t) => (t as { text: string }).text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** Remove citation markers, e.g. for history sent back in native mode */
export function stripMarkers(text: string) {
  return text.replace(MARKER_RE, "").replace(/\s+([.,;:!?])/g, "$1");
}

/**
 * Label for a native citation's block range (one block per sentence,
 * end exclusive). A range that covers whole paragraphs becomes P-ids.
 */
export function blockRangeToSpec(
  doc: KonnashDocument,
  startBlock: number,
  endBlock: number,
): string | null {
  const first = startBlock;
  const last = Math.max(startBlock, endBlock - 1);
  if (first < 0 || last >= doc.sentences.length) return null;
  const firstParagraph = doc.paragraphs[doc.sentences[first].paragraph];
  const lastParagraph = doc.paragraphs[doc.sentences[last].paragraph];
  const coversWhole =
    firstParagraph.sentences[0] === first &&
    lastParagraph.sentences[lastParagraph.sentences.length - 1] === last &&
    (firstParagraph !== lastParagraph || firstParagraph.sentences.length > 1);
  if (coversWhole) {
    return firstParagraph === lastParagraph
      ? firstParagraph.id
      : `${firstParagraph.id}–${lastParagraph.id}`;
  }
  return first === last
    ? doc.sentences[first].id
    : `${doc.sentences[first].id}–${doc.sentences[last].id}`;
}
