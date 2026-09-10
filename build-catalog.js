// One-off build script: turns download-links.txt (presigned, expiring S3 URLs)
// into a permanent, link-free catalog (paths + counts only) for the static site.
const fs = require("fs");
const path = require("path");

const ROOT = __dirname;
const SRC = path.join(ROOT, "download-links.txt");
const S3_PREFIX = "/accelerator-prod/accreu/user-uploads/";

// Nice display names for the raw top-level folder names found in the S3 dump.
const NICE_NAMES = {
  D2_4_Crop_Pollination_Climate_Only: "Crop Pollination — Climate-Only Scenarios",
  D2_4_Crop_Pollination_Full_Workflow: "Crop Pollination — Full Workflow",
  Flood: "Flood Exposure & Impact Model Outputs",
  ISIMIP3b_monthly: "ISIMIP3b Monthly Climate Forcing (Europe)",
  DTU_Wildfire_Simulations: "DTU Wildfire Risk Simulations",
  WP3_CS3_2_Lido_Alberoni: "Case Study — Lido di Alberoni",
  CMCC_energy: "CMCC Energy Demand Shocks",
  GLOFRIS_flood: "GLOFRIS Flood Risk Model Outputs",
  "GLOFRIS_NUTS3(for_Lorenza)": "GLOFRIS Flood Risk — NUTS3 Aggregates",
  GLOBIOM_IAMC: "GLOBIOM IAMC-Template Outputs",
  D2_3_Health: "Health Impact Assessment",
  Inflation_adjusted: "Inflation-Adjusted Economic Data",
  DIVA_SLR_Impact: "DIVA — Sea-Level Rise Impact",
  KIP_INCA_Ecosystem_Services_Evaluation: "KIP-INCA Ecosystem Services Evaluation",
  CMCC_lab_prod: "CMCC Labour Productivity Shocks",
};

// Accelerator top-level folders dropped from the catalog entirely.
// - CROP_ANALYSIS: this is the pre-Zenodo working copy of the "Flood/Crop
//   Workflow Code" record below (10.5281/zenodo.15923032) — same dataset, so
//   only the Zenodo entry (with its permanent link) is kept.
// - HeatStress, GLOBIOM_LandCover: removed from the catalog per request.
const EXCLUDE_TOPS = new Set(["CROP_ANALYSIS", "HeatStress", "GLOBIOM_LandCover"]);

// ACCREU project jargon: D<n>.<m> = Deliverable, WP<n> = Work Package, CS<n>.<m> = Case Study.
const TAGS = {
  D2_4_Crop_Pollination_Climate_Only: { type: "D", title: "Deliverable 2.4" },
  D2_4_Crop_Pollination_Full_Workflow: { type: "D", title: "Deliverable 2.4" },
  D2_3_Health: { type: "D", title: "Deliverable 2.3" },
  WP3_CS3_2_Lido_Alberoni: { type: "W", title: "Work Package 3 — Case Study 3.2" },
};

// CWatM discharge/runoff output that Amanda uploaded to the Accelerator, split
// across two S3 top-level folders by temporal resolution. Combined into one
// dataset row with "daily"/"monthly" subfolders instead of two separate rows
// — it's the same model run, just two output frequencies. No Zenodo match:
// the CWatM data itself only lives on the Accelerator (see ZENODO_ONLY below
// for the separate, unrelated water-demand Zenodo record).
const MERGE_GROUPS = [
  {
    id: "cwatm-rcp4p5",
    label: "CWatM Discharge & Runoff — RCP4.5",
    members: [
      { sub: "daily", top: "cwatm_rcp4p5_daily" },
      { sub: "monthly", top: "CWatM_RCP4p5" },
    ],
  },
];

