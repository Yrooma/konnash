// Offline end-to-end test of Konnash's logic against a real Zotero SDT pack:
// answer parsing/checking, structure and routing, Explain anchors, storage,
// model lists, and both provider adapters against local mock servers
// (no real API calls, no cost).
//
// Usage: node scripts/test-ai.cjs <structured-document-text.js> <bundle.cjs> <.zotero-sdt-cache>
const fs = require("fs");
const zlib = require("zlib");
const http = require("http");

globalThis._globalThis = globalThis;
globalThis.Zotero = { getMainWindow: () => globalThis, Prefs: { get: () => undefined } };
globalThis.ztoolkit = { log() {} };

const sdt = require(process.argv[2]);
const K = require(process.argv[3]);

function assert(cond, message) {
  if (!cond) {
    console.error("FAIL", message);
    process.exitCode = 1;
  } else {
    console.log("ok  ", message);
  }
}

function sse(res, type, data) {
  res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
}

(async () => {
  const pack = await sdt.openStructuredDocumentTextPack(
    new Uint8Array(fs.readFileSync(process.argv[4])),
    { inflate: (b) => zlib.inflateRawSync(b) },
  );
  const doc = K.buildDocument(1, await pack.materialize());
  const id = (i) => doc.sentences[i].id;

  // 1. Answer parsing and checking ------------------------------------------------
  const answer = [
    "## Findings",
    "The review covered many studies. [S21] It found growth [S22–S24, S30].",
    "- Paragraph level evidence [P7].",
    "- Bad id here [S99999].",
    "This is a long statement without any citation that should be flagged here.",
    "AI is widely used in schools [general].",
    "What does it say about tutors?",
  ].join("\n");
  const check = K.checkAnswer(doc, answer);
  assert(check.valid === 4 && check.invalid.length === 1 && check.uncited === 1 && check.general === 1, "check: 4 valid, 1 invalid, 1 uncited, 1 general");
  const md = K.parseAnswer("**The theoretical idea. ** It integrates TAM [S5–S6]. Then *method:* `survey` [S9].");
  const tokens = md[0].sentences.flatMap((s) => s.tokens);
  assert(tokens[0].bold && tokens[0].text === "The theoretical idea." && !tokens.some((t) => t.type === "text" && t.text.includes("*")), "markdown across sentences");
  const numberer = K.createCitationNumberer(doc);
  numberer.number("S21");
  assert(numberer.number("S22–S24, S21").items.map((x) => x.n).join(",") === "2,1", "citation numbering reuses numbers");

  // Bare ids ("paragraph P23") become links only where nothing else is meant
  const inlineSpecs = (text) =>
    K.answerSentences(text).flatMap((s) => s.tokens).filter((t) => t.type === "cite" && t.inline).map((t) => t.spec);
  assert(inlineSpecs("Read closely: P23 in full, then the discussion in P40.").join() === "P23,P40", "bare ids: a Read closely line links them");
  assert(inlineSpecs("**قرأ عن قرب:** الفقرة P23 كاملة، ثم مناقشة الاستدلال من السلوك في P40.").join() === "P23,P40", "bare ids: Arabic pointer line");
  assert(inlineSpecs("انظر الفقرتين P3 وP4 لفهم الحجة كاملة كما يعرضها المؤلفان.").join() === "P3,P4", "bare ids: after a place word, and the id listed next to it");
  assert(inlineSpecs("See paragraphs P3–P5 and S40 for the method in full detail here.").join() === "P3–P5,S40", "bare ids: ranges and lists");
  assert(inlineSpecs("Participant P1 said the tool helped a lot across all of their courses.").length === 0, "bare ids: a participant label stays text");
  assert(inlineSpecs("The answer is in [P4] and P5 of the discussion section of the paper.").join() === "P5", "bare ids: listed right after a bracketed citation");
  const bareCheck = K.checkAnswer(doc, "Read closely: P23 in full, then P40.\nSee paragraph P99999 for every detail of the method that the authors used.");
  assert(bareCheck.invalid.length === 0 && bareCheck.valid === 2 && bareCheck.uncited === 1, "bare ids: real ones count as citations, a missing one is words (and the statement uncited)");
  assert(K.checkAnswer(doc, "Participant P1 described the tool as helpful in every single course.").uncited === 1, "bare ids: unlinked statement stays uncited");
  const bareNote = K.buildNoteHTML(doc, { title: "T", updated: 0, messages: [{ role: "user", text: "Q" }, { role: "assistant", text: "Read closely: P23 in full." }] }, { title: "D", openURL: () => "x" });
  assert(/P23<sup>1<\/sup>/.test(bareNote), "bare ids: notes keep the words and number them");
  assert(K.getSystemPrompt("protocol").includes("Never write an id without brackets") && !K.getSystemPrompt("native").includes("Never write an id"), "prompt: ids in brackets, protocol mode only");

  // Answer blocks (markdown-it): tables, lists, quotes, code ----------------------
  const kinds = (text) => K.parseAnswer(text).map((b) => b.kind).join(",");
  const tableAnswer = [
    "Two factors decide how far a reader processes a message [S5].",
    "",
    "| Factor | What it means |",
    "|---|---|",
    "| **Motivation** | An intention to examine the message carefully and deliberately [S6]. |",
    "| Ability | The clarity of the message and how much the reader already knows about it. |",
  ].join("\n");
  const tb = K.parseAnswer(tableAnswer);
  assert(kinds(tableAnswer) === "paragraph,table" && tb[1].head.length === 2 && tb[1].rows.length === 2, "blocks: a table with its header and rows");
  const tableCheck = K.checkAnswer(doc, tableAnswer);
  assert(tableCheck.valid === 2 && tableCheck.uncited === 1, "blocks: citations inside table cells count; an uncited cell is marked, header cells never");
  assert(tb[1].rows[0][0][0].tokens[0].bold, "blocks: markdown inside a cell");
  const arTable = "| العامل | معناه |\n|---|---|\n| الدافعية | نية واعية ورغبة في فحص الرسالة بعناية [S5] |";
  assert(kinds(arTable) === "table" && K.answerSentences(arTable).some((s) => s.cited), "blocks: Arabic table");
  const listAnswer = "3. First step [S5].\n4. Second step\n   - a nested point [S6]\n\n> The authors write that it matters [S7].";
  const lb = K.parseAnswer(listAnswer);
  assert(kinds(listAnswer) === "list,quote" && lb[0].ordered && lb[0].start === 3 && lb[0].items[1].some((b) => b.kind === "list"), "blocks: numbered list from 3, nested list, quote");
  assert(kinds("[S12]: the claim stands here as written.") === "paragraph", "blocks: [S12]: … is not a link definition");
  assert(kinds("A line\n---") === "paragraph,rule", "blocks: --- under a line is a rule, not a heading");
  assert(kinds("    An indented line that cites [S5].") === "paragraph", "blocks: indentation is not code");
  assert(kinds("```\nconst x = 1;\n```") === "code", "blocks: fenced code");
  assert(K.parseAnswer("Some answer.\n\n**Read closely:** P23 in full.")[1].pointer === true, "blocks: Read closely line is a pointer");
  assert(inlineSpecs("**Read closely:** [P3] in full, then [P5–P6].").join() === "P3,P5–P6", "blocks: bracketed places in a Read closely line read as named links");
  assert(K.checkAnswer(doc, answer).uncited === 1, "blocks: the earlier answer checks the same");
  const richNote = K.buildNoteHTML(doc, { title: "T", updated: 0, messages: [{ role: "user", text: "Q" }, { role: "assistant", text: `${tableAnswer}\n\n${listAnswer}` }] }, { title: "D", openURL: () => "x" });
  assert(/<table>.*<th>Factor<\/th>/s.test(richNote) && /<ol start="3"/.test(richNote) && /<blockquote>/.test(richNote) && /<sup>2<\/sup>/.test(richNote), "notes: tables, numbered lists and quotes kept, citations numbered");
  const arHTML = K.answerHTML(arTable, K.createCitationNumberer(doc), { fallback: "ltr" });
  assert(/<table dir="rtl">/.test(arHTML), "notes: an Arabic table reads right-to-left");

  // Copying a selection: across answers, numbered as one piece ---------------------
  const E = (tag, classes, attrs, ...children) => ({ tag, classes, attrs: attrs || {}, children });
  const cite = (label, n) => E("sup", ["konnash-cite"], { "data-span": label }, String(n));
  const sep = () => E("sup", ["konnash-cite-sep"], {}, ",");
  const turn = (q, ...answer) =>
    E("div", ["k-turn"], {}, E("div", ["k-q"], {}, q), E("div", ["konnash-context"], {}, "Whole document"),
      E("div", ["k-a"], {}, E("details", ["konnash-think"], {}, E("summary", [], {}, "Thought"), E("div", ["konnash-think-body"], {}, "reasoning")),
        E("div", ["konnash-answer"], {}, ...answer),
        E("div", ["konnash-a-footer"], {}, "All statements cited · model"),
        E("div", ["konnash-a-tools"], {}, E("button", [], {}, "Copy"))));
  // Each answer numbers from 1: S22 is 2 in the first and 1 in the second
  const twoTurns = [
    turn("First question?", E("p", ["konnash-a-p"], {}, E("span", [], {}, "Growth was found", cite("S21", 1), sep(), cite("S22", 2), "."))),
    turn("Second question?", E("p", ["konnash-a-p"], {}, E("span", [], {}, "Tutors helped", cite("S22", 1), ".")), E("ul", ["konnash-a-list"], {}, E("li", [], {}, "A point ", E("strong", [], {}, "in bold"), cite("S30", 2)))),
  ];
  const clip = K.clipToNote(doc, twoTurns, () => "zotero://x");
  assert(clip && /<h2>First question\?<\/h2>/.test(clip.html) && /<h2>Second question\?<\/h2>/.test(clip.html), "clip: questions become headings");
  assert(/found<sup>1,2<\/sup>\./.test(clip.html) && /helped<sup>2<\/sup>\./.test(clip.html) && /<sup>3<\/sup>/.test(clip.html), "clip: renumbered across answers, the same place keeps one number, adjacent citations share one superscript");
  assert((clip.html.match(/<li value=/g) || []).length === 3 && /<a href="zotero:\/\/x">p\./.test(clip.html), "clip: one sources list for the whole selection, linked to its pages");
  assert(!/reasoning|Whole document|All statements|Copy|Thought/.test(clip.html + clip.text), "clip: reasoning, context line, footer and buttons left out");
  assert(/<ul><li>A point <strong>in bold<\/strong><sup>3<\/sup><\/li><\/ul>/.test(clip.html), "clip: lists and bold kept");
  assert(/found\[1,2\]\./.test(clip.text) && /- A point in bold\[3\]/.test(clip.text) && /\n\nSources\n1\. “/.test(clip.text), "clip: plain text keeps numbers and lists its sources");
  const words = K.clipToNote(doc, ["only some ", E("em", [], {}, "words")]);
  assert(words && words.html === "only some <em>words</em>" && words.text === "only some words", "clip: words from inside a paragraph stay inline, to paste into a sentence");
  const wordsCited = K.clipToNote(doc, ["a claim", cite("S21", 4)]);
  assert(wordsCited && /^<p>a claim<sup>1<\/sup><\/p>\n<p><strong>Sources/.test(wordsCited.html), "clip: inline words with a citation get their sources");
  const orphans = K.clipToNote(doc, [E("li", [], {}, "one"), E("li", [], {}, "two")]);
  const cells = K.clipToNote(doc, [E("td", [], {}, "a"), E("td", [], {}, "b")]);
  assert(orphans && orphans.html === "<ul><li>one</li><li>two</li></ul>" && cells && cells.html === "<table><tr><td>a</td><td>b</td></tr></table>" && cells.text === "a | b", "clip: list items and cells cut from their list or table get one back");
  const named = K.clipToNote(doc, [E("p", [], { dir: "rtl" }, "اقرأ ", E("span", ["konnash-ref"], { "data-span": "P23" }, "P23"), " كاملة")]);
  assert(named && /<p dir="rtl">اقرأ P23<sup>1<\/sup> كاملة<\/p>/.test(named.html), "clip: a named place keeps its words and gets a number; direction kept");
  const general = K.clipToNote(doc, [E("p", [], {}, "Widely used", E("sup", ["konnash-cite", "konnash-cite-general"], {}, "○"), ".")]);
  assert(general && /<sup title="Background knowledge[^"]*">○<\/sup>/.test(general.html) && !/Sources/.test(general.html), "clip: background knowledge keeps its mark, with no source");
  assert(K.clipToNote(doc, [E("div", ["konnash-a-tools"], {}, E("button", [], {}, "Copy"))]) === null, "clip: nothing readable selected gives nothing");

  // Effort: each provider's documented levels; "Default" sends nothing -----------------
  const lv = (id, model = "m") => K.effortLevels(K.getPreset(id), model).map((l) => l.value).join(",");
  assert(lv("deepseek") === "low,high,max" && lv("openai") === "low,medium,high" && lv("anthropic", "claude-opus-4-8") === "low,medium,high,xhigh,max", "effort: each provider's own levels");
  assert(lv("anthropic", "claude-haiku-4-5") === "" && lv("ollama") === "" && lv("lmstudio") === "" && lv("custom") === "", "effort: not offered where it isn't documented");
  assert(JSON.stringify(K.effortParams({ effort: "max", preset: K.getPreset("deepseek") })) === '{"reasoning_effort":"max"}' && JSON.stringify(K.effortParams({ effort: "high", preset: K.getPreset("openrouter") })) === '{"reasoning":{"effort":"high"}}' && JSON.stringify(K.effortParams({ effort: "", preset: K.getPreset("deepseek") })) === "{}", "effort: sent in each provider's shape, nothing for its default");

  // Highlight: a press on the passage keeps it, elsewhere clears it ------------------------
  const hl = { pageIndex: 3, rects: [[100, 200, 300, 220], [100, 180, 250, 198]], nextPageRects: [[100, 700, 200, 720]] };
  const at = (pageIndex, x, y) => ({ pageIndex, rects: [[x, y, x, y]] });
  assert(K.positionContains(hl, at(3, 150, 210)) && K.positionContains(hl, at(3, 101, 199)) && K.positionContains(hl, at(4, 150, 710)), "highlight: a press on its lines (or where it continues on the next page) is inside");
  assert(!K.positionContains(hl, at(3, 400, 210)) && !K.positionContains(hl, at(2, 150, 210)) && !K.positionContains(hl, at(3, 150, 300)) && !K.positionContains(null, at(3, 150, 210)), "highlight: elsewhere on the page, or another page, is outside");

  // Adding to a note ------------------------------------------------------------------
  assert(K.appendToNoteHTML('<div data-schema-version="9"><p>Mine</p></div>', "<p>Added</p>") === '<div data-schema-version="9"><p>Mine</p>\n<p>Added</p></div>', "note: added inside Zotero's note wrapper");
  assert(K.appendToNoteHTML("<p>Old</p>", "<p>Added</p>") === "<p>Old</p>\n<p>Added</p>" && K.appendToNoteHTML("", "<p>A</p>") === '<div data-schema-version="9"><p>A</p></div>', "note: older and empty notes");
  const passageTurn = K.turnNoteHTML(doc, { role: "user", text: "Explain", passage: K.toStoredRef(doc, { paragraph: 6 }) }, { role: "assistant", text: "It says so [S21]." }, () => "x");
  assert(/^<h2>Explain<\/h2>\n<blockquote[^>]*><p>“[^<]+” <em>\(P7/.test(passageTurn) && /so<sup>1<\/sup>\./.test(passageTurn) && /<strong>Sources/.test(passageTurn), "note: an answer keeps its question, the passage asked about, and its sources");
  const sourceNumbers = K.createCitationNumberer(doc);
  sourceNumbers.number("S21");
  assert(/^Sources\n1\. “.+”( \(p\. .+\))?$/.test(K.sourcesText(doc, sourceNumbers)), "note: sources as plain text");

  // 2. Native block mapping (whole document and subsets) ---------------------------
  const p7 = doc.paragraphs[6];
  const a = p7.sentences[0];
  const b = p7.sentences[p7.sentences.length - 1];
  assert(K.blockRangeToSpec(doc, a, b + 1) === "P7", "whole paragraph -> P7");
  const selection = [10, 11, 12, 40, 41];
  assert(K.blocksToSpecs(doc, selection, 0, 2).join() === `${id(10)}–${id(11)}`, "subset blocks map to global ids");
  assert(K.blocksToSpecs(doc, selection, 1, 5).join() === `${id(11)}–${id(12)},${id(40)}–${id(41)}`, "subset range across a gap splits into runs");

  // 3. Structure ---------------------------------------------------------------------
  const sections = K.getSections(doc);
  const roles = new Set(sections.map((s) => s.role));
  assert(["front-matter", "abstract", "methods", "references", "conclusion"].every((r) => roles.has(r)), "roles: front matter, abstract, methods, references, conclusion");
  assert(sections[0].start === 0 && sections[sections.length - 1].end === doc.paragraphs.length - 1, "sections cover the whole document");
  assert(/Abstract \[P\d+–P\d+\] \(p\./i.test(K.describeOutline(doc, true)), "outline with paragraph ranges and pages");
  // Headings are the document's own words; Konnash never names a section
  const docText = doc.paragraphs.map((p) => p.text).join("\n");
  assert(sections.every((s) => s.heading === null || docText.includes(s.heading) || doc.outline.some((o) => o.title === s.heading)), "every heading is the document's own: printed in its text or in its outline");
  const frontSection = sections.find((s) => s.role === "front-matter");
  assert(frontSection && frontSection.heading === null && K.sectionLabel(doc, frontSection).own && K.sectionForModel(doc, frontSection) === "the text before the first heading", "text before the first heading: a role, no heading, described by its place");
  const outlineLines = K.describeOutline(doc, true).split("\n");
  assert(outlineLines.length === sections.length && outlineLines.every((line, i) => line.trim().startsWith(sections[i].heading ?? K.NO_HEADING)), "outline names sections only by their printed headings, NO_HEADING otherwise");
  assert(/Front matter/i.test(docText) || !/Front matter/i.test(K.describeOutline(doc, true) + K.buildDocumentContext(doc, undefined, "protocol")), "no invented 'Front matter' reaches the model");
  // Zotero's cross-references: words in a sentence -> the paragraph they point to
  assert(doc.links.length > 50 && doc.links.every((l) => doc.sentences[l.sentence] && doc.paragraphs[l.paragraph] && doc.sentences[l.sentence].paragraph !== l.paragraph), `links: Zotero's cross-references, sentence -> another paragraph (${doc.links.length})`);
  const tableLink = doc.links.find((l) => /^Table 1\b/.test(doc.paragraphs[l.paragraph].text) && /Table 1/.test(doc.sentences[l.sentence].text));
  assert(tableLink && doc.paragraphs[tableLink.paragraph].kind === "caption", "links: 'Table 1' in the text -> its caption");
  assert(doc.links.some((l) => doc.paragraphs[l.paragraph].kind === "listitem" && /\(\d{4}\)/.test(doc.paragraphs[l.paragraph].text)), "links: an in-text citation -> its bibliography entry");
  const linkedPara = doc.paragraphs[doc.sentences[tableLink.sentence].paragraph];
  const captionID = doc.paragraphs[tableLink.paragraph].id;
  const lq = K.buildPassageQuestion(doc, { paragraph: linkedPara.index }, "Explain.", "protocol");
  assert(lq.includes("It points to these places in the document:") && lq.includes(`- ${captionID}, caption`) && lq.trim().endsWith("Explain."), "passage question: what it points to, with ids, before the instruction");
  const lqn = K.buildPassageQuestion(doc, { paragraph: linkedPara.index }, "Explain.", "native");
  assert(lqn.includes("It points to these places in the document:") && !lqn.includes(`- ${captionID}`) && /- caption, p\. /.test(lqn), "native passage question: what it points to, by kind and page, no ids");
  const cq = K.buildPassageQuestion(doc, { paragraph: tableLink.paragraph }, "x", "protocol");
  assert(cq.includes("The document points to it from:") && cq.includes(doc.sentences[tableLink.sentence].id), "passage question on a caption: where the text points to it");
  const grown = K.withLinkedParagraphs(doc, linkedPara.sentences, 3000);
  assert(grown.added > 0 && doc.paragraphs[tableLink.paragraph].sentences.every((i) => grown.selection.includes(i)), "a partial selection gains what it points to");
  assert(K.withLinkedParagraphs(doc, linkedPara.sentences, 0).added === 0, "no room, nothing added");
  const noLinks = { ...doc, links: [] };
  assert(!K.buildPassageQuestion(noLinks, { paragraph: linkedPara.index }, "x", "protocol").includes("points to") && K.withLinkedParagraphs(noLinks, linkedPara.sentences, 3000).added === 0, "without Zotero's links, everything works as before");

  // A PDF without structure: page chunks for routing, no names, no outline
  const flat = { ...doc, outline: [], paragraphs: doc.paragraphs.map((p) => ({ ...p, kind: p.kind === "heading" ? "paragraph" : p.kind })) };
  const chunks = K.getSections(flat);
  assert(chunks.length > 1 && chunks.every((s) => s.heading === null && s.role === null) && K.describeOutline(flat, true) === "" && /^the text on pp?\. /.test(K.sectionForModel(flat, chunks[0])) && /^Pages? /.test(K.sectionLabel(flat, chunks[0]).text), "no headings: page chunks without names, and no outline for the model");
  const info = { typeLabel: "Journal Article", title: "AI in HE", authors: ["Helen Crompton", "Diane Burke"], date: "2023", publication: "IJETHE", doi: "10.1/x" };
  const context = K.buildDocumentContext(doc, info, "native");
  assert(context.includes("Authors: Helen Crompton; Diane Burke") && context.includes("Type: Journal Article") && !/\[P\d+/.test(context), "native context: metadata, outline without ids");

  // Locate paragraph / sentences from a page position
  const target = doc.paragraphs.find((p) => p.kind === "paragraph" && p.sentences.length > 3 && !p.auxiliary);
  const s1 = target.sentences[1];
  const rects = K.getSentenceRects(doc, s1);
  const [pageIndex, sentenceRects] = [...rects.entries()][0];
  const r = sentenceRects[0];
  assert(K.locateParagraph(doc, { pageIndex, rects: [[r[0] + 1, r[1] + 1, r[0] + 3, r[3] - 1]] }) === target.index, "point inside a sentence -> its paragraph");
  const located = K.locateSentences(doc, { pageIndex, rects: sentenceRects.map((x) => [x[0] + 0.5, x[1] + 0.5, x[2] - 0.5, x[3] - 0.5]) });
  assert(located && located[0] <= s1 && located[1] >= s1 && located[1] - located[0] <= 2, `selection -> sentences (${located})`);

  // 4. Rules ---------------------------------------------------------------------------
  assert(K.matchIntent("Who are the authors?")?.name === "authors", "intent: authors");
  assert(K.matchIntent("What does the abstract say?")?.name === "abstract", "intent: abstract");
  assert(K.matchIntent("Which references does the paper cite most? What sources does it cite")?.name === "references", "intent: references");
  assert(K.matchIntent("How is the paper organized?")?.name === "outline", "intent: outline");
  for (const q of ["Give me an overview of this document.", "I want to understand this document well. Which sections should I read closely, in what order, and why?", "What year was the data collected?", "Summarise the paper"]) {
    assert(K.matchIntent(q) === null, `no rule for: ${q}`);
  }
  const authorsRoute = K.ruleRoute(doc, "Who are the authors?");
  const front = sections.find((s) => s.role === "front-matter");
  assert(authorsRoute && authorsRoute.selection.every((i) => doc.sentences[i].paragraph <= front.end), "authors -> front matter only");
  assert(K.estimateTokens(doc, authorsRoute.selection) < K.estimateTokens(doc) / 5, "routed payload much smaller than the paper");

  // 5. Storage v4, migration, trash, Notebook index ---------------------------
  const v1 = JSON.stringify({ version: 1, chats: [{ id: "c1", title: "Q", created: 1, updated: 2, messages: [{ role: "user", text: "Q", time: 1 }, { role: "assistant", text: "A [S21].", meta: ["m"], time: 2 }] }] });
  const fromV1 = K.parseDocFile(v1);
  assert(fromV1.version === 4 && fromV1.chats[0].messages[1].text === "A [S21]." && Array.isArray(fromV1.trash), "v1 chat file migrates to v4");
  const anchor = K.anchorFor(doc, target.index);
  const v2 = JSON.stringify({
    version: 2,
    chats: [],
    explanations: [{ id: "e1", anchor, sentences: [s1, s1], text: "Explained [S3].", meta: ["m"], created: 5 }],
    rankings: { q: { basis: "b", global: false, sectionIds: ["s3"], at: 1 } },
  });
  const fromV2 = K.parseDocFile(v2);
  const v2chat = fromV2.chats[0];
  assert(v2chat && v2chat.messages.length === 2 && v2chat.messages[0].label === "Explain" && v2chat.messages[0].passage.sentences[0] === s1 && v2chat.messages[1].text === "Explained [S3].", "v2 explanation -> conversation with a passage turn");
  assert(fromV2.rankings.q.sections[0].id === "s3", "v2 ranking ids kept");
  const v3 = JSON.stringify({
    version: 3,
    chats: [],
    passages: [{ id: "p1", anchor, turns: [
      { id: "t1", question: "Explain this passage…", label: "Explain", text: "First [S3].", thinking: "hmm", created: 10 },
      { id: "t2", question: "Why here?", text: "Because [S4].", created: 11 },
    ], created: 10, updated: 11 }],
    trash: [{ kind: "passage", deletedAt: 50, passage: { id: "p2", anchor, turns: [{ id: "t3", question: "Q", text: "A", created: 1 }] } }],
  });
  const fromV3 = K.parseDocFile(v3);
  const v3chat = fromV3.chats.find((c) => c.id === "p1");
  assert(v3chat && v3chat.messages.length === 4 && v3chat.messages.filter((m) => m.role === "user").every((m) => m.passage && m.passage.anchor.paragraph === target.index) && v3chat.messages[1].thinking === "hmm" && v3chat.title.startsWith("Passage · "), "v3 passage thread -> conversation, every turn keeps its passage");
  assert(fromV3.trash.length === 1 && fromV3.trash[0].chat.messages.length === 2, "v3 trashed passage -> trashed conversation");
  // Notebook: passages in reading order, section activity
  const nb = K.emptyDocFile();
  const later = doc.paragraphs.filter((p) => p.kind === "paragraph" && p.index > target.index + 10)[0];
  nb.chats.push({ id: "a", title: "A", created: 1, updated: 1, messages: [
    { role: "user", text: "Q later", passage: K.toStoredRef(doc, { paragraph: later.index }), time: 1 },
    { role: "assistant", text: "x", time: 1 },
    { role: "user", text: "Plain question", time: 2 },
    { role: "assistant", text: "y", time: 2 },
  ] });
  nb.chats.push({ id: "b", title: "B", created: 3, updated: 3, messages: [
    { role: "user", text: "Explain…", label: "Explain", passage: K.toStoredRef(doc, { paragraph: target.index }), time: 3 },
    { role: "assistant", text: "z", time: 3 },
  ] });
  const index = K.indexPassages(doc, nb);
  assert(index.length === 2 && index[0].ref.paragraph === target.index && index[0].asked === "Explain" && index[1].messageIndex === 0 && index[1].chatID === "a", "Notebook: passages listed in reading order with what was asked");
  const activity = K.sectionActivity(doc, nb);
  const targetSection = K.sectionOfParagraph(doc, target.index);
  assert((activity.get(targetSection.id) || 0) >= 1, "Notebook: section activity counts passage questions");
  const file3 = K.parseDocFile(v1);
  file3.chats[0].messages[1].routing = { mode: "focus", sections: [{ id: "s3", title: "Method", pages: "p. 3", score: 3, reason: "Describes the search" }], totalSections: 20, helperModel: "claude-haiku-5-5", ms: 900 };
  file3.chats[0].messages[1].thinking = "First I look at the method.";
  file3.chats[0].messages[1].thinkingMs = 4200;
  file3.chats[0].messages[0].passage = K.toStoredRef(doc, { paragraph: target.index, sentences: [s1, s1] });
  file3.chats[0].messages[0].label = "Explain";
  const round = K.parseDocFile(K.serializeDocFile(file3));
  const rm = round.chats[0].messages[1];
  assert(rm.routing.sections[0].reason === "Describes the search" && rm.routing.totalSections === 20 && rm.thinking.startsWith("First") && rm.thinkingMs === 4200, "v4 round trip keeps routing details and thinking");
  assert(round.chats[0].messages[0].passage.sentences[1] === s1 && round.chats[0].messages[0].label === "Explain", "v4 round trip keeps passage and label on the user turn");
  // Trash: move, restore, purge
  const chatToTrash = round.chats[0];
  K.trashChat(round, chatToTrash, 1000);
  assert(round.chats.length === 0 && round.trash.length === 1, "trash: conversation moved to trash");
  K.restoreFromTrash(round, round.trash[0]);
  assert(round.chats[0] === chatToTrash && round.trash.length === 0, "trash: restored");
  K.trashChat(round, chatToTrash, 1000);
  const afterRound = K.parseDocFile(K.serializeDocFile(round));
  assert(afterRound.trash[0].chat.title === "Q", "trash survives saving");
  assert(!K.purgeTrash(afterRound, 1000 + 29 * 86400000) && afterRound.trash.length === 1, "trash kept before 30 days");

  // Conversations from another computer: fingerprint and merge
  const basisNow = K.documentBasis(doc);
  const chatOf = (id, updated, text) => ({ id, title: text, created: 1, updated, messages: [{ role: "user", text, time: 1 }, { role: "assistant", text: "A [S1].", time: 2 }] });
  const here = K.emptyDocFile();
  here.chats.push(chatOf("a", 10, "kept here"), chatOf("b", 10, "older here"));
  here.trash.push({ kind: "chat", deletedAt: 5, chat: chatOf("c", 3, "deleted here") });
  here.sectionStats = { s1: 2 };
  const there = K.emptyDocFile();
  there.chats.push(chatOf("b", 20, "newer there"), chatOf("c", 4, "deleted here"), chatOf("d", 15, "only there"));
  there.sectionSummaries = { basis: basisNow, model: "m", at: 1, items: [] };
  there.sectionStats = { s1: 1, s2: 4 };
  assert(K.fileBasis(K.parseDocFile(K.serializeDocFile(there))) === basisNow && K.parseDocFile(JSON.stringify({ basis: "x", chats: [] })).basis === "x", "transfer: a file's fingerprint (saved, or from its summaries)");
  const merged = K.mergeDocFiles(here, there);
  assert(merged.added === 1 && merged.updated === 1, "transfer: one new conversation, one updated");
  assert(here.chats.map((c) => c.id).join() === "b,d,a" && here.chats[0].title === "newer there", "transfer: newer copy wins, newest first");
  assert(!here.chats.some((c) => c.id === "c") && here.trash.length === 1, "transfer: a conversation deleted here stays deleted");
  assert(here.sectionStats.s1 === 3 && here.sectionStats.s2 === 4 && here.sectionSummaries.basis === basisNow, "transfer: counts add up, summaries brought over");
  assert(K.mergeDocFiles(here, there).added === 0, "transfer: importing twice adds nothing");
  assert(K.purgeTrash(afterRound, 1000 + 31 * 86400000) && afterRound.trash.length === 0, "trash purged after 30 days");
  assert(K.parseDocFile("{nope").chats.length === 0, "corrupt file -> empty");
  assert(K.resolveAnchor(doc, { ...anchor, paragraph: anchor.paragraph + 5 }) === target.index, "anchor re-found after paragraph ids shift");
  assert(K.resolveAnchor(doc, { ...anchor, start: "text that is not in the document anywhere" }) === null, "missing passage -> null");

  // 6. Prompts and model lists --------------------------------------------------
  const passageQ = K.buildPassageQuestion(doc, { paragraph: target.index }, "Critique it please.", "protocol");
  const targetHeading = K.sectionOfParagraph(doc, target.index)?.heading;
  assert(passageQ.includes(`Paragraph ${target.id}`) && passageQ.includes(doc.sentences[target.sentences[0]].text.slice(0, 30)) && (targetHeading ? passageQ.includes(`section "${targetHeading}"`) : !/section "/.test(passageQ)) && passageQ.trim().endsWith("Critique it please."), "passage question: passage, id, section heading as printed, then the instruction");
  const frontParagraph = doc.paragraphs.find((p) => p.index <= frontSection.end && p.sentences.length);
  const frontQ = K.buildPassageQuestion(doc, { paragraph: frontParagraph.index }, "x", "native");
  assert(!/section "/.test(frontQ) && /p\. /.test(frontQ), "passage before the first heading: its page, no section name");
  const partQ = K.buildPassageQuestion(doc, { paragraph: target.index, sentences: [s1, s1] }, "x", "native");
  assert(partQ.includes("The passage") && !partQ.includes(`[${id(s1)}]`), "native passage question has no ids");
  const recommended = K.resolvePrompts("document", {});
  assert(recommended.length === 5 && recommended.every((p) => p.recommended), "prompts: recommended set by default");
  const edited = K.resolvePrompts("document", { document: { overview: { text: "My overview please" }, method: { hidden: true } }, custom: [{ id: "c1", label: "Mine", text: "Q?" }] });
  assert(edited.find((p) => p.id === "overview").text === "My overview please" && !edited.find((p) => p.id === "overview").recommended && !edited.some((p) => p.id === "method") && edited.at(-1).custom, "prompts: edits, hiding and custom prompts apply");
  assert(K.resolvePassageDefault({}).id === "explain" && K.resolvePassageDefault({ passageDefault: "simplify" }).label === "Simplify", "passage Enter default resolves");
  assert(K.resolvePrompts("passage", K.parseOverrides("{broken")).length === 4, "broken prompt prefs fall back to recommended");
  const allHidden = { document: { overview: { hidden: true }, findings: { hidden: true }, method: { hidden: true }, where: { hidden: true }, terms: { hidden: true } } };
  const listed = K.resolvePrompts("document", allHidden, true);
  assert(K.resolvePrompts("document", allHidden).length === 0 && listed.length === 5 && listed.every((p) => p.hidden), "hidden prompts stay listed (for Show) in Settings");
  const overviewPrompt = K.RECOMMENDED.document.find((p) => p.id === "overview").text;
  assert(/two to four sentences/.test(overviewPrompt) && /in its own order/.test(overviewPrompt) && /its own headings/.test(overviewPrompt), "overview recipe lives in the Overview suggestion and follows the document's own structure");
  for (const mode of ["native", "protocol"]) {
    const system = K.getSystemPrompt(mode);
    assert(!/overview|Specific questions|Questions about where/i.test(system), `${mode} prompt: no answer recipes in the core`);
    assert(/reader decides the form, length and focus/.test(system) && /grounding and citation rules hold whatever the form/.test(system), `${mode} prompt: the reader's instructions shape the answer, grounding still holds`);
    assert(!/Use only this document/.test(system) && /two sources, kept apart/.test(system) && /ends with \[general\]/.test(system) && /Never present general knowledge as what the document says/.test(system), `${mode} prompt: document and general knowledge both used, each marked`);
  }
  // No provider favoured: none chosen by default, none ranked above another
  assert(K.getPreset("").id === "" && /Choose an AI provider/.test(K.getSettingsProblem({ preset: K.getPreset(""), baseURL: "", model: "", helperModel: "", apiKey: "", effort: "medium", contextWindow: 1 })), "no provider until the reader chooses one");
  assert(K.PROVIDERS.every((p) => !/claude/i.test(p.label) && !("defaultModel" in p) && !("defaultHelperModel" in p)), "no provider comes with a suggested model");
  const hosted = K.PROVIDERS.filter((p) => p.tier !== "basic" && p.id !== "custom").map((p) => p.label);
  assert(hosted.join() === [...hosted].sort((x, y) => x.localeCompare(y)).join(), "hosted providers listed alphabetically");
  assert(Object.values(K.TIER_LABELS).every((t) => !/guaranteed|weak|best|recommended/i.test(t)), "citation methods described, not ranked");
  const generalNote = K.buildNoteHTML(doc, { title: "T", updated: 0, messages: [{ role: "user", text: "Q" }, { role: "assistant", text: "AI is widely used in schools [general]." }] }, { title: "D", openURL: () => "x" });
  assert(generalNote.includes(`${K.GENERAL_MARK}</sup>`) && !generalNote.includes("†") && K.GENERAL_MARK === "○", "background knowledge marked with an open circle, not a dagger");
  for (const p of [...K.RECOMMENDED.document]) {
    assert(K.matchIntent(p.text) === null, `suggestion "${p.label}" is not mistaken for a metadata question`);
  }
  const anthropicList = K.parseModelList({ data: [{ id: "claude-opus-5-5", display_name: "Claude Opus 5.5", max_input_tokens: 1000000 }] });
  const openaiList = K.parseModelList({ data: [{ id: "gpt-x", object: "model" }] });
  assert(anthropicList[0].contextWindow === 1000000 && anthropicList[0].name === "Claude Opus 5.5" && openaiList[0].id === "gpt-x", "model lists parsed (Anthropic and OpenAI shapes)");
  assert(K.parseJSONText('Sure:\n```json\n{"a":1}\n```').a === 1, "JSON parsed from fenced text");

  // 7. Mock servers -----------------------------------------------------------------
  const requests = { stream: [], helper: [], openai: [] };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      if (req.url.startsWith("/v1/messages")) {
        const json = JSON.parse(body);
        if (!json.stream) {
          // Helper calls: section summaries or ranking
          requests.helper.push(json);
          let payload;
          if (/index a document/.test(json.system)) {
            const ids = [...json.messages[0].content.matchAll(/<section id="(s\d+)"/g)].map((m) => m[1]);
            payload = { sections: ids.map((sid) => ({ id: sid, summary: `Summary of ${sid}`, terms: ["t"] })) };
          } else {
            const question = json.messages[0].content;
            const methods = sections.filter((s) => s.role === "methods").map((s) => ({ id: s.id, score: 3, reason: `How ${s.heading} was done` }));
            payload = { global: /overall/i.test(question), sections: methods };
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({
            id: "h1", type: "message", role: "assistant", model: json.model,
            content: [{ type: "text", text: JSON.stringify(payload) }],
            stop_reason: "end_turn", usage: { input_tokens: 10, output_tokens: 10 },
          }));
          return;
        }
        requests.stream.push({ headers: req.headers, body: json });
        res.writeHead(200, { "content-type": "text/event-stream" });
        const blockCount = json.messages[0].content[0].source.content.length;
        sse(res, "message_start", {
          message: { id: "m1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } },
        });
        // Reasoning summary first, then the cited answer
        sse(res, "content_block_start", { index: 0, content_block: { type: "thinking", thinking: "", signature: "" } });
        sse(res, "content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Looking at the method. " } });
        sse(res, "content_block_delta", { index: 0, delta: { type: "thinking_delta", thinking: "Then the results." } });
        sse(res, "content_block_delta", { index: 0, delta: { type: "signature_delta", signature: "sig" } });
        sse(res, "content_block_stop", { index: 0 });
        sse(res, "content_block_start", { index: 1, content_block: { type: "text", text: "" } });
        sse(res, "content_block_delta", { index: 1, delta: { type: "text_delta", text: "Claim" } });
        const cite = blockCount === doc.sentences.length ? [a, b + 1] : [0, Math.min(2, blockCount)];
        sse(res, "content_block_delta", {
          index: 1,
          delta: { type: "citations_delta", citation: { type: "content_block_location", cited_text: "…", document_index: 0, document_title: "T", start_block_index: cite[0], end_block_index: cite[1] } },
        });
        sse(res, "content_block_stop", { index: 1 });
        sse(res, "message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
        sse(res, "message_stop", {});
        res.end();
      } else if (req.url === "/v1/chat/completions") {
        requests.openai.push({ headers: req.headers, body: JSON.parse(body) });
        res.writeHead(200, { "content-type": "text/event-stream" });
        const model = JSON.parse(body).model;
        const deltas =
          model === "reasoner"
            ? [{ reasoning_content: "Think about growth. " }, { reasoning_content: "Check S22." }, { content: "Growth is reported [S22]." }]
            : model === "local-think"
              ? [{ content: "<think>Hmm, growth" }, { content: " in S22.</think>" }, { content: "\n\nGrowth is reported [S22]." }]
              : [{ content: "Growth is " }, { content: "reported [S2" }, { content: "2]. Also [S9999]." }];
        for (const delta of deltas) {
          res.write(`data: ${JSON.stringify({ model: "mock-1", choices: [{ delta }] })}\n\n`);
        }
        res.write("data: [DONE]\n\n");
        res.end();
      } else {
        res.writeHead(401);
        res.end('{"error":"bad key"}');
      }
    });
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const signal = () => new AbortController().signal;
  const settingsA = {
    preset: K.getPreset("anthropic"), baseURL: `http://127.0.0.1:${port}`,
    model: "claude-opus-5-5", helperModel: "claude-haiku-5-5", apiKey: "k", effort: "medium", contextWindow: 1000000,
  };

  // Whole document, native
  const liveThinking = [];
  const ra = await K.ask({ doc, title: "T", source: info, history: [{ role: "user", text: "q0" }, { role: "assistant", text: "earlier [S3]." }], question: "Q?", settings: settingsA, signal: signal(), onUpdate: () => {}, onThinking: (t) => liveThinking.push(t) });
  const main = requests.stream.at(-1);
  const documentBlock = main.body.messages[0].content[0];
  assert(documentBlock.source.content.length === doc.sentences.length && documentBlock.cache_control && documentBlock.citations.enabled, "native: whole document, cached, citations on");
  assert(documentBlock.context.includes("Authors: Helen Crompton"), "native: metadata in document context");
  assert(documentBlock.cache_control.ttl === "1h" && main.body.cache_control?.type === "ephemeral" && main.body.cache_control.ttl === "1h", "native: document cached for an hour, conversation cached too (same lifetime)");
  assert(JSON.stringify(main.body.messages).split('"cache_control"').length - 1 === 1, "native: one explicit mark (on the document); the conversation mark is automatic");
  assert(main.body.fallbacks === "default" && String(main.headers["anthropic-beta"]).includes("server-side-fallback-2026-07-01") && main.body.messages[1].content === "earlier.", "native: fallbacks, history without markers");
  assert(ra.text === "Claim [P7]", `native citations -> markers (${ra.text})`);
  assert(main.body.thinking && main.body.thinking.type === "adaptive" && main.body.thinking.display === "summarized", "native: adaptive thinking with summarized display requested");
  assert(liveThinking.at(-1) === "Looking at the method. Then the results." && ra.thinking === liveThinking.at(-1) && typeof ra.thinkingMs === "number", "native: reasoning streamed live and returned with duration");

  // Router: rules, full, focus, global, large
  const file = K.emptyDocFile();
  const rules = await K.decideRoute({ doc, question: "Who are the authors?", settings: settingsA, file, focus: false });
  assert(rules.routing.mode === "rules" && rules.selection.length < 40 && /first page|the text before the first heading/.test(rules.partialNote) && !/Front matter/.test(rules.partialNote), "router: metadata question -> rules, small payload, part described by its place");
  assert(rules.routing.intent === "authors" && rules.routing.sections[0].title === "Before the first heading" && rules.routing.sections[0].untitled === true && /^pp?\. /.test(rules.routing.sections[0].pages), "router: rules record intent and section with pages; an untitled part is marked as Konnash's label");  const full = await K.decideRoute({ doc, question: "Give me an overview of this document.", settings: settingsA, file, focus: false });
  assert(full.routing.mode === "full" && !full.selection, "router: broad question -> whole document");
  const helperBefore = requests.helper.length;
  const focused = await K.decideRoute({ doc, question: "How did they search the literature?", settings: settingsA, file, focus: true });
  const methodIds = sections.filter((s) => s.role === "methods").map((s) => s.id);
  const focusedIDs = focused.routing.sections.map((s) => s.id);
  assert(focused.routing.mode === "focus" && methodIds.every((sid) => focusedIDs.includes(sid)), "router: Focus -> ranked methods sections");
  const focusedSel = K.sentencesOfSections(doc, sections.filter((s) => focusedIDs.includes(s.id)));
  const focusedLinks = K.linkedFrom(doc, focusedSel, new Set(focusedSel.map((i) => doc.sentences[i].paragraph)));
  assert(focusedLinks.length && /plus the tables, figures, notes and references they point to/.test(focused.partialNote) && focused.selection.length > focusedSel.length, "router: Focus also sends what the chosen sections point to");
  const ranked = focused.routing.sections.find((s) => s.id === methodIds[0]);
  assert(ranked.score === 3 && /was done/.test(ranked.reason) && focused.routing.totalSections === sections.length && focused.routing.helperModel === "claude-haiku-5-5" && typeof focused.routing.ms === "number", "router: Focus records scores, reasons, totals, helper and time");
  assert(requests.helper.length - helperBefore === 2 && requests.helper[helperBefore].model === "claude-haiku-5-5" && requests.helper[helperBefore].output_config.format.type === "json_schema", "router: summaries + ranking on the helper model with structured output");
  assert(file.sectionSummaries && file.sectionSummaries.items.length === sections.length, "summaries cached in the doc file");
  const again = await K.decideRoute({ doc, question: "how did they search the literature", settings: settingsA, file, focus: true });
  assert(requests.helper.length - helperBefore === 2 && again.routing.mode === "focus" && again.routing.ms === undefined && again.routing.sections.find((s) => s.id === methodIds[0]).reason, "repeat question reuses cached ranking (with reasons, no time)");
  const helperPrompts = requests.helper.map((h) => JSON.stringify(h.messages)).join("");
  assert(helperPrompts && !/Front matter/.test(helperPrompts) && /the text before the first heading \[front-matter\]/.test(helperPrompts), "helper prompts: sections by printed heading or by place, never an invented name");
  const globalQ = await K.decideRoute({ doc, question: "What is the overall argument?", settings: settingsA, file, focus: true });
  assert(globalQ.routing.mode === "full" && globalQ.routing.global === true, "router: Focus on a whole-document question -> whole document, recorded as global");
  const large = await K.decideRoute({ doc, question: "What did they find about assessment?", settings: { ...settingsA, contextWindow: 20000 }, file, focus: false });
  assert(large.routing.mode === "large" && K.estimateTokens(doc, large.selection) <= 20000 * 0.7, "router: too-big document -> large, within budget");
  assert(Object.keys(file.sectionStats).length > 0, "section stats recorded");

  // Native with a subset selection
  const rs = await K.ask({ doc, title: "T", source: info, history: [], question: "Who are the authors?", settings: settingsA, signal: signal(), selection: rules.selection, partialNote: rules.partialNote, onUpdate: () => {} });
  const subsetReq = requests.stream.at(-1);
  assert(subsetReq.body.messages[0].content[0].source.content.length === rules.selection.length && subsetReq.body.system.includes("Only part of the document"), "native subset: only routed sentences + partial note");
  assert(rs.text === `Claim [${id(rules.selection[0])}–${id(rules.selection[1])}]`, `native subset citations map to global ids (${rs.text})`);

  // OpenAI-compatible, Konnash protocol
  const settingsO = { ...settingsA, preset: K.getPreset("openrouter"), baseURL: `http://127.0.0.1:${port}/v1`, model: "mock-1" };
  const ro = await K.ask({ doc, title: "T", source: info, history: [], question: "Q?", settings: settingsO, signal: signal(), onUpdate: () => {} });
  const sys = requests.openai.at(-1).body.messages[0].content;
  assert(sys.includes("[S1] ") && /Abstract \[P\d+–P\d+\]/.test(sys) && sys.includes("Authors: Helen Crompton"), "protocol: numbered text, outline with ids, metadata");
  assert(K.checkAnswer(doc, ro.text).invalid.length === 1, "protocol answer checked");
  await K.ask({ doc, title: "T", history: [], question: "Q?", settings: settingsO, signal: signal(), selection: rules.selection, onUpdate: () => {} });
  const subsetSys = requests.openai.at(-1).body.messages[0].content;
  assert(!subsetSys.includes(`[${doc.sentences[doc.sentences.length - 1].id}]`) && subsetSys.includes(`[${id(rules.selection[0])}]`), "protocol subset keeps original ids, omits the rest");

  // Reasoning from OpenAI-compatible providers
  const rr = await K.ask({ doc, title: "T", history: [], question: "Q?", settings: { ...settingsO, model: "reasoner" }, signal: signal(), onUpdate: () => {} });
  assert(rr.thinking === "Think about growth. Check S22." && rr.text === "Growth is reported [S22].", "protocol: reasoning_content -> thinking");
  const updates = [];
  const rt = await K.ask({ doc, title: "T", history: [], question: "Q?", settings: { ...settingsO, model: "local-think" }, signal: signal(), onUpdate: (t) => updates.push(t) });
  assert(rt.thinking === "Hmm, growth in S22." && rt.text === "Growth is reported [S22]." && !updates.some((u) => u.includes("<think>")), "protocol: <think> tags -> thinking, never shown as answer");
  const st = K.splitThinkTags("A <think>x</think>B <think>y");
  assert(st.answer === "A B " && st.thinking === "x\n\ny", "splitThinkTags handles several and unclosed tags");

  try {
    await K.ask({ doc, title: "T", history: [], question: "Q", settings: { ...settingsO, baseURL: `http://127.0.0.1:${port}/bad` }, signal: signal(), onUpdate: () => {} });
    assert(false, "401 should throw");
  } catch (e) {
    assert(/rejected the API key/.test(e.message), "401 -> friendly error");
  }
  server.close();
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
