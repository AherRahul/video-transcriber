"""Offline tests for the caption parsing, track choice and output formats, and the screenshots (on a test
video FFmpeg makes, never downloaded). Run: python -m unittest -v"""

import json
import os
import shutil
import tempfile
import unittest

# the screenshots (and the Motion part of the app) work under one temporary folder, deleted at the end,
# never in transcriber-data or motion-data
TMP = tempfile.mkdtemp(prefix="transcriber-test-")
os.environ["TRANSCRIBER_DATA_DIR"] = os.path.join(TMP, "data")
os.environ["MOTION_DATA_DIR"] = os.path.join(TMP, "motion-data")
os.environ["MOTION_ENGINE"] = "api"

import io  # noqa: E402
import subprocess  # noqa: E402
import time  # noqa: E402
import zipfile  # noqa: E402
from pathlib import Path  # noqa: E402
from unittest import mock  # noqa: E402

import screenshots as shots  # noqa: E402
import transcriber as tr  # noqa: E402


def tearDownModule():
    shutil.rmtree(TMP, ignore_errors=True)


def _wait_for(check, seconds: float = 10.0) -> None:
    """Waits until check() is true (work handed to a background pool), failing after `seconds`."""
    end = time.time() + seconds
    while time.time() < end:
        if check():
            return
        time.sleep(0.02)
    raise AssertionError("timed out waiting")


class ParseCaptions(unittest.TestCase):
    def test_json3(self):
        raw = json.dumps(
            {
                "events": [
                    {"tStartMs": 1200, "dDurationMs": 3000, "segs": [{"utf8": "Hello "}, {"utf8": "there"}]},
                    {"tStartMs": 4200, "dDurationMs": 10, "segs": [{"utf8": "\n"}]},  # line break only
                    {"tStartMs": 5000},  # no text
                    {"tStartMs": 6000, "dDurationMs": 1000, "segs": [{"utf8": "Tom &amp; Jerry"}]},
                ]
            }
        )
        segs = tr.parse_json3(raw)
        self.assertEqual([s.text for s in segs], ["Hello there", "Tom & Jerry"])
        self.assertAlmostEqual(segs[0].start, 1.2)
        self.assertAlmostEqual(segs[0].end, 4.2)

    def test_vtt_with_tags_and_rolling_repeats(self):
        raw = (
            "WEBVTT\nKind: captions\n\n"
            "00:00:01.000 --> 00:00:02.000 align:start position:0%\n"
            "hello<00:00:01.500><c> world</c>\n\n"
            "00:00:02.000 --> 00:00:03.000\n"
            "hello world\n\n"
            "00:00:03.000 --> 00:00:04.000\n"
            "hello world how are you\n\n"
            "01:02:03.250 --> 01:02:04.000\n"
            "late line\n"
        )
        segs = tr.parse_vtt_or_srt(raw)
        self.assertEqual([s.text for s in segs], ["hello world", "how are you", "late line"])
        self.assertEqual(segs[0].end, 3.0)  # the repeat extends the first cue
        self.assertAlmostEqual(segs[2].start, 3723.25)

    def test_srt(self):
        raw = "1\r\n00:00:00,500 --> 00:00:01,000\r\nFirst\r\nline\r\n\r\n2\r\n00:00:01,000 --> 00:00:02,000\r\nSecond\r\n"
        segs = tr.parse_vtt_or_srt(raw)
        self.assertEqual([s.text for s in segs], ["First line", "Second"])
        self.assertAlmostEqual(segs[0].start, 0.5)


