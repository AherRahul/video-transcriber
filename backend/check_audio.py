"""Quick check: can this machine download a video's audio? Usage: python check_audio.py <url> [<url> ...]"""

import pathlib
import shutil
import sys
import tempfile

import transcriber as tr

for url in sys.argv[1:]:
    folder = pathlib.Path(tempfile.mkdtemp(prefix="vt-check-"))
    try:
        path = tr.download_audio(url, folder, lambda *_: None)
        print("OK  ", url, path.name, path.stat().st_size, "bytes")
    except Exception as err:  # noqa: BLE001
        print("FAIL", url, type(err).__name__, err)
    finally:
        shutil.rmtree(folder, ignore_errors=True)
