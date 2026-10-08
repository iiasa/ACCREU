(function () {
  "use strict";

  const MAX_SEARCH_RESULTS = 500;
  const CONTACT_EMAIL = "palazzo@iiasa.ac.at";

  const state = {
    manifest: null,
    deliverables: {}, // "D2.4" -> { title, url }
    datasets: new Map(), // id -> dataset (with .paths, .tree once loaded)
    access: "all", // "all" | "zenodo" | "s3"
    deliverable: new URLSearchParams(window.location.search).get("deliverable") || "all", // "all" | "none" | "D2.4"…
    searchTimer: 0,
    pendingRequest: null,
  };

  const els = {};

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    cacheElements();
    bindEvents();

    try {
      const manifestResp = await fetch("catalog/manifest.json");
      if (!manifestResp.ok) throw new Error(`Unable to load manifest (${manifestResp.status})`);
      state.manifest = await manifestResp.json();
      for (const dataset of state.manifest.datasets) {
        dataset.paths = [];
        state.datasets.set(dataset.id, dataset);
      }

      const pathsResp = await fetch(state.manifest.catalog_file);
      if (!pathsResp.ok) throw new Error(`Unable to load ${state.manifest.catalog_file} (${pathsResp.status})`);
      const text = await pathsResp.text();
      assignPathsToDatasets(text);

      try {
        const deliverablesResp = await fetch("catalog/deliverables.json");
        if (deliverablesResp.ok) state.deliverables = (await deliverablesResp.json()).deliverables || {};
      } catch (e) {
        // Deliverable links are an extra; the catalog still works without them.
      }

      renderDeliverableFilter();
      renderTree();
      fillMissingZenodoFiles();
    } catch (error) {
      showError(error.message || String(error));
    }
  }

  // A Zenodo dataset added to the manifest but not yet run through
  // sync_zenodo.py has no file list. List its top-level files straight from
  // the Zenodo API (which allows cross-origin requests) so it never shows an
  // empty 0. Files inside zip archives only appear after the sync script runs.
  async function fillMissingZenodoFiles() {
    const pending = state.manifest.datasets.filter(
      (d) => d.zenodo && !d.source_folder && !d.paths.length && !d.files_restricted
    );
    if (!pending.length) return;
    for (const dataset of pending) {
      for (const record of dataset.zenodo) {
        const id = zenodoRecordId(record.doi);
        if (!id) continue;
        try {
          const resp = await fetch(`https://zenodo.org/api/records/${id}`);
          if (!resp.ok) continue;
          const meta = await resp.json();
          if (meta.metadata && meta.metadata.access_right === "restricted") dataset.files_restricted = true;
          for (const file of meta.files || []) dataset.paths.push(`${dataset.id}/${file.key}`);
        } catch (e) {
          // Zenodo unreachable: leave the dataset as it is.
        }
      }
      dataset.file_count = dataset.paths.length;
    }
    renderSearchOrTree();
  }

  function zenodoRecordId(doi) {
    const match = /zenodo\.(\d+)/.exec(doi || "");
    return match ? match[1] : null;
  }

  function normalizeDoi(doi) {
    return String(doi || "").replace(/^https?:\/\/(dx\.)?doi\.org\//i, "");
  }

  // The manifest's `deliverables` list (e.g. ["D2.1", "D2.4"]) is the source
  // of truth. For an entry added without one, fall back to its tag:
  // "Deliverable 2.4" -> D2.4; "Case Study 3.2" is reported in D3.2.
  function deliverableIds(dataset) {
    if (Array.isArray(dataset.deliverables)) return dataset.deliverables;
    const title = (dataset.tag && dataset.tag.title) || "";
    const match = /(\d+)\.(\d+)/.exec(title);
    if (match && /deliverable/i.test(title)) return [`D${match[1]}.${match[2]}`];
    if (/case study/i.test(title)) return ["D3.2"];
    return [];
  }

  function deliverablesFor(dataset) {
    return deliverableIds(dataset)
      .map((id) => ({ id, ...(state.deliverables[id] || {}) }))
      .filter((d) => d.url);
  }

  function cacheElements() {
    els.accessFilter = document.getElementById("accessFilter");
    els.deliverableFilter = document.getElementById("deliverableFilter");
    els.deliverableDetail = document.getElementById("deliverableDetail");
    els.searchInput = document.getElementById("searchInput");
    els.clearSearch = document.getElementById("clearSearch");
    els.statusLine = document.getElementById("statusLine");
    els.searchResults = document.getElementById("searchResults");
    els.tree = document.getElementById("tree");
    els.themeToggle = document.getElementById("themeToggle");
    els.agreementDialog = document.getElementById("agreementDialog");
    els.agreementSubtitle = document.getElementById("agreementSubtitle");
    els.agreementCancel = document.getElementById("agreementCancel");
    els.agreementAccept = document.getElementById("agreementAccept");
  }

  function bindEvents() {
    els.searchInput.addEventListener("input", function () {
      window.clearTimeout(state.searchTimer);
      state.searchTimer = window.setTimeout(renderSearchOrTree, 160);
    });

    els.clearSearch.addEventListener("click", function () {
      els.searchInput.value = "";
      renderSearchOrTree();
      els.searchInput.focus();
    });

    els.accessFilter.addEventListener("click", function (event) {
      const button = event.target.closest(".filter-chip");
      if (!button) return;
      state.access = button.dataset.filter;
      syncFilterChips();
      renderSearchOrTree();
    });

    els.deliverableFilter.addEventListener("change", function () {
      setDeliverableFilter(els.deliverableFilter.value);
    });

    els.themeToggle.addEventListener("click", function () {
      const current = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
      const next = current === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem("accreu-theme", next);
      } catch (e) {}
    });

    els.agreementCancel.addEventListener("click", function () {
      els.agreementDialog.close();
    });

    els.agreementAccept.addEventListener("click", function () {
      const dataset = state.pendingRequest;
      if (!dataset) return;
      const subject = encodeURIComponent(`ACCREU data request: ${dataset.source_folder}`);
      const body = encodeURIComponent(
        `I would like to request the file list and access details for "${dataset.label}" (${dataset.source_folder}) from the ACCREU Data Catalog.\n\nI have read and agree to the data use terms: cite the ACCREU project (Horizon Europe grant agreement No. 101081358) and this dataset in any resulting output, use the data for the stated research purpose only, and not redistribute the raw files without permission.`
      );
      window.location.href = `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`;
      els.agreementDialog.close();
    });
  }

  function buildPopoverText(dataset) {
    const lines = deliverablesFor(dataset).map((d) => `${d.id} — ${d.title}`);
    return lines.length ? `${lines.join("\n")}\n\n${dataset.description}` : dataset.description;
  }

  function openAgreement(dataset) {
    state.pendingRequest = dataset;
    els.agreementSubtitle.textContent = `${dataset.label} · ${dataset.source_folder}`;
    els.agreementDialog.showModal();
  }


  function assignPathsToDatasets(text) {
    const lines = text.split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      const top = line.slice(0, line.indexOf("/"));
      const dataset = state.datasets.get(slugify(top));
      if (dataset) dataset.paths.push(line);
    }
  }

  function slugify(name) {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function visibleDatasets() {
    return state.manifest.datasets.filter((d) => {
      if (state.access === "zenodo" && !d.zenodo) return false;
      if (state.access === "s3" && d.zenodo) return false;
      const ids = deliverableIds(d);
      if (state.deliverable === "none") return ids.length === 0;
      if (state.deliverable !== "all") return ids.includes(state.deliverable);
      return true;
    });
  }

  // Dropdown with one entry per deliverable that has datasets, in report
  // order, with counts.
  function renderDeliverableFilter() {
    const counts = new Map();
    let without = 0;
    for (const d of state.manifest.datasets) {
      const ids = deliverableIds(d);
      if (!ids.length) without += 1;
      for (const id of ids) counts.set(id, (counts.get(id) || 0) + 1);
    }
    const order = Object.keys(state.deliverables);
    const ids = [...counts.keys()].sort((a, b) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib) || a.localeCompare(b);
    });
    if (state.deliverable !== "all" && state.deliverable !== "none" && !counts.has(state.deliverable)) {
      state.deliverable = "all";
    }

    const options = [new Option(`All deliverables (${state.manifest.datasets.length})`, "all")];
    for (const id of ids) {
      const info = state.deliverables[id];
      options.push(new Option(`${id} — ${info ? info.title : ""} (${counts.get(id)})`, id));
    }
    if (without) options.push(new Option(`No deliverable (${without})`, "none"));
    els.deliverableFilter.replaceChildren(...options);
    syncFilterChips();
  }

  function setDeliverableFilter(value) {
    state.deliverable = value || "all";
    const url = new URL(window.location.href);
    if (state.deliverable === "all") url.searchParams.delete("deliverable");
    else url.searchParams.set("deliverable", state.deliverable);
    window.history.replaceState(null, "", url);
    syncFilterChips();
    renderSearchOrTree();
  }

  function syncFilterChips() {
    for (const chip of els.accessFilter.querySelectorAll(".filter-chip")) {
      chip.setAttribute("aria-pressed", String(chip.dataset.filter === state.access));
    }
    els.deliverableFilter.value = state.deliverable;
    // Under the dropdown: the selected deliverable's report link.
    const info = state.deliverables[state.deliverable];
    els.deliverableDetail.hidden = !info;
    if (info) {
      const link = document.createElement("a");
      link.href = info.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.textContent = `Open the ${state.deliverable} report ↗`;
      els.deliverableDetail.replaceChildren(link);
    }
  }

  // Small D / CS marker; clicking it filters to the dataset's main deliverable.
  function createTagIcon(dataset) {
    const primary = deliverableIds(dataset)[0];
    const icon = document.createElement("button");
    icon.type = "button";
    icon.className = "dataset-tag-icon";
    icon.textContent = dataset.tag && dataset.tag.type ? dataset.tag.type : "D";
    icon.title = `Show all datasets of ${primary}`;
    icon.addEventListener("click", (event) => {
      event.stopPropagation();
      setDeliverableFilter(state.deliverable === primary ? "all" : primary);
    });
    return icon;
  }

  function renderSearchOrTree() {
    const query = els.searchInput.value.trim();
    if (query) {
      renderSearch(query);
    } else {
      els.searchResults.hidden = true;
      els.tree.hidden = false;
      renderTree();
    }
  }

  function renderTree() {
    const datasets = visibleDatasets();
    const files = datasets.reduce((sum, d) => sum + (d.file_count || 0), 0);
    const scope =
      state.deliverable === "all"
        ? ""
        : state.deliverable === "none"
          ? " · without a deliverable"
          : ` · ${state.deliverable}${state.deliverables[state.deliverable] ? ` — ${state.deliverables[state.deliverable].title}` : ""}`;
    els.statusLine.textContent = `${formatNumber(datasets.length)} dataset${datasets.length === 1 ? "" : "s"} · ${formatNumber(files)} files${scope}`;
    const fragment = document.createDocumentFragment();
    for (const dataset of datasets) {
      fragment.appendChild(createDatasetElement(dataset));
    }
    els.tree.replaceChildren(fragment);
  }

  function createDatasetElement(dataset) {
    const canBrowse = Boolean(dataset.file_count);
    const details = document.createElement("details");
    details.className = `tree-folder tree-dataset ${dataset.zenodo ? "is-zenodo" : "is-request"} ${
      canBrowse ? "" : "is-standalone"
    }`;

    const summary = document.createElement("summary");
    if (!canBrowse) {
      // Nothing to expand.
      summary.addEventListener("click", (event) => event.preventDefault());
    }

    const statusDot = document.createElement("span");
    statusDot.className = "status-dot";

    const titleWrap = document.createElement("span");
    titleWrap.className = "dataset-title";

    const mainLine = document.createElement("span");
    mainLine.className = "dataset-title-main";

    if (deliverableIds(dataset).length) {
      mainLine.append(createTagIcon(dataset));
    }

    const label = document.createElement("span");
    label.className = "dataset-label";
    label.textContent = dataset.label;
    mainLine.append(label);

    if (dataset.description) {
      const popoverId = `desc-${dataset.id}`;

      const hint = document.createElement("button");
      hint.type = "button";
      hint.className = "dataset-desc-hint";
      hint.textContent = "?";
      hint.setAttribute("popovertarget", popoverId);
      hint.setAttribute("aria-label", "Show description");
      mainLine.append(hint);

      const popover = document.createElement("div");
      popover.id = popoverId;
      popover.setAttribute("popover", "auto");
      popover.className = "desc-popover";
      popover.textContent = buildPopoverText(dataset);
      mainLine.append(popover);
    }

    titleWrap.append(mainLine);

    const actionsWrap = document.createElement("span");
    actionsWrap.className = "dataset-badges";
    actionsWrap.append(...createDatasetActions(dataset));

    if (dataset.file_count === null) {
      summary.append(statusDot, titleWrap, actionsWrap);
    } else {
      const count = document.createElement("span");
      count.className = "count-pill";
      if (dataset.files_restricted && !dataset.file_count) {
        count.textContent = "restricted";
        count.title = "The Zenodo record is public, but its files are restricted — request access on Zenodo.";
      } else {
        count.textContent = formatNumber(dataset.file_count) + (dataset.files_truncated ? "+" : "");
        if (dataset.files_truncated) {
          count.title = "Zenodo's archive preview lists at most 1,000 entries per zip; the full archive holds more.";
        }
      }
      summary.append(statusDot, titleWrap, count, actionsWrap);
    }

    const children = document.createElement("div");
    children.className = "tree-children";
    details.append(summary, children);

    if (canBrowse) {
      let rendered = false;
      function ensureRendered() {
        if (rendered) return;
        const root = buildTree(dataset);
        renderNodeChildren(root, children);
        rendered = true;
      }
      details.addEventListener("toggle", function () {
        if (details.open) ensureRendered();
      });
    }

    return details;
  }

  const ICON_LOCK =
    '<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8 11V8a4 4 0 0 1 8 0v3" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';

  function createDeliverableLinks(dataset) {
    return deliverablesFor(dataset).map((deliverable) => {
      const link = document.createElement("a");
      link.target = "_blank";
      link.rel = "noopener";
      link.addEventListener("click", (event) => event.stopPropagation());
      link.className = "badge badge-deliverable";
      link.href = deliverable.url;
      link.title = `ACCREU ${deliverable.id}: ${deliverable.title}`;
      link.textContent = `${deliverable.id} ↗`;
      return link;
    });
  }

  function createDatasetActions(dataset) {
    // Each folder is either a confirmed Zenodo match (its files) or an
    // Accelerator-only folder you request access to — never both, since a
    // folder only gets a Zenodo entry when it's the same files.
    const deliverableLinks = createDeliverableLinks(dataset);
    if (dataset.zenodo) {
      return [
        ...deliverableLinks,
        ...dataset.zenodo.map((record) => {
          const action = document.createElement("a");
          action.target = "_blank";
          action.rel = "noopener";
          action.addEventListener("click", (event) => event.stopPropagation());
          action.className = "badge badge-zenodo";
          action.href = `https://doi.org/${normalizeDoi(record.doi)}`;
          action.title = record.title;
          action.textContent = "Zenodo ↗";
          return action;
        }),
      ];
    }

    const requestBtn = document.createElement("button");
    requestBtn.type = "button";
    requestBtn.className = "badge badge-contact";
    requestBtn.title = "Review the data use terms and email a request";
    requestBtn.innerHTML = `${ICON_LOCK}<span>Request access</span>`;
    requestBtn.addEventListener("click", (event) => {
      event.stopPropagation();
      openAgreement(dataset);
    });
    return [...deliverableLinks, requestBtn];
  }

  function buildTree(dataset) {
    const root = createFolderNode("");
    for (const fullPath of dataset.paths) {
      const parts = fullPath.split("/").slice(1); // drop the top-level folder name (shown as dataset header)
      const cat = extCategory(fileType(parts[parts.length - 1]));
      let node = root;
      node.fileCount += 1;
      node.extCounts[cat] = (node.extCounts[cat] || 0) + 1;
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        const isFile = index === parts.length - 1;
        if (isFile) {
          node.files.push(part);
        } else {
          if (!node.children.has(part)) node.children.set(part, createFolderNode(part));
          node = node.children.get(part);
          node.fileCount += 1;
          node.extCounts[cat] = (node.extCounts[cat] || 0) + 1;
        }
      }
    }
    return root;
  }

  function createFolderNode(name) {
    return { name, fileCount: 0, extCounts: {}, children: new Map(), files: [] };
  }

  function renderNodeChildren(node, container) {
    for (const child of node.children.values()) {
      container.appendChild(createFolderElement(child));
    }
    for (const file of node.files) {
      container.appendChild(createFileElement(file));
    }
  }

  const ICON_FOLDER =
    '<svg class="folder-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path d="M4 6.5A1.5 1.5 0 0 1 5.5 5h4l1.5 2h7A1.5 1.5 0 0 1 19.5 8.5v9A1.5 1.5 0 0 1 18 19H5.5A1.5 1.5 0 0 1 4 17.5v-11Z" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  const CATEGORY_ORDER = ["raster", "table", "doc", "archive", "other"];

  function createFolderElement(node) {
    const details = document.createElement("details");
    details.className = "tree-folder";

    const summary = document.createElement("summary");
    const icon = document.createElement("span");
    icon.className = "folder-icon-wrap";
    icon.innerHTML = ICON_FOLDER;
    const label = document.createElement("span");
    label.className = "folder-name";
    label.textContent = node.name;
    const mix = createCompositionBar(node.extCounts, node.fileCount);
    const count = document.createElement("span");
    count.className = "count-pill";
    count.textContent = formatNumber(node.fileCount);
    summary.append(icon, label, mix, count);

    const children = document.createElement("div");
    children.className = "tree-children";

    let rendered = false;
    function ensureRendered() {
      if (rendered) return;
      renderNodeChildren(node, children);
      rendered = true;
    }

    details.append(summary, children);
    details.addEventListener("toggle", function () {
      if (details.open) ensureRendered();
    });

    return details;
  }

  function createFileElement(name) {
    const row = document.createElement("div");
    row.className = "file-row";
    const label = document.createElement("span");
    label.className = "file-name";
    label.textContent = name;
    const type = document.createElement("span");
    const ext = fileType(name);
    type.className = `file-type file-type-${extCategory(ext)}`;
    type.textContent = ext;
    row.append(label, type);
    return row;
  }

  const EXT_CATEGORY = {
    TIF: "raster",
    XML: "raster",
    JSON: "raster",
    NC: "raster",
    CSV: "table",
    TXT: "table",
    XLSX: "table",
    PDF: "doc",
    PNG: "doc",
    ZIP: "archive",
    "7Z": "archive",
  };

  function extCategory(ext) {
    return EXT_CATEGORY[ext] || "other";
  }

  function createCompositionBar(extCounts, total) {
    const bar = document.createElement("span");
    bar.className = "mix-bar";
    if (!total) return bar;
    const parts = [];
    for (const cat of CATEGORY_ORDER) {
      const n = extCounts[cat];
      if (!n) continue;
      parts.push(`${n} ${cat}`);
      const segment = document.createElement("span");
      segment.className = `mix-segment mix-segment-${cat}`;
      segment.style.width = `${(n / total) * 100}%`;
      bar.appendChild(segment);
    }
    bar.title = parts.join(", ");
    return bar;
  }

  function renderSearch(query) {
    const datasets = visibleDatasets();
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    const matches = [];

    outer: for (const dataset of datasets) {
      for (const fullPath of dataset.paths) {
        const candidate = fullPath.toLowerCase();
        if (terms.every((term) => candidate.includes(term))) {
          matches.push({ fullPath, dataset });
          if (matches.length >= MAX_SEARCH_RESULTS) break outer;
        }
      }
    }

    els.tree.hidden = true;
    els.searchResults.hidden = false;
    els.statusLine.textContent = `${formatNumber(matches.length)} shown for "${query}"`;

    const fragment = document.createDocumentFragment();
    if (!matches.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "No matching files.";
      fragment.appendChild(empty);
    } else {
      for (const match of matches) {
        fragment.appendChild(createSearchRow(match));
      }
    }
    els.searchResults.replaceChildren(fragment);
  }

  function createSearchRow(match) {
    const row = document.createElement("div");
    row.className = "result-row";
    const path = document.createElement("span");
    path.className = "result-path";
    path.textContent = match.fullPath;
    const badges = createDatasetActions(match.dataset);
    for (const badge of badges) badge.classList.add("badge-small");
    const badgesWrap = document.createElement("span");
    badgesWrap.className = "dataset-badges";
    badgesWrap.append(...badges);
    row.append(path, badgesWrap);
    return row;
  }

  function fileType(name) {
    if (name.endsWith(".tif.aux.xml")) return "AUX";
    if (name.endsWith(".tif.aux.json")) return "JSON";
    const index = name.lastIndexOf(".");
    return index >= 0 ? name.slice(index + 1).toUpperCase() : "FILE";
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("en-US");
  }

  function showError(message) {
    els.statusLine.textContent = "Error";
    const error = document.createElement("div");
    error.className = "error-state";
    error.textContent = message;
    els.tree.replaceChildren(error);
  }
})();
