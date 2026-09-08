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
  GLOBIOM_LandCover: "GLOBIOM Land Cover Projections",
  CROP_ANALYSIS: "Crop Area, Production & Revenue Analysis",
  WP3_CS3_2_Lido_Alberoni: "Case Study — Lido di Alberoni",
  cwatm_rcp4p5_daily: "CWatM Daily Discharge — RCP4.5",
  CMCC_energy: "CMCC Energy Demand Shocks",
  GLOFRIS_flood: "GLOFRIS Flood Risk Model Outputs",
  "GLOFRIS_NUTS3(for_Lorenza)": "GLOFRIS Flood Risk — NUTS3 Aggregates",
  GLOBIOM_IAMC: "GLOBIOM IAMC-Template Outputs",
  D2_3_Health: "Health Impact Assessment",
  Inflation_adjusted: "Inflation-Adjusted Economic Data",
  CWatM_RCP4p5: "CWatM Hydrology — RCP4.5",
  DIVA_SLR_Impact: "DIVA — Sea-Level Rise Impact",
  KIP_INCA_Ecosystem_Services_Evaluation: "KIP-INCA Ecosystem Services Evaluation",
  CMCC_lab_prod: "CMCC Labour Productivity Shocks",
  HeatStress: "Heat Stress Indicators",
};

// ACCREU project jargon: D<n>.<m> = Deliverable, WP<n> = Work Package, CS<n>.<m> = Case Study.
const TAGS = {
  D2_4_Crop_Pollination_Climate_Only: { type: "D", title: "Deliverable 2.4" },
  D2_4_Crop_Pollination_Full_Workflow: { type: "D", title: "Deliverable 2.4" },
  D2_3_Health: { type: "D", title: "Deliverable 2.3" },
  WP3_CS3_2_Lido_Alberoni: { type: "W", title: "Work Package 3 — Case Study 3.2" },
};

// Confirmed Zenodo matches: exactly one per Accelerator folder, kept ONLY where
// the file naming/format genuinely supports it being the same data (not just the
// same topic). E.g. a folder named "..._daily" cannot be the same data as a
// Zenodo record whose files are named "..._year_..." (annual) — different
// temporal resolution means different files, so no match is recorded for it.
const ZENODO = {
  DIVA_SLR_Impact: {
    doi: "10.5281/zenodo.20545890",
    title: "DIVACoast model results: sea-level rise impacts and adaptation response",
  },
  D2_3_Health: {
    doi: "10.5281/zenodo.21129554",
    title: "Future health and economic impacts of extreme heat on older adults",
  },
  CWatM_RCP4p5: {
    doi: "10.5281/zenodo.13767595",
    title: "SSP-aligned projected European water withdrawal/consumption at 5 arcminutes",
  },
};

// Related ACCREU Zenodo records that do NOT correspond file-for-file to any of
// the 20 Accelerator folders above (different temporal resolution, different
// file types, or code rather than data). Listed as their own standalone rows
// instead of being force-attached to a folder whose actual files differ.
// `files` is the record's real file listing straight from the Zenodo API
// (https://zenodo.org/api/records/<id>), so these rows can be browsed the
// same way as an Accelerator folder.
const ZENODO_ONLY = [
  {
    label: "Energy Systems Model (AETOS)",
    doi: "10.5281/zenodo.18771647",
    title: "Climate change impacts in EU's energy systems - Energy Systems Model",
    description: "Technoeconomic energy-system model inputs and outputs across RCP2.6/4.5/7.0 climate scenarios.",
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
    description: "Gridded residential air-conditioning ownership and electricity-demand projections, SSP1/2/3/5, 2020-2050.",
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
    description:
      "Decadal BIOCLIM variables from ISIMIP3b bias-adjusted climate forcing across 5 GCMs, historical and SSP1-2.6/2-4.5/3-7.0/5-8.5.",
    files: ["historical.zip", "Screenshot.png", "ssp245.zip", "ssp585.zip", "ssp370.zip", "ssp126.zip"],
  },
  {
    label: "Wildfire & Biodiversity Meta-Analysis",
    doi: "10.5281/zenodo.18678145",
    title: "Wildfire and Biodiversity Meta-Analysis Dataset (European Forests)",
    description: "Meta-analysis of wildfire effects on European forest fauna and flora abundance, with effect-size estimates.",
    files: ["data_meta_analysis_gerber_v3.csv", "data_meta_analysis_gerber_v3_study_list.xlsx"],
  },
  {
    label: "Flood/Crop Workflow Code",
    doi: "10.5281/zenodo.15923032",
    title: "Integrated Flood Exposure, Land-Use Impact, Crop & Grassland data",
    description: "Reproducible workflows for flood exposure, land-use impact, and crop/grassland outcomes across models and RCPs.",
    files: ["andrenakhavali/ACCREU-Release.zip"],
  },
];

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

const tops = [...folderPaths.keys()].sort((a, b) => folderPaths.get(b).length - folderPaths.get(a).length);

const allPaths = [];
const datasets = [];

for (const top of tops) {
  const paths = folderPaths.get(top).sort();
  allPaths.push(...paths);

  const extCounts = [...folderExt.get(top).entries()].sort((a, b) => b[1] - a[1]);

  datasets.push({
    id: slugify(top),
    source_folder: top,
    label: NICE_NAMES[top] || top,
    tag: TAGS[top] || null,
    file_count: paths.length,
    extensions: Object.fromEntries(extCounts),
    zenodo: ZENODO[top] ? [ZENODO[top]] : null,
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
