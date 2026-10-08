// ACCREU Assistant.
//
// A small open language model (BAAI bge-small-en-v1.5, served from this site
// and run in a Web Worker, see ai-model.js) turns questions into meaning
// vectors. They are matched against
//   * the catalog datasets, the ACCREU Zenodo community and the deliverables
//     list (embedded here, on first use), and
//   * about four thousand passages of the ACCREU deliverable reports
//     (pre-embedded by build_knowledge.py into catalog/knowledge/).
// The sources found go to the proxy (worker/), whose hosted model answers
// from them only, citing them; without the proxy the sources are quoted.
// Greetings, help, counts and "what is in D2.4" are answered directly.

import { loadEmbedder, QUERY_PREFIX } from "./ai-model.js";
import { loadSources, buildDocs, embedText, textKey } from "./knowledge.js";

const MAX_SOURCES = 4;
const MAX_PASSAGES = 3;

// The proxy (worker/) that holds the AI key and runs a free hosted language
// model. Set in agent-config.js. ?assistant=http://127.0.0.1:8787 overrides it
// for local testing only (localhost addresses, so a crafted link can't
// redirect the chat elsewhere).
const requestedProxy = new URLSearchParams(window.location.search).get("assistant") || "";
const ASSISTANT_URL = (
  /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/?$/.test(requestedProxy) ? requestedProxy : String(window.ACCREU_ASSISTANT_URL || "")
).replace(/\/+$/, "");

const els = {
  toggle: document.getElementById("agentToggle"),
  panel: document.getElementById("agentPanel"),
  close: document.getElementById("agentClose"),
  log: document.getElementById("agentLog"),
  form: document.getElementById("agentForm"),
  input: document.getElementById("agentInput"),
  progress: document.getElementById("agentProgress"),
  progressFill: document.getElementById("agentProgressFill"),
};

let knowledgePromise = null;
let lastQuestion = "";
let lastItems = []; // sources of the previous answer, for follow-ups
const history = []; // [{role, content}] sent to the model for context
let busy = false;

// ---------- panel ----------

function setOpen(open) {
  els.panel.hidden = !open;
  els.toggle.setAttribute("aria-expanded", String(open));
  if (open) {
    els.input.focus();
    warmUp();
  } else {
    els.toggle.focus();
  }
}

els.toggle.addEventListener("click", () => setOpen(els.panel.hidden));
els.close.addEventListener("click", () => setOpen(false));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !els.panel.hidden) setOpen(false);
});

els.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) {
    event.preventDefault();
    els.form.requestSubmit();
  }
});
els.input.addEventListener("input", () => {
  els.input.style.height = "auto";
  els.input.style.height = `${els.input.scrollHeight}px`;
});

els.log.addEventListener("click", (event) => {
  const chip = event.target.closest(".agent-suggestion");
  if (!chip || busy) return;
  els.input.value = chip.textContent;
  els.form.requestSubmit();
});

els.form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const question = els.input.value.trim();
  if (!question || busy) return;
  busy = true;
  els.form.querySelector("button").disabled = true;
  els.input.value = "";
  els.input.style.height = "auto";
  addMessage("user", question);
  // "Thinking" stays at the bottom of the chat until the answer is complete.
  const thinking = addMessage("assistant", "Thinking");
  thinking.classList.add("agent-msg-pending");
  thinking.setAttribute("role", "status");
  const dots = document.createElement("span");
  dots.className = "agent-dots";
  dots.setAttribute("aria-hidden", "true");
  dots.append(document.createElement("i"), document.createElement("i"), document.createElement("i"));
  thinking.append(dots);
  try {
    await answer(question);
  } catch (error) {
    addMessage("error", `Something went wrong: ${error.message || error}`);
  } finally {
    thinking.remove();
    lastQuestion = question;
    busy = false;
    els.form.querySelector("button").disabled = false;
    els.input.focus();
  }
});