class PickTrack(unittest.TestCase):
    def tracks(self, *codes):
        return {c: [{"ext": "vtt", "url": f"u-{c}"}, {"ext": "json3", "url": f"j-{c}"}] for c in codes}

    def test_prefers_wanted_then_video_language_then_english(self):
        t = self.tracks("de", "en", "hi")
        self.assertEqual(tr._pick_track(t, "hi", "de")[0], "hi")
        self.assertEqual(tr._pick_track(t, None, "de")[0], "de")
        self.assertEqual(tr._pick_track(t, None, None)[0], "en")

    def test_prefers_original_auto_track_and_json3(self):
        t = self.tracks("en", "en-orig", "fr")
        code, fmt = tr._pick_track(t, "en", None)
        self.assertEqual(code, "en-orig")
        self.assertEqual(fmt["ext"], "json3")

    def test_regional_code_matches_base_language(self):
        self.assertEqual(tr._pick_track(self.tracks("en-GB", "fr"), "en", None)[0], "en-GB")

    def test_no_usable_track(self):
        self.assertIsNone(tr._pick_track({}, None, None))
        self.assertIsNone(tr._pick_track({"live_chat": [{"ext": "json", "url": "x"}]}, None, None))
        self.assertIsNone(tr._pick_track({"en": [{"ext": "ttml", "url": "x"}]}, None, None))


class Formats(unittest.TestCase):
    t = tr.Transcript(
        "T", "u", 70, "en", "captions", [tr.Segment(0, 1.5, "One"), tr.Segment(65.25, 70, "Two")]
    )

    def test_txt(self):
        self.assertEqual(tr.to_txt(self.t), "[00:00:00] One\n[00:01:05] Two\n")
        self.assertEqual(tr.to_txt(self.t, timestamps=False), "One Two\n")

    def test_srt(self):
        self.assertEqual(
            tr.to_srt(self.t),
            "1\n00:00:00,000 --> 00:00:01,500\nOne\n\n2\n00:01:05,250 --> 00:01:10,000\nTwo\n",
        )

    def test_vtt(self):
        self.assertTrue(tr.to_vtt(self.t).startswith("WEBVTT\n\n00:00:00.000 --> 00:00:01.500\nOne\n"))


class Errors(unittest.TestCase):
    def test_friendly_messages(self):
        cases = {
            "ERROR: [youtube] x: Sign in to confirm you're not a bot": "not a bot",
            "ERROR: [vimeo] 1: The web client only works when logged-in. Use --cookies": "signed-in users",
            "ERROR: [youtube] x: Private video. Sign in if you've been granted access": "private",
            "ERROR: Unsupported URL: https://example.com/page": "not a video page",
        }
        for raw, expected in cases.items():
            self.assertIn(expected, str(tr._friendly(Exception(raw))), raw)

    def test_rejects_non_http_url(self):
        with self.assertRaises(tr.TranscriptError):
            tr.transcribe_url("file:///etc/passwd")
        with self.assertRaises(tr.TranscriptError):
            tr.transcribe_url("https://example.com/v.mp4", model="huge")


# ── screenshots ──


class PickMoments(unittest.TestCase):
    def test_scene_cuts_plus_the_grid(self):
        # shots start at 0, 8, 20 and 22 in a 40 s video: the opening at 1 s, each cut 0.5 s after it, and
        # the grid at 15 and 30. The 2 s flash at 20 is 2 s from the long shot at 22, which wins.
        self.assertEqual(shots.pick_moments([8, 20, 22], 40), [1.0, 8.5, 15.0, 22.5, 30.0])

    def test_the_grid_gives_way_to_a_cut(self):
        self.assertEqual(shots.pick_moments([14], 40), [1.0, 14.5, 30.0])  # 15 is 0.5 s from 14.5
        self.assertEqual(shots.pick_moments([], 40), [1.0, 15.0, 30.0])

    def test_no_two_closer_than_four_seconds(self):
        cuts = [0.5 + i * 1.7 for i in range(60)]  # a cut every 1.7 s
        moments = shots.pick_moments(cuts, 120)
        self.assertEqual(moments, sorted(moments))
        self.assertTrue(all(b - a >= 4 for a, b in zip(moments, moments[1:])), moments)
        self.assertLessEqual(moments[-1], 120 - 0.25)

    def test_the_cap_keeps_the_whole_video(self):
        moments = shots.pick_moments([i * 5.0 for i in range(1, 200)], 1000)  # 200 shots
        self.assertEqual(len(moments), 120)
        self.assertEqual(moments[0], 1.0)  # first and last kept
        self.assertGreater(moments[-1], 990)
        self.assertTrue(all(b - a >= 4 for a, b in zip(moments, moments[1:])))
        self.assertEqual(len(shots.pick_moments([i * 5.0 for i in range(1, 200)], 1000, cap=10)), 10)

    def test_short_videos(self):
        self.assertEqual(shots.pick_moments([], 0.2), [])
        self.assertEqual(shots.pick_moments([], 3), [1.0])
        self.assertEqual(shots.pick_moments([2.0], 3), [1.0])  # the cut is too close to the opening


