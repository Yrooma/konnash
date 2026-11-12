/**
 * Decides what the main model receives for a question, and records why, so
 * the answer can show it in a quiet, collapsible context line.
 *
 * - Metadata questions (authors, abstract, table of contents, references,
 *   keywords, the authors' own summary): rule-based, no AI. Only the parts
 *   that answer them are sent, so these answers are fast and cheap.
 * - Everything else, broad questions included: the whole document.
 * - Focus (composer toggle) or a document too big for the model: the helper
 *   model ranks sections (with a short reason each) from a cached section
 *   map, and the top sections are sent within a budget. A question about the
 *   whole document still gets the whole document when it fits.
 */
import { getPageLabel, KonnashDocument } from "./document";
import {
  getSections,
  Role,
  Section,
  sectionForModel,
  sectionLabel,
  sectionsWithRole,
  sentencesOfSections,
} from "./structure";
import { estimateTokens, partialDocumentNote } from "./ai/prompt";
import { withLinkedParagraphs } from "./links";

/** Room for what a partial selection points to: at least this many tokens… */
const LINKED_MIN_TOKENS = 1500;
/** …or this share of the selection, whichever is more (within the budget) */
const LINKED_SHARE = 0.15;
import { askJSON } from "./ai/client";
import { AISettings } from "./ai/providers";
import { DocFile, Routing, RoutingSection, SectionSummary } from "./docStore";

export interface RouteDecision {
  routing: Routing;
  selection?: number[];
  partialNote?: string;
}

export function pagesLabel(doc: KonnashDocument, pages: [number, number]) {
  const [a, b] = pages;
  return a === b ? `p. ${getPageLabel(doc, a)}` : `pp. ${getPageLabel(doc, a)}–${getPageLabel(doc, b)}`;
}

function routingSection(doc: KonnashDocument, s: Section, score = 0, reason?: string): RoutingSection {
  const label = sectionLabel(doc, s);
  return { id: s.id, title: label.text, untitled: label.own || undefined, pages: pagesLabel(doc, s.pages), score, reason };
}

// ---------------------------------------------------------------------------
// Rules

interface Intent {
  name: string;
  /** Plain words for the context line: "A question about …" */
  about: string;
  pattern: RegExp;
  roles: Role[];
}

const INTENTS: Intent[] = [
  {
    name: "authors",
    about: "the authors or publication details",
    pattern:
      /\b(who (are|is|were|was) the authors?|who wrote|written by|authors?'?s? (names?|affiliations?|backgrounds?)|affiliations?|corresponding author|which (journal|university|institution|publisher)|(when|where) was (it|this|the (paper|article|book|chapter)) published|publication (year|date|venue)|doi)\b/i,
    roles: ["front-matter"],
  },
  { name: "abstract", about: "the abstract", pattern: /\babstract\b/i, roles: ["abstract"] },
  {
    name: "outline",
    about: "the document's structure",
    pattern:
      /\b(table of contents|toc|how is (it|this|the (paper|article|book|chapter|document)) (organi[sz]ed|structured)|what (are|is) the (sections|chapters|structure)|list (the|all) (sections|chapters|headings)|outline of (the|this))\b/i,
    roles: [],
  },
  {
    name: "references",
    about: "the references",
    pattern:
      /\b(reference list|bibliography|works cited|list of references|what (sources|references|works|studies|papers) (does|do) (it|this|the (paper|authors?|book|chapter)) cite|which (sources|references|works|studies|papers) (are|were) cited)\b/i,
    roles: ["references"],
  },
  { name: "keywords", about: "the keywords", pattern: /\bkey ?words\b/i, roles: ["keywords"] },
  {
    name: "own-summary",
    about: "the authors' own summary",
    pattern:
      /\b(highlights|key points|executive summary|(the )?authors'? (own )?(summary|conclusions?)|concluding (section|remarks)|chapter summary)\b/i,
    roles: ["summary", "abstract", "conclusion"],
  },
];

export function matchIntent(question: string): Intent | null {
  return INTENTS.find((intent) => intent.pattern.test(question)) || null;
}

export function describeIntent(name?: string) {
  return INTENTS.find((i) => i.name === name)?.about || "metadata";
}

/** Sentences a metadata question needs, or null when it isn't one */
export function ruleRoute(doc: KonnashDocument, question: string) {
  const intent = matchIntent(question);
  if (!intent) return null;
  let selection: number[] = [];
  let titles: string[] = [];
  let sections: RoutingSection[] = [];
  if (intent.name === "outline") {
    // Headings carry the structure; the outline itself is in the context
    selection = doc.paragraphs.filter((p) => p.kind === "heading").flatMap((p) => p.sentences);
    titles = ["the section headings"];
  } else {
    const found = intent.roles.flatMap((role) => sectionsWithRole(doc, role));
    if (found.length) {
      selection = sentencesOfSections(doc, found);
      titles = found.map((s) => sectionForModel(doc, s));
      sections = found.map((s) => routingSection(doc, s));
    } else if (intent.name === "authors") {
      // No front matter section: the first page holds title and authors
      selection = doc.sentences
        .filter((s) => doc.paragraphs[s.paragraph].charPos.find((c) => c)?.pageIndex === 0)
        .map((s) => s.index);
      titles = ["the first page"];
    }
  }
  if (!selection.length) return null;
  return { intent: intent.name, selection, titles, sections };
}

// ---------------------------------------------------------------------------
// Section summaries and ranking (helper model)

export function documentBasis(doc: KonnashDocument) {
  const first = doc.sentences[0]?.text.slice(0, 40) || "";
  const last = doc.sentences[doc.sentences.length - 1]?.text.slice(-40) || "";
  return `${doc.paragraphs.length}:${doc.sentences.length}:${first}|${last}`;
}

export function normaliseQuestion(question: string) {
  return question.toLowerCase().replace(/\s+/g, " ").replace(/[?.!\s]+$/, "").trim();
}

const SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          summary: { type: "string" },
          terms: { type: "array", items: { type: "string" } },
        },
        required: ["id", "summary", "terms"],
        additionalProperties: false,
      },
    },
  },
  required: ["sections"],
  additionalProperties: false,
};

