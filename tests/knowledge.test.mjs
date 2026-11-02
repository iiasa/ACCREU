import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { buildDocs, embedText, textKey } from "../assets/knowledge.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const manifest = JSON.parse(read("../catalog/manifest.json"));
const { deliverables } = JSON.parse(read("../catalog/deliverables.json"));
const docs = buildDocs({ manifest, deliverables, pathsText: "", records: [] });
const agent = read("../assets/agent.js");
const { buildIndex, search } = runInNewContext(
  "const MAX_SOURCES=4, MAX_PASSAGES=3; const onProgress=()=>{};" +
    agent.slice(agent.indexOf("async function embedDocs("), agent.indexOf("// ---------- answering ----------")) +
    "; ({ buildIndex, search });",
  { embedText, textKey, loadEmbedder: async () => { throw new Error("offline test"); }, console: { warn() {} } }
);
const knowledge = { ...buildIndex(docs), precomputed: new Map(), reports: null };

test("offline health search includes excess mortality among the four sources", async () => {
  for (const query of ["health", "Which datasets cover health?"]) {
    const { sources } = await search(knowledge, query);
    assert(sources.some((doc) => doc.title === "Excess Mortality Projections by SSP-RCP Scenario"));
  }
});

test("deliverable context invalidates stale dataset embeddings", () => {
  const mortality = docs.find((doc) => doc.title.startsWith("Excess Mortality"));
  assert.match(mortality.text, /D2\.7: Health risks/);
  const old = { ...mortality, text: mortality.text.replace(/D2\.7: .*?\. /, "") };
  assert.notEqual(textKey(embedText(mortality)), textKey(embedText(old)));
});

test("unlinked datasets do not inherit unrelated health context", () => {
  const crop = docs.find((doc) => doc.title === "Crop Pollination — Climate-Only Scenarios");
  assert(!/health/i.test(crop.text));
  const unlinked = buildDocs({
    manifest: { datasets: [{ id: "unlinked", label: "Unlinked", deliverables: ["D9.9"] }] },
    deliverables, pathsText: "", records: [],
  });
  assert(!unlinked[0].text.includes("undefined"));
});
