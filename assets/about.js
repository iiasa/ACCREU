(function () {
  "use strict";

  document.addEventListener("DOMContentLoaded", init);

  async function init() {
    bindThemeToggle();
    try {
      const [manifest, deliverables] = await Promise.all([
        fetch("catalog/manifest.json").then((r) => r.json()),
        fetch("catalog/deliverables.json").then((r) => r.json()),
      ]);
      renderStats(manifest);
      renderDeliverableTable(manifest.datasets, deliverables.deliverables || {});
    } catch (error) {
      document.getElementById("deliverableTable").textContent = `Could not load the catalog: ${error.message}`;
    }
  }

  function bindThemeToggle() {
    document.getElementById("themeToggle").addEventListener("click", function () {
      const current = document.documentElement.getAttribute("data-theme") === "light" ? "light" : "dark";
      const next = current === "light" ? "dark" : "light";
      document.documentElement.setAttribute("data-theme", next);
      try {
        localStorage.setItem("accreu-theme", next);
      } catch (e) {}
    });
  }

  function renderStats(manifest) {
    const all = manifest.datasets;
    const rows = [
      ["Files cataloged", formatNumber(manifest.total_files)],
      ["Datasets", formatNumber(all.length)],
      ["On Zenodo", `${all.filter((d) => d.zenodo).length} of ${all.length}`],
      ["Deliverables linked", String(new Set(all.flatMap((d) => d.deliverables || [])).size)],
    ];
    const fragment = document.createDocumentFragment();
    for (const [label, value] of rows) {
      const tile = document.createElement("div");
      tile.className = "stat-tile";
      const dt = document.createElement("dt");
      const dd = document.createElement("dd");
      dt.textContent = label;
      dd.textContent = value;
      tile.append(dt, dd);
      fragment.appendChild(tile);
    }
    document.getElementById("statRow").replaceChildren(fragment);
  }

  function renderDeliverableTable(datasets, deliverables) {
    const table = document.createElement("table");
    const head = table.createTHead().insertRow();
    for (const label of ["Deliverable", "Title", "Datasets in this catalog"]) {
      const th = document.createElement("th");
      th.textContent = label;
      head.appendChild(th);
    }
    const body = table.createTBody();
    for (const [id, info] of Object.entries(deliverables)) {
      const linked = datasets.filter((d) => (d.deliverables || []).includes(id));
      const row = body.insertRow();

      const idCell = row.insertCell();
      const link = document.createElement("a");
      link.href = info.url;
      link.target = "_blank";
      link.rel = "noopener";
      link.className = "badge badge-deliverable";
      link.textContent = `${id} ↗`;
      idCell.appendChild(link);

      row.insertCell().textContent = info.title;

      const dsCell = row.insertCell();
      if (!linked.length) {
        dsCell.className = "muted";
        dsCell.textContent = "—";
      } else {
        const list = document.createElement("ul");
        for (const d of linked) {
          const li = document.createElement("li");
          const a = document.createElement("a");
          a.href = `index.html?deliverable=${encodeURIComponent(id)}`;
          a.textContent = d.label;
          li.appendChild(a);
          list.appendChild(li);
        }
        dsCell.appendChild(list);
      }
    }
    document.getElementById("deliverableTable").replaceChildren(table);
  }

  function formatNumber(value) {
    return Number(value || 0).toLocaleString("en-US");
  }
})();