class TextAround(unittest.TestCase):
    segs = [
        tr.Segment(0, 3, "Hello and welcome."),
        tr.Segment(3, 7, "Today we look at queues. They hold work"),
        tr.Segment(7, 11, "until a worker is free. [Music] Then the worker takes one."),
        tr.Segment(11, 16, "And that is the whole idea. Next we add a second worker."),
        tr.Segment(40, 44, "so the line gets shorter"),
    ]

    def test_the_sentence_being_said_and_the_next(self):
        self.assertEqual(shots.text_around(self.segs, 8.5), "They hold work until a worker is free. Then the worker takes one.")
        self.assertEqual(shots.text_around(self.segs, 1.0), "Hello and welcome. Today we look at queues. They hold work")

    def test_only_what_is_said_around_it(self):
        # [t - 4, t + 6]: at 30 nothing is said; at 37 the line at 40 is said 3 s later
        self.assertEqual(shots.text_around(self.segs, 30), "")
        self.assertEqual(shots.text_around(self.segs, 37), "so the line gets shorter")
        self.assertEqual(shots.text_around([{"start": 1, "end": 2, "text": "A dict works too."}], 1.5), "A dict works too.")

    def test_auto_captions_without_full_stops_are_capped(self):
        # 80 words over 10 s: word16 is said at 2 s, so the 40 words start four words before it
        words = " ".join(f"word{i}" for i in range(80))
        text = shots.text_around([tr.Segment(0, 10, words)], 2)
        self.assertEqual(len(text.split()), 40)
        self.assertTrue(text.startswith("...word12 word13"), text)
        self.assertTrue(text.endswith("word51..."), text)

    def test_a_long_line_starts_where_the_frame_is(self):
        # one caption line of 12 s: at 6 s the speaker is on its second sentence, not its first
        seg = tr.Segment(0, 12, "First we fill the tank. Then we check the tyres. Then we drive off.")
        self.assertEqual(shots.text_around([seg], 6), "Then we check the tyres. Then we drive off.")
        # two short sentences are under 12 words, so a third comes along
        self.assertEqual(shots.text_around([seg], 0.2), "First we fill the tank. Then we check the tyres. Then we drive off.")


def _jpeg_size(path: Path) -> tuple[int, int] | None:
    from motion.store import image_size

    return image_size(path)