const RANKING_SCHEMA = {
  type: "object",
  properties: {
    global: { type: "boolean" },
    sections: {
      type: "array",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          score: { type: "integer" },
          reason: { type: "string" },
        },
        required: ["id", "score", "reason"],
        additionalProperties: false,
      },
    },
  },
  required: ["global", "sections"],
  additionalProperties: false,
};

const MAX_SECTION_CHARS = 24000;
const BATCH_CHARS = 240000;

function sectionText(doc: KonnashDocument, s: Section) {
  const text = doc.paragraphs
    .slice(s.start, s.end + 1)
    .map((p) => p.text)
    .join("\n");
  return text.length > MAX_SECTION_CHARS
    ? `${text.slice(0, MAX_SECTION_CHARS - 2000)}\n[…]\n${text.slice(-2000)}`
    : text;
}

/** Section summaries, built once per document version and cached */
export async function ensureSummaries(
  doc: KonnashDocument,
  settings: AISettings,
  file: DocFile,
  signal?: AbortSignal,
): Promise<SectionSummary[]> {
  const basis = documentBasis(doc);
  if (file.sectionSummaries?.basis === basis) return file.sectionSummaries.items;
  const items: SectionSummary[] = [];
  let batch: string[] = [];
  let size = 0;
  const run = async () => {
    if (!batch.length) return;
    const result = await askJSON(
      settings,
      "You index a document so questions can be routed to the right sections. For each section give a factual summary of at most 25 words and up to 6 key terms. Use the section ids given.",
      batch.join("\n\n"),
      SUMMARY_SCHEMA,
      signal,
    );
    for (const s of result?.sections || []) {
      if (typeof s?.id === "string") {
        items.push({ id: s.id, summary: String(s.summary || ""), terms: Array.isArray(s.terms) ? s.terms.map(String) : [] });
      }
    }
    batch = [];
    size = 0;
  };
  for (const s of getSections(doc)) {
    const heading = s.heading ? ` heading="${s.heading.replace(/"/g, "'")}"` : "";
    const block = `<section id="${s.id}"${heading}>\n${sectionText(doc, s)}\n</section>`;
    if (size + block.length > BATCH_CHARS) await run();
    batch.push(block);
    size += block.length;
  }
  await run();
  file.sectionSummaries = { basis, model: settings.helperModel, at: Date.now(), items };
  return items;
}

export interface Ranking {
  global: boolean;
  scores: Map<string, { score: number; reason?: string }>;
  cached: boolean;
}

export async function rankSections(
  doc: KonnashDocument,
  question: string,
  settings: AISettings,
  file: DocFile,
  signal?: AbortSignal,
): Promise<Ranking> {
  const basis = documentBasis(doc);
  const key = normaliseQuestion(question);
  const cached = file.rankings[key];
  if (cached && cached.basis === basis) {
    return {
      global: cached.global,
      scores: new Map(cached.sections.map((s) => [s.id, { score: s.score, reason: s.reason }])),
      cached: true,
    };
  }
  const summaries = new Map((await ensureSummaries(doc, settings, file, signal)).map((s) => [s.id, s]));
  const lines = getSections(doc).map((s) => {
    const info = summaries.get(s.id);
    const role = s.role ? ` [${s.role}]` : "";
    const terms = info?.terms.length ? ` Terms: ${info.terms.join(", ")}.` : "";
    return `${s.id} | ${sectionForModel(doc, s)}${role} | ~${s.tokens} tokens | ${info?.summary || ""}${terms}`;
  });
  const result = await askJSON(
    settings,
    `You route a reader's question to the sections of one document that hold the answer.
Set "global" to true when the question concerns the document as a whole (overview, main argument, overall evaluation).
Score each relevant section: 3 = contains the answer, 2 = context needed to answer well, 1 = marginal. Leave out irrelevant sections.
Give each listed section a reason of at most 12 words saying what it contributes to this question.`,
    `Question: ${question}\n\nSections (id | heading as printed, or place when it has none [role] | size | summary):\n${lines.join("\n")}`,
    RANKING_SCHEMA,
    signal,
  );
  const scores = new Map<string, { score: number; reason?: string }>();
  for (const s of result?.sections || []) {
    if (typeof s?.id === "string" && Number(s.score) > 0) {
      scores.set(s.id, { score: Math.min(3, Number(s.score)), reason: typeof s.reason === "string" ? s.reason : undefined });
    }
  }
  const global = !!result?.global;
  file.rankings[key] = {
    basis,
    global,
    sections: [...scores.entries()].map(([id, v]) => ({ id, score: v.score, reason: v.reason })),
    at: Date.now(),
  };
  return { global, scores, cached: false };
}

