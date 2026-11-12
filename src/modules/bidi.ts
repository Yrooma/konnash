/**
 * Reading direction (RTL/LTR) for text whose language Konnash can't know in
 * advance: answers, questions, passages from the PDF, prompts.
 *
 * The browser's own dir="auto" looks only at the first strong letter, so an
 * Arabic paragraph that opens with "GPT-4" or a citation reads left-to-right
 * and becomes unreadable. Here a block's direction comes from its words
 * instead: the share of words written in a right-to-left script, with
 * citation markers, code and links left out. A block needs a few words to
 * decide; shorter ones follow their surroundings (the answer, the PDF).
 *
 * Inside a block, a bold/italic/code run in the other direction is isolated
 * (dir on an inline element), so its punctuation and numbers stay with it.
 */

export type Dir = "rtl" | "ltr";
export type DirSetting = Dir | "auto";

const LETTER = /\p{L}/u;
// Hebrew, Arabic, Syriac, Thaana, NKo, Samaritan, Mandaic, Arabic extended
// and presentation forms; historic RTL scripts; Adlam and Arabic math
const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF\u{10800}-\u{10FFF}\u{1E800}-\u{1EFFF}]/u;
// Citation markers, inline code, links and e-mail addresses: always Latin,
// whatever the language around them
const NOISE = /\[[^\]\n]*\]|`[^`\n]*`|\b(?:https?:\/\/|www\.)\S+|\S+@\S+\.\S+/g;

export interface DirectionCount {
  rtl: number;
  ltr: number;
  first: Dir | null;
}

/** Words per direction; a word counts by its first letter */
export function countDirection(text: string): DirectionCount {
  const count: DirectionCount = { rtl: 0, ltr: 0, first: null };
  for (const word of text.replace(NOISE, " ").split(/\s+/)) {
    for (const ch of word) {
      if (!LETTER.test(ch)) continue;
      const dir: Dir = RTL_LETTER.test(ch) ? "rtl" : "ltr";
      count[dir] += 1;
      count.first ??= dir;
      break;
    }
  }
  return count;
}

/**
 * The direction a text reads in, or null when it has fewer than `minWords`
 * words with letters (numbers, symbols, a single short word).
 *
 * Right-to-left when at least 40% of the words are in an RTL script, or 20%
 * when the text also starts with one. Technical terms in Latin script are
 * common inside Arabic or Hebrew prose, so the bar for RTL is lower; the
 * reverse (an Arabic term quoted in English) stays well below it.
 */
export function detectDirection(text: string, minWords = 1): Dir | null {
  const { rtl, ltr, first } = countDirection(text);
  const total = rtl + ltr;
  if (!total || total < minWords) return null;
  const share = rtl / total;
  return share >= 0.4 || (share >= 0.2 && first === "rtl") ? "rtl" : "ltr";
}

/** Set an element's dir from its text; leave it inheriting when undecided */
export function setAutoDir(node: HTMLElement, text = node.textContent || "", fallback?: Dir | null, minWords = 1) {
  const dir = detectDirection(text, minWords) || fallback;
  if (dir) node.dir = dir;
  else node.removeAttribute("dir");
  return dir || null;
}

const docDirections = new WeakMap<object, Dir>();

/** The main direction of a document, from a sample of its sentences */
export function documentDirection(kdoc: { sentences: { text: string }[] }): Dir {
  let dir = docDirections.get(kdoc);
  if (!dir) {
    const step = Math.max(1, Math.floor(kdoc.sentences.length / 300));
    let sample = "";
    for (let i = 0; i < kdoc.sentences.length; i += step) sample += ` ${kdoc.sentences[i].text}`;
    dir = detectDirection(sample) || "ltr";
    docDirections.set(kdoc, dir);
  }
  return dir;
}

/** Zotero's interface direction (the panel's chrome follows it) */
export function interfaceDirection(): Dir {
  try {
    return (Zotero as any).rtl ? "rtl" : "ltr";
  } catch {
    return "ltr";
  }
}

const BLOCKS = ".konnash-a-p, .konnash-a-heading, .konnash-a-list, .konnash-a-table, .konnash-think-body p";
const INLINE_RUNS = "strong, em, code";

/**
 * Directions for a rendered answer (or any container of blocks).
 * - forced: every block reads in this direction (the reader's choice)
 * - fallback: for an answer too short to decide (the document's direction)
 * A list is decided as a whole, so its bullets line up; so is a table (its
 * column order), and then each cell reads in the direction of its own
 * words. Returns the answer's overall direction.
 */
export function applyBlockDirections(container: HTMLElement, options: { forced?: Dir | null; fallback: Dir }) {
  const overall = options.forced || detectDirection(container.textContent || "") || options.fallback;
  container.dir = overall;
  for (const block of container.querySelectorAll(BLOCKS) as NodeListOf<HTMLElement>) {
    // Nested blocks (a list in a quote) inherit what their parent decided
    const parentDir = (block.parentElement?.closest("[dir]") as HTMLElement | null)?.dir;
    const inherited: Dir = parentDir === "rtl" || parentDir === "ltr" ? parentDir : overall;
    const dir = options.forced || detectDirection(block.textContent || "", 3) || inherited;
    if (dir === inherited) block.removeAttribute("dir");
    else block.dir = dir;
    if (block.localName === "table") {
      for (const cell of block.querySelectorAll("th, td") as NodeListOf<HTMLElement>) {
        const own = options.forced || detectDirection(cell.textContent || "") || dir;
        if (own === dir) cell.removeAttribute("dir");
        else cell.dir = own;
        isolateRuns(cell, own);
      }
    } else {
      isolateRuns(block, dir);
    }
  }
  return overall;
}

/** Give bold/italic/code runs in the other direction their own dir */
function isolateRuns(block: HTMLElement, blockDir: Dir) {
  for (const run of block.querySelectorAll(INLINE_RUNS) as NodeListOf<HTMLElement>) {
    const dir = detectDirection(run.textContent || "");
    if (run.localName === "code") run.dir = dir || "ltr";
    else if (dir && dir !== blockDir) run.dir = dir;
  }
}