// Load the model and indexes in the background once the page is idle, so the
// assistant is ready by the time it is opened. The model starts loading in
// its worker while the indexes download. The browser caches the files.
function warmUp() {
  loadEmbedder(onProgress).catch(() => {});
  return loadKnowledge()
    .then(embedDocs)
    .catch(() => {});
}
const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1000));
idle(() => warmUp(), { timeout: 3000 });

function onProgress(p) {
  if (p.status !== "progress" || !p.total || !p.file.endsWith(".onnx")) return;
  els.progress.hidden = p.loaded >= p.total;
  els.progressFill.style.width = `${Math.round((p.loaded / p.total) * 100)}%`;
}

// ---------- knowledge ----------

function loadKnowledge() {
  if (!knowledgePromise) {
    knowledgePromise = buildKnowledge().catch((error) => {
      knowledgePromise = null;
      throw error;
    });
  }
  return knowledgePromise;
}

async function buildKnowledge() {
  const [sources, reports, precomputed] = await Promise.all([loadSources(), loadReportIndex(), loadCatalogVectors()]);
  const docs = buildDocs(sources);
  return { manifest: sources.manifest, deliverables: sources.deliverables, reports, precomputed, ...buildIndex(docs) };
}

// Vectors of the catalog entries, pre-computed by build_knowledge.py, keyed by
// a fingerprint of each entry's text. Entries added or edited since are
// embedded on the visitor's device.
async function loadCatalogVectors() {
  try {
    const [meta, buffer] = await Promise.all([
      fetch("catalog/knowledge/catalog.json").then((r) => r.json()),
      fetch("catalog/knowledge/catalog.bin").then((r) => r.arrayBuffer()),
    ]);
    const all = new Float32Array(buffer);
    return new Map(meta.keys.map((key, i) => [key, all.subarray(i * meta.dims, (i + 1) * meta.dims)]));
  } catch (e) {
    return new Map();
  }
}

// Passages of the deliverable reports with their pre-computed int8 vectors.
async function loadReportIndex() {
  try {
    const [meta, buffer] = await Promise.all([
      fetch("catalog/knowledge/passages.json").then((r) => r.json()),
      fetch("catalog/knowledge/vectors.bin").then((r) => r.arrayBuffer()),
    ]);
    return { passages: meta.passages, dims: meta.dims, vectors: new Int8Array(buffer) };
  } catch (e) {
    return null; // index not built: the assistant still answers from the catalog
  }
}

function sentencesOf(text) {
  return String(text)
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z(])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 25);
}

// ---------- vectors ----------

async function embedDocs(knowledge) {
  if (knowledge.vectors) return knowledge.vectors;
  if (!knowledge.vectorsPromise) {
    knowledge.vectorsPromise = (async () => {
      const texts = knowledge.docs.map(embedText);
      const vectors = texts.map((t) => knowledge.precomputed.get(textKey(t)) || null);
      const missing = texts.map((_, i) => i).filter((i) => !vectors[i]);
      if (missing.length) {
        const embed = await loadEmbedder(onProgress);
        const batches = [];
        for (let i = 0; i < missing.length; i += 32) batches.push(embed(missing.slice(i, i + 32).map((j) => texts[j])));
        (await Promise.all(batches)).flat().forEach((v, k) => (vectors[missing[k]] = v));
      }
      knowledge.vectors = vectors;
      return vectors;
    })();
    knowledge.vectorsPromise.catch(() => (knowledge.vectorsPromise = null));
  }
  return knowledge.vectorsPromise;
}

function dot(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i] * b[i];
  return s;
}

