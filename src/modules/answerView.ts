/**
 * Renders an answer for reading: clean text, faint footnote-style citation
 * numbers, a hover card with the quoted evidence, and a quiet footer.
 */
import { getPageLabel, getSentencePageIndex, KonnashDocument } from "./document";
import { CitationSpan, getSpanText, parseCitation } from "./citations";
import {
  AnswerBlock,
  AnswerToken,
  CitationCheck,
  createCitationNumberer,
  GENERAL_MARK,
  InlineText,
  parseAnswer,
  sentenceWords,
} from "./ai/answer";
import { Routing } from "./docStore";
import { describeIntent } from "./router";
import { documentDirection, setAutoDir } from "./bidi";

const HTML_NS = "http://www.w3.org/1999/xhtml";

export interface AnswerActions {
  showSpan: (span: CitationSpan) => void;
  /** Save the span as a Zotero highlight; comment is the claim it supports */
  keepHighlight: (span: CitationSpan, comment: string) => Promise<void>;
}

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = doc.createElementNS(HTML_NS, tag) as HTMLElementTagNameMap[K];
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function getSpanPageLabel(kdoc: KonnashDocument, span: CitationSpan) {
  const pageIndex = getSentencePageIndex(kdoc, span.firstSentence);
  return pageIndex === null ? "" : `p. ${getPageLabel(kdoc, pageIndex)}`;
}

// ---------------------------------------------------------------------------
// Hover card, shared by all answers in a chat view

interface CardData {
  span: CitationSpan;
  claim: string;
}

export interface HoverCard {
  attach: (target: HTMLElement, data: CardData) => void;
  hide: () => void;
}

export function createHoverCard(
  doc: Document,
  host: HTMLElement,
  kdoc: KonnashDocument,
  actions: AnswerActions,
): HoverCard {
  const win = doc.defaultView as Window;
  const card = el(doc, "div", "konnash-card");
  card.hidden = true;
  host.append(card);
  let hideTimer: number | undefined;

  const cancelHide = () => {
    if (hideTimer !== undefined) win.clearTimeout(hideTimer);
    hideTimer = undefined;
  };
  const scheduleHide = () => {
    cancelHide();
    hideTimer = win.setTimeout(() => (card.hidden = true), 250);
  };
  card.addEventListener("mouseenter", cancelHide);
  card.addEventListener("mouseleave", scheduleHide);

  const show = (target: HTMLElement, data: CardData) => {
    cancelHide();
    const { span } = data;
    const meta = [getSpanPageLabel(kdoc, span), span.label].filter(Boolean).join(" · ");
    const quote = getSpanText(kdoc, span);
    const showButton = el(doc, "button", "konnash-card-button", "Show in PDF");
    showButton.addEventListener("click", () => actions.showSpan(span));
    const keepButton = el(doc, "button", "konnash-card-button", "Keep as highlight");
    keepButton.addEventListener("click", async () => {
      keepButton.disabled = true;
      keepButton.textContent = "Saving…";
      try {
        await actions.keepHighlight(span, data.claim);
        keepButton.textContent = "Kept ✓";
      } catch (e: any) {
        keepButton.textContent = "Couldn't save";
        keepButton.title = String(e?.message || e);
        keepButton.disabled = false;
      }
    });
    const actionsRow = el(doc, "div", "konnash-card-actions");
    actionsRow.append(showButton, keepButton);
    const quoteEl = el(doc, "div", "konnash-card-quote", quote.length > 320 ? `${quote.slice(0, 320)}…` : quote);
    setAutoDir(quoteEl, quote, documentDirection(kdoc), 3);
    card.replaceChildren(el(doc, "div", "konnash-card-meta", meta), quoteEl, actionsRow);
    card.hidden = false;

    const rect = target.getBoundingClientRect();
    // Stay within the panel: Zotero's side icons overlay the window's edge
    const bounds = host.getBoundingClientRect();
    const minLeft = Math.max(0, bounds.left) + 4;
    const maxRight = Math.min(doc.documentElement?.clientWidth || win.innerWidth, bounds.right) - 4;
    const width = Math.min(320, maxRight - minLeft);
    card.style.width = `${width}px`;
    card.style.left = `${Math.max(minLeft, Math.min(rect.left - 24, maxRight - width))}px`;
    const below = rect.bottom + 6;
    const height = card.offsetHeight;
    card.style.top =
      below + height > win.innerHeight - 8 ? `${Math.max(8, rect.top - height - 6)}px` : `${below}px`;
  };

  return {
    attach(target, data) {
      target.addEventListener("mouseenter", () => show(target, data));
      target.addEventListener("mouseleave", scheduleHide);
      target.addEventListener("focus", () => show(target, data));
    },
    hide() {
      cancelHide();
      card.hidden = true;
    },
  };
}

