"""Fill in the file listing of every Zenodo-linked dataset in catalog/manifest.json.

Any dataset with a Zenodo DOI lists exactly the files of that Zenodo record,
so what the catalog shows always matches what the "Zenodo" button downloads
(an Accelerator `source_folder`, if any, is kept as provenance only). Datasets
added straight to the manifest start out with `file_count: 0`; this script asks
the Zenodo API for each record's files and, for every .zip, reads Zenodo's own
archive preview so the files *inside* the zip are listed too.
The result is written back to catalog/manifest.json (file_count, extensions,
files_restricted) and catalog/paths.txt (one line per file, prefixed with the
dataset id, the same format the Accelerator folders use).

Edits made by hand to the manifest (labels, descriptions, tags, order) are
kept; only the file fields above are touched. Standard library only, so it
runs anywhere with Python 3.9+:

    python sync_zenodo.py
"""

from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT / "catalog" / "manifest.json"
PATHS = ROOT / "catalog" / "paths.txt"
USER_AGENT = "ACCREU-Data-Catalog/1.0 (+https://iiasa.github.io/ACCREU/)"


def slugify(name: str) -> str:
    return re.sub(r"^-+|-+$", "", re.sub(r"[^a-z0-9]+", "-", name.lower()))


def record_id(doi: str) -> str:
    match = re.search(r"zenodo\.(\d+)", doi)
    if not match:
        raise ValueError(f"Not a Zenodo DOI: {doi}")
    return match.group(1)


def http_get(url: str) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                return response.read()
        except urllib.error.HTTPError as error:
            # Zenodo rate-limits bursts; back off and retry.
            if error.code == 429 and attempt < 3:
                time.sleep(10 * (attempt + 1))
                continue
            raise
    raise RuntimeError(f"Gave up on {url}")


class ZipPreviewParser(HTMLParser):
    """Reads the folder tree out of Zenodo's zip preview page.

    Folders appear as `<a href="#tree_itemN">name</a>` followed by
    `<ul id="tree_itemN">…</ul>`; files as a `<span>` holding a file icon and
    the file name.
    """

    def __init__(self) -> None:
        super().__init__()
        self.paths: list[str] = []
        self.truncated = False
        self._stack: list[str] = []
        self._ul_kinds: list[bool] = []  # True for a folder's <ul>
        self._pending_folder: str | None = None
        self._in_folder_link = False
        self._in_span = False
        self._span_is_file = False
        self._in_header = False  # the <h4> title bar repeats the zip's own name
        self._text = ""

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "h4":
            self._in_header = True
        elif self._in_header:
            return
        elif tag == "a" and (attrs.get("href") or "").startswith("#tree_item"):
            self._in_folder_link = True
            self._text = ""
        elif tag == "ul":
            is_folder = (attrs.get("id") or "").startswith("tree_item")
            self._ul_kinds.append(is_folder)
            if is_folder:
                self._stack.append(self._pending_folder or "")
                self._pending_folder = None
        elif tag == "span":
            self._in_span = True
            self._span_is_file = False
            self._text = ""
        elif tag == "i" and self._in_span and "file" in (attrs.get("class") or ""):
            self._span_is_file = True

    def handle_endtag(self, tag):
        if tag == "h4":
            self._in_header = False
        elif self._in_header:
            return
        elif tag == "a" and self._in_folder_link:
            self._in_folder_link = False
            self._pending_folder = self._text.strip()
        elif tag == "ul" and self._ul_kinds:
            if self._ul_kinds.pop():
                self._stack.pop()
        elif tag == "span" and self._in_span:
            self._in_span = False
            name = self._text.strip()
            if self._span_is_file and name:
                self.paths.append("/".join([*self._stack, name]))

    def handle_data(self, data):
        if self._in_folder_link or self._in_span:
            self._text += data


# Zenodo's zip preview silently stops listing after this many entries
# (files + folders), so an archive at the cap is flagged as partially listed.
PREVIEW_ENTRY_CAP = 1000


def zip_contents(rec: str, key: str) -> tuple[list[str], bool]:
    """Return (paths inside the archive, whether the listing hit the cap)."""
    url = f"https://zenodo.org/records/{rec}/preview/{urllib.parse.quote(key)}"
    try:
        html = http_get(url).decode("utf-8", "replace")
    except urllib.error.HTTPError:
        return [], False
    parser = ZipPreviewParser()
    parser.feed(html)
    inner = parser.paths
    folders = {p.rsplit("/", 1)[0] for p in inner if "/" in p}
    truncated = len(inner) + len(folders) >= PREVIEW_ENTRY_CAP - 1
    # Most archives wrap everything in one folder named after the zip itself;
    # drop that level so the tree reads `Flow.zip/file.csv`, not
    # `Flow.zip/Flow/file.csv`.
    stem = key[:-4]
    if inner and all(p.startswith(stem + "/") for p in inner):
        inner = [p[len(stem) + 1:] for p in inner]
    return inner, truncated