function searchReports(reports, queryVector, onlyDeliverable) {
  if (!reports) return [];
  const { passages, dims, vectors } = reports;
  const scored = [];
  for (let i = 0; i < passages.length; i += 1) {
    if (onlyDeliverable && passages[i].d !== onlyDeliverable) continue;
    let s = 0;
    const offset = i * dims;
    for (let j = 0; j < dims; j += 1) s += queryVector[j] * vectors[offset + j];
    scored.push({ passage: passages[i], score: s / 127 });
  }
  scored.sort((a, b) => b.score - a.score);
  // One passage per report page keeps the quotes varied.
  const seen = new Set();
  const out = [];
  for (const s of scored) {
    const key = `${s.passage.d}:${s.passage.p}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= MAX_PASSAGES * 2) break;
  }
  return out;
}

// ---------- keyword search (BM25): blended in, and the fallback ----------

const STOP = new Set(
  "the and for with from that this which what where when who how are was were have has had into about over under there their them they your you can any all some does give show find tell me is in of on to a an by or be it at as do i we our please list say says said".split(" ")
);
const SYNONYMS = { slr: ["sea", "level", "rise"], heatwave: ["heat"], fire: ["wildfire"], wildfires: ["wildfire"], pollinator: ["pollination"], crops: ["crop"], labor: ["labour"] };

function tokenize(text) {
  const out = [];
  for (let word of String(text).toLowerCase().split(/[^a-z0-9.]+/)) {
    word = word.replace(/^\.+|\.+$/g, "");
    if (!word || STOP.has(word)) continue;
    if (/^d\d\.\d$/.test(word)) {
      out.push(word);
      continue;
    }
    for (const part of word.split(".")) {
      if (part.length < 2 || STOP.has(part)) continue;
      const stem = part.length > 4 ? part.replace(/(ies|es|s)$/, "") : part;
      out.push(stem, ...(SYNONYMS[part] || []));
    }
  }
  return out;
}

function buildIndex(docs) {
  const df = new Map();
  let totalLength = 0;
  for (const doc of docs) {
    doc.terms = new Map();
    const tokens = tokenize(`${doc.title} ${doc.title} ${doc.text}`);
    doc.length = tokens.length;
    totalLength += tokens.length;
    for (const t of tokens) doc.terms.set(t, (doc.terms.get(t) || 0) + 1);
    for (const t of doc.terms.keys()) df.set(t, (df.get(t) || 0) + 1);
  }
  return { docs, df, avgLength: totalLength / Math.max(docs.length, 1) };
}

function bm25(knowledge, query) {
  const terms = [...new Set(tokenize(query))];
  const N = knowledge.docs.length;
  return knowledge.docs.map((doc) => {
    let score = 0;
    for (const t of terms) {
      const tf = doc.terms.get(t);
      if (!tf) continue;
      const idf = Math.log(1 + (N - knowledge.df.get(t) + 0.5) / (knowledge.df.get(t) + 0.5));
      score += (idf * tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (doc.length / knowledge.avgLength)));
    }
    return score;
  });
}

// ---------- search ----------

// Everyday words mapped to the terms the ACCREU reports use, appended to the
// question before it is embedded.
const EXPANSIONS = [
  [/\b(older|elderly|old) (people|persons|adults|population)\b|\belderly\b|\bpensioners?\b/i, "people aged 65 and over, older adults, elderly"],
  [/\bkids?\b|\bchildren\b/i, "children, young people"],
  [/\bslr\b/i, "sea-level rise"],
  [/\bheat ?waves?\b/i, "extreme heat, high temperatures"],
  [/\bjobs?\b|\bworkers?\b/i, "labour productivity, employment"],
  [/\bmoney\b|\bcosts?\b|\bdamages?\b/i, "economic costs, damages, GDP"],
  [/\bfarm(s|ers|ing)?\b/i, "agriculture, crops"],
];

function expandQuery(query) {
  const extra = EXPANSIONS.filter(([re]) => re.test(query)).map(([, words]) => words);
  return extra.length ? `${query} (${extra.join("; ")})` : query;
}

// Thresholds measured on this catalog with bge-small: on-topic questions score
// >= 0.66 against the catalog (even one-word ones such as "hydropower"),
// off-topic ones ("pizza recipe", "stock prices") 0.45-0.62 with little or no
// keyword overlap. Report passages are judged with their own threshold.
const CATALOG_SURE = 0.65;
const PASSAGE_SURE = 0.7;

async function search(knowledge, query, onlyDeliverable) {
  const keyword = bm25(knowledge, query);
  const maxKeyword = Math.max(...keyword, 0);
  let semantic = null;
  let queryVector = null;
  try {
    const vectors = await embedDocs(knowledge);
    [queryVector] = await (await loadEmbedder(onProgress))([QUERY_PREFIX + expandQuery(query)]);
    semantic = vectors.map((v) => dot(queryVector, v));
  } catch (e) {
    console.warn("ACCREU assistant: model unavailable, using keyword search:", e);
  }

  const scored = knowledge.docs.map((doc, i) => {
    const kw = maxKeyword ? keyword[i] / maxKeyword : 0;
    const sem = semantic ? semantic[i] : 0;
    // Catalog datasets get a slight edge: they are what the page is about.
    const bonus = doc.kind === "dataset" ? 0.03 : 0;
    return { doc, kw: keyword[i], sem, score: semantic ? sem + 0.15 * kw + bonus : kw };
  });
  scored.sort((a, b) => b.score - a.score);
  const best = scored[0];
  const maxSem = Math.max(...scored.map((s) => s.sem));
  const catalogSure = semantic ? maxSem >= CATALOG_SURE || (maxSem >= 0.6 && maxKeyword >= 3) : maxKeyword > 0;
  // Short questions ("water") embed less sharply, so a strong keyword match
  // also qualifies a source.
  const picked = semantic
    ? scored.filter(
        (s) => (s.score >= best.score - 0.2 && s.sem >= 0.62) || (maxKeyword && s.kw >= 0.5 * maxKeyword && s.sem >= 0.55)
      )
    : scored.filter((s) => s.kw > 0 && s.score >= best.score * 0.35);

  const passages = queryVector ? searchReports(knowledge.reports, queryVector, onlyDeliverable) : [];
  const passageBest = passages.length ? passages[0].score : 0;
  // Within one named deliverable any close match counts; across all reports
  // a passage must be clearly on topic.
  const floor = onlyDeliverable ? passageBest - 0.05 : Math.max(PASSAGE_SURE - 0.04, passageBest - 0.05);
  const goodPassages = passages.filter((p) => p.score >= floor).slice(0, onlyDeliverable ? MAX_PASSAGES + 3 : MAX_PASSAGES);

  return {
    sources: catalogSure ? picked.slice(0, MAX_SOURCES).map((s) => s.doc) : [],
    passages: passageBest >= PASSAGE_SURE || (onlyDeliverable && passageBest >= 0.62) ? goodPassages : [],
    closest: semantic && maxSem >= 0.58 ? scored.slice(0, 2).map((s) => s.doc) : [],
    semantic: Boolean(semantic),
  };
}

// For each text, its sentence closest to the question (by meaning when the
// model is available, else by shared keywords).
async function bestSentences(texts, query, useModel) {
  const embed = useModel ? await loadEmbedder(onProgress).catch(() => null) : null;
  const q = embed ? (await embed([QUERY_PREFIX + query]))[0] : null;
  const terms = new Set(tokenize(query));
  const out = [];
  for (const text of texts) {
    const sentences = sentencesOf(text).slice(0, 12);
    if (!sentences.length) {
      out.push(text.length > 25 ? text.slice(0, 300) : "");
      continue;
    }
    const scores = embed
      ? (await embed(sentences)).map((v) => dot(q, v))
      : sentences.map((x) => tokenize(x).filter((t) => terms.has(t)).length);
    out.push(sentences[scores.indexOf(Math.max(...scores))]);
  }
  return out;
}

// ---------- answering ----------

const INTRODUCTION =
  "I'm the ACCREU Data Assistant, an AI assistant developed at IIASA by Dr. Andre Nakhavali. I help you find datasets in the ACCREU Data Catalog and the ACCREU Zenodo community, and explain what the ACCREU deliverable reports say about them, with a link to every source.";

// Intents with needsKnowledge: false are answered at once, before the
// catalog has loaded.
const INTENTS = [
  {
    test: /\b(who|what) are you\b|\bwho (made|built|developed|created|designed|trained) (you|this|it)\b|\bintroduce yourself\b|\b(about|describe) yourself\b|\byour name\b|\bwhat is this (assistant|chat|chatbot|bot|tool|ai)\b|\bare you (an? )?(ai|bot|robot|human|person|chatbot)\b/i,
    needsKnowledge: false,
    reply: () => `${INTRODUCTION} Ask me about a hazard, a sector, a region, a model or a deliverable.`,
  },
  {
    test: /^\s*(?:(?:hi+|hello|hey+|hallo|hola|ciao|servus|salut|bonjour|howdy|greetings|good (?:morning|afternoon|evening|day))(?: there| all| everyone)?|how are you(?: doing)?|how's it going)(?:[\s,!.]+(?:how are you(?: doing)?|how's it going))?[\s!.?]*$/i,
    needsKnowledge: false,
    reply: () => `Hello! ${INTRODUCTION} What would you like to find?`,
  },
  {
    test: /^\s*(thanks|thank you|thx|cheers)\b/i,
    needsKnowledge: false,
    reply: () => "You're welcome!",
  },
  {
    test: /^\s*(bye|goodbye|see you)\b/i,
    needsKnowledge: false,
    reply: () => "Goodbye!",
  },
  {
    test: /^\s*(help|\?)\s*$|\bwhat can you do\b|\bhow (do|can) (i|you) use\b/i,
    needsKnowledge: false,
    reply: () =>
      "I search the catalog datasets, the ACCREU Zenodo community and the full text of the ACCREU deliverables. Try:\n• Which datasets cover sea-level rise?\n• What is in D2.2?\n• What does D2.3 say about older people?\n• How many datasets are on Zenodo?",
  },
  {
    test: /^\s*(how many|number of) (datasets|files|deliverables|records)( are there| are on zenodo| on zenodo| in (the|this) catalog| do you have)?\s*\??\s*$/i,
    reply: (k) => {
      const all = k.manifest.datasets;
      const onZenodo = all.filter((d) => d.zenodo).length;
      const delivs = new Set(all.flatMap((d) => d.deliverables || [])).size;
      return `The catalog holds ${all.length} datasets with ${Number(k.manifest.total_files).toLocaleString("en-US")} files: ${onZenodo} on Zenodo and ${all.length - onZenodo} on request. They are linked to ${delivs} ACCREU deliverables.`;
    },
  },
];

const FOLLOW_UP = /^\s*(and|also|what about|how about|same for)\s*(for|in|on|about|with)?\s*/i;
const CODE = /\bD\s?(\d)\s?\.\s?(\d)\b/gi;

// Questions that point back at the previous answer ("explain each",
// "compare them", "tell me more about the first one").
const REFERS_BACK =
  /\b(each|them|these|those|they|both|first|second|third|fourth|last one|this one|that one|compare|comparison|differ|difference|more detail|tell me more|elaborate|explain)\b/i;

async function answer(question) {
  const intent = INTENTS.find((it) => it.test.test(question));
  if (intent) {
    const knowledge = intent.needsKnowledge === false ? null : await loadKnowledge();
    addMessage("assistant", intent.reply(knowledge));
    return;
  }

  const knowledge = await loadKnowledge();

  const codes = [...new Set((question.match(CODE) || []).map((c) => c.replace(/\s/g, "").toUpperCase()))];
  // Search on the subject itself: "What does D2.3 say about older people?"
  // -> "older people" (the filler words dilute the match).
  const topic =
    question
      .replace(FOLLOW_UP, "")
      .replace(CODE, " ")
      .replace(/^\s*(what|how|which|where|why|who|is|are|does|do|can|could|tell me|show me)\b.*?\b(say|says|said|write|writes|report|reports|find|finds|found|conclude|concludes)\s+(about|on|regarding|for)\s+/i, "")
      .replace(/^\s*(tell me|show me|find)\s+(about|on)\s+/i, "")
      .replace(/\s+/g, " ")
      .trim() || question;
  const topicWords = tokenize(topic).filter((t) => !/^(deliverable|report|contain|cover|inside|accreu|dataset|data|about)$/.test(t));

  const unknown = codes.filter((c) => !knowledge.deliverables[c]);
  if (unknown.length) {
    addMessage("assistant", `${unknown.join(", ")} is not among the public ACCREU deliverables. The full list is at https://www.accreu.eu/deliverables/`);
    return;
  }

  let result = { sources: [], passages: [], closest: [], semantic: false };
  if (codes.length && !topicWords.length) {
    // "What is in D2.4?": the deliverable and its datasets.
    for (const code of codes) {
      const d = knowledge.docs.find((x) => x.kind === "deliverable" && x.id === code);
      result.sources.push(d, ...knowledge.docs.filter((x) => x.kind === "dataset" && d.datasets.includes(x.title)));
    }
  } else {
    // "What does D2.3 say about older people?": search that report only.
    const onlyDeliverable = codes.length === 1 ? codes[0] : null;
    result = await search(knowledge, topic || question, onlyDeliverable);
    // Follow-ups ("and for water?", "what about Venice?") borrow the previous
    // question's context only if the new topic alone finds nothing.
    if (!result.sources.length && !result.passages.length && lastQuestion && FOLLOW_UP.test(question)) {
      result = await search(knowledge, `${lastQuestion} ${topic}`, onlyDeliverable);
    }
    if (onlyDeliverable) result.sources = [];
  }

  let items = [...result.sources.map(docItem), ...result.passages.map((p) => passageItem(p.passage, knowledge.deliverables))];
  if (lastItems.length && REFERS_BACK.test(question) && (topicWords.length <= 3 || !items.length)) {
    items = dedupe([...lastItems, ...items]).slice(0, 10);
  }

  if (ASSISTANT_URL) {
    // The answer is shown as it is written; its source list once complete.
    let reply = null;
    let frame = 0;
    const show = (text, final) => {
      const atBottom = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < 60;
      if (!reply) {
        reply = addMessage("assistant", "");
      }
      reply.replaceChildren(renderAnswer(text, items, final));
      if (atBottom) els.log.scrollTop = els.log.scrollHeight;
    };
    try {
      const text = await askModel(question, items, (partial) => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(() => show(partial, false));
      });
      cancelAnimationFrame(frame);
      show(text, true);
      history.push({ role: "user", content: question }, { role: "assistant", content: text });
      lastItems = items.length ? items : lastItems;
      return;
    } catch (error) {
      cancelAnimationFrame(frame);
      if (error.partial) {
        show(`${error.partial}\n\n*The answer was interrupted. Please ask again.*`, true);
        lastItems = items.length ? items : lastItems;
        return;
      }
      if (reply) reply.remove();
      console.warn("ACCREU assistant: AI service unavailable, answering by search:", error);
    }
  }

  // Without the AI service: quote the sources directly.
  if (!items.length) {
    const reply = addMessage(
      "assistant",
      "I couldn't find that in the ACCREU data or deliverables. Try a sector, hazard, region, model or scenario, e.g. \"flood damages\" or \"GLOBIOM\"."
    );
    if (result.closest.length) {
      reply.append(document.createTextNode("\n\nClosest matches:"));
      reply.append(renderSources(result.closest, []));
    }
    return;
  }
  lastItems = items;
  const quotes = await bestSentences(items.map((it) => it.text), topic || question, result.semantic);
  const reply = addMessage("assistant", leadSentence(items));
  const wrap = document.createElement("div");
  wrap.className = "agent-sources";
  items.forEach((it, i) => wrap.append(sourceCard(it.url, it.title, it.meta, quotes[i])));
  reply.append(wrap);
}

