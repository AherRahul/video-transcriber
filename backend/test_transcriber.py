"""Offline tests for the caption parsing, track choice and output formats. Run: python -m unittest -v"""

import json
import unittest

import transcriber as tr


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


if __name__ == "__main__":
    unittest.main()