// ACCREU Zenodo records that do NOT correspond file-for-file to any Accelerator
// folder (different temporal resolution, different file types, a curated/
// cleaned release vs. the raw working folder, or code rather than data).
// Listed as their own standalone rows instead of being force-attached to a
// folder whose actual files differ. `files` is the record's real file listing
// and `description` is verbatim from the Zenodo record's own description
// (https://zenodo.org/api/records/<id>), trimmed to the lead paragraph where
// the full text is long — so these rows can be browsed the same way as an
// Accelerator folder, with the same description shown on Zenodo itself.
const ZENODO_ONLY = [
  {
    label: "water_demand_SSPv3_0_1",
    doi: "10.5281/zenodo.13767595",
    title: "SSP-aligned projected European water withdrawal/consumption at 5 arcminutes",
    // Verbatim from the Zenodo record's description (zenodo.org/api/records/13767595).
    description:
      "The dataset provides annual water withdrawal and consumption estimates for Europe at a spatial resolution of 5 arcminutes, covering the periods 1960-2020 (historical) and 2020-2100 for four SSPs (1, 2, 3, and 5).",
    files: [
      "historical_dom_year_millionm3_5min_Europe_1960_2020.nc",
      "historical_ind_year_millionm3_5min_Europe_1960_2020.nc",
      "ssp1_dom_year_millionm3_5min_Europe_2020_2100.nc",
      "ssp1_ind_year_millionm3_5min_Europe_2020_2100.nc",
      "ssp2_dom_year_millionm3_5min_Europe_2020_2100.nc",
      "ssp2_ind_year_millionm3_5min_Europe_2020_2100.nc",
      "ssp3_dom_year_millionm3_5min_Europe_2020_2100.nc",
      "ssp3_ind_year_millionm3_5min_Europe_2020_2100.nc",
      "ssp5_dom_year_millionm3_5min_Europe_2020_2100.nc",
      "ssp5_ind_year_millionm3_5min_Europe_2020_2100.nc",
      "Readme-Data and Methods.pdf",
    ],
  },
  {
    label: "Energy Systems Model (AETOS)",
    doi: "10.5281/zenodo.18771647",
    title: "Climate change impacts in EU's energy systems - Energy Systems Model",
    // Verbatim from the Zenodo record's description (zenodo.org/api/records/18771647).
    description:
      "This repository contains datasets and model inputs developed within the ACCREU project to assess climate change impacts on European energy systems. The data support technoeconomic modelling of electricity demand and supply under multiple climate scenarios (RCP2.6, RCP4.5, and RCP7.0), including impacts on renewable generation, hydropower availability, thermal plant performance, and temperature-driven demand changes.",
    files: [
      "ACCREU_BASE.xlsx", "ACCREU_H70_NoTrade.txt", "ACCREU_H70v2_NoTrade.xlsx", "ACCREU_M45.txt",
      "ACCREU_H26.txt", "ACCREU_L70.xlsx", "ACCREU_L45.xlsx", "ACCREU_BASE.txt", "ACCREU_M45.xlsx",
      "ACCREU_H45.xlsx", "ACCREU_M70.xlsx", "osemosys_fast_ACCREU.txt", "ACCREU_H45.txt", "ACCREU_H70.txt",
      "ACCREU_L45.txt", "ACCREU_L26.txt", "ACCREU_M26.txt", "ACCREU_L70.txt", "ACCREU_M70.txt",
      "ACCREU_H26.xlsx", "ACCREU_H70.xlsx", "ACCREU_L26.xlsx", "ACCREU_M26.xlsx",
    ],
  },
  {
    label: "Residential Cooling Energy Demand",
    doi: "10.5281/zenodo.18456618",
    title: "Global gridded scenarios of residential cooling energy demand to 2050",
    // Verbatim from the Zenodo record's description (zenodo.org/api/records/18456618).
    description:
      "This repository hosts output data for SSPs126, 245, 370 and 585 on the estimated and future projected ownership of residential air conditioning (% of households), the related energy consumption (TWh/yr.), and the underlying population counts (useful to quantify the per-capita average consumption or the headcount of people affected by the cooling gap).",
    files: [
      "source_code_data_replication_figures.zip",
      "pop_ssp1_ssp2_ssp3_ssp5_2020_2050.nc",
      "ac_penetration_ssp1_ssp2_ssp3_ssp5_2020_2050.nc",
      "ac_TWh_ssp1_ssp2_ssp3_ssp5_2020_2050.nc",
      "replication_package_input_data.7z",
    ],
  },
  {
    label: "Decadal BIOCLIM (ISIMIP3b)",
    doi: "10.5281/zenodo.13259644",
    title: "Decadal BIOCLIM estimates based on ISIMIP3b climatic forcing data for the European continent",
    // Verbatim from the Zenodo record's description (zenodo.org/api/records/13259644).
    description:
      "This dataset contains BIOCLIM variables (plus huss, sfcwind, rsds) which have been prepared and calculated from the original ISIMIP3b bias-adjusted climate forcing data from 5 GCM models (obtained on 2023-08-07).",
    files: ["historical.zip", "Screenshot.png", "ssp245.zip", "ssp585.zip", "ssp370.zip", "ssp126.zip"],
  },
  {
    label: "Wildfire & Biodiversity Meta-Analysis",
    doi: "10.5281/zenodo.18678145",
    title: "Wildfire and Biodiversity Meta-Analysis Dataset (European Forests)",
    // Verbatim from the Zenodo record's description (zenodo.org/api/records/18678145), lead paragraph only.
    description:
      "Here is the dataset of a meta-analysis examining the effects of fires on taxa abundances within various European forest fauna and flora. The analysis focuses on how different taxa respond to fire, providing quantitative estimates of these responses using effect sizes. The dataset provides 2192 unique effect sizes from 819 unique taxa reported in 29 studies investigating wild or prescribed fires.",
    files: ["data_meta_analysis_gerber_v3.csv", "data_meta_analysis_gerber_v3_study_list.xlsx"],
  },
  {
    label: "Flood/Crop Workflow Code",
    doi: "10.5281/zenodo.15923032",
    title: "Integrated Flood Exposure, Land-Use Impact, Crop & Grassland data",
    // Verbatim from the Zenodo record's description (zenodo.org/api/records/15923032).
    description:
      "A comprehensive, reproducible suite of workflows for assessing flood exposure, land-use impacts, and crop-area, production, and revenue outcomes across multiple models, RCPs, and adaptation or mitigation strategies (snapshot years 2020-2050).",
    files: ["andrenakhavali/ACCREU-Release.zip"],
  },
  {
    label: "Extreme Heat Health & Economic Impacts",
    doi: "10.5281/zenodo.21129554",
    title: "Future health and economic impacts of extreme heat on older adults: a subnational analysis for Europe",
    // Verbatim from the Zenodo record's description (zenodo.org/api/records/21129554).
    description:
      "This dataset contains information collected during the ACCREU (Assessment of Climate Change in Europe) study, carried out at BC3 (Basque Centre for Climate Change) in 2025. The dataset includes six files in Excel format that record estimates of mortality, morbidity and their costs attributable to extreme heat in Europe, at NUTS3 level for people over 65 years of age. These estimates have been made for a historical period and for projections in 2030, 2050 and 2070 under four different climate scenarios (combinations of SSP and RCP).",
    files: [
      "Heat related morbidity WTP based costs_LoroñoLeturiondo_et_al_2026.xlsx",
      "Heat-related mortality costs VSL_NUTS3_people over 65_LoroñoLeturiondo_et_al_2026.xlsx",
      "Heat related morbidity estimates_ NUTS3_people over 65_LoroñoLeturiondo_et_al_2026.xlsx",
      "Heat related morbidity medical costs_LoroñoLeturiondo_et_al_2026.xlsx",
      "Heat-related mortality costs VOLY_NUTS3_people over 65_LoroñoLeturiondo_et_al_2026.xlsx",
      "Heat-related mortality estimates_NUTS3_people over 65_LoroñoLeturiondo_et_al_2026.xlsx",
    ],
  },
  {
    label: "DIVACoast Sea-Level Rise Impacts",
    doi: "10.5281/zenodo.20545890",
    title: "DIVACoast model results: sea-level rise impacts and adaptation response under different adaptation paradigms",
    // Verbatim from the Zenodo record's description (zenodo.org/api/records/20545890).
    description:
      "This dataset contains modelled outputs of the DIVACoast model on flood risk driven by sea-level rise and adaptation response from the ACCREU EU project, structured across three spatial scales: NUTS2/GADM1 (subnational), country and global.",
    files: [
      "ACCREU_GADM1_NUT2.csv",
      "ACCREU_COUNTRY.csv",
      "ACCREU_COUNTRY_CFPS.csv",
      "ACCREU_GLOBAL.csv",
      "ACCREU_GADM1_NUT2_CFPS.csv",
      "ACCREU_GLOBAL_CFPS.csv",
      "README.md",
    ],
  },
];

