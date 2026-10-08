// The assistant's catalog sources: one searchable entry per catalog dataset,
// per deliverable and per other ACCREU Zenodo community record. Shared by the
// page (agent.js) and the knowledge builder (tools/embed.html), so the
// vectors build_knowledge.py pre-computes match what the page searches.

const site = new URL("../", import.meta.url); // the site root
const COMMUNITY_API = "https://zenodo.org/api/communities/accreu-project/records";

export async function loadSources() {
  const [manifest, deliverablesFile, pathsText, records] = await Promise.all([
    fetch(new URL("catalog/manifest.json", site)).then((r) => r.json()),
    fetch(new URL("catalog/deliverables.json", site)).then((r) => r.json()),
    fetch(new URL("catalog/paths.txt", site)).then((r) => (r.ok ? r.text() : "")),
    communityRecords(),
  ]);
  return { manifest, deliverables: deliverablesFile.deliverables || {}, pathsText, records };
}

// The ACCREU Zenodo community, all pages at once. If Zenodo is slow or
// unreachable the assistant goes ahead without it: the catalog, deliverables
// and reports still work.
async function communityRecords() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  const page = (n) =>
    fetch(`${COMMUNITY_API}?size=25&page=${n}&sort=newest`, { signal: controller.signal })
      .then((r) => r.json())
      .then((data) => ({ hits: (data.hits && data.hits.hits) || [], total: (data.hits && data.hits.total) || 0 }));
  try {
    const first = await page(1);
    const pages = Math.min(Math.ceil(first.total / 25), 4);
    const rest = await Promise.all(Array.from({ length: Math.max(pages - 1, 0) }, (_, i) => page(i + 2).catch(() => ({ hits: [] }))));
    return [first, ...rest].flatMap((p) => p.hits);
  } catch (e) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

export function buildDocs({ manifest, deliverables, pathsText, records }) {
  // A sample of each dataset's file names, so explanations rest on what is
  // actually in it.
  const fileSamples = new Map();
  for (const line of pathsText.split("\n")) {
    const cut = line.indexOf("/");
    if (cut < 0) continue;
    const id = line.slice(0, cut).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
    const list = fileSamples.get(id) || [];
    if (list.length < 25) list.push(line.slice(cut + 1));
    fileSamples.set(id, list);
  }
  const docs = [];
  const catalogIds = new Set();

  for (const d of manifest.datasets) {
    const ids = Array.isArray(d.deliverables) ? d.deliverables : [];
    const zenodo = (d.zenodo || []).map((z) => {
      const doi = String(z.doi).replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
      const match = /zenodo\.(\d+)/.exec(doi);
      if (match) catalogIds.add(match[1]);
      return { url: `https://doi.org/${doi}`, title: z.title };
    });
    docs.push({
      kind: "dataset",
      title: d.label,
      deliverables: ids,
      access: d.zenodo ? (d.files_restricted ? "on Zenodo, files restricted" : "on Zenodo") : "request access",
      summary: d.description || "",
      files: d.file_count || 0,
      detail: [
        d.description,
        ids.length ? `ACCREU deliverables: ${ids.map((id) => `${id} (${(deliverables[id] || {}).title || ""})`).join(", ")}.` : "",
        `Access: ${d.zenodo ? (d.files_restricted ? "Zenodo record, files restricted (request on Zenodo)" : "public on Zenodo") : "not public yet, request access through the catalog"}.`,
        d.file_count ? `Files: ${d.file_count}${d.files_truncated ? "+" : ""} (${Object.entries(d.extensions || {}).map(([e, n]) => `${n} ${e.toUpperCase()}`).join(", ")}).` : "",
        zenodo.length ? `Zenodo title: ${zenodo.map((r) => r.title).join("; ")}.` : "",
        fileSamples.has(d.id) ? `Example files: ${fileSamples.get(d.id).join(", ")}.` : "",
      ].filter(Boolean).join(" "),
      url: zenodo[0] ? zenodo[0].url : `index.html?deliverable=${encodeURIComponent(ids[0] || "all")}`,
      text: [d.label, ...zenodo.map((r) => r.title), d.description].join(". "),
    });
  }

  for (const [id, info] of Object.entries(deliverables)) {
    const datasets = manifest.datasets.filter((d) => (d.deliverables || []).includes(id)).map((d) => d.label);
    docs.push({
      kind: "deliverable",
      id,
      title: `${id}: ${info.title}`,
      deliverables: [id],
      datasets,
      summary: datasets.length
        ? `ACCREU deliverable ${id} (${info.title}). In this catalog, ${datasets.length} dataset${datasets.length > 1 ? "s are" : " is"} linked to it: ${datasets.join("; ")}.`
        : `ACCREU deliverable ${id}: ${info.title}. No catalog dataset is linked to it yet.`,
      url: info.url,
      text: `ACCREU deliverable ${id}: ${info.title}`,
    });
  }

  // Zenodo community records that are not already catalog datasets (papers,
  // other outputs). Every version of a catalog record shares its concept id.
  for (const r of records) if (catalogIds.has(String(r.id))) catalogIds.add(String(r.conceptrecid));
  for (const r of records) {
    if (catalogIds.has(String(r.id)) || catalogIds.has(String(r.conceptrecid))) continue;
    const meta = r.metadata || {};
    const kind = (meta.resource_type && (meta.resource_type.title || meta.resource_type.type)) || "record";
    const description = plainText(meta.description || "");
    docs.push({
      kind: "zenodo",
      title: meta.title,
      deliverables: [],
      access: String(kind).toLowerCase(),
      summary: description,
      url: `https://doi.org/${r.doi || meta.doi}`,
      text: `${meta.title}. ${description}`,
    });
  }
  return docs;
}

function plainText(markup) {
  // DOMParser documents are inert: no scripts run and no images load.
  const doc = new DOMParser().parseFromString(markup, "text/html");
  return (doc.body.textContent || "").replace(/\s+/g, " ").trim();
}

// The text embedded for an entry.
export function embedText(doc) {
  return `${doc.title}. ${doc.text}`.slice(0, 1200);
}

// A short fingerprint of an entry's text (cyrb53): a pre-computed vector is
// used only while its entry's text is unchanged.
export function textKey(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}
