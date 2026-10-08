"""Add a dataset to the ACCREU Data Catalog (or update one already there).

A dataset published on Zenodo: give its record link or DOI and the ACCREU
deliverable(s) it belongs to. The title, description and complete file list
(including the files inside zip archives) are read from Zenodo:

    python add_dataset.py https://zenodo.org/records/1234567 --deliverable D2.4

A dataset that is not public yet (held on the IIASA Accelerator; visitors use
"Request access"): give its Accelerator folder name, a label, and its file
list, either as a text file with one path per line or as a local copy of the
folder:

    python add_dataset.py --request-access --folder CMCC_energy --label "CMCC Energy Demand Shocks" --files-from-dir D:/data/CMCC_energy --deliverable D2.2

Optional for both: --label, --description, more --deliverable flags.
Running it again for the same record or folder updates that entry.

The script updates catalog/manifest.json and catalog/paths.txt, then
refreshes the assistant's search index if Playwright is installed (otherwise
the site handles new entries on its own; see README). Standard library only,
Python 3.9+.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from html.parser import HTMLParser
from pathlib import Path

from sync_zenodo import MANIFEST, PATHS, extension, http_get, record_id, slugify, sync_dataset

ROOT = Path(__file__).resolve().parent
DELIVERABLES = ROOT / "catalog" / "deliverables.json"


class TextOnly(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.parts: list[str] = []

    def handle_data(self, data):
        self.parts.append(data)


def plain_text(html: str) -> str:
    parser = TextOnly()
    parser.feed(html or "")
    return re.sub(r"\s+", " ", " ".join(parser.parts)).strip()


def short_description(text: str, limit: int = 450) -> str:
    """The first sentences of a description, up to about `limit` characters."""
    if len(text) <= limit:
        return text
    cut = text[:limit]
    end = max(cut.rfind(". "), cut.rfind("! "), cut.rfind("? "))
    return cut[: end + 1] if end > 80 else cut.rsplit(" ", 1)[0] + "…"


def deliverable_tag(ids: list[str]) -> dict | None:
    if not ids:
        return None
    number = ids[0].lstrip("Dd")
    return {"type": "D", "title": f"Deliverable {number}"}


def normalise_deliverables(values: list[str]) -> list[str]:
    known = json.loads(DELIVERABLES.read_text(encoding="utf-8"))["deliverables"]
    out: list[str] = []
    for value in values:
        match = re.fullmatch(r"[Dd]?\s*(\d)\s*\.\s*(\d+)", value.strip())
        if not match:
            sys.exit(f"Not a deliverable code: {value!r} (expected e.g. D2.4)")
        code = f"D{match.group(1)}.{match.group(2)}"
        if code not in known:
            print(f"Note: {code} is not in catalog/deliverables.json, so its badge will have no report link. "
                  f"Add it there (id, title, PDF url) if the report is public.")
        if code not in out:
            out.append(code)
    return out


def zenodo_entry(link: str) -> dict:
    match = re.search(r"zenodo\.(\d+)|records?/(\d+)|^\s*(\d+)\s*$", link)
    if not match:
        sys.exit(f"Not a Zenodo record link or DOI: {link}")
    rec = next(g for g in match.groups() if g)
    meta = json.loads(http_get(f"https://zenodo.org/api/records/{rec}"))
    md = meta.get("metadata", {})
    return {
        "title": md.get("title") or meta.get("title") or f"Zenodo record {rec}",
        # The concept DOI always opens the newest version of the record.
        "doi": meta.get("conceptdoi") or meta.get("doi") or md.get("doi"),
        "description": short_description(plain_text(md.get("description", ""))),
        # Every id this record is known by: the one given, its version, its concept.
        "ids": {rec, str(meta.get("id")), str(meta.get("conceptrecid"))},
    }


def write_catalog(manifest: dict, dataset_id: str, top: str, paths: list[str]) -> None:
    """Replace the dataset's lines in paths.txt (in place) and save both catalog files."""
    old = PATHS.read_text(encoding="utf-8").splitlines()
    mine = {i for i, l in enumerate(old) if slugify(l.split("/", 1)[0]) == dataset_id}
    at = min(mine) if mine else len(old)
    lines = [l for i, l in enumerate(old) if i not in mine]
    lines[at:at] = sorted(paths)
    PATHS.write_text("\n".join(lines) + "\n", encoding="utf-8", newline="\n")
    manifest["total_files"] = sum(d.get("file_count") or 0 for d in manifest["datasets"])
    MANIFEST.write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")