// Description for Accelerator ("Request access") folders that have no Zenodo
// abstract: a plain-language, two-part summary of what's actually in them —
// how the files are organized into subfolders, then what file types they are.
// `relPaths` are paths relative to the dataset's own root (top-level folder
// name / merge-group id already stripped) so subfolder names come out clean.
function describeAccelFolder(relPaths, extCountsSorted, fileCount) {
  const subfolders = [...new Set(relPaths.filter((p) => p.includes("/")).map((p) => p.split("/")[0]))].sort();
  const fmt = (n) => n.toLocaleString("en-US");

  const organization = subfolders.length
    ? `${fmt(fileCount)} files in ${subfolders.length} subfolder${subfolders.length === 1 ? "" : "s"}: ${subfolders.join(", ")}`
    : `${fmt(fileCount)} files, no subfolders`;

  const extSummary = extCountsSorted
    .slice(0, 6)
    .map(([ext, count]) => `${fmt(count)} ${ext.toUpperCase()}`)
    .join(", ");
  const fileTypes = `File types: ${extSummary}${extCountsSorted.length > 6 ? ", …" : ""}`;

  return `${organization}\n\n${fileTypes}`;
}

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const lines = fs.readFileSync(SRC, "utf-8").split(/\r?\n/).filter(Boolean);

const folderPaths = new Map(); // top folder -> array of relative paths (including folder)
const folderExt = new Map(); // top folder -> Map(ext -> count)

