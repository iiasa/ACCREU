# ACCREU Data Catalog

A static website (GitHub Pages: <https://iiasa.github.io/ACCREU/>) for finding the
datasets produced by [ACCREU](https://www.accreu.eu/) (Assessing Climate Change Risk
in EUrope, Horizon Europe grant agreement No. 101081358). Each dataset links to its
Zenodo record, or to an access request if it is not public yet, and to the ACCREU
deliverable report that describes it. An "Ask AI" assistant answers questions about
the datasets and the deliverables.

| Page or file | What it is |
|---|---|
| `index.html` | the catalog |
| `about.html` | about the catalog, datasets by deliverable |
| `catalog/manifest.json` | the list of datasets: label, description, Zenodo DOI, deliverables |
| `catalog/paths.txt` | the file list of every dataset |
| `catalog/deliverables.json` | the public ACCREU deliverables and their PDF links |
| `catalog/knowledge/` | the assistant's search index (built by `build_knowledge.py`) |
| `add_dataset.py` | adds a dataset (see below) |
| `worker/` | the assistant's proxy, which keeps the AI key secret (see `worker/README.md`) |

## Adding a dataset

You need Python 3.9 or newer. Nothing else has to be installed.

**A dataset published on Zenodo:** give its record link (or DOI) and the deliverable
it belongs to:

    python add_dataset.py https://zenodo.org/records/1234567 --deliverable D2.4

The title, description and full file list are read from Zenodo, including the files
inside zip archives. Options:

- `--deliverable` can be repeated, for example `-d D2.1 -d D2.4`.
- `--label "Short name"` sets a shorter name for the catalog.
- `--description "..."` replaces the description taken from Zenodo.

**A dataset that is not public yet** (held on the IIASA Accelerator; visitors press
"Request access"): give the Accelerator folder name, a label and its files, either
from a local copy of the folder or from a text file with one path per line:

    python add_dataset.py --request-access --folder CMCC_energy --label "CMCC Energy Demand Shocks" --files-from-dir D:/data/CMCC_energy --deliverable D2.2 --description "..."

Use `--files list.txt` instead of `--files-from-dir` for a text file.

Running the script again for the same record or folder updates that entry instead of
adding a second one. Labels, descriptions and deliverables can also be edited by hand
in `catalog/manifest.json`.

**Then check it locally:**

    python -m http.server 8000

Open <http://localhost:8000>, and publish it as described below.

### Other updates

- **Zenodo records got new files or versions:** run `python sync_zenodo.py` to refresh
  every Zenodo file list.
- **A new deliverable report is public:** add it to `catalog/deliverables.json` (id,
  title, PDF link), then run `python build_knowledge.py` so the assistant can quote
  it. This step needs `pip install playwright` and `pdftotext`, which comes with Git
  for Windows.
- **Assistant index:** after adding datasets you can run
  `python build_knowledge.py --catalog-only` (about a minute). If you skip it, the
  site handles new entries itself, slightly slower on a visitor's first question.
  `add_dataset.py` runs this step automatically when Playwright is installed.

## Publishing to GitHub, step by step

The site is served by GitHub Pages straight from the `main` branch of
<https://github.com/iiasa/ACCREU>, so a push publishes it. These steps use Git from a
terminal; GitHub Desktop works the same way (Fetch, Commit, Push).

1. **Get the latest version first,** in case someone else changed it:

       git pull

2. **Make your changes,** for example run `add_dataset.py`, and check them locally.

3. **See what changed:**

       git status

   Only catalog and site files should be listed. Never commit `worker/.dev.vars` or
   any file containing a key; `.gitignore` already excludes them.

4. **Commit,** with a short message saying what changed:

       git add -A
       git commit -m "Add GLOFRIS flood risk dataset (D2.1)"

5. **Push:**

       git push

6. **Check the site.** GitHub Pages updates in 1 to 2 minutes (progress under the
   repository's **Actions** tab). Reload <https://iiasa.github.io/ACCREU/> with
   Ctrl+F5.

If `git push` is rejected because GitHub has newer commits, run `git pull`, then
`git push` again.

## The AI assistant

"Ask AI" works in two steps:

1. **Finding sources, in the browser.** A small open model,
   [BAAI bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5)
   (MIT, 34 MB), is bundled in `assets/models/` with the
   [transformers.js](https://github.com/huggingface/transformers.js) runtime
   (Apache-2.0) in `assets/vendor/transformers/`. It runs in a background worker, so
   the page never freezes. It matches the question by meaning against the catalog,
   the ACCREU Zenodo community and about 3,600 passages of the deliverable reports.
2. **Writing the answer, through the proxy.** The question and those sources go to
   the Cloudflare Worker in [worker/](worker/). The Worker holds the OpenRouter key as
   a secret and asks a free hosted model (NVIDIA Nemotron 3 Ultra first) to answer
   from the sources only, citing them as [1], [2]. The answer is streamed, and each
   citation links to its source (reports open at the cited page).
