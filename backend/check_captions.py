"""Quick check: can this machine read a video and its captions? Usage: python check_captions.py <url>"""

import sys

import transcriber as tr

url = sys.argv[1]
info = tr.fetch_info(url)
print("title:", info.get("title"))
print("duration:", info.get("duration"), "s")
print("language:", info.get("language"))
print("subtitles:", sorted((info.get("subtitles") or {}).keys())[:10])
print("auto-captions (first 10):", sorted((info.get("automatic_captions") or {}).keys())[:10])
found = tr.fetch_captions(info, None)
if not found:
    print("No captions found.")
else:
    source, lang, segments = found
    print(f"source={source} lang={lang} segments={len(segments)}")
    for s in segments[:5]:
        print(f"  [{s.start:7.2f}] {s.text}")