for (const line of lines) {
  let u;
  try {
    u = new URL(line);
  } catch (e) {
    continue;
  }
  const decoded = decodeURIComponent(u.pathname);
  const rel = decoded.startsWith(S3_PREFIX) ? decoded.slice(S3_PREFIX.length) : decoded;
  const top = rel.split("/")[0];

  if (!folderPaths.has(top)) folderPaths.set(top, []);
  folderPaths.get(top).push(rel);

  const dot = rel.lastIndexOf(".");
  const ext = dot >= 0 ? rel.slice(dot + 1).toLowerCase() : "(none)";
  if (!folderExt.has(top)) folderExt.set(top, new Map());
  const m = folderExt.get(top);
  m.set(ext, (m.get(ext) || 0) + 1);
}

const mergedTops = new Set(MERGE_GROUPS.flatMap((g) => g.members.map((m) => m.top)));

const tops = [...folderPaths.keys()]
  .filter((t) => !mergedTops.has(t) && !EXCLUDE_TOPS.has(t))
  .sort((a, b) => folderPaths.get(b).length - folderPaths.get(a).length);

const allPaths = [];
const datasets = [];

for (const top of tops) {
  const paths = folderPaths.get(top).sort();
  allPaths.push(...paths);

  const extCounts = [...folderExt.get(top).entries()].sort((a, b) => b[1] - a[1]);
  const relPaths = paths.map((p) => p.slice(top.length + 1));

  datasets.push({
    id: slugify(top),
    source_folder: top,
    label: NICE_NAMES[top] || top,
    description: describeAccelFolder(relPaths, extCounts, paths.length),
    tag: TAGS[top] || null,
    file_count: paths.length,
    extensions: Object.fromEntries(extCounts),
    zenodo: null,
  });
}

for (const group of MERGE_GROUPS) {
  const extCounts = new Map();
  const paths = [];
  const sourceNames = [];

  for (const { sub, top } of group.members) {
    const rawPaths = folderPaths.get(top) || [];
    for (const p of rawPaths) paths.push(`${group.id}/${sub}/${p.slice(top.length + 1)}`);

    const em = folderExt.get(top);
    if (em) for (const [ext, count] of em) extCounts.set(ext, (extCounts.get(ext) || 0) + count);
    sourceNames.push(`${top} (${sub})`);
  }

  paths.sort();
  allPaths.push(...paths);

  const sortedExtCounts = [...extCounts.entries()].sort((a, b) => b[1] - a[1]);
  const relPaths = paths.map((p) => p.slice(group.id.length + 1));

  datasets.push({
    id: group.id,
    source_folder: sourceNames.join(" + "),
    label: group.label,
    description: describeAccelFolder(relPaths, sortedExtCounts, paths.length),
    tag: null,
    file_count: paths.length,
    extensions: Object.fromEntries(sortedExtCounts),
    zenodo: null,
  });
}

// Standalone Zenodo-only rows: real ACCREU outputs that don't correspond to any
// Accelerator folder's actual files, so they get their own entry rather than
// being force-attached to a folder with different content. Their file list
// comes straight from Zenodo (not the S3 export), browsable the same as an
// Accelerator folder.
for (const record of ZENODO_ONLY) {
  const id = slugify(record.label);
  const paths = record.files.map((f) => `${id}/${f}`).sort();
  allPaths.push(...paths);

  const extCounts = new Map();
  for (const f of record.files) {
    const dot = f.lastIndexOf(".");
    const ext = dot >= 0 ? f.slice(dot + 1).toLowerCase() : "(none)";
    extCounts.set(ext, (extCounts.get(ext) || 0) + 1);
  }

  datasets.push({
    id,
    source_folder: null,
    label: record.label,
    description: record.description,
    tag: null,
    file_count: paths.length,
    extensions: Object.fromEntries([...extCounts.entries()].sort((a, b) => b[1] - a[1])),
    zenodo: [{ doi: record.doi, title: record.title }],
  });
}

fs.writeFileSync(path.join(ROOT, "catalog", "paths.txt"), allPaths.join("\n") + "\n", "utf-8");

const manifest = {
  generated_at: new Date().toISOString(),
  source_note:
    "Generated from an internal export of the IIASA Accelerator (S3) storage for the ACCREU project. The export contained temporary, pre-signed download URLs (valid ~30 minutes); those signatures are intentionally not published here. This catalog lists file names and folder structure only.",
  catalog_file: "catalog/paths.txt",
  total_files: allPaths.length,
  datasets,
};

fs.writeFileSync(path.join(ROOT, "catalog", "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");

console.log("Total files:", allPaths.length);
console.log("Datasets:", datasets.length);
for (const d of datasets) {
  const count = d.file_count === null ? "  (n/a)" : d.file_count.toString().padStart(6);
  console.log(`  ${count}  ${d.source_folder || d.label}  ${d.zenodo ? "[zenodo]" : ""}`);
}
