# ACCREU Data Catalog

Static GitHub Pages site cataloging the research data files produced across
[ACCREU](https://www.accreu.eu/) (Assessing Climate Change Risk in EUrope, Horizon Europe
grant agreement No. 101081358) work packages and held on IIASA's internal Accelerator
(S3) storage.

The site lists file and folder names for browsing only — it does **not** embed direct
download links. The original file export contains temporary, pre-signed S3 URLs that
expire roughly 30 minutes after generation, so they cannot be published as permanent
links. Instead:

- Datasets already published with a Zenodo DOI link straight to the permanent record.
- Everything else shows a "Request access" link that emails the data contact.

## Rebuilding the catalog

1. Export a fresh `download-links.txt` (one pre-signed URL per line) from the
   Accelerator platform into the repo root.
2. Run `node build-catalog.js` to regenerate `catalog/manifest.json` and
   `catalog/paths.txt` from it.
3. Update the `ZENODO` mapping at the top of `build-catalog.js` as more datasets get
   archived on Zenodo.
4. Commit and push — GitHub Pages serves directly from `main`.

`download-links.txt` itself is git-ignored: it's a large, short-lived export and isn't
needed once the catalog files are built.