// ---------------------------------------------------------------------------
// Answer body

export interface RenderOptions {
  /**
   * The same answer rendered a moment ago (streaming): its blocks whose
   * Markdown hasn't changed are moved over as they are, so finished text
   * never flickers and keeps hover state
   */
  previous?: HTMLElement | null;
  /** Still arriving: a table not yet past its header row stays hidden */
  streaming?: boolean;
}

export function renderAnswer(
  doc: Document,
  kdoc: KonnashDocument,
  text: string,
  actions: AnswerActions,
  card: HoverCard,
  options: RenderOptions = {},
) {
  const container = el(doc, "div", "konnash-answer");
  const numberer = createCitationNumberer(kdoc);
  let blocks = parseAnswer(text);
  if (options.streaming) {
    // "| a | b |" before its "|---|" line would show as raw pipes
    const last = blocks[blocks.length - 1];
    if (last?.kind === "paragraph" && /^\s*\|/.test(last.source)) blocks = blocks.slice(0, -1);
  }
  const old = options.previous ? ([...options.previous.children] as HTMLElement[]) : [];
  let reusing = true;
  blocks.forEach((block, i) => {
    const prior = old[i];
    // The last block may still be growing; earlier unchanged ones are final
    if (reusing && prior && prior.dataset.src === block.source && i < blocks.length - 1) {
      numberBlock(block, numberer);
      container.append(prior);
      return;
    }
    reusing = false;
    const node = renderBlock(doc, block, { numberer, card, actions });
    node.dataset.src = block.source;
    container.append(node);
  });
  return container;
}

interface InlineContext {
  numberer: ReturnType<typeof createCitationNumberer>;
  card: HoverCard;
  actions: AnswerActions;
}

/** Numbers a reused block's citations, so later ones keep counting from them */
function numberBlock(block: AnswerBlock, numberer: ReturnType<typeof createCitationNumberer>) {
  const texts: InlineText[] =
    block.kind === "paragraph" || block.kind === "heading"
      ? [block.sentences]
      : block.kind === "table"
        ? [...block.head, ...block.rows.flat()]
        : [];
  for (const text of texts) {
    for (const sentence of text) {
      for (const token of sentence.tokens) if (token.type === "cite" && !token.general) numberer.number(token.spec);
    }
  }
  if (block.kind === "list") block.items.forEach((item) => item.forEach((b) => numberBlock(b, numberer)));
  if (block.kind === "quote") block.blocks.forEach((b) => numberBlock(b, numberer));
}

function appendInline(doc: Document, parent: HTMLElement, sentences: InlineText, ctx: InlineContext) {
  sentences.forEach((sentence, i) => {
    const sentenceEl = el(doc, "span", sentence.uncited ? "konnash-uncited" : undefined);
    appendTokens(doc, sentenceEl, sentence.tokens, ctx.numberer, ctx.card, ctx.actions, sentenceWords(sentence));
    if (i > 0) parent.append(doc.createTextNode(" "));
    parent.append(sentenceEl);
  });
}