def extension(name: str) -> str:
    dot = name.rfind(".")
    return name[dot + 1:].lower() if dot >= 0 else "(none)"


def is_metadata_only(files: list[dict]) -> bool:
    """A record holding only README files: its data lives elsewhere."""
    return bool(files) and all(f["key"].lower().startswith("readme") for f in files)


def sync_dataset(dataset: dict, accelerator_paths: list[str]) -> list[str]:
    paths: list[str] = []
    restricted = False
    truncated = False
    for record in dataset["zenodo"]:
        meta = json.loads(http_get(f"https://zenodo.org/api/records/{record_id(record['doi'])}"))
        # A concept DOI resolves to its latest version; previews live under
        # that version's own id.
        rec = str(meta["id"])
        if meta.get("metadata", {}).get("access_right") == "restricted" or not meta.get("files"):
            restricted = restricted or meta.get("metadata", {}).get("access_right") == "restricted"
            continue
        if is_metadata_only(meta["files"]) and accelerator_paths:
            # e.g. the DTU wildfire record: README on Zenodo, data in the
            # public Accelerator folder it points to. List both.
            paths.extend(accelerator_paths)
        for entry in meta["files"]:
            key = entry["key"]
            inner, capped = zip_contents(rec, key) if key.lower().endswith(".zip") else ([], False)
            truncated = truncated or capped
            if inner:
                paths.extend(f"{dataset['id']}/{key}/{p}" for p in inner)
            else:
                paths.append(f"{dataset['id']}/{key}")

    paths.sort()
    ext_counts: dict[str, int] = {}
    for p in paths:
        ext = extension(p.rsplit("/", 1)[-1])
        ext_counts[ext] = ext_counts.get(ext, 0) + 1

    dataset["file_count"] = len(paths)
    dataset["extensions"] = dict(sorted(ext_counts.items(), key=lambda kv: -kv[1]))
    if restricted and not paths:
        dataset["files_restricted"] = True
    else:
        dataset.pop("files_restricted", None)
    if truncated:
        dataset["files_truncated"] = True
    else:
        dataset.pop("files_truncated", None)
    return paths


def main() -> int:
    manifest = json.loads(MANIFEST.read_text(encoding="utf-8"))
    datasets = manifest["datasets"]

    zenodo_linked = [d for d in datasets if d.get("zenodo")]
    accelerator_ids = {d["id"] for d in datasets if d.get("source_folder") and not d.get("zenodo")}

    # Keep Accelerator file lines only for Accelerator-only datasets still in
    # the manifest; Zenodo-linked lines are regenerated below, and lines for
    # folders that were dropped from the manifest are pruned. Accelerator
    # lines of Zenodo-linked datasets are held aside in case their record
    # turns out to be metadata-only.
    kept: list[str] = []
    held: dict[str, list[str]] = {}
    for line in PATHS.read_text(encoding="utf-8").splitlines():
        top = line.split("/", 1)[0]
        if slugify(top) in accelerator_ids:
            kept.append(line)
        else:
            held.setdefault(slugify(top), []).append(line)

    regenerated: list[str] = []
    for dataset in zenodo_linked:
        accelerator_paths = held.get(dataset["id"], []) if dataset.get("source_folder") else []
        # Lines already written under the dataset id are Zenodo listings from
        # an earlier sync; the Accelerator copy keeps its folder name.
        accelerator_paths = [p for p in accelerator_paths if p.split("/", 1)[0] != dataset["id"]]
        paths = sync_dataset(dataset, accelerator_paths)
        regenerated.extend(paths)
        note = " (restricted on Zenodo)" if dataset.get("files_restricted") else ""
        note += " (zip listing capped by Zenodo preview)" if dataset.get("files_truncated") else ""
        print(f"{dataset['file_count']:>6}  {dataset['id']}{note}")

    all_paths = kept + regenerated
    PATHS.write_text("\n".join(all_paths) + "\n", encoding="utf-8", newline="\n")
    manifest["total_files"] = sum(d.get("file_count") or 0 for d in datasets)
    MANIFEST.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n"
    )
    print(f"Total files: {manifest['total_files']}  (paths.txt lines: {len(all_paths)})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