@unittest.skipUnless(shots.ffmpeg_exe(), "FFmpeg not found")
class ScreenshotsOnAFile(unittest.TestCase):
    """A 40 s test video (red 8 s, blue 12 s, a 2 s green flash, then 18 s of FFmpeg's moving test pattern),
    so the scene cuts are at 8, 20 and 22 s."""

    JOB = "abcdef123456"
    SEGMENTS = [
        tr.Segment(0, 4, "Welcome to the queue lesson."),
        tr.Segment(4, 9, "A queue keeps jobs in the order they came. The first one in"),
        tr.Segment(9, 13, "is the first one out."),
        tr.Segment(13, 20, "Workers take jobs from the front | one at a time."),
        tr.Segment(21, 27, "When every worker is busy, the line grows."),
        tr.Segment(28, 36, "Add a worker and it shrinks again. That is all."),
    ]

    @classmethod
    def setUpClass(cls):
        cls.dir = Path(tempfile.mkdtemp(prefix="video-", dir=TMP))
        cls.video = cls.dir / "test.mp4"
        parts = [("color=c=red:", 8), ("color=c=blue:", 12), ("color=c=green:", 2), ("testsrc=", 18)]
        cmd = [shots.ffmpeg_exe(), "-hide_banner", "-v", "error"]
        for src, seconds in parts:
            cmd += ["-f", "lavfi", "-i", f"{src}s=640x360:r=25:d={seconds}"]
        cmd += ["-filter_complex", "[0][1][2][3]concat=n=4:v=1:a=0", "-c:v", "mpeg4", "-q:v", "5", "-y", str(cls.video)]
        subprocess.run(cmd, check=True, capture_output=True, timeout=120)
        cls.folder = shots.FRAMES_DIR / cls.JOB
        cls.items = shots.take_screenshots(cls.video, cls.SEGMENTS, cls.folder)
        (cls.folder / "job.json").write_text(json.dumps({"title": "Queues, explained", "url": "https://example.com/v", "duration": 40, "state": "done", "message": "5 screenshots"}), encoding="utf-8")

    def test_scene_changes(self):
        cuts = shots.scene_changes(self.video, shots.ffmpeg_exe(), 40)
        self.assertEqual([round(c) for c in cuts], [8, 20, 22])

    def test_the_frames_and_the_manifest(self):
        self.assertEqual([it["t"] for it in self.items], [1.0, 8.5, 15.0, 22.5, 30.0])
        self.assertEqual([it["file"] for it in self.items], ["frame-00m01s.jpg", "frame-00m08s.jpg", "frame-00m15s.jpg", "frame-00m22s.jpg", "frame-00m30s.jpg"])
        for it in self.items:
            self.assertEqual(_jpeg_size(self.folder / it["file"]), (1280, 720), it["file"])  # 1280 wide
        self.assertEqual(json.loads((self.folder / "manifest.json").read_text(encoding="utf-8")), self.items)
        # what is said around each one: [t - 4, t + 6], trimmed to about two sentences
        text = {it["t"]: it["text"] for it in self.items}
        # at 8.5 s "The first one in" is being said (the line runs 4 to 9 s)
        self.assertEqual(text[8.5], "The first one in is the first one out. Workers take jobs from the front | one at a time.")
        self.assertEqual(text[30.0], "Add a worker and it shrinks again. That is all.")
        self.assertEqual(text[1.0], "Welcome to the queue lesson. A queue keeps jobs in the order they came.")

    def test_the_cap_on_a_file(self):
        items = shots.take_screenshots(self.video, self.SEGMENTS, self.dir / "capped", cap=3)
        self.assertEqual([it["t"] for it in items], [1.0, 15.0, 30.0])
        self.assertEqual(sorted(p.name for p in (self.dir / "capped").glob("*.jpg")), ["frame-00m01s.jpg", "frame-00m15s.jpg", "frame-00m30s.jpg"])

    def test_routes_serve_a_job_gone_from_memory(self):
        from fastapi.testclient import TestClient

        import app

        c = TestClient(app.app)
        self.assertNotIn(self.JOB, app._jobs)
        r = c.get(f"/api/jobs/{self.JOB}/frames")
        self.assertEqual(r.status_code, 200, r.text)
        body = r.json()
        self.assertEqual(body["state"], "done")
        self.assertEqual([it["t"] for it in body["items"]], [1.0, 8.5, 15.0, 22.5, 30.0])
        self.assertEqual(body["items"][1]["url"], f"/api/jobs/{self.JOB}/frames/frame-00m08s.jpg")
        img = c.get(body["items"][1]["url"])
        self.assertEqual(img.status_code, 200)
        self.assertEqual(img.headers["content-type"], "image/jpeg")
        self.assertEqual(img.content[:2], b"\xff\xd8")
        for bad in ("manifest.json", "..%2Fjob.json", "frame-99m99s.jpg"):
            self.assertEqual(c.get(f"/api/jobs/{self.JOB}/frames/{bad}").status_code, 404, bad)
        self.assertEqual(c.get("/api/jobs/000000000000/frames").status_code, 404)
        self.assertEqual(c.get("/api/jobs/000000000000/frames.zip").status_code, 404)

        z = c.get(f"/api/jobs/{self.JOB}/frames.zip")
        self.assertEqual(z.status_code, 200)
        self.assertIn('filename="Queues explained - screenshots.zip"', z.headers["content-disposition"])
        names = zipfile.ZipFile(io.BytesIO(z.content)).namelist()
        self.assertEqual(sorted(names), sorted(["REFERENCES.md", "references.json"] + [it["file"] for it in self.items]))
        md = zipfile.ZipFile(io.BytesIO(z.content)).read("REFERENCES.md").decode()
        self.assertIn("Source: Queues, explained (https://example.com/v)", md)
        self.assertIn("| Time | File | What is said |", md)
        self.assertIn("| 0:08 | frame-00m08s.jpg | The first one in is the first one out. Workers take jobs from the front \\| one at a time. |", md)
        self.assertIn("front \\| one at a time", md)  # a | in the text can't break the table
        refs = json.loads(zipfile.ZipFile(io.BytesIO(z.content)).read("references.json"))
        self.assertEqual([f["time"] for f in refs["frames"]], ["0:01", "0:08", "0:15", "0:22", "0:30"])

    def test_the_whole_job_on_a_local_file(self):
        # run_for_job with the download replaced by a copy of the test video: no network
        def fake_download(_url, folder, _progress=None):
            return Path(shutil.copy(self.video, folder / "video.mp4"))

        t = tr.Transcript("Queues", "https://example.com/v", 40, "en", "captions", list(self.SEGMENTS))
        seen = []
        with mock.patch.object(shots, "download_video", fake_download):
            result = shots.run_for_job("fedcba654321", t, lambda pct, msg: seen.append((pct, msg)))
        self.assertEqual(result, {"state": "done", "message": "5 screenshots", "count": 5})
        found = shots.load("fedcba654321")
        self.assertEqual((found["state"], found["title"], len(found["items"])), ("done", "Queues", 5))
        self.assertEqual(seen[-1][1], "Taking screenshots (5 of 5)")
        self.assertTrue(all(b[0] >= a[0] for a, b in zip(seen, seen[1:]) if a[0] is not None and b[0] is not None))  # never goes back


