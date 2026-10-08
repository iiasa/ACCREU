"""Build the assistant's searchable index of the ACCREU deliverable reports.

For every deliverable in catalog/deliverables.json this downloads the PDF,
extracts its text page by page (pdftotext, from poppler), cuts it into short
passages, and embeds each passage with the same model the site uses
(assets/ai-model.js), by running tools/embed.html in a headless browser. The
assistant can then quote the reports themselves, with a link to the page.

It also pre-computes the vectors of the catalog entries (datasets,
deliverables and the other ACCREU Zenodo community records, built by
assets/knowledge.js), so the page does not have to embed them on each visit.

Output (loaded by assets/agent.js):
    catalog/knowledge/passages.json   passage text, deliverable id and page
    catalog/knowledge/vectors.bin     one int8 vector (384 bytes) per passage
    catalog/knowledge/catalog.json    text fingerprint of each catalog entry
    catalog/knowledge/catalog.bin     one float32 vector (1536 bytes) per entry

Requirements: pdftotext on PATH, Python with Playwright, and Chrome or
Playwright's Chromium. Re-run whenever a deliverable is added or replaced:

    python build_knowledge.py

After catalog edits or sync_zenodo.py, refreshing the catalog vectors is
enough (about a minute; entries changed since are embedded in the browser):

    python build_knowledge.py --catalog-only
"""

from __future__ import annotations

import functools
import http.server
import array
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import urllib.request
from collections import Counter
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent
DELIVERABLES = ROOT / "catalog" / "deliverables.json"
OUT_DIR = ROOT / "catalog" / "knowledge"
MODEL_ID = "Xenova/bge-small-en-v1.5"
TARGET_WORDS = 110
MIN_WORDS = 35
CHROME = os.environ.get("CHROME", r"C:\Program Files\Google\Chrome\Application\chrome.exe")


def pdf_pages(pdf: Path) -> list[str]:
    exe = shutil.which("pdftotext")
    if not exe:
        sys.exit("pdftotext not found: install poppler (it ships with Git for Windows).")
    txt = pdf.with_suffix(".txt")
    subprocess.run([exe, "-q", "-enc", "UTF-8", str(pdf), str(txt)], check=True)
    return txt.read_text(encoding="utf-8", errors="replace").split("\f")


def looks_like_noise(text: str) -> bool:
    """Table of contents, reference lists, tables and figure residue."""
    words = text.split()
    if len(words) < MIN_WORDS:
        return True
    if re.search(r"\.{5,}|…{2,}", text):  # table-of-contents dot leaders
        return True
    alpha = sum(1 for w in words if re.fullmatch(r"[A-Za-zÀ-ÿ'’()-]+[.,;:]?", w))
    if alpha / len(words) < 0.65:  # mostly numbers or symbols: a table
        return True
    citations = len(re.findall(r"\b(19|20)\d\d[a-z]?\b|doi|https?://|et al\.", text, re.I))
    return citations > len(words) / 12  # a reference list


def passages_of(pages: list[str]) -> list[tuple[int, str]]:
    # Lines repeated on many pages are running headers and footers.
    line_pages = Counter()
    for page in pages:
        for line in {l.strip() for l in page.splitlines() if l.strip()}:
            line_pages[line] += 1
    repeated = {l for l, n in line_pages.items() if n > max(3, len(pages) * 0.3)}

    out: list[tuple[int, str]] = []
    for number, page in enumerate(pages, start=1):
        lines = [l.strip() for l in page.splitlines() if l.strip() and l.strip() not in repeated]
        text = re.sub(r"-\s*\n\s*(?=[a-z])", "", "\n".join(lines))  # re-join hyphenated words
        text = re.sub(r"\s+", " ", text).strip()
        sentences = re.split(r"(?<=[.!?])\s+(?=[A-Z(])", text)
        chunk: list[str] = []
        count = 0
        for sentence in sentences:
            chunk.append(sentence)
            count += len(sentence.split())
            if count >= TARGET_WORDS:
                out.append((number, " ".join(chunk)))
                chunk, count = [], 0
        if chunk:
            out.append((number, " ".join(chunk)))
    return [(p, t) for p, t in out if not looks_like_noise(t)]


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        # Cross-origin isolation lets the WebAssembly runtime use all CPU
        # threads, which makes embedding several times faster.
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        super().end_headers()

    def log_message(self, *args):
        pass


def run_embedder(task):
    """Open tools/embed.html in a headless browser and run task(page)."""
    handler = functools.partial(QuietHandler, directory=str(ROOT))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        with sync_playwright() as p:
            launch = {"headless": True}
            if Path(CHROME).exists():
                launch["executable_path"] = CHROME
            browser = p.chromium.launch(**launch)
            page = browser.new_page()
            page.goto(f"http://127.0.0.1:{server.server_address[1]}/tools/embed.html")
            page.wait_for_function("window.embedderReady === true")
            result = task(page)
            browser.close()
            return result
    finally:
        server.shutdown()


def embed_passages(texts: list[str]) -> list[list[int]]:
    def task(page):
        vectors: list[list[int]] = []
        for i in range(0, len(texts), 256):
            vectors += page.evaluate("t => window.embedPassages(t)", texts[i : i + 256])
            print(f"  embedded {len(vectors)}/{len(texts)}", flush=True)
        return vectors

    return run_embedder(task)


def build_catalog_vectors() -> None:
    result = run_embedder(lambda page: page.evaluate("window.embedCatalog()"))
    vectors = result["vectors"]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "catalog.json").write_text(
        json.dumps({"model": MODEL_ID, "dims": len(vectors[0]), "keys": result["keys"]}, separators=(",", ":")),
        encoding="utf-8",
        newline="\n",
    )
    (OUT_DIR / "catalog.bin").write_bytes(array.array("f", (v for vec in vectors for v in vec)).tobytes())
    print(f"{len(vectors)} catalog entries written to {OUT_DIR}")


def main() -> int:
    if "--catalog-only" in sys.argv[1:]:
        build_catalog_vectors()
        return 0
    deliverables = json.loads(DELIVERABLES.read_text(encoding="utf-8"))["deliverables"]
    passages: list[dict] = []
    seen: set[str] = set()
    with tempfile.TemporaryDirectory() as tmp:
        for did, info in deliverables.items():
            pdf = Path(tmp) / f"{did}.pdf"
            request = urllib.request.Request(info["url"], headers={"User-Agent": "ACCREU-Data-Catalog/1.0"})
            with urllib.request.urlopen(request, timeout=300) as response:
                pdf.write_bytes(response.read())
            kept = 0
            for page, text in passages_of(pdf_pages(pdf)):
                key = text.lower()
                if key in seen:
                    continue
                seen.add(key)
                passages.append({"d": did, "p": page, "t": text})
                kept += 1
            print(f"{did}: {kept} passages")

    # Embed "title + passage" so a passage also matches its report's subject.
    texts = [f"{p['d']} {deliverables[p['d']]['title']}. {p['t']}" for p in passages]
    vectors = embed_passages(texts)

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "passages.json").write_text(
        json.dumps({"model": MODEL_ID, "dims": len(vectors[0]), "passages": passages}, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
        newline="\n",
    )
    (OUT_DIR / "vectors.bin").write_bytes(bytes((int(v) + 256) % 256 for vec in vectors for v in vec))
    print(f"{len(passages)} passages, {len(vectors[0])}-d vectors written to {OUT_DIR}")
    build_catalog_vectors()
    return 0


if __name__ == "__main__":
    sys.exit(main())