def refresh_assistant_index() -> None:
    try:
        import playwright  # noqa: F401
    except ImportError:
        print("Assistant index not refreshed (Playwright not installed). That is fine: the site embeds new "
              "entries in the visitor's browser. To refresh it: pip install playwright, then "
              "python build_knowledge.py --catalog-only")
        return
    print("Refreshing the assistant's search index…")
    subprocess.run([sys.executable, str(ROOT / "build_knowledge.py"), "--catalog-only"], check=False)


def main() -> int:
    ap = argparse.ArgumentParser(description="Add or update a dataset in the ACCREU Data Catalog.")
    ap.add_argument("zenodo", nargs="?", help="Zenodo record link or DOI, e.g. https://zenodo.org/records/1234567")
    ap.add_argument("--deliverable", "-d", action="append", default=[], help="ACCREU deliverable, e.g. D2.4 (repeatable)")
    ap.add_argument("--label", help="Short name shown in the catalog (default: the Zenodo title)")
    ap.add_argument("--description", help="One or two sentences (default: from Zenodo)")
    ap.add_argument("--request-access", action="store_true", help="Dataset not public yet: visitors request access")
    ap.add_argument("--folder", help="Accelerator folder name (with --request-access)")
    ap.add_argument("--files", help="Text file listing the dataset's files, one path per line (with --request-access)")
    ap.add_argument("--files-from-dir", help="Local copy of the dataset folder to list (with --request-access)")
    ap.add_argument("--no-index", action="store_true", help="Do not refresh the assistant's search index")
    args = ap.parse_args()

    if bool(args.zenodo) == args.request_access:
        ap.error("give either a Zenodo record, or --request-access with --folder")
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    datasets = manifest["datasets"]
    deliverables = normalise_deliverables(args.deliverable)

    if args.zenodo:
        info = zenodo_entry(args.zenodo)
        existing = next((d for d in datasets if any(record_id(z["doi"]) in info["ids"]
                                                     for z in (d.get("zenodo") or []))), None)
        label = args.label or (existing or {}).get("label") or info["title"]
        dataset = existing or {"id": slugify(label)[:60].strip("-"), "source_folder": None,
                               "zenodo": [{"doi": info["doi"], "title": info["title"]}]}
        dataset.update({
            "label": label,
            "description": args.description or (existing or {}).get("description") or info["description"],
        })
        top = dataset["id"]
    else:
        if not args.folder or not args.label or not (args.files or args.files_from_dir):
            ap.error("--request-access needs --folder, --label and --files or --files-from-dir")
        top = args.folder.strip("/\\")
        existing = next((d for d in datasets if d["id"] == slugify(top)), None)
        dataset = existing or {"id": slugify(top), "source_folder": top}
        dataset.update({
            "label": args.label,
            "description": args.description or (existing or {}).get("description") or "",
            "zenodo": None,
        })

    if deliverables or not existing:
        dataset["deliverables"] = deliverables
        dataset["tag"] = deliverable_tag(deliverables)
    if not existing:
        if any(d["id"] == dataset["id"] for d in datasets):
            dataset["id"] += "-2"
        datasets.append(dataset)

    # The file list.
    if args.zenodo:
        print(f"Reading the file list of {info['doi']} from Zenodo…")
        # A record holding only a README keeps the Accelerator file list.
        accelerator = [l for l in PATHS.read_text(encoding="utf-8").splitlines()
                       if dataset.get("source_folder") and l.split("/", 1)[0] != dataset["id"]
                       and slugify(l.split("/", 1)[0]) == dataset["id"]]
        paths = sync_dataset(dataset, accelerator)
    else:
        if args.files_from_dir:
            base = Path(args.files_from_dir)
            names = [p.relative_to(base).as_posix() for p in sorted(base.rglob("*")) if p.is_file()]
        else:
            names = [l.strip().lstrip("/") for l in Path(args.files).read_text(encoding="utf-8").splitlines() if l.strip()]
        paths = [f"{top}/{n}" for n in names]
        counts: dict[str, int] = {}
        for n in names:
            counts[extension(n.rsplit("/", 1)[-1])] = counts.get(extension(n.rsplit("/", 1)[-1]), 0) + 1
        dataset["file_count"] = len(names)
        dataset["extensions"] = dict(sorted(counts.items(), key=lambda kv: -kv[1]))
    write_catalog(manifest, dataset["id"], top, paths)

    action = "Updated" if existing else "Added"
    print(f"{action} '{dataset['label']}' ({dataset['id']}): {dataset.get('file_count', 0)} files, "
          f"deliverables {', '.join(dataset.get('deliverables') or []) or 'none'}.")
    if not dataset.get("description"):
        print("Tip: add a short --description; it shows in the catalog and helps the assistant find the dataset.")
    if not args.no_index:
        refresh_assistant_index()
    print("Next: check it locally (python -m http.server 8000, open http://localhost:8000), then publish (see README).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