class ScreenshotFailures(unittest.TestCase):
    def test_a_video_that_cant_be_downloaded_keeps_the_transcript(self):
        import app

        t = tr.Transcript("Talk", "https://example.com/v", 60, "en", "captions", [tr.Segment(0, 2, "Hi.")])
        job = "aaaabbbbcccc"
        app._jobs[job] = {"id": job, "url": t.url, "state": "queued", "stage": "queued", "percent": None, "message": "", "createdAt": time.time(), "updatedAt": time.time(), "frames": {"state": "waiting"}}
        req = app.JobRequest(url=t.url)
        with mock.patch.object(tr, "transcribe_url", return_value=t), mock.patch.object(shots, "download_video", side_effect=shots.ShotsError("The video could not be downloaded: This video is private.")):
            app._run(job, req)
            # the screenshots run in their own pool after the transcript: wait for them inside the patch
            _wait_for(lambda: app._jobs[job]["frames"]["state"] not in ("waiting", "running"))
        try:
            self.assertEqual(app._jobs[job]["state"], "done")
            self.assertIs(app._jobs[job]["transcript"], t)
            self.assertEqual(app._jobs[job]["frames"]["state"], "none")
            from fastapi.testclient import TestClient

            body = TestClient(app.app).get(f"/api/jobs/{job}/frames").json()
            self.assertEqual(body, {"state": "none", "percent": None, "message": "The video could not be downloaded: This video is private.", "items": []})
            self.assertEqual(json.loads((shots.FRAMES_DIR / job / "job.json").read_text(encoding="utf-8"))["state"], "none")
        finally:
            app._jobs.pop(job, None)

    def test_off_and_running_states(self):
        import app
        from fastapi.testclient import TestClient

        c = TestClient(app.app)
        for job, frames in (("off000000001", {"state": "off", "message": "Screenshots were turned off for this video."}), ("run000000001", {"state": "running", "percent": 42.0, "message": "Finding the scene changes"})):
            app._jobs[job] = {"id": job, "state": "done", "frames": frames}
            try:
                body = c.get(f"/api/jobs/{job}/frames").json()
                self.assertEqual((body["state"], body["percent"], body["message"], body["items"]), (frames["state"], frames.get("percent"), frames["message"], []))
            finally:
                app._jobs.pop(job, None)
        self.assertTrue(app.JobRequest(url="https://example.com/v").screenshots)  # on by default

    def test_no_ffmpeg(self):
        with mock.patch.object(shots, "ffmpeg_exe", return_value=None), self.assertRaises(shots.ShotsError) as ctx:
            shots.take_screenshots(Path("missing.mp4"), [], Path(TMP) / "none")
        self.assertIn("FFmpeg was not found", str(ctx.exception))

    def test_old_folders_are_deleted(self):
        old, new = shots.FRAMES_DIR / "01d000000001", shots.FRAMES_DIR / "0e0000000001"
        for d in (old, new):
            d.mkdir(parents=True, exist_ok=True)
        stamp = time.time() - 15 * 86400
        os.utime(old, (stamp, stamp))
        shots.cleanup()
        self.assertFalse(old.exists())
        self.assertTrue(new.exists())