function renderBlock(doc: Document, block: AnswerBlock, ctx: InlineContext): HTMLElement {
  switch (block.kind) {
    case "paragraph": {
      const p = el(doc, "p", "konnash-a-p");
      appendInline(doc, p, block.sentences, ctx);
      if (!block.pointer) return p;
      // "Read closely": where to go next in the text, set apart
      const box = el(doc, "div", "konnash-pointer");
      box.append(p);
      return box;
    }
    case "heading": {
      const h = el(doc, "div", "konnash-a-heading");
      h.dataset.level = String(Math.min(4, Math.max(1, block.level)));
      appendInline(doc, h, block.sentences, ctx);
      return h;
    }
    case "list": {
      const list = el(doc, block.ordered ? "ol" : "ul", "konnash-a-list");
      if (block.ordered && block.start !== 1) (list as HTMLOListElement).start = block.start;
      for (const item of block.items) {
        const li = el(doc, "li", "konnash-a-item");
        // A tight item is one paragraph: its text sits in the item itself
        if (item.length === 1 && item[0].kind === "paragraph" && !item[0].pointer) appendInline(doc, li, item[0].sentences, ctx);
        else for (const child of item) li.append(renderBlock(doc, child, ctx));
        list.append(li);
      }
      return list;
    }
    case "quote": {
      const quote = el(doc, "blockquote", "konnash-a-quote");
      for (const child of block.blocks) quote.append(renderBlock(doc, child, ctx));
      return quote;
    }
    case "table": {
      // Wide tables scroll inside their own frame, never the pane
      const wrap = el(doc, "div", "konnash-a-table-wrap");
      const table = el(doc, "table", "konnash-a-table");
      table.style.setProperty("--cols", String(Math.max(block.head.length, ...block.rows.map((r) => r.length), 1)));
      const cell = (tag: "th" | "td", text: InlineText, col: number) => {
        const c = el(doc, tag);
        if (block.align[col] === "center") c.classList.add("konnash-center");
        appendInline(doc, c, text, ctx);
        return c;
      };
      if (block.head.length) {
        const thead = el(doc, "thead");
        const tr = el(doc, "tr");
        block.head.forEach((h, col) => tr.append(cell("th", h, col)));
        thead.append(tr);
        table.append(thead);
      }
      const tbody = el(doc, "tbody");
      for (const row of block.rows) {
        const tr = el(doc, "tr");
        row.forEach((d, col) => tr.append(cell("td", d, col)));
        tbody.append(tr);
      }
      table.append(tbody);
      wrap.append(table);
      return wrap;
    }
    case "code": {
      const pre = el(doc, "pre", "konnash-a-code");
      pre.dir = "ltr";
      pre.append(el(doc, "code", undefined, block.text));
      return pre;
    }
    case "rule":
      return el(doc, "hr", "konnash-a-rule");
  }
}

function appendTokens(
  doc: Document,
  parent: HTMLElement,
  tokens: AnswerToken[],
  numberer: ReturnType<typeof createCitationNumberer>,
  card: HoverCard,
  actions: AnswerActions,
  claim: string,
) {
  let prevWasCite = false;
  for (const token of tokens) {
    if (token.type === "text") {
      // Drop the space a model leaves before a citation: "claim [S1]." → "claim¹."
      let text = token.text;
      prevWasCite = false;
      if (!text) continue;
      const next = tokens[tokens.indexOf(token) + 1];
      if (next?.type === "cite" && !next.inline) text = text.replace(/\s+$/, "");
      let node: Node = doc.createTextNode(text);
      if (token.code) {
        const code = el(doc, "code");
        code.append(node);
        node = code;
      }
      if (token.italic) {
        const em = el(doc, "em");
        em.append(node);
        node = em;
      }
      if (token.bold) {
        const strong = el(doc, "strong");
        strong.append(node);
        node = strong;
      }
      parent.append(node);
      continue;
    }

    if (token.general) {
      const sup = el(doc, "sup", "konnash-cite konnash-cite-general", GENERAL_MARK);
      sup.title = "Background knowledge, not from this document";
      if (prevWasCite) parent.append(el(doc, "sup", "konnash-cite-sep", ","));
      parent.append(sup);
      prevWasCite = true;
      continue;
    }

    // A bare id ("paragraph P23"): the model's own words, as a link to the place
    if (token.inline) {
      prevWasCite = false;
      const span = numberer.number(token.spec).items[0]?.span;
      if (!span) {
        parent.append(doc.createTextNode(token.inline));
        continue;
      }
      const ref = el(doc, "span", "konnash-ref", token.inline);
      ref.tabIndex = 0;
      ref.dir = "ltr";
      ref.dataset.span = span.label;
      card.attach(ref, { span, claim });
      ref.addEventListener("click", () => {
        card.hide();
        actions.showSpan(span);
      });
      parent.append(ref);
      continue;
    }

    const { items, errors } = numberer.number(token.spec);
    for (const { n, span } of items) {
      if (prevWasCite) parent.append(el(doc, "sup", "konnash-cite-sep", ","));
      const sup = el(doc, "sup", "konnash-cite", String(n));
      sup.tabIndex = 0;
      sup.dataset.span = span.label;
      card.attach(sup, { span, claim });
      sup.addEventListener("click", () => {
        // The panel lives in a shadow root: look within it, not the document
        (sup.getRootNode() as unknown as ParentNode)
          .querySelectorAll(".konnash-cite-active")
          .forEach((c: Element) => c.classList.remove("konnash-cite-active"));
        sup.classList.add("konnash-cite-active");
        card.hide();
        actions.showSpan(span);
      });
      parent.append(sup);
      prevWasCite = true;
    }
    for (const error of errors) {
      if (prevWasCite) parent.append(el(doc, "sup", "konnash-cite-sep", ","));
      const bad = el(doc, "sup", "konnash-cite konnash-cite-invalid", "?");
      bad.title = `Invalid citation: ${error}`;
      parent.append(bad);
      prevWasCite = true;
    }
  }
}