/** Pick ranked sections within a token budget, best first, abstract kept */
export function pickSections(doc: KonnashDocument, scores: Map<string, { score: number }>, budget: number) {
  const sections = getSections(doc);
  const chosen: Section[] = [];
  let used = 0;
  const take = (s: Section) => {
    if (chosen.includes(s) || used + s.tokens > budget) return;
    chosen.push(s);
    used += s.tokens;
  };
  sectionsWithRole(doc, "abstract").forEach(take);
  for (const minScore of [3, 2]) {
    sections.filter((s) => (scores.get(s.id)?.score || 0) >= minScore).forEach(take);
  }
  return chosen.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Decision

export async function decideRoute(options: {
  doc: KonnashDocument;
  question: string;
  settings: AISettings;
  file: DocFile;
  focus: boolean;
  signal?: AbortSignal;
}): Promise<RouteDecision> {
  const { doc, question, settings, file, focus, signal } = options;
  const docTokens = estimateTokens(doc);
  // Leave room for the instructions, the conversation and the answer
  const budget = Math.max(4000, Math.floor(settings.contextWindow * 0.7) - 8000);
  const fits = docTokens <= budget;
  const totalSections = getSections(doc).length;

  if (fits && !focus) {
    const rule = ruleRoute(doc, question);
    if (rule) {
      const linked = withLinkedParagraphs(doc, rule.selection, LINKED_MIN_TOKENS);
      return {
        routing: { mode: "rules", intent: rule.intent, sections: rule.sections, totalSections },
        selection: linked.selection,
        partialNote: partialDocumentNote(rule.titles, linked.added > 0),
      };
    }
    return { routing: { mode: "full" } };
  }

  const started = Date.now();
  let ranking: Ranking;
  try {
    ranking = await rankSections(doc, question, settings, file, signal);
  } catch (e) {
    if (fits) return { routing: { mode: "full" } };
    throw e;
  }
  const ms = ranking.cached ? undefined : Date.now() - started;
  const helperModel = settings.helperModel;
  if (ranking.global && fits) {
    return { routing: { mode: "full", global: true, helperModel, ms, totalSections } };
  }

  const cap = fits ? Math.max(6000, Math.min(budget, Math.floor(docTokens * 0.5))) : budget;
  let chosen = pickSections(doc, ranking.scores, cap);
  if (!chosen.some((s) => (ranking.scores.get(s.id)?.score || 0) >= 2)) {
    if (fits) return { routing: { mode: "full", helperModel, ms, totalSections } };
    // Nothing ranked: fall back to the parts that frame any document
    const framing: Role[] = ["abstract", "summary", "introduction", "conclusion"];
    chosen = pickSections(
      doc,
      new Map(getSections(doc).filter((s) => s.role && framing.includes(s.role)).map((s) => [s.id, { score: 3 }])),
      budget,
    );
  }
  for (const s of chosen) file.sectionStats[s.id] = (file.sectionStats[s.id] || 0) + 1;
  // What the chosen sections point to (a table at the end, a footnote, the
  // works they cite), within a small share of the budget
  const selection = sentencesOfSections(doc, chosen);
  const used = estimateTokens(doc, selection);
  const linked = withLinkedParagraphs(
    doc,
    selection,
    Math.min(Math.max(LINKED_MIN_TOKENS, Math.floor(used * LINKED_SHARE)), Math.max(0, budget - used)),
  );
  return {
    routing: {
      mode: fits ? "focus" : "large",
      sections: chosen.map((s) => {
        const r = ranking.scores.get(s.id);
        return routingSection(doc, s, r?.score || 0, r?.reason || (s.role === "abstract" ? "Kept for orientation" : undefined));
      }),
      totalSections,
      helperModel,
      ms,
    },
    selection: linked.selection,
    partialNote: partialDocumentNote(chosen.map((s) => sectionForModel(doc, s)), linked.added > 0),
  };
}