class ParallelJobs(unittest.TestCase):
    """Several videos at once: each step within its own limit, a captioned video never waiting behind the
    speech-to-text of others, cancels, and the list the page polls. transcribe_url is replaced by a stand-in
    that takes the same gates the real one does, so nothing is downloaded or transcribed."""

    def setUp(self):
        import threading

        import app

        self.app = app
        self.threading = threading
        self.release = threading.Event()  # holds every stand-in speech step until the test lets go
        self.lock = threading.Lock()
        self.inside = 0  # stand-in speech steps running right now
        self.most = 0
        self.ids: list[str] = []

    def tearDown(self):
        self.release.set()
        for job in self.ids:
            _wait_for(lambda job=job: self.app._settled(self.app._jobs.get(job) or {"state": "done"}))
            self.app._jobs.pop(job, None)
            self.app._cancels.pop(job, None)

    def fake(self, url, *, language=None, model=None, force_whisper=False, progress=None, gate=None, on_info=None):
        """Captioned links ("/cap") come back at once; the rest hold a speech slot until released."""
        on_info and on_info(f"Video {url[-1]}", 60.0)
        if "/cap" in url:
            return tr.Transcript(f"Video {url[-1]}", url, 60.0, "en", "captions", [tr.Segment(0, 2, "Hi.")])
        with gate("download"):
            progress("downloading", 50.0, "Downloading the audio")
        with gate("speech"):
            # the stage first, then the count, as the real one does (transcriber.py reports "transcribing" as
            # soon as it holds the slot): a test that sees the count can then rely on the stage
            progress("transcribing", 0.0, "Turning speech into text")
            with self.lock:
                self.inside += 1
                self.most = max(self.most, self.inside)
            try:
                while not self.release.wait(0.02):
                    progress("transcribing", 10.0, "Turning speech into text")
            finally:
                with self.lock:
                    self.inside -= 1
        return tr.Transcript(f"Video {url[-1]}", url, 60.0, "en", "whisper", [tr.Segment(0, 2, "Hi.")])

    def start(self, client, url):
        job = client.post("/api/jobs", json={"url": url, "screenshots": False}).json()["id"]
        self.ids.append(job)
        return job

    def test_speech_runs_side_by_side_within_its_limit(self):
        from fastapi.testclient import TestClient

        c = TestClient(self.app.app)
        slots = tr.SPEECH_SLOTS
        with mock.patch.object(tr, "transcribe_url", self.fake):
            jobs = [self.start(c, f"https://example.com/v{i}") for i in range(slots + 1)]
            # every slot fills, and the one more waits, saying what for
            _wait_for(lambda: self.most == slots and any(self.app._jobs[j]["stage"] == "waiting" for j in jobs))
            waiting = next(j for j in jobs if self.app._jobs[j]["stage"] == "waiting")
            self.assertIn("speech-to-text", self.app._jobs[waiting]["message"])
            # a captioned video added now is done at once, whatever the others are doing
            quick = self.start(c, "https://example.com/cap9")
            _wait_for(lambda: self.app._jobs[quick]["state"] == "done")
            self.assertEqual(self.inside, slots)
            # the list: newest first, titles known, no transcripts but a summary of the finished one
            listed = c.get("/api/jobs").json()
            self.assertEqual(listed[0]["id"], quick)
            self.assertNotIn("transcript", listed[0])
            self.assertEqual(listed[0]["summary"]["source"], "captions")
            self.assertEqual({j["title"] for j in listed if j["id"] in jobs}, {f"Video {i}" for i in range(slots + 1)})
            self.release.set()
            _wait_for(lambda: all(self.app._jobs[j]["state"] == "done" for j in jobs))
        self.assertEqual(self.most, slots)  # never more than the limit at once

    def test_cancel_a_running_and_a_waiting_video(self):
        from fastapi.testclient import TestClient

        c = TestClient(self.app.app)
        slots = tr.SPEECH_SLOTS
        with mock.patch.object(tr, "transcribe_url", self.fake):
            jobs = [self.start(c, f"https://example.com/v{i}") for i in range(slots + 1)]
            _wait_for(lambda: self.most == slots and any(self.app._jobs[j]["stage"] == "waiting" for j in jobs))
            running = next(j for j in jobs if self.app._jobs[j]["stage"] == "transcribing")
            waiting = next(j for j in jobs if self.app._jobs[j]["stage"] == "waiting")
            self.assertEqual(c.post(f"/api/jobs/{running}/cancel").json()["state"], "cancelling")
            c.post(f"/api/jobs/{waiting}/cancel")
            _wait_for(lambda: self.app._jobs[running]["state"] == "cancelled" and self.app._jobs[waiting]["state"] == "cancelled")
            # a finished job leaves the list; a running one can't be removed
            self.assertEqual(c.delete(f"/api/jobs/{running}").status_code, 200)
            self.assertNotIn(running, [j["id"] for j in c.get("/api/jobs").json()])
            still = next(j for j in jobs if j not in (running, waiting))
            self.assertEqual(c.delete(f"/api/jobs/{still}").status_code, 409)

    def test_retry_a_failed_video_in_its_own_row(self):
        from fastapi.testclient import TestClient

        c = TestClient(self.app.app)
        calls: list[dict] = []

        def flaky(url, *, language=None, model=None, force_whisper=False, progress=None, gate=None, on_info=None):
            calls.append({"url": url, "language": language, "model": model, "force_whisper": force_whisper})
            if len(calls) == 1:  # the first try can't reach the site; the second can
                raise tr.TranscriptError("Could not reach the site. Check the URL and the network.")
            return tr.Transcript("Talk", url, 60.0, "en", "captions", [tr.Segment(0, 2, "Hi.")])

        with mock.patch.object(tr, "transcribe_url", flaky):
            job = c.post("/api/jobs", json={"url": "https://example.com/v1", "language": "hi", "model": "tiny", "forceWhisper": True, "screenshots": False}).json()["id"]
            self.ids.append(job)
            _wait_for(lambda: self.app._jobs[job]["state"] == "error")
            self.assertEqual(c.post(f"/api/jobs/{job}/retry").json(), {"ok": True, "attempts": 2})
            _wait_for(lambda: self.app._jobs[job]["state"] == "done")
        listed = {j["id"]: j for j in c.get("/api/jobs").json()}
        self.assertEqual(listed[job]["attempts"], 2)  # the same row, its tries counted
        self.assertEqual(calls[1], calls[0])  # asked again exactly as the first time (link, language, model, Whisper)
        self.assertEqual(calls[1]["language"], "hi")

    def test_retry_every_failed_video_and_refuse_a_running_one(self):
        from fastapi.testclient import TestClient

        c = TestClient(self.app.app)
        tries: dict[str, int] = {}

        def fails_once(url, *, language=None, model=None, force_whisper=False, progress=None, gate=None, on_info=None):
            tries[url] = tries.get(url, 0) + 1
            if tries[url] == 1:
                raise tr.TranscriptError("Could not reach the site. Check the URL and the network.")
            return tr.Transcript("Talk", url, 60.0, "en", "captions", [tr.Segment(0, 2, "Hi.")])

        with mock.patch.object(tr, "transcribe_url", fails_once):
            jobs = [self.start(c, f"https://example.com/f{i}") for i in range(3)]
            _wait_for(lambda: all(self.app._jobs[j]["state"] == "error" for j in jobs))
            self.assertEqual(c.post("/api/jobs/retry-failed").json()["retried"], 3)
            _wait_for(lambda: all(self.app._jobs[j]["state"] == "done" for j in jobs))
        with mock.patch.object(tr, "transcribe_url", self.fake):
            running = self.start(c, "https://example.com/v7")
            _wait_for(lambda: self.app._jobs[running]["stage"] in ("transcribing", "waiting"))
            self.assertEqual(c.post(f"/api/jobs/{running}/retry").status_code, 409)  # still running: nothing to retry
            self.release.set()

    def test_a_stale_worker_stands_down(self):
        # a job cancelled while waiting and retried at once: its first worker, starting late, must not run it too
        job = "stale0000001"
        self.ids.append(job)
        self.app._jobs[job] = {"id": job, "url": "https://example.com/s", "state": "queued", "stage": "queued", "percent": None, "message": "",
                               "createdAt": time.time(), "updatedAt": time.time(), "frames": {"state": "off"}, "run": 2}
        self.app._cancels[job] = self.threading.Event()
        with mock.patch.object(tr, "transcribe_url", side_effect=AssertionError("a stale worker ran the job")):
            self.app._run(job, self.app.JobRequest(url="https://example.com/s", screenshots=False), 1)
        self.assertEqual(self.app._jobs[job]["state"], "queued")  # untouched: the newer try owns it
        self.app._jobs[job]["state"] = "cancelled"

    def test_the_speech_model_serves_every_slot(self):
        made = {}

        class FakeModel:
            def __init__(self, name, **kwargs):
                made[name] = kwargs

        import sys
        import types

        fake_module = types.SimpleNamespace(WhisperModel=FakeModel)
        with mock.patch.dict(sys.modules, {"faster_whisper": fake_module}), mock.patch.dict(tr._models, {}, clear=True):
            threads = [self.threading.Thread(target=tr._whisper, args=("tiny",)) for _ in range(4)]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
        self.assertEqual(len(made), 1)  # loaded once, however many videos asked at the same moment
        self.assertEqual(made["tiny"]["num_workers"], tr.SPEECH_SLOTS)
        self.assertEqual(made["tiny"]["cpu_threads"], tr.WHISPER_THREADS)


if __name__ == "__main__":
    unittest.main()