// ---------------------------------------------------------------------------
// Footer

export function renderFooter(
  doc: Document,
  answerEl: HTMLElement,
  check: CitationCheck,
  meta: string[],
) {
  const footer = el(doc, "div", "konnash-a-footer");
  const parts: (string | HTMLElement)[] = [];
  if (check.uncited) {
    const toggle = el(
      doc,
      "button",
      "konnash-link-quiet",
      `${check.uncited} statement${check.uncited === 1 ? "" : "s"} without citation`,
    );
    toggle.title = "Show which statements are not linked to the document";
    toggle.addEventListener("click", () => answerEl.classList.toggle("konnash-show-uncited"));
    parts.push(toggle);
  } else if (check.valid) {
    parts.push("All statements cited");
  }
  if (check.invalid.length) parts.push(`${check.invalid.length} invalid citation${check.invalid.length === 1 ? "" : "s"}`);
  parts.push(...meta);
  parts.forEach((part, i) => {
    if (i > 0) footer.append(doc.createTextNode(" · "));
    footer.append(part);
  });
  return footer;
}

// ---------------------------------------------------------------------------
// The model's reasoning: live while it thinks, then a quiet disclosure

function formatDuration(ms?: number) {
  if (!ms || ms < 1000) return "a moment";
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

const THINKING_NOTE =
  "A summary the model writes of its reasoning. It shows how the model approached the question, but it is not a complete record of how the answer was computed.";

/** An id of this document in the model's words: S12, S3–S5, P4 (not inside a word or number) */
const PLACE_ID_RE = /(?<![A-Za-z0-9])[SP]\d+(?:\s*[-–—]\s*[SP]?\d+)?(?![0-9])/g;

export interface PlaceLinks {
  kdoc: KonnashDocument;
  card: HoverCard;
  actions: AnswerActions;
}

/**
 * Text in which the places the model names (S13, S281–S286, P4) are links
 * to them, as they were written: no numbers, nothing counted as a citation.
 * Hovering shows the passage, clicking shows it in the PDF.
 */
function appendWithPlaceLinks(doc: Document, parent: HTMLElement, text: string, links: PlaceLinks) {
  let last = 0;
  for (const match of text.matchAll(PLACE_ID_RE)) {
    const { spans, errors } = parseCitation(links.kdoc, match[0]);
    if (spans.length !== 1 || errors.length) continue;
    const span = spans[0];
    parent.append(doc.createTextNode(text.slice(last, match.index)));
    const ref = el(doc, "span", "konnash-ref", match[0]);
    ref.tabIndex = 0;
    ref.dir = "ltr";
    ref.dataset.span = span.label;
    links.card.attach(ref, { span, claim: "" });
    ref.addEventListener("click", () => {
      links.card.hide();
      links.actions.showSpan(span);
    });
    parent.append(ref);
    last = match.index! + match[0].length;
  }
  parent.append(doc.createTextNode(text.slice(last)));
}

export function renderThinking(
  doc: Document,
  thinking: string | undefined,
  thinkingMs: number | undefined,
  live: boolean,
  /** Once the reasoning is finished, the places it names become links */
  links?: PlaceLinks,
) {
  if (live) {
    const box = el(doc, "div", "konnash-think-live");
    box.append(el(doc, "div", "konnash-thinking", "Thinking"));
    if (thinking) {
      const tail = thinking.length > 360 ? `…${thinking.slice(-360)}` : thinking;
      box.append(el(doc, "div", "konnash-think-tail", tail));
    }
    box.title = THINKING_NOTE;
    return box;
  }
  if (!thinking) return null;
  const details = el(doc, "details", "konnash-think");
  const summary = el(doc, "summary", "konnash-think-summary", `Thought for ${formatDuration(thinkingMs)}`);
  summary.title = THINKING_NOTE;
  const body = el(doc, "div", "konnash-think-body");
  for (const para of thinking.split(/\n{2,}/)) {
    if (!para.trim()) continue;
    const p = el(doc, "p");
    if (links) appendWithPlaceLinks(doc, p, para.trim(), links);
    else p.textContent = para.trim();
    body.append(p);
  }
  details.append(summary, body);
  return details;
}

// ---------------------------------------------------------------------------
// Context line: what the model was given, and why (only when not everything)

function scoreDots(score: number) {
  // Score 0: included without ranking (e.g. the abstract, for orientation)
  if (score <= 0) return "—";
  const n = Math.min(3, Math.round(score));
  return "●".repeat(n) + "○".repeat(3 - n);
}

export function renderContextLine(
  doc: Document,
  routing: Routing | undefined,
  onShowSection: (sectionID: string) => void,
) {
  if (!routing) return null;
  if (routing.mode === "full") {
    if (!routing.global) return null;
    const line = el(doc, "div", "konnash-context konnash-context-plain", "◎ This question is about the whole document, so all of it was used.");
    if (routing.helperModel) line.title = `Decided by ${routing.helperModel}${routing.ms ? ` in ${formatDuration(routing.ms)}` : ""}`;
    return line;
  }
  const sections = routing.sections || [];
  const details = el(doc, "details", "konnash-context");
  let summaryText: string;
  let explanation: string;
  if (routing.mode === "rules") {
    const where = sections.length
      ? sections.map((s) => `${s.title}${s.pages ? ` (${s.pages})` : ""}`).join(", ")
      : routing.intent === "outline"
        ? "the section headings"
        : "the first page";
    summaryText = `Answered from ${where}`;
    explanation = `A question about ${describeIntent(routing.intent)}, so only ${sections.length > 1 ? "these parts" : "this part"} of the document was sent: faster and cheaper, with the same grounding.`;
  } else {
    const n = sections.length;
    summaryText =
      routing.mode === "focus"
        ? `◎ Focused on ${n} of ${routing.totalSections || n} sections`
        : `Large document · answered from ${n} of ${routing.totalSections || n} sections`;
    explanation =
      routing.mode === "focus"
        ? "Focus ranked the sections for this question; the answer was written from these:"
        : "The document is too long to send whole, so the sections most relevant to the question were chosen:";
  }
  details.append(el(doc, "summary", "konnash-context-summary", summaryText));
  const body = el(doc, "div", "konnash-context-body");
  body.append(el(doc, "div", "konnash-context-why", explanation));
  for (const s of sections) {
    const row = el(doc, "div", "konnash-context-row");
    row.title = "Show this section in the PDF";
    if (routing.mode !== "rules") row.append(el(doc, "span", "konnash-context-score", scoreDots(s.score)));
    const text = el(doc, "span", "konnash-context-text");
    // Titles and reasons may be in another language: isolate each one
    // A section without a heading carries Konnash's description, set apart
    const titleEl = el(doc, "span", `konnash-context-title${s.untitled ? " k-untitled" : ""}`, s.title);
    setAutoDir(titleEl);
    text.append(titleEl);
    if (s.pages) text.append(el(doc, "span", "konnash-context-pages", ` · ${s.pages}`));
    if (s.reason) {
      text.append(el(doc, "span", "konnash-context-pages", " · "));
      const reason = el(doc, "span", "konnash-context-reason", s.reason);
      setAutoDir(reason);
      text.append(reason);
    }
    row.append(text);
    row.addEventListener("click", () => onShowSection(s.id));
    body.append(row);
  }
  const foot: string[] = [];
  if (routing.mode !== "rules") {
    if (routing.helperModel) {
      foot.push(routing.ms ? `Ranked by ${routing.helperModel} in ${formatDuration(routing.ms)}` : "Ranking reused from the same question earlier");
    }
    const left = (routing.totalSections || 0) - sections.length;
    if (left > 0) foot.push(`${left} section${left === 1 ? "" : "s"} not included`);
  }
  if (foot.length) body.append(el(doc, "div", "konnash-context-foot", foot.join(" · ")));
  details.append(body);
  return details;
}