// One shape for everything sent to the model and listed under an answer.
function docItem(doc) {
  const kind = { dataset: "Dataset", deliverable: "Deliverable report", zenodo: "Zenodo record" }[doc.kind];
  const deliv = doc.kind !== "deliverable" && doc.deliverables.length ? ` · ${doc.deliverables.join(", ")}` : "";
  const files = doc.kind === "dataset" && doc.files ? ` · ${doc.files.toLocaleString("en-US")} files` : "";
  return {
    key: doc.url + doc.title,
    kind,
    title: doc.title,
    meta: `${kind}${deliv}${files}${doc.access ? ` · ${doc.access}` : ""}`,
    url: doc.url,
    text: doc.detail || doc.summary,
  };
}

function passageItem(passage, deliverables) {
  const info = deliverables[passage.d] || {};
  return {
    key: `${passage.d}:${passage.p}:${passage.t.slice(0, 40)}`,
    kind: "Deliverable report passage",
    title: `${passage.d}: ${info.title}`,
    meta: `Report ${passage.d}, page ${passage.p}`,
    url: `${info.url}#page=${passage.p}`,
    text: passage.t,
  };
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => !seen.has(it.key) && seen.add(it.key));
}

// Asks the proxy and reads the answer as it streams in (one JSON object per
// line, see worker/src/index.js), calling onText with the text so far.
// Resolves to the full answer; on failure the error carries the text received
// so far as error.partial.
async function askModel(question, items, onText) {
  const controller = new AbortController();
  // The proxy may try several models before one starts answering; after that
  // a stalled stream is given up.
  let timer = setTimeout(() => controller.abort(), 75000);
  let text = "";
  try {
    const resp = await fetch(`${ASSISTANT_URL}/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        question,
        history: history.slice(-6),
        sources: items.map(({ kind, title, meta, text }) => ({ kind, title, meta, text })),
      }),
    });
    if (!resp.ok || !resp.body) {
      const data = await resp.json().catch(() => ({}));
      throw new Error(data.error || `HTTP ${resp.status}`);
    }
    const reader = resp.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(), 30000);
      buffer += value;
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end).trim();
        buffer = buffer.slice(end + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.error) throw new Error(msg.error);
        if (msg.t) {
          text += msg.t;
          onText(text);
        }
        if (msg.done) return text;
      }
    }
    if (!text) throw new Error("empty answer");
    return text;
  } catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.partial = text;
    throw failure;
  } finally {
    clearTimeout(timer);
  }
}

function leadSentence(items) {
  const count = (kind) => items.filter((it) => it.kind === kind).length;
  const parts = [];
  const n = { d: count("Dataset"), z: count("Zenodo record"), r: count("Deliverable report") + count("Deliverable report passage") };
  if (n.d) parts.push(`${n.d} dataset${n.d > 1 ? "s" : ""}`);
  if (n.z) parts.push(`${n.z} Zenodo record${n.z > 1 ? "s" : ""}`);
  if (n.r) parts.push(`${n.r} report source${n.r > 1 ? "s" : ""}`);
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0];
  return `I found ${list}:`;
}

// ---------- rendering ----------

function sourceCard(href, titleText, metaText, quoteText) {
  const a = document.createElement("a");
  a.className = "agent-source";
  a.href = href;
  if (!href.startsWith("index.html")) {
    a.target = "_blank";
    a.rel = "noopener";
  }
  const title = document.createElement("strong");
  title.textContent = titleText;
  const meta = document.createElement("span");
  meta.textContent = metaText;
  a.append(title, meta);
  if (quoteText) {
    const quote = document.createElement("q");
    quote.textContent = quoteText;
    a.append(quote);
  }
  return a;
}

function renderSources(sources, quotes) {
  const wrap = document.createElement("div");
  wrap.className = "agent-sources";
  sources.forEach((s, i) => {
    const kind = { dataset: "Dataset", deliverable: "Deliverable report", zenodo: "Zenodo" }[s.kind];
    const deliv = s.kind !== "deliverable" && s.deliverables.length ? ` · ${s.deliverables.join(", ")}` : "";
    const files = s.kind === "dataset" && s.files ? ` · ${s.files.toLocaleString("en-US")} files` : "";
    wrap.append(sourceCard(s.url, s.title, `${kind}${deliv}${files}${s.access ? ` · ${s.access}` : ""}`, quotes[i]));
  });
  return wrap;
}

// The model's reply: paragraphs, bullet lists and **bold**, with [1]-style
// citations linked to the sources, then (once final) the list of sources.
// Built from text nodes only, so the reply cannot inject markup.
function renderAnswer(text, items, final = true) {
  text = text
    .replace(/<think>[\s\S]*?(<\/think>|$)/gi, "") // reasoning a model may leak
    .replace(/【\s*(\d+)\s*】/g, "[$1]"); // some models write 【1】 for [1]
  const wrap = document.createElement("div");
  wrap.className = "agent-answer";
  let list = null;
  for (const raw of text.replace(/\r/g, "").split("\n")) {
    const line = raw.trim();
    if (!line || /^-{3,}$/.test(line)) {
      list = null;
      continue;
    }
    const bullet = /^([-*•]|\d+[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      if (!list) {
        list = document.createElement(/^\d/.test(bullet[1]) ? "ol" : "ul");
        wrap.append(list);
      }
      const li = document.createElement("li");
      appendInline(li, bullet[2], items);
      list.append(li);
      continue;
    }
    list = null;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    const para = document.createElement("p");
    if (heading) {
      const strong = document.createElement("strong");
      appendInline(strong, heading[1], items);
      para.append(strong);
    } else {
      appendInline(para, line, items);
    }
    wrap.append(para);
  }

  if (final && items.length) {
    const cited = new Set([...text.matchAll(/\[(\d+(?:\s*,\s*\d+)*)\]/g)].flatMap((m) => m[1].split(/\s*,\s*/).map(Number)));
    const shown = items.map((it, i) => ({ it, n: i + 1 })).filter(({ n }) => cited.size === 0 || cited.has(n));
    const sources = document.createElement("div");
    sources.className = "agent-cited";
    for (const { it, n } of shown) {
      const a = document.createElement("a");
      a.href = it.url;
      if (!it.url.startsWith("index.html")) {
        a.target = "_blank";
        a.rel = "noopener";
      }
      a.title = it.meta;
      a.textContent = `[${n}] ${it.title}`;
      const meta = document.createElement("span");
      meta.textContent = it.meta;
      a.append(meta);
      sources.append(a);
    }
    wrap.append(sources);
  }
  return wrap;
}

function appendInline(parent, text, items) {
  const tokens = text.split(/(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`|\[\d+(?:\s*,\s*\d+)*\])/);
  for (const token of tokens) {
    if (!token) continue;
    const bold = /^\*\*([^*]+)\*\*$/.exec(token);
    const italic = /^\*([^*]+)\*$/.exec(token);
    const code = /^`([^`]+)`$/.exec(token);
    const cite = /^\[(\d+(?:\s*,\s*\d+)*)\]$/.exec(token);
    if (bold) {
      const strong = document.createElement("strong");
      strong.textContent = bold[1];
      parent.append(strong);
    } else if (italic || code) {
      const em = document.createElement(code ? "code" : "em");
      em.textContent = (italic || code)[1];
      parent.append(em);
    } else if (cite) {
      for (const n of cite[1].split(/\s*,\s*/).map(Number)) {
        const item = items[n - 1];
        if (!item) continue;
        const a = document.createElement("a");
        a.className = "agent-cite";
        a.href = item.url;
        if (!item.url.startsWith("index.html")) {
          a.target = "_blank";
          a.rel = "noopener";
        }
        a.title = item.title;
        a.textContent = n;
        parent.append(a);
      }
    } else {
      parent.append(token);
    }
  }
}

// Messages go above the "Thinking" indicator while it is shown.
function addMessage(kind, text) {
  const div = document.createElement("div");
  div.className = `agent-msg agent-msg-${kind}`;
  div.textContent = text;
  els.log.insertBefore(div, els.log.querySelector(".agent-msg-pending"));
  els.log.scrollTop = els.log.scrollHeight;
  return div;
}
