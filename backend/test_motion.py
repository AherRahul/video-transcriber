"""Offline tests for Motion: the project store, scene checks, patches, undo, cache hashes, brand colour
parsing and the chat loop with a stand-in for Claude (no network, no browser, no API key).
Run: python -m unittest -v"""

import os
import shutil
import tempfile

# every test works under one temporary folder (deleted at the end), never in motion-data
TMP = tempfile.mkdtemp(prefix="motion-test-")
os.environ["MOTION_DATA_DIR"] = os.path.join(TMP, "app-data")
# the transcriber's screenshots too (the app imports them), never transcriber-data
os.environ["TRANSCRIBER_DATA_DIR"] = os.path.join(TMP, "transcriber-data")
# the chat-loop tests use a stand-in API client: never let them reach Claude Code or the API
os.environ["MOTION_ENGINE"] = "api"
os.environ.pop("ANTHROPIC_API_KEY", None)

import copy  # noqa: E402
import json  # noqa: E402
import math  # noqa: E402
import threading  # noqa: E402
import time  # noqa: E402
import unittest  # noqa: E402
from pathlib import Path  # noqa: E402
from types import SimpleNamespace  # noqa: E402

from anthropic.types.beta import BetaMessage  # noqa: E402

from unittest import mock  # noqa: E402

from motion import agent as ag  # noqa: E402
from motion import brand as br  # noqa: E402
from motion import render as rd  # noqa: E402
from motion import store as store_mod  # noqa: E402
from motion import voice as vc  # noqa: E402
from motion.hub import Hub  # noqa: E402
from motion.store import Store, StoreError, check_scene  # noqa: E402

SCENE = """<style>.t { font: 800 100px/1 var(--font-display); color: var(--ink); }</style>
<h1 class="t" data-id="title">{{title}}</h1>
<script>tl.from($('title'), { y: 40, autoAlpha: 0, duration: 0.5 }, 0.2);</script>"""


def new_store() -> Store:
    return Store(Path(tempfile.mkdtemp(prefix="store-", dir=TMP)))


def tearDownModule():
    shutil.rmtree(TMP, ignore_errors=True)


def storyboard(store: Store, pid: str) -> None:
    store.write_storyboard(
        pid,
        [
            {"id": "s1", "name": "Hook", "idea": "a", "duration": 3, "transition": "fade"},
            {"id": "s2", "name": "Body", "idea": "b", "duration": 4, "transition": "cut"},
            {"id": "s3", "name": "End", "idea": "c", "duration": 3, "transition": "fade"},
        ],
    )


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.store = new_store()
        self.pid = self.store.create_project("Test", "9:16")["id"]
        storyboard(self.store, self.pid)

    def test_seed_kits(self):
        ids = [k["id"] for k in self.store.list_kits()]
        self.assertEqual(ids[:2], ["algoinsight", "algoinsight-paper"])
        self.assertIsNotNone(self.store.kit_logo_path("algoinsight"))

    def test_storyboard_keeps_code_and_drops_removed_scenes(self):
        self.store.write_scene(self.pid, "s2", SCENE, {"title": "Hi"})
        p, notes = self.store.write_storyboard(self.pid, [{"id": "s2", "name": "Body", "duration": 5, "transition": "cut"}])
        self.assertEqual([s["id"] for s in p["scenes"]], ["s2"])
        self.assertEqual(p["scenes"][0]["status"], "written")
        self.assertIn("removed scene s1", notes)
        self.assertIsNotNone(self.store.scene_source(self.pid, "s2"))

    def test_bad_ids_and_limits(self):
        with self.assertRaises(StoreError):
            self.store.write_storyboard(self.pid, [{"id": "Bad Id", "duration": 2}])
        with self.assertRaises(StoreError):
            self.store.write_storyboard(self.pid, [{"id": f"s{i}", "duration": 60} for i in range(46)])  # 46 min > 45 min

    def test_patch_all_or_nothing(self):
        self.store.write_scene(self.pid, "s1", SCENE, {"title": "Hi"})
        with self.assertRaises(StoreError):
            self.store.patch_scene(self.pid, "s1", [{"find": "0.5", "replace": "0.7"}, {"find": "missing", "replace": "x"}])
        self.assertIn("duration: 0.5", self.store.scene_source(self.pid, "s1"))  # the first edit was not applied
        _, _, n = self.store.patch_scene(self.pid, "s1", [{"find": "duration: 0.5", "replace": "duration: 0.7"}])
        self.assertEqual(n, 1)
        self.assertIn("duration: 0.7", self.store.scene_source(self.pid, "s1"))

    def test_patch_refuses_ambiguous_find(self):
        self.store.write_scene(self.pid, "s1", SCENE + "\n<!-- 0.2 -->", {"title": "Hi"})
        with self.assertRaises(StoreError) as ctx:
            self.store.patch_scene(self.pid, "s1", [{"find": "0.2", "replace": "0.3"}])
        self.assertIn("occurs 2 times", str(ctx.exception))
        self.store.patch_scene(self.pid, "s1", [{"find": "0.2", "replace": "0.3", "all": True}])
        self.assertNotIn("0.2", self.store.scene_source(self.pid, "s1"))

    def test_stale_direct_edit_is_refused(self):
        p, _ = self.store.write_scene(self.pid, "s1", SCENE, {"title": "Hi"})
        rev = p["scenes"][0]["rev"]
        self.store.set_props(self.pid, "s1", {"title": "Claude changed it"})
        with self.assertRaises(StoreError) as ctx:
            self.store.edit_scene(self.pid, "s1", {"props": {"title": "Mine"}}, base_rev=rev)
        self.assertEqual(ctx.exception.status, 409)

    def test_undo_restores_scenes(self):
        self.store.write_scene(self.pid, "s1", SCENE, {"title": "One"})
        self.store.snapshot(self.pid, "Before: test")
        self.store.set_props(self.pid, "s1", {"title": "Two"})
        self.store.patch_scene(self.pid, "s1", [{"find": "0.5", "replace": "0.9"}])
        before = self.store.get_project(self.pid)["version"]
        p = self.store.undo(self.pid)
        self.assertEqual(p["scenes"][0]["props"]["title"], "One")
        self.assertIn("duration: 0.5", self.store.scene_source(self.pid, "s1"))
        self.assertGreater(p["version"], before)  # versions only go up
        with self.assertRaises(StoreError):
            self.store.undo(self.pid)

    def test_bundle_and_state(self):
        self.store.write_scene(self.pid, "s1", SCENE, {"title": "Hi"})
        b = self.store.bundle(self.pid)
        self.assertEqual((b["width"], b["height"]), (1080, 1920))
        self.assertEqual([s["start"] for s in b["scenes"]], [0, 3, 7])
        self.assertEqual(b["duration"], 10)
        self.assertTrue(b["brand"]["logoUrl"].startswith("/api/motion/brand-kits/algoinsight/logo"))
        state = self.store.state_summary(self.pid)
        self.assertIn('s1 "Hook" at 0:00, 3.0 s, fade, written', state)
        self.assertIn("brand kit: AlgoInsight", state)


class NarrationTests(unittest.TestCase):
    def setUp(self):
        self.store = new_store()
        self.pid = self.store.create_project("Talk", "16:9", "algoinsight-paper", target_seconds=600)["id"]

    def test_paper_stage_and_defaults(self):
        p = self.store.get_project(self.pid)
        self.assertEqual(self.store.stage_size(p), (1600, 900))
        self.assertEqual(p["voice"]["id"], "fydPJq00SigRIaPxWgiS")  # Pooja, the YouTube voice
        self.assertEqual(p["voice"]["model"], "eleven_v4")
        b = self.store.bundle(self.pid)
        self.assertEqual((b["theme"], b["width"], b["height"]), ("paper", 1600, 900))
        self.assertTrue(b["brand"]["iconUrl"].startswith("/api/motion/brand-kits/algoinsight-paper/icon"))
        self.assertIn("length the user set: 10:00; the whole video must run between 9:00 and 15:00", self.store.state_summary(self.pid))

    def test_spoken_text_and_cues(self):
        text, offsets = vc.spoken("An LLM reads text. <cue/> Then the AI answers. <cue/>", [{"written": "LLM", "spoken": "L-L-M"}, {"written": "AI", "spoken": "A-I"}])
        self.assertEqual(text, "An L-L-M reads text. Then the A-I answers.")
        self.assertEqual(text[offsets[0]:offsets[0] + 4], "Then")
        self.assertEqual(offsets[1], len(text))
        self.assertNotIn("A-IR", vc.spoken("AIR is not AI", [{"written": "AI", "spoken": "A-I"}])[0])

    def test_narrated_length_follows_the_speech(self):
        narration = "Meera opens the app at six. <cue/> The estimate says thirty two minutes. <cue/> It arrives fifty minutes late."
        p, _ = self.store.write_storyboard(self.pid, [{"id": "s1", "name": "Order", "duration": 2, "transition": "tear", "narration": narration, "label": "ONE ORDER", "part": "Part 1 · The evening"}])
        s = p["scenes"][0]
        t = self.store.timing(self.pid, p, s)
        self.assertTrue(t["narrated"])
        self.assertAlmostEqual(t["speech"], round(17 / 2.9, 2), places=2)
        self.assertAlmostEqual(s["duration"], round(math.ceil((0.75 + t["speech"] + 0.6) * 30) / 30, 3))
        self.assertEqual(len(t["cues"]), 3)  # voice start + two cues
        self.assertLess(t["cues"][1], t["cues"][2])
        p = self.store.update_timeline(self.pid, [{"id": "s1", "duration": s["duration"] + 2}])
        self.assertAlmostEqual(p["scenes"][0]["hold"], 2, places=1)  # a longer length becomes a hold after the words

    def test_real_clip_replaces_the_estimate(self):
        narration = "One. <cue/> Two."
        p, _ = self.store.write_storyboard(self.pid, [{"id": "s1", "duration": 2, "transition": "fade", "narration": narration}])
        t = self.store.timing(self.pid, p, p["scenes"][0])
        text = t["spoken"]
        vc.save_clip(self.store.voice_dir(self.pid), t["hash"], text, b"ID3", [0.1 * i for i in range(len(text))], None)
        p = self.store.link_voice(self.pid, "s1", t["hash"])
        t2 = self.store.timing(self.pid, p, p["scenes"][0])
        self.assertTrue(t2["voiced"])
        self.assertAlmostEqual(t2["cues"][1], 0.75 + 0.1 * text.index("Two"), places=2)
        plan = self.store.narration_plan(self.pid)
        self.assertEqual(len(plan["clips"]), 1)
        p, _ = self.store.write_script(self.pid, [{"id": "s1", "narration": "One. <cue/> Three."}])
        self.assertTrue(self.store.timing(self.pid, p, p["scenes"][0])["stale"])  # edited words: the old audio no longer counts

    def test_voice_rules_and_script(self):
        self.store.write_storyboard(self.pid, [{"id": "a", "duration": 3, "transition": "tear", "part": "Part 1 · Start"}, {"id": "b", "duration": 3, "transition": "turn", "part": "Part 2 · Next"}, {"id": "end", "kind": "endscreen", "duration": 15, "transition": "fade"}])
        _, notes = self.store.write_script(self.pid, [{"id": "a", "narration": "It costs 20% (about $6) - see?"}])
        joined = " ".join(notes)
        for rule in ("digits", "parentheses", "symbols", "dashes"):
            self.assertIn(rule, joined)
        md = self.store.script_markdown(self.pid)
        self.assertIn("## Chapters", md)
        self.assertIn("0:00 Part 1 · Start", md)
        self.assertIn("(end screen)", md)
        self.assertEqual([c["title"] for c in self.store.chapters(self.pid)], ["Part 1 · Start", "Part 2 · Next"])

    def test_kit_validation(self):
        with self.assertRaises(StoreError):
            self.store.create_kit({"name": "X", "palette": {"bg": "navy"}})
        kit = self.store.create_kit({"name": "Mine", "palette": {"accent": "#ABCDEF"}}, base_id="algoinsight")
        self.assertEqual(kit["palette"]["accent"], "#abcdef")
        self.assertEqual(kit["palette"]["bg"], "#0b1020")  # from the base kit
        self.assertEqual(kit["logo"], "logo.png")  # the base kit's logo is copied

    def test_assets(self):
        item = self.store.save_asset(self.pid, "My Logo.PNG", b"\x89PNG\r\n\x1a\n" + b"\0\0\0\rIHDR" + (64).to_bytes(4, "big") + (32).to_bytes(4, "big") + b"\x08\x06\0\0\0")
        self.assertEqual(item["name"], "My-Logo.png")
        self.assertEqual((item["width"], item["height"]), (64, 32))
        with self.assertRaises(StoreError):
            self.store.save_asset(self.pid, "run.exe", b"MZ")
        with self.assertRaises(StoreError):
            self.store.asset_path(self.pid, "../project.json")


SOURCE = """Title: lesson1
Link: https://example.com/lesson1.mp4

[0:00] Many products now contain a model.
[0:03] A model is a function whose behavior is learned from data, not written by a developer.
[0:09] It takes an input and returns an output.
[4:30] The time between a request and its answer is called latency.
[9:40] Like and subscribe for more videos like this one.
[10:08] In the interview, name the family and agree on the scope first.
"""


def talk(words: int, start: str = "Meera") -> str:
    """Narration of about this many words that shares no run of eight words with SOURCE."""
    base = f"{start} looks at the dosa stall queue and counts the people waiting before her turn. <cue/> "
    n = len(base.split()) - 1
    return base * max(1, words // n)


PLAN = {"shape": "story", "why": "one evening at a food stall shows the whole idea", "minutes": 6, "lengthWhy": "one idea with one worked example"}


class SourceTests(unittest.TestCase):
    """A reference transcript is research only; the script follows a plan (shape and length for the topic)
    and waits for the user's own words before any scene code."""

    def setUp(self):
        self.store = new_store()
        self.hub = Hub(self.store)
        self.agent = ag.Agent(self.store, renderer=None, hub=self.hub, exports=None)
        self.pid = self.store.create_project("From a talk", "16:9", "algoinsight-paper")["id"]
        self.store.save_asset(self.pid, "transcript-lesson1.txt", SOURCE.encode())

    def attach(self):
        return self.agent._attachment_blocks(self.pid, "transcript-lesson1.txt")


    def test_a_timed_attachment_is_the_reference(self):
        blocks = self.attach()
        self.assertIn("is the reference (10:08 by its timestamps): cover every point it makes, nothing dropped", blocks[-1]["text"])
        p = self.store.get_project(self.pid)
        self.assertIsNone(p["targetSeconds"])  # the user set no length: the reference's own sets it (length_target)
        self.assertFalse(p["scriptReview"])  # no video waits for the user's words any more
        self.assertEqual(self.store.length_target(self.pid, p)[:2], (608.0, "reference"))
        src = self.store.get_source(self.pid)
        self.assertEqual(len(src["lines"]), 6)  # the title and the link are not lines
        self.assertEqual(src["lines"][3], {"t": 270.0, "text": "The time between a request and its answer is called latency."})
        listing, label = self.agent._tool(self.pid, "read_source", {"from": "4:00"})
        self.assertIn("the reference: the video covers every point it makes, in about its length", listing)
        self.assertIn("[4:30] The time between a request and its answer is called latency.", listing)
        self.assertEqual(label, "Read the reference (3 lines)")
        state = self.store.state_summary(self.pid)
        self.assertIn("reference: transcript-lesson1.txt, 10:08, 6 timed lines (the video covers every point it makes", state)
        self.assertIn("length: about the reference's own 10:08", state)
        # copying it word for word is still refused
        self.store.write_storyboard(self.pid, [{"id": "b", "name": "Latency", "idea": "y", "transition": "tear"}])
        self.store.write_script(self.pid, [{"id": "b", "narration": "A model is a function whose behavior is learned from data, not written by a developer."}])
        joined = " ".join(self.store.plan_review(self.pid)["problems"])
        self.assertIn("repeat the reference word for word", joined)
        self.assertIn('b: "a model is a function whose behavior is learned from data not written by a developer"', joined)

    def test_transcript_formats_and_plans(self):
        srt = "1\n00:00:01,000 --> 00:00:04,000\nHello there\nand welcome\n\n2\n00:01:05,500 --> 00:01:08,000\nSecond cue\n"
        self.assertEqual(store_mod.parse_source(srt), [{"t": 1.0, "text": "Hello there and welcome"}, {"t": 65.0, "text": "Second cue"}])
        self.assertEqual(store_mod.parse_source("1:02:03 Late in a long talk\nstill talking")[0], {"t": 3723.0, "text": "Late in a long talk still talking"})
        self.assertEqual(store_mod.clean_plan({**PLAN, "shape": "Story"}), {**PLAN, "minutes": 6.0})
        for bad in ({**PLAN, "shape": "listicle"}, {**PLAN, "why": ""}, {**PLAN, "minutes": "long"}, {**PLAN, "minutes": 90}, "story"):
            with self.assertRaises(StoreError):
                store_mod.clean_plan(bad)


    def test_claude_writes_every_word_and_never_waits(self):
        # no reference here: the topic decides the length
        self.store.write_storyboard(self.pid, [
            {"id": "a", "name": "The queue", "idea": "x", "transition": "tear", "narration": talk(60)},
            {"id": "b", "name": "Latency", "idea": "y", "transition": "turn", "narration": talk(60, "Kabir")},
        ])
        self.assertEqual(self.store.plan_review(self.pid)["problems"], [])  # no plan, no approval needed first
        # a place left for the user's words is Claude's to fill: scene code is refused until it does
        content, _ = self.agent._tool(self.pid, "write_script", {"scenes": [
            {"id": "a", "narration": talk(60)},
            {"id": "b", "narration": talk(40, "Kabir") + " [[you: the interview where you got latency wrong, two sentences]]"},
        ]})
        self.assertIn("1 place for the user's words still to write yourself", content)
        review = self.store.plan_review(self.pid)
        self.assertIn("1 place for the user's own words left (b): write each one yourself", " ".join(review["problems"]))
        self.assertIsNone(review["waiting"])
        with self.assertRaises(StoreError) as refused:
            self.agent._tool(self.pid, "write_scene", {"id": "a", "html": SCENE})
        self.assertIn("isn't ready for scene code", str(refused.exception))
        from motion.jobs import VoiceJobs

        with self.assertRaises(StoreError) as refused:
            VoiceJobs(self.store, self.hub, lambda: None).start(self.pid)
        self.assertIn("b still has a place for your own words", str(refused.exception))
        # Claude writes it in: the scenes are built in the same turn, nobody waits
        self.agent._tool(self.pid, "write_script", {"scenes": [{"id": "b", "narration": talk(40, "Kabir") + " The one thing to remember is that latency is waiting time, not speed."}]})
        self.assertEqual(self.store.plan_review(self.pid)["problems"], [])
        self.assertFalse(self.store.script_state(self.pid)["waiting"])
        content, _ = self.agent._tool(self.pid, "write_scene", {"id": "a", "html": SCENE})
        self.assertIn("Scene a saved", content)
        self.assertNotIn("waiting for the user", self.store.state_summary(self.pid))
        # narration the user rewrote themselves stays theirs: Claude changes it only when asked
        p = self.store.get_project(self.pid)
        rev = next(s for s in p["scenes"] if s["id"] == "b")["rev"]
        self.store.edit_scene(self.pid, "b", {"narration": talk(40, "Kabir") + " I once said latency was the same as speed."}, rev)
        self.assertEqual(self.store.script_state(self.pid)["byUser"], 1)
        with self.assertRaises(StoreError) as refused:
            self.agent._tool(self.pid, "write_script", {"scenes": [{"id": "b", "narration": talk(30, "Kabir")}]})
        self.assertIn("in the user's own words", str(refused.exception))
        self.agent._tool(self.pid, "write_script", {"scenes": [{"id": "b", "narration": talk(30, "Kabir")}], "replaceOwnWords": True})
        self.assertFalse(next(s for s in self.store.get_project(self.pid)["scenes"] if s["id"] == "b")["byUser"])


    def test_the_reference_sets_the_length_unless_the_user_set_one(self):
        self.attach()  # a 10:08 reference: the video must run 9:07 to 12:09
        self.store.write_storyboard(self.pid, [{"id": "a", "name": "Queue", "idea": "x", "transition": "tear", "narration": talk(60)}])
        joined = " ".join(self.store.plan_review(self.pid)["problems"])
        self.assertIn("the reference's length (10:08) needs at least", joined)
        self.assertIn("Check every point the reference makes is covered; never pad.", joined)
        # far too long: tighten, never drop one of its points
        self.store.write_storyboard(self.pid, [
            {"id": k, "name": k, "idea": "x", "transition": "tear", "narration": talk(700, "Meera" if i % 2 else "Kabir")} for i, k in enumerate("abcd")
        ])
        joined = " ".join(self.store.plan_review(self.pid)["problems"])
        self.assertIn("the reference's length (10:08) allows at most", joined)
        self.assertIn("never one of its points", joined)
        # a length the user set wins over the reference's
        self.store.update_project(self.pid, {"targetSeconds": 600})
        self.store.write_storyboard(self.pid, [{"id": "a", "name": "Queue", "idea": "x", "transition": "tear", "narration": talk(60)}])
        joined = " ".join(self.store.plan_review(self.pid)["problems"])
        self.assertIn("the length the user set (10:00) needs at least 9:00", joined)
        self.assertIn("length the user set: 10:00", self.store.state_summary(self.pid))
        # no reference and no length of the user's: the topic decides, nothing is forced
        other = self.store.create_project("No reference", "16:9", "algoinsight-paper")["id"]
        self.store.write_storyboard(other, [{"id": "a", "name": "Queue", "idea": "x", "transition": "tear", "narration": talk(60)}])
        self.assertEqual(self.store.plan_review(other)["problems"], [])

    def test_a_short_from_a_long_talk(self):
        self.attach()
        p, _ = self.store.write_storyboard(self.pid, [{"id": "a", "name": "Reel", "idea": "x", "transition": "fade", "duration": 30}], target_minutes=0.5)
        self.assertEqual(p["targetSeconds"], 30)
        self.assertEqual(self.store.plan_review(self.pid)["problems"], [])  # a silent short has no script to wait for
        self.agent._tool(self.pid, "write_scene", {"id": "a", "html": SCENE})

    def test_the_other_videos_shapes_are_in_the_state(self):
        other = self.store.create_project("Older video", "16:9", "algoinsight-paper")["id"]
        self.store.write_storyboard(other, [{"id": "a", "name": "One", "idea": "x", "transition": "tear", "narration": talk(30)}], plan={**PLAN, "shape": "compare"})
        old = self.store.create_project("Before plans", "16:9", "algoinsight-paper")["id"]
        self.store.write_storyboard(old, [{"id": "a", "name": "One", "idea": "x", "transition": "tear", "narration": talk(30)}])
        line = next(ln for ln in self.store.state_summary(self.pid).splitlines() if ln.startswith("the user's other videos"))
        self.assertIn('"Older video" compare', line)
        self.assertIn('"Before plans" shape not recorded', line)


    def test_an_older_video_with_the_review_on_never_waits(self):
        p = self.store.get_project(self.pid)
        p["scriptReview"] = True  # switched on before the words step was taken out
        store_mod.write_json(self.store._dir(self.pid) / "project.json", p)
        self.store.write_storyboard(self.pid, [{"id": "a", "name": "Queue", "idea": "x", "transition": "tear", "narration": talk(60)}])
        review = self.store.plan_review(self.pid)
        self.assertEqual(review["problems"], [])  # no plan and no approval needed
        self.assertIsNone(review["waiting"])
        self.agent._tool(self.pid, "write_scene", {"id": "a", "html": SCENE})

class ToneTests(unittest.TestCase):
    """The script's tone: normal, funny, focused or informational, picked per video."""

    def test_tone_on_the_project_and_in_what_claude_sees(self):
        store = new_store()
        pid = store.create_project("Tones", "16:9", "algoinsight-paper")["id"]
        self.assertEqual(store.get_project(pid)["tone"], "normal")
        self.assertEqual(store.create_project("Funny", "16:9", tone="funny")["tone"], "funny")
        self.assertEqual(store.create_project("Odd", "16:9", tone="sarcastic")["tone"], "normal")
        with self.assertRaises(StoreError):
            store.update_project(pid, {"tone": "sarcastic"})
        store.update_project(pid, {"tone": "informational"})
        self.assertIn("tone: informational (research and technical sources decoded in simple English", store.state_summary(pid))
        self.assertIn("Tone: informational.", store.script_markdown(pid))
        p = store.get_project(pid)
        p.pop("tone")  # a video made before tones
        self.assertEqual(store_mod.tone_of(p), "normal")

    def test_a_new_tone_after_the_script_leaves_a_note(self):
        from fastapi.testclient import TestClient

        import app

        c = TestClient(app.app)
        r = c.post("/api/motion/projects", json={"title": "Tone note", "brandKitId": "algoinsight-paper", "tone": "focused"})
        pid = r.json()["project"]["id"]
        self.assertEqual(r.json()["project"]["tone"], "focused")
        self.assertEqual(c.patch(f"/api/motion/projects/{pid}", json={"tone": "funny"}).json()["project"]["tone"], "funny")
        notes = [e["text"] for e in c.get(f"/api/motion/projects/{pid}/chat").json()["log"] if e.get("kind") == "note"]
        self.assertEqual(notes, [])  # no script yet: nothing to rewrite
        Store(store_mod.DATA_DIR).write_storyboard(pid, [{"id": "a", "name": "One", "idea": "x", "transition": "tear", "narration": "Meera waits in the queue."}])
        c.patch(f"/api/motion/projects/{pid}", json={"tone": "informational"})
        notes = [e["text"] for e in c.get(f"/api/motion/projects/{pid}/chat").json()["log"] if e.get("kind") == "note"]
        self.assertTrue(any("Tone now informational. The script was written in the funny tone" in n for n in notes), notes)
        self.assertEqual(c.patch(f"/api/motion/projects/{pid}", json={"tone": "loud"}).status_code, 400)
        c.delete(f"/api/motion/projects/{pid}")

    def test_the_prompt_says_what_each_tone_asks_for(self):
        from motion.prompts import SYSTEM_PROMPT

        section = SYSTEM_PROMPT[SYSTEM_PROMPT.index("# Tone"):SYSTEM_PROMPT.index("# Editing")]
        for tone in store_mod.TONES:
            self.assertIn(f"- {tone}:", section)
        for phrase in (
            "Every tone keeps simple, easy English",
            "Facts stay serious: a number or a claim is never the joke",
            "no jokes about religion, politics, caste, gender, looks, illness or tragedies",
            "Every sentence teaches something",
            "name it (title, authors, year, where it appeared)",
            "Keep what the paper claims apart from your reading of it",
        ):
            self.assertIn(phrase, section)
        self.assertIn("paper (a research paper decoded", SYSTEM_PROMPT)
        self.assertIn("in the video's tone (see Tone)", SYSTEM_PROMPT)


class PublishingTests(unittest.TestCase):
    """Playlists and courses, each video's place in one, its status marks and its publishing details."""

    def episodes(self, store, cid):
        return [(v["title"], v["episode"]) for v in next(c for c in store.list_collections() if c["id"] == cid)["videos"]]

    def test_videos_are_numbered_in_their_playlist(self):
        store = new_store()
        pl = store.create_collection("youtube", "AI for Everyone")
        with self.assertRaises(StoreError):
            store.create_collection("youtube", "ai for everyone")  # the same name twice
        with self.assertRaises(StoreError):
            store.create_collection("vimeo", "Nope")
        a = store.create_project("One", "16:9", collection={"id": pl["id"]})
        b = store.create_project("Two", "16:9", collection={"id": pl["id"]})
        c = store.create_project("Three", "16:9", collection={"id": pl["id"]})
        self.assertEqual(self.episodes(store, pl["id"]), [("One", 1), ("Two", 2), ("Three", 3)])
        self.assertEqual(c["collection"]["order"], 3)
        # a new video at episode 2 moves the others down
        d = store.create_project("New two", "16:9", collection={"id": pl["id"], "order": 2})
        self.assertEqual(self.episodes(store, pl["id"]), [("One", 1), ("New two", 2), ("Two", 3), ("Three", 4)])
        # moving one later, then taking one out, closes the gaps
        store.update_project(a["id"], {"collection": {"id": pl["id"], "order": 3}})
        self.assertEqual(self.episodes(store, pl["id"]), [("New two", 1), ("Two", 2), ("One", 3), ("Three", 4)])
        store.update_project(b["id"], {"collection": None})
        self.assertEqual(self.episodes(store, pl["id"]), [("New two", 1), ("One", 2), ("Three", 3)])
        store.reorder_collection(pl["id"], [c["id"], d["id"]])
        self.assertEqual(self.episodes(store, pl["id"]), [("Three", 1), ("New two", 2), ("One", 3)])
        store.delete_project(c["id"])
        self.assertEqual(self.episodes(store, pl["id"]), [("New two", 1), ("One", 2)])
        place = store.placement(a["id"])
        self.assertEqual((place["episode"], place["count"], place["previous"], place["next"]), (2, 2, "New two", None))
        summary = store.state_summary(a["id"])
        self.assertIn('placement: episode 2 of 2 in the YouTube playlist "AI for Everyone" (before it: "New two"; the last one so far)', summary)
        self.assertIn('the episodes in order: 1 "New two"; 2 "One"', summary)
        self.assertIn("has no description yet (write_details collection", summary)
        store.delete_collection(pl["id"])
        self.assertIsNone(store.get_project(a["id"])["collection"])
        self.assertIn("placement: in no playlist or course", store.state_summary(a["id"]))

    def test_a_udemy_course_makes_a_udemy_video_in_its_section(self):
        store = new_store()
        course = store.create_collection("udemy", "System design from zero")
        a = store.create_project("Load balancers", "16:9", "algoinsight-paper", collection={"id": course["id"], "section": "Scaling"})
        self.assertEqual(a["destination"], "udemy")
        # the logo card, but no web address, promo or end screen
        self.assertEqual(store.get_project(a["id"])["closing"], {"logo": True, "url": False, "promo": False, "endscreen": False})
        b = store.create_project("Caches", "16:9", "algoinsight-paper", collection={"id": course["id"]})
        self.assertEqual(b["collection"]["section"], "Scaling")  # the section of the lecture before it
        self.assertIn('lecture 2 of 2 in the Udemy course "System design from zero", section "Scaling"', store.state_summary(b["id"]))
        # back to a YouTube playlist: a YouTube video again, with its end screen
        pl = store.create_collection("youtube", "Daily")
        p = store.update_project(b["id"], {"collection": {"id": pl["id"]}})
        self.assertEqual((p["destination"], p["closing"]["endscreen"]), ("youtube", True))
        self.assertEqual(self.episodes(store, course["id"]), [("Load balancers", 1)])
        self.assertEqual(store.create_project("Plain udemy", "16:9", destination="udemy")["destination"], "udemy")

    def test_downloaded_and_uploaded_marks(self):
        store = new_store()
        pid = store.create_project("Marks", "16:9")["id"]
        self.assertEqual(store.list_projects()[0]["progress"]["stage"], "new")
        store.mark_downloaded(pid, "marks-3840x2160-v4.mp4")
        st = store.get_project(pid)["status"]
        self.assertEqual(st["downloadedFile"], "marks-3840x2160-v4.mp4")
        with self.assertRaises(StoreError):
            store.update_project(pid, {"status": {"uploadUrl": "youtube.com/watch"}})
        store.update_project(pid, {"status": {"uploadUrl": "https://youtu.be/abc123"}})
        row = store.list_projects()[0]
        self.assertTrue(row["progress"]["uploaded"] and row["progress"]["downloaded"])
        self.assertEqual(row["progress"]["stage"], "uploaded")
        self.assertIn("status: uploaded (https://youtu.be/abc123)", store.state_summary(pid))
        store.update_project(pid, {"status": {"uploaded": False}})
        self.assertNotIn("uploadUrl", store.get_project(pid)["status"])

    def test_details_are_plain_text_with_live_chapters(self):
        store = new_store()
        pid = store.create_project("Details", "16:9", "algoinsight-paper")["id"]
        store.write_storyboard(pid, [
            {"id": "a", "name": "One", "idea": "x", "part": "Part 1 · The queue", "narration": "Meera waits in the queue."},
            {"id": "b", "name": "Two", "idea": "y", "part": "Part 2 · The fix", "narration": "Then the line moves."},
        ])
        p, warnings = store.write_details(pid, youtube={
            "titles": ["Why your queue is slow and how to fix it", "Short", "Short"],
            "primaryKeyword": "queue wait time",
            "description": "## Why queues get slow\n\nThe **queue wait time** explained.\n\nIn this video:\n* Where the wait comes from\n* The fix\n\n{chapters}\n\nRead [the paper](https://example.org/paper).",
            "tags": ["queues"] * 3,
            "hashtags": ["Queues", "#system design", "#queues"],
            "unknown": "dropped",
        })
        yt = p["details"]["youtube"]
        self.assertEqual(yt["title"], "Why your queue is slow and how to fix it")  # the first option until one is picked
        self.assertEqual(yt["titles"], ["Why your queue is slow and how to fix it", "Short"])  # repeats dropped
        self.assertEqual(yt["hashtags"], ["#Queues", "#systemdesign"])
        self.assertEqual(yt["tags"], ["queues"])
        self.assertNotIn("unknown", yt)
        # Markdown is taken out: YouTube shows it as typed
        self.assertEqual(
            yt["description"],
            "Why queues get slow\n\nThe queue wait time explained.\n\nIn this video:\n- Where the wait comes from\n- The fix\n\n{chapters}\n\nRead the paper: https://example.org/paper.",
        )
        for w in ("give 3 to 5 title options", "1 tags: aim for 10 to 15", "2 hashtags: use 3 to 5", "the description has", 'the title doesn\'t carry the main keyword "queue wait time"'):
            self.assertTrue(any(w in x for x in warnings), (w, warnings))
        desc = store.details_view(pid)["youtubeDescription"]
        self.assertIn("The fix\n\nChapters\n0:00 The queue\n0:", desc)  # the chapters where {chapters} was, named by their parts
        self.assertNotIn("{chapters}", desc)
        self.assertTrue(desc.endswith("#Queues #systemdesign"))
        self.assertIn('publishing details (youtube): written, title "Why your queue is slow', store.state_summary(pid))
        # the user's own text is used as it is, its chapter lines still follow the video
        mine = desc.replace("The queue wait time explained.", "My own words about the queue wait time.").replace("0:00 The queue", "0:00 Old name")
        store.update_project(pid, {"details": {"youtube": {"post": mine}}})
        view = store.details_view(pid)
        self.assertIn("My own words about the queue wait time.", view["youtubeDescription"])
        self.assertIn("0:00 The queue", view["youtubeDescription"])
        self.assertNotIn("Old name", view["youtubeDescription"])
        # Claude writing a new description replaces the hand-edited one
        store.write_details(pid, youtube={"description": "A new post about the queue wait time."})
        self.assertNotIn("post", store.get_project(pid)["details"]["youtube"])
        # Udemy: the quiz needs four options and the answer; AlgoInsight never appears
        _, warnings = store.write_details(pid, udemy={
            "lectureTitle": "Queues: where the wait comes from",
            "objectives": ["Explain queueing delay", "Choose a fix"],
            "quiz": [{"question": "What grows the wait?", "options": ["Load", "Colour"], "answer": 5, "why": "x"}],
            "lectureDescription": "See it on AlgoInsight.",
        })
        self.assertTrue(any("4 options" in w for w in warnings), warnings)
        self.assertTrue(any("can't name AlgoInsight" in w for w in warnings), warnings)
        md = store.details_markdown(pid)
        self.assertIn("## YouTube", md)
        self.assertIn("Title:\nWhy your queue is slow and how to fix it\n", md)
        self.assertIn("## Udemy", md)
        self.assertIn("By the end of this lecture you will be able to:\n- Explain queueing delay", md)
        self.assertNotIn("**", md)
        # the course's own details, only for a video in one
        _, warnings = store.write_details(pid, collection={"title": "x"})
        self.assertIn("collection details not saved: this video is in no playlist or course", warnings)

    def test_seo_checks_and_invisible_characters(self):
        from motion import publishing as pb

        self.assertEqual(pb.keyword_missing("chatgpt training data", "Where ChatGPT's training data comes from"), [])
        self.assertEqual(pb.keyword_missing("load balancing", "Load balancers, simply"), ["balancing"])
        store = new_store()
        c = store.create_collection("youtube", "AI​​ System Design")
        self.assertEqual(c["title"], "AI System Design")
        good = " ".join(["word"] * 240)
        warnings = pb.details_warnings("youtube", {
            "titles": ["Load balancing explained with one real outage", "Load balancing: the three algorithms", "Load balancing in system design interviews"],
            "title": "Load balancing explained with one real outage",
            "primaryKeyword": "load balancing",
            "description": "Load balancing, explained with one real outage. " + good,
            "hashtags": ["#SystemDesign", "#LoadBalancing", "#Backend"],
            "tags": [f"tag {i}" for i in range(12)],
        })
        self.assertEqual(warnings, [])

    def test_thumbnail_colour_check(self):
        self.assertEqual(store_mod.thumbnail_colour_warnings({"pale": 0.2, "dark": 0.5, "vivid": 0.2}), [])
        pale = store_mod.thumbnail_colour_warnings({"pale": 0.8, "dark": 0.05, "vivid": 0.05})
        self.assertTrue(any("80% of the thumbnail is pale" in w for w in pale), pale)
        self.assertTrue(any("Only 10% of it is dark or strongly coloured" in w for w in pale), pale)

    def test_the_api_places_marks_and_downloads(self):
        from fastapi.testclient import TestClient

        import app

        c = TestClient(app.app)
        course = c.post("/api/motion/collections", json={"kind": "udemy", "title": "API course " + str(time.time())}).json()
        r = c.post("/api/motion/projects", json={"title": "API lecture", "tone": "focused", "collection": {"id": course["id"], "section": "Basics"}, "scriptReview": False, "targetSeconds": 600})
        p = r.json()["project"]
        self.assertEqual((p["destination"], p["tone"], p["scriptReview"], p["targetSeconds"]), ("udemy", "focused", False, 600))
        pid = p["id"]
        self.assertEqual(c.patch(f"/api/motion/collections/{course['id']}", json={"meta": {"level": "Beginner", "subtitle": "s" * 300}}).json()["meta"]["subtitle"], "s" * 120)
        listed = next(x for x in c.get("/api/motion/collections").json() if x["id"] == course["id"])
        self.assertEqual([(v["title"], v["episode"], v["section"]) for v in listed["videos"]], [("API lecture", 1, "Basics")])
        # a download from the page marks it; playing it doesn't
        renders = Store(store_mod.DATA_DIR).renders_dir(pid)
        (renders / "api-lecture-1920x1080-v1.mp4").write_bytes(b"\0" * 64)
        c.get(f"/api/motion/projects/{pid}/renders/api-lecture-1920x1080-v1.mp4")
        self.assertNotIn("downloadedAt", c.get(f"/api/motion/projects/{pid}").json()["project"].get("status") or {})
        c.get(f"/api/motion/projects/{pid}/renders/api-lecture-1920x1080-v1.mp4?download=1")
        self.assertEqual(c.get(f"/api/motion/projects/{pid}/details").json()["status"]["downloadedFile"], "api-lecture-1920x1080-v1.mp4")
        c.patch(f"/api/motion/projects/{pid}", json={"details": {"udemy": {"lectureTitle": "Queues"}}})
        self.assertIn("Lecture title:\nQueues", c.get(f"/api/motion/projects/{pid}/details.md").text)
        self.assertFalse(c.get(f"/api/motion/projects/{pid}/details").json()["running"])
        self.assertEqual(c.delete(f"/api/motion/collections/{course['id']}").json(), {"ok": True})
        c.delete(f"/api/motion/projects/{pid}")

    def test_the_prompt_asks_for_the_details_like_a_creator(self):
        from motion.prompts import SYSTEM_PROMPT, TOOLS

        section = SYSTEM_PROMPT[SYSTEM_PROMPT.index("# Publishing details"):SYSTEM_PROMPT.index("# The plain theme")]
        for phrase in (
            "a top educational creator",
            "Everything is plain text",
            "at most 70 characters",
            "200 to 350 words",
            "A line {chapters} where the chapters go",
            "The episodes either side by their titles",
            "Hashtags: 3 to 5",
            "10 to 15 phrases",
            "four options, one clearly right",
            "Nothing about AlgoInsight",
        ):
            self.assertIn(phrase, section)
        thumb = SYSTEM_PROMPT[SYSTEM_PROMPT.index("# The thumbnail"):SYSTEM_PROMPT.index("# Publishing details")]
        for phrase in ("Concept first", "1 to 4 words", "fills 40 to 60 percent of the frame", "never the pale paper alone", "the feed view", "EP 4"):
            self.assertIn(phrase, thumb)
        tool = next(t for t in TOOLS if t["name"] == "write_details")
        self.assertEqual(set(tool["input_schema"]["properties"]["youtube"]["properties"]), {"titles", "title", "primaryKeyword", "description", "hashtags", "tags"})
        self.assertNotIn("YOUTUBE.md document", SYSTEM_PROMPT)


class BrollTests(unittest.TestCase):
    """B-roll: the user's clips and free stock, converted for exact seeking (backend/motion/broll.py)."""

    @classmethod
    def setUpClass(cls):
        cls.ff = _ffmpeg()

    def clip(self, name: str, seconds: float = 2.0, size: str = "1280x720", rate: int = 25, audio: bool = True) -> Path:
        """A test clip: testsrc2 (a moving picture) with a tone, made by FFmpeg."""
        import subprocess

        if not self.ff:
            self.skipTest("FFmpeg not found")
        out = Path(tempfile.mkdtemp(dir=TMP)) / name
        args = [self.ff, "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", f"testsrc2=size={size}:rate={rate}:duration={seconds}"]
        if audio:
            args += ["-f", "lavfi", "-i", f"sine=frequency=440:duration={seconds}", "-shortest"]
        args += ["-pix_fmt", "yuv420p", str(out)]
        subprocess.run(args, check=True, timeout=120)
        return out

    def test_the_copy_is_made_for_exact_seeking(self):
        from motion import broll as bl

        args = bl.convert_args("ffmpeg", Path("in.mov"), Path("out.mp4"), 30, start=1.5, seconds=4)
        joined = " ".join(args)
        for piece in ("-an", "-g 10", "-keyint_min 10", "-sc_threshold 0", "-bf 0", "-color_range tv", "-pix_fmt yuv420p", "fps=30", "out_range=tv", "-ss 1.500", "-t 4.000", "+faststart"):
            self.assertIn(piece, joined)
        self.assertIn("min(3840/iw,2160/ih)", joined)  # never larger than 4K, never grown
        self.assertEqual((bl.clip_fps(29.97), bl.clip_fps(None), bl.clip_fps(120), bl.clip_fps(0.5)), (29.97, 30.0, 30.0, 30.0))
        facts = bl.probe_text("Duration: 00:01:02.50, start: 0\n  Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 25 fps, 25 tbr")
        self.assertEqual(facts, {"seconds": 62.5, "width": 1920, "height": 1080, "fps": 25.0})

    def test_a_real_clip_converts_silent_with_a_keyframe_every_10_frames(self):
        import subprocess

        from motion import broll as bl

        src = self.clip("phone.mov", seconds=2.0, rate=25)
        dst = src.with_name("phone.mp4")
        facts = bl.convert(self.ff, src, dst)
        self.assertEqual((facts["width"], facts["height"], facts["fps"]), (1280, 720, 25.0))
        self.assertAlmostEqual(facts["seconds"], 2.0, delta=0.1)
        probe = bl.ffprobe_exe(self.ff)
        if probe:
            streams = subprocess.run([probe, "-v", "error", "-show_entries", "stream=codec_type,color_range,pix_fmt", "-of", "json", str(dst)], capture_output=True, text=True, timeout=60).stdout
            info = json.loads(streams)["streams"]
            self.assertEqual([s["codec_type"] for s in info], ["video"])  # no sound
            self.assertEqual((info[0]["pix_fmt"], info[0].get("color_range")), ("yuv420p", "tv"))
            kinds = subprocess.run([probe, "-v", "error", "-select_streams", "v:0", "-show_entries", "frame=pict_type", "-of", "csv=p=0", str(dst)], capture_output=True, text=True, timeout=60).stdout.split()
            keys = [i for i, k in enumerate(kinds) if k.startswith("I")]
            self.assertEqual(keys, list(range(0, len(kinds), 10)))
            self.assertNotIn("B", "".join(kinds))
        # a part of it, trimmed
        part = bl.convert(self.ff, src, src.with_name("part.mp4"), start=0.5, seconds=1.0)
        self.assertAlmostEqual(part["seconds"], 1.0, delta=0.1)

    def test_clips_in_the_store_and_what_claude_sees(self):
        from motion import broll as bl

        store = new_store()
        pid = store.create_project("Clips", "16:9", "algoinsight-paper")["id"]
        with self.assertRaises(StoreError):
            store.save_asset(pid, "raw.mov", b"\0" * 10)  # clips go through the conversion
        (store.assets_dir(pid) / "street.mp4").write_bytes(b"\0" * 100)
        bl.write_meta(store, pid, "street.mp4", {"kind": "video", "state": "ready", "source": "pexels", "seconds": 4.2, "width": 1920, "height": 1080, "fps": 25.0})
        bl.write_meta(store, pid, "desk.mp4", {"kind": "video", "state": "converting", "source": "upload"})
        items = {a["name"]: a for a in store.list_assets(pid)}
        self.assertEqual((items["street.mp4"]["kind"], items["street.mp4"]["seconds"], items["street.mp4"]["width"]), ("video", 4.2, 1920))
        self.assertEqual(items["desk.mp4"]["state"], "converting")
        self.assertEqual(bl.free_name(store, pid, "desk.mov", ".mp4"), "desk-2.mp4")  # a clip on its way keeps its name
        summary = store.state_summary(pid)
        self.assertIn("b-roll clips: street.mp4 (4.2 s, 1920x1080, stock), desk.mp4 (still converting)", summary)
        store.delete_asset(pid, "street.mp4")
        self.assertIsNone(store.asset_meta(pid, "street.mp4"))

    def stock(self, routes: dict):
        """Stands in for the network: each URL part maps to a JSON answer or to bytes."""
        import io

        from motion import broll as bl

        class Res(io.BytesIO):
            def __enter__(self):
                return self

            def __exit__(self, *a):
                return False

        def fake(req, timeout=None):
            url = req.full_url if hasattr(req, "full_url") else req
            for part, answer in routes.items():
                if part in url:
                    if isinstance(answer, Exception):
                        raise answer
                    return Res(answer if isinstance(answer, bytes) else json.dumps(answer).encode())
            raise AssertionError("unexpected request " + url)

        return mock.patch.multiple(bl, _urlopen=fake, _check_url=lambda u: u)

    PEXELS_VIDEOS = {"videos": [
        {"id": 111, "width": 3840, "height": 2160, "duration": 12, "url": "https://www.pexels.com/video/people-queue-at-a-counter-111/", "image": "https://images.pexels.com/111.jpg",
         "user": {"name": "Asha", "url": "https://www.pexels.com/@asha"},
         "video_files": [{"link": "https://v.pexels.com/111-uhd.mp4", "width": 3840, "height": 2160, "fps": 25, "file_type": "video/mp4"},
                         {"link": "https://v.pexels.com/111-8k.mp4", "width": 7680, "height": 4320, "fps": 25, "file_type": "video/mp4"},
                         {"link": "https://v.pexels.com/111-hd.mp4", "width": 1920, "height": 1080, "fps": 25, "file_type": "video/mp4"}]},
        {"id": 112, "width": 1080, "height": 1920, "duration": 9, "url": "https://www.pexels.com/video/tall-112/", "image": "", "user": {}, "video_files": [{"link": "https://v.pexels.com/112.mp4", "width": 1080, "height": 1920}]},
    ]}
    PIXABAY_VIDEOS = {"hits": [{"id": 222, "pageURL": "https://pixabay.com/videos/server-room-222/", "tags": "server, data centre", "duration": 3, "user": "ravi", "user_id": 9,
                                "videos": {"large": {"url": "https://cdn.pixabay.com/222-l.mp4", "width": 1920, "height": 1080, "thumbnail": "https://cdn.pixabay.com/222.jpg"},
                                           "small": {"url": "https://cdn.pixabay.com/222-s.mp4", "width": 960, "height": 540}}}]}

    def test_stock_search_from_both_services(self):
        from motion import broll as bl

        with mock.patch.dict(os.environ, {"MOTION_PEXELS_KEY": "", "MOTION_PIXABAY_KEY": ""}):
            with self.assertRaises(bl.BrollError) as none:
                bl.search("queue at a counter")
            self.assertIn("MOTION_PEXELS_KEY", str(none.exception))
            self.assertIn("https://www.pexels.com/api/", str(none.exception))
        with mock.patch.dict(os.environ, {"MOTION_PEXELS_KEY": "pk", "MOTION_PIXABAY_KEY": "xk"}), self.stock({"api.pexels.com/videos/search": self.PEXELS_VIDEOS, "pixabay.com/api/videos/": self.PIXABAY_VIDEOS}):
            found = bl.search("queue at a counter", "video", "landscape", min_seconds=2)
        self.assertEqual([c["id"] for c in found], ["pexels:111", "pixabay:222"])  # the tall clip left out, the services alternate
        first = found[0]
        self.assertEqual((first["title"], first["author"], first["seconds"]), ("people queue at a counter", "Asha", 12.0))
        self.assertIn("Pexels License", first["licence"])
        self.assertEqual(bl.best_file(first)["url"], "https://v.pexels.com/111-uhd.mp4")  # the largest at most 4K
        self.assertEqual(bl.best_file(found[1])["url"], "https://cdn.pixabay.com/222-l.mp4")
        self.assertIn("imports at 3840 x 2160", bl.describe(first))
        import urllib.error

        with mock.patch.dict(os.environ, {"MOTION_PEXELS_KEY": "bad", "MOTION_PIXABAY_KEY": ""}), self.stock({"api.pexels.com": urllib.error.HTTPError("u", 401, "no", {}, None)}):
            with self.assertRaises(bl.BrollError) as refused:
                bl.search("queue")
        self.assertIn("refused the key", str(refused.exception))

    def test_import_converts_trims_and_keeps_the_credit(self):
        from motion import broll as bl

        store = new_store()
        pid = store.create_project("Stock", "16:9", "algoinsight-paper")["id"]
        raw = self.clip("stock.mp4", seconds=3.0, rate=30).read_bytes()
        with mock.patch.dict(os.environ, {"MOTION_PEXELS_KEY": "pk", "MOTION_PIXABAY_KEY": ""}), self.stock({"api.pexels.com/videos/search": self.PEXELS_VIDEOS, "111-uhd.mp4": raw}):
            bl.search("queue", "video")
            item = bl.import_stock(store, pid, self.ff, "pexels:111", start=0.5, seconds=1.5)
        self.assertEqual(item["kind"], "video")
        self.assertTrue(item["name"].startswith("broll-people-queue-at-a-counter-111"), item["name"])
        self.assertAlmostEqual(item["seconds"], 1.5, delta=0.1)
        meta = store.asset_meta(pid, item["name"])
        self.assertEqual((meta["source"], meta["author"], meta["stockId"]), ("pexels", "Asha", "pexels:111"))
        credits = store.read_doc(pid, "CREDITS.md")
        self.assertIn(f'- asset://{item["name"]}: "people queue at a counter" by Asha (https://www.pexels.com/@asha) on Pexels', credits)
        self.assertFalse(any((store.assets_dir(pid) / ".incoming").iterdir()))  # the download is gone

    def test_an_upload_converts_in_the_background(self):
        from fastapi.testclient import TestClient

        import app

        src = self.clip("mine.mov", seconds=1.5, rate=30)
        c = TestClient(app.app)
        pid = c.post("/api/motion/projects", json={"title": "Upload clip", "brandKitId": "algoinsight-paper"}).json()["project"]["id"]
        with open(src, "rb") as fh:
            got = c.post(f"/api/motion/projects/{pid}/assets", files={"files": ("mine.mov", fh, "video/quicktime")}).json()
        self.assertEqual((got[0]["name"], got[0]["kind"], got[0]["state"]), ("mine.mp4", "video", "converting"))
        for _ in range(240):
            item = next((a for a in c.get(f"/api/motion/projects/{pid}/assets").json() if a["name"] == "mine.mp4"), {})
            if item.get("state") == "ready":
                break
            time.sleep(0.25)
        self.assertEqual((item.get("state"), item.get("width"), item.get("fps")), ("ready", 1280, 30.0))
        notes = [e["text"] for e in c.get(f"/api/motion/projects/{pid}/chat").json()["log"] if e.get("kind") == "note"]
        self.assertTrue(any("Clip ready: asset://mine.mp4" in n for n in notes), notes)
        # the player seeks clips with range requests
        r = c.get(f"/api/motion/projects/{pid}/assets/mine.mp4", headers={"Range": "bytes=0-99"})
        self.assertEqual((r.status_code, len(r.content)), (206, 100))
        c.delete(f"/api/motion/projects/{pid}")

    def test_the_prompt_and_tools(self):
        from motion import render as rd
        from motion.prompts import SYSTEM_PROMPT, TOOLS

        section = SYSTEM_PROMPT[SYSTEM_PROMPT.index("## B-roll"):SYSTEM_PROMPT.index("## The user's Excalidraw drawings")]
        for phrase in ("the user's own clips first", "never presented as a real demo, a measurement", "Never show identifiable people as our users", "no brand logo", "Keep the credits", "Never call play()", "fx.kenburns"):
            self.assertIn(phrase, section)
        self.assertIn("b-roll is placed, never made", SYSTEM_PROMPT)
        names = {t["name"] for t in TOOLS}
        self.assertTrue({"find_broll", "import_broll"} <= names)
        self.assertIn("p.settle", rd.SEEK_SETTLE)


class KitIconsAndCastTests(unittest.TestCase):
    """The explainer kit's icons, logos and cast as the backend sees them (the files the build scripts wrote)."""

    def test_the_kit_files_are_there(self):
        from motion import kitdata

        self.assertGreater(len(kitdata.icon_tags()), 1500)
        self.assertIn("aws/s3", kitdata.logo_index())
        self.assertEqual(kitdata.logo_index()["azure/acr"], "Container Registries")
        self.assertEqual(set(kitdata.cast_people()), {"meera", "kavya", "kabir", "ishaan", "arjun", "priya"})
        m = kitdata.cast_manifest()
        self.assertIn("talk", m["faces"])
        self.assertEqual(m["aliases"]["faces"]["Explaining"], "talk")  # scenes written for the old cast still work

    def test_find_icons_answers_plain_words(self):
        from motion import kitdata

        db = kitdata.find_icons("database")
        self.assertEqual(db["icons"][0][0], "database")
        self.assertTrue({"aws/rds", "brands/postgres"} <= {n for n, _ in db["logos"]})
        self.assertIn("aws/sqs", [n for n, _ in kitdata.find_icons("message queue")["logos"]][:3])
        self.assertIn("split", [n for n, _ in kitdata.find_icons("load balancer")["icons"]][:3])
        self.assertIn("bot", [n for n, _ in kitdata.find_icons("llm")["icons"]])
        starter = kitdata.find_icons("")
        self.assertIn("server", [n for n, _ in starter["icons"]])
        self.assertEqual(len(starter["logos"]), len(kitdata.logo_index()))

    def test_unknown_icons_logos_and_people_are_reported(self):
        warnings = check_scene(
            '<div data-id="a" data-icon="databse">x</div><img data-id="b" data-logo="aws/s4">'
            '<div class="p-person" data-id="m" data-person="meera" data-pose="fly" data-face="Calm"></div>'
            '<div data-id="z" data-person="zoe"></div><script>tl.set($("a"), {x: 0}, 0)</script>',
            {},
        )
        joined = " | ".join(warnings)
        for part in ('No icon named "databse"', 'No logo "aws/s4"', 'Meera has no pose "fly"', 'No person "zoe" in the cast'):
            self.assertIn(part, joined)
        ok = check_scene('<div data-id="a" data-icon="database">x</div><div data-id="m" data-person="kabir" data-pose="arms" data-face="Driven"></div><script>tl.set($("a"), {x: 0}, 0)</script>', {})
        self.assertFalse(any("icon" in w or "person" in w or "pose" in w or "face" in w for w in ok), ok)

    def test_the_prompt_names_the_cast_and_the_kit(self):
        from motion.prompts import SYSTEM_PROMPT, TOOLS

        self.assertNotIn("{CAST_LIST}", SYSTEM_PROMPT)
        self.assertNotIn("(KIT:icons)", SYSTEM_PROMPT)
        self.assertNotIn("(KIT:cast)", SYSTEM_PROMPT)
        self.assertIn("- meera: Meera, a backend engineer", SYSTEM_PROMPT)
        self.assertIn("never a letter in a circle", SYSTEM_PROMPT)
        self.assertIn('data-icon="name"', SYSTEM_PROMPT)
        self.assertIn("find_icons", [t["name"] for t in TOOLS])


class SketchDrawingTests(unittest.TestCase):
    """The Excalidraw sketch look and the user's own Excalidraw drawings (kit/sketch.ts, kit/excalidraw.ts)."""

    DOC = {
        "type": "excalidraw",
        "version": 2,
        "elements": [
            {"id": "lb", "type": "rectangle", "x": 100, "y": 40, "width": 200, "height": 80, "groupIds": ["g1"], "seed": 11},
            {"id": "lb-text", "type": "text", "x": 120, "y": 65, "width": 160, "height": 25, "text": "Load\nbalancer", "originalText": "Load balancer", "containerId": "lb"},
            {"id": "db", "type": "ellipse", "x": 420, "y": 40, "width": 160, "height": 90, "groupIds": ["g1"]},
            {"id": "a1", "type": "arrow", "x": 300, "y": 80, "width": 120, "height": 4, "points": [[0, 0], [120, 4]], "endArrowhead": "arrow"},
            {"id": "note", "type": "text", "x": 100, "y": 200, "width": 120, "height": 25, "text": "80 ms here", "frameId": "f1"},
            {"id": "f1", "type": "frame", "x": 80, "y": 180, "width": 300, "height": 80, "name": "Latency"},
            {"id": "gone", "type": "rectangle", "x": 900, "y": 900, "width": 50, "height": 50, "isDeleted": True},
        ],
        "files": {},
    }

    def test_excalidraw_files_are_drawings_and_checked(self):
        store = new_store()
        pid = store.create_project("Drawings", "16:9", "algoinsight-paper")["id"]
        item = store.save_asset(pid, "arch.excalidraw", json.dumps(self.DOC).encode())
        self.assertEqual((item["name"], item["kind"]), ("arch.excalidraw", "drawing"))
        with self.assertRaises(StoreError):
            store.save_asset(pid, "broken.excalidraw", b"{not json")
        with self.assertRaises(StoreError):
            store.save_asset(pid, "empty.excalidraw", b'{"type": "excalidraw"}')
        self.assertEqual(store_mod.asset_kind("x.EXCALIDRAW"), "drawing")

    def test_read_drawing_lists_parts_with_their_labels(self):
        store = new_store()
        pid = store.create_project("Drawings", "16:9", "algoinsight-paper")["id"]
        store.save_asset(pid, "arch.excalidraw", json.dumps(self.DOC).encode())
        info = store.read_drawing(pid, "arch")  # the extension is optional
        ids = [e["id"] for e in info["elements"]]
        self.assertNotIn("gone", ids)  # a deleted element isn't part of the drawing
        lb = next(e for e in info["elements"] if e["id"] == "lb")
        self.assertEqual((lb["text"], lb["groups"], lb["box"]), ("Load balancer", ["g1"], [100.0, 40.0, 200.0, 80.0]))
        label = next(e for e in info["elements"] if e["id"] == "lb-text")
        self.assertEqual(label["container"], "lb")
        arrow = next(e for e in info["elements"] if e["id"] == "a1")
        self.assertEqual(arrow["box"], [300.0, 80.0, 120.0, 4.0])
        frame = next(e for e in info["elements"] if e["id"] == "f1")
        self.assertEqual(frame["name"], "Latency")
        self.assertEqual(info["bounds"], [80.0, 40.0, 500.0, 220.0])
        self.assertEqual(info["texts"], ["Load balancer", "80 ms here"])
        self.assertIn("drawing arch.excalidraw: 6 elements, texts: Load balancer; 80 ms here", store.state_summary(pid))
        with self.assertRaises(StoreError) as missing:
            store.read_drawing(pid, "other.excalidraw")
        self.assertIn("Drawings: arch.excalidraw", str(missing.exception))
        # the tool Claude calls
        agent = ag.Agent(store, renderer=None, hub=Hub(store), exports=None)
        text, label = agent._tool(pid, "read_drawing", {"name": "arch.excalidraw"})
        self.assertIn('- lb rectangle at 100,40 size 200x80 "Load balancer"; groups g1', text)
        self.assertIn("- lb-text text at 120,65 size 160x25", text)
        self.assertIn("label of lb", text)
        self.assertIn('named "Latency"', text)
        self.assertIn("fx.drawPart", text)
        self.assertEqual(label, "Read the drawing arch.excalidraw (6 elements)")

    def test_the_prompt_teaches_the_sketch_look_and_drawings(self):
        from motion.prompts import SYSTEM_PROMPT, TOOL_LABELS, TOOLS

        sketch = SYSTEM_PROMPT[SYSTEM_PROMPT.index("## Sketch diagrams"):SYSTEM_PROMPT.index("## Coding visuals")]
        for phrase in ("s-box, s-circle, s-ellipse or s-diamond", "data-fill", "fx.sketchIn", "fx.sketchLink", "fx.sketchCircle", "var(--font-sketch)"):
            self.assertIn(phrase, sketch)
        drawings = SYSTEM_PROMPT[SYSTEM_PROMPT.index("## The user's Excalidraw drawings"):SYSTEM_PROMPT.index("# The thumbnail")]
        for phrase in ('class="x-draw"', "read_drawing", "fx.drawIn", "fx.drawPart", "fx.drawingPart", "Never redraw the user's drawing"):
            self.assertIn(phrase, drawings)
        self.assertNotIn("(KIT:sketch)", SYSTEM_PROMPT)
        self.assertNotIn("(KIT:excalidraw)", SYSTEM_PROMPT)
        self.assertIn("read_drawing", [t["name"] for t in TOOLS])
        self.assertEqual(TOOL_LABELS["read_drawing"], "Reading the drawing")


class CodingVisualsPromptTests(unittest.TestCase):
    """The explainer kit's coding visuals, sequence diagrams, terminal and diff, as the prompt teaches them."""

    def test_the_prompt_teaches_the_coding_visuals(self):
        from motion.prompts import SYSTEM_PROMPT

        kit = SYSTEM_PROMPT[SYSTEM_PROMPT.index("## Coding visuals"):SYSTEM_PROMPT.index("## People (the cast)")]
        for phrase in (
            "fx.array(el, values, opts)",
            "pointer(name, i, at, tone)",
            "swap(i, j, at)",
            "window(i, j, at)",
            "fx.list(el, values, opts)",
            "reverse(i, at)",
            "fx.stack(el, values, opts)",
            "fx.queue(el, values, opts)",
            "fx.hashmap(el, buckets, opts)",
            "fx.tree(el, data, opts)",
            "[8, 3, 10, 1, 6, null, 14]",
            "fx.graph(el, {nodes",
            "frontier([ids], at)",
            "fx.grid(el, {rows, cols, values, rowLabels, colLabels}, opts)",
            "fx.callstack(el, opts)",
            "fx.sequence(el, {actors, messages, notes}, opts)",
            "kind is call (solid), reply (dashed), async (open head) or self (a loop)",
            "never made up",
        ):
            self.assertIn(phrase, kit)
        self.assertNotIn("(KIT:ds)", SYSTEM_PROMPT)
        self.assertNotIn("(KIT:sequence)", SYSTEM_PROMPT)

    def test_the_code_panel_teaches_the_terminal_and_the_diff(self):
        from motion.prompts import SYSTEM_PROMPT

        code = next(line for line in SYSTEM_PROMPT.splitlines() if line.startswith("- p-code:"))
        for phrase in ('data-lang="diff"', "data-diff", '<pre class="p-term"', "fx.term(el, at)", "verbatim from the run"):
            self.assertIn(phrase, code)


class WindowsFileTests(unittest.TestCase):
    def test_a_busy_file_is_retried_not_fatal(self):
        path = Path(tempfile.mkdtemp(dir=TMP)) / "chat.json"
        real = os.replace
        calls = []

        def busy_twice(src, dst):
            calls.append(1)
            if len(calls) <= 2:
                raise PermissionError(5, "Access is denied")  # another reader holds the file open
            return real(src, dst)

        with mock.patch.object(store_mod.os, "replace", busy_twice), mock.patch.object(store_mod.os, "name", "nt"):
            store_mod.write_json(path, {"ok": True})
        self.assertEqual(len(calls), 3)
        self.assertEqual(store_mod.read_json(path), {"ok": True})


class SceneCheckTests(unittest.TestCase):
    def test_clean_scene(self):
        self.assertEqual(check_scene(SCENE, {"title": "Hi"}), [])

    def test_code_in_a_panel_is_not_counted_as_words(self):
        code = "int find(int[] seats, int target) {\n    int left = 0, right = seats.length - 1;\n" * 6
        src = SCENE + '\n<pre class="p-code" data-id="code-1" data-lang="java">{{code}}</pre>'
        self.assertFalse([w for w in check_scene(src, {"title": "Hi", "code": code}) if "words of text" in w])
        # the same words as page text still count
        src2 = SCENE + '\n<p data-id="para">{{code}}</p>'
        self.assertTrue([w for w in check_scene(src2, {"title": "Hi", "code": code}) if "words of text" in w])

    def test_problems_are_reported(self):
        bad = """<style>.a { color: #ff0000; animation: spin 1s; }</style>
<div class="a" data-id="x">{{missing}}</div><div data-id="x">Two</div><p>No id here</p>
<svg><linearGradient id="g"/><rect fill="url(#bad)"/></svg>
<script>setTimeout(() => {}, 10); Math.random(); tl.play();</script>"""
        text = " | ".join(check_scene(bad, {}))
        for expected in ("Duplicate data-id", "without a data-id", "{{missing}}", "setTimeout", "Math.random", "CSS animations", "play()", "#ff0000"):
            self.assertIn(expected, text)
        self.assertNotIn("#bad", text)  # url(#id) is a reference, not a colour


class HashTests(unittest.TestCase):
    def test_edit_rerenders_only_that_scene_and_its_fade(self):
        store = new_store()
        pid = store.create_project("H", "16:9")["id"]
        storyboard(store, pid)
        for sid in ("s1", "s2", "s3"):
            store.write_scene(pid, sid, SCENE, {"title": sid})
        before = rd.scene_hashes(store.bundle(pid), None, 1920, 1080)
        store.set_props(pid, "s2", {"title": "changed"})
        after = rd.scene_hashes(store.bundle(pid), None, 1920, 1080)
        self.assertEqual(before[0], after[0])
        self.assertNotEqual(before[1], after[1])
        self.assertNotEqual(before[2], after[2])  # s3 fades in over s2's last frame
        store.update_timeline(pid, [{"id": "s1", "duration": 5}])  # a longer s1 doesn't move the other scenes' frames
        moved = rd.scene_hashes(store.bundle(pid), None, 1920, 1080)
        self.assertEqual(after[1:], moved[1:])

    def test_a_rebuilt_player_redoes_every_scene(self):
        """Scenes cached by an older player build are redone, version bump or not."""
        store = new_store()
        pid = store.create_project("P", "16:9")["id"]
        storyboard(store, pid)
        for sid in ("s1", "s2", "s3"):
            store.write_scene(pid, sid, SCENE, {"title": sid})
        b = store.bundle(pid)
        with tempfile.TemporaryDirectory() as d:
            self.assertEqual(rd.player_fingerprint(Path(d)), "")  # no build: the hashes are as they were
            self.assertEqual(rd.scene_hashes(b, None, 1920, 1080, ""), rd.scene_hashes(b, None, 1920, 1080))
            page = Path(d) / "motion-player.html"
            page.write_text('<script src="/assets/player-AAAA.js"></script>', encoding="utf-8")
            old = rd.scene_hashes(b, None, 1920, 1080, rd.player_fingerprint(Path(d)))
            page.write_text('<script src="/assets/player-BBBB.js"></script>', encoding="utf-8")  # the player changed
            new = rd.scene_hashes(b, None, 1920, 1080, rd.player_fingerprint(Path(d)))
        self.assertTrue(all(x != y for x, y in zip(old, new)))

    def test_the_encoder_is_part_of_each_scene_key(self):
        """Scene files from two encoders can't be joined into one MP4: switching redoes every scene."""
        store = new_store()
        pid = store.create_project("E", "16:9")["id"]
        storyboard(store, pid)
        b = store.bundle(pid)
        qsv = rd.scene_hashes(b, None, 3840, 2160, "", f"qsv-{rd.ENCODE_VERSION}")
        x264 = rd.scene_hashes(b, None, 3840, 2160, "", f"x264-{rd.ENCODE_VERSION}")
        self.assertTrue(all(a != c for a, c in zip(qsv, x264)))
        self.assertEqual(rd.scene_hashes(b, None, 3840, 2160, "", ""), rd.scene_hashes(b, None, 3840, 2160))

    def test_the_encoder_choice(self):
        with mock.patch.dict(os.environ, {"MOTION_ENCODER": "x264"}):
            self.assertEqual(rd.video_encoder("anything"), "x264")
        with mock.patch.dict(os.environ, {"MOTION_ENCODER": "qsv"}):
            self.assertEqual(rd.video_encoder("anything"), "qsv")
        with mock.patch.dict(os.environ, {"MOTION_ENCODER": ""}):
            # an FFmpeg that can't open Quick Sync (here: none at all) falls back to x264 on the CPU
            self.assertEqual(rd.video_encoder(str(Path(tempfile.mkdtemp(dir=TMP)) / "no-ffmpeg.exe")), "x264")

    def test_exports_are_4k_by_default(self):
        import inspect

        from motion.jobs import Exports

        self.assertEqual(rd.DEFAULT_RESOLUTION, 2160)
        self.assertEqual(inspect.signature(Exports.start).parameters["resolution"].default, 2160)
        self.assertEqual(rd.output_size(1600, 900, rd.DEFAULT_RESOLUTION)[:2], (3840, 2160))

    def test_output_size(self):
        self.assertEqual(rd.output_size(1080, 1920, 720)[:2], (720, 1280))
        self.assertEqual(rd.output_size(1920, 1080, 1080)[:2], (1920, 1080))
        self.assertEqual(rd.output_size(1080, 1350, 720)[:2], (720, 900))


class BrandTests(unittest.TestCase):
    def test_to_hex(self):
        self.assertEqual(br.to_hex("#ABC"), "#aabbcc")
        self.assertEqual(br.to_hex("rgb(255, 0, 10)"), "#ff000a")
        self.assertEqual(br.to_hex("rgba(0 0 0 / 20%)"), None)  # mostly transparent
        self.assertEqual(br.to_hex("hsl(0, 100%, 50%)"), "#ff0000")
        self.assertIsNone(br.to_hex("transparent"))

    def test_local_addresses_are_refused(self):
        for url in ("http://127.0.0.1:8765/api/motion/projects", "http://localhost/", "file:///C:/Windows", "ftp://example.com"):
            with self.assertRaises(br.FetchError):
                br.check_public_url(url)
        with self.assertRaises(br.FetchError):
            br.page_text("http://127.0.0.1:8765/")

    def test_page_text_extraction(self):
        scan = br._TextScan()
        scan.feed("<html><head><title>Policy</title><script>x=1</script></head><body><nav>Menu</nav><h1>Refunds</h1><p>Late orders get a credit.</p><ul><li>One</li></ul></body></html>")
        text = "".join(scan.parts)
        self.assertEqual(scan.title, "Policy")
        self.assertIn("## Refunds", text)
        self.assertIn("Late orders get a credit.", text)
        self.assertIn("- One", text)
        self.assertNotIn("x=1", text)
        self.assertNotIn("Menu", text)


class EngineTests(unittest.TestCase):
    def test_tool_results_for_claude_code(self):
        from motion import claude_code as cc

        self.assertEqual(cc._mcp_content("done"), [{"type": "text", "text": "done"}])
        blocks = [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "QUJD"}}, {"type": "text", "text": "report"}]
        self.assertEqual(cc._mcp_content(blocks), [{"type": "image", "data": "QUJD", "mimeType": "image/jpeg"}, {"type": "text", "text": "report"}])
        signin = cc._assistant_error("Invalid API key · Please run /login")
        self.assertIn("couldn't sign in", signin)
        self.assertIn("Claude Code said: Invalid API key · Please run /login", signin)  # the cause is never hidden
        self.assertIn("usage limit", cc._assistant_error("Claude AI usage limit reached"))

    def test_source_length_from_timestamps(self):
        self.assertEqual(ag.source_seconds("[0:00] a\n[10:08] b"), 608)
        self.assertEqual(ag.source_seconds("00:01:02.000 --> 00:01:05.500"), 65)
        self.assertEqual(ag.source_seconds("no times here"), 0)

    def test_tests_never_use_claude_code(self):
        self.assertEqual(ag.default_engine(), "api")

    def test_system_prompt_goes_in_a_file(self):
        """Inline, the prompt pushed the CLI's command line past Windows' 32,767 characters, so the CLI could
        not start ("Claude Code not found at ...claude.exe" though the file was there)."""
        from pathlib import Path

        from motion import claude_code as cc
        from motion.prompts import CLAUDE_CODE_NOTE, SYSTEM_PROMPT

        path = Path(cc.system_prompt_file())
        self.assertEqual(path.read_bytes(), (SYSTEM_PROMPT + CLAUDE_CODE_NOTE).encode("utf-8"))  # exactly, no CRLF
        self.assertEqual(cc.system_prompt_file(), str(path))  # one file per prompt
        path.unlink()
        self.assertTrue(Path(cc.system_prompt_file()).exists())  # written again after the temp folder is cleared


class HubTests(unittest.TestCase):
    def test_add_is_a_snapshot(self):
        hub = Hub(new_store())
        pid = "p1"
        hub._logs[pid] = []
        e = hub.add(pid, {"kind": "assistant", "text": ""})
        hub.append_text(pid, e["id"], "Hello")
        ops = hub.wait(pid, 0, 0)
        self.assertEqual(ops[0]["entry"]["text"], "")  # a page applying add + append must end with "Hello", not "HelloHello"
        self.assertEqual(ops[1], {"op": "append", "id": e["id"], "text": "Hello", "seq": 2})
        self.assertEqual(hub.log(pid)[0]["text"], "Hello")

    def test_only_local_tools(self):
        from motion.prompts import ALL_TOOLS, SYSTEM_PROMPT, TOOL_LABELS

        self.assertTrue(all("type" not in t for t in ALL_TOOLS))  # no server tools (no hidden sandbox)
        self.assertEqual({t["name"] for t in ALL_TOOLS} - set(TOOL_LABELS), set())
        self.assertIn("at most 120 scenes and 45 minutes", SYSTEM_PROMPT)


# ── the chat loop, with a stand-in for Claude ──


def message(content, stop="tool_use", n=1):
    return BetaMessage.construct(
        id=f"msg_{n}", type="message", role="assistant", model="claude-opus-5-5", content=content, stop_reason=stop, stop_sequence=None,
        usage=SimpleNamespace(input_tokens=100, output_tokens=50, cache_read_input_tokens=1000, cache_creation_input_tokens=0),
    )


def block(kind, **kw):
    from anthropic.types.beta import BetaTextBlock, BetaToolUseBlock

    return BetaTextBlock.construct(type="text", text=kw["text"]) if kind == "text" else BetaToolUseBlock.construct(type="tool_use", id=kw["id"], name=kw["name"], input=kw["input"])


class FakeStream:
    def __init__(self, msg):
        self.msg = msg

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def __iter__(self):
        return iter(())

    def get_final_message(self):
        return self.msg


class FakeClient:
    def __init__(self, script):
        self.script = list(script)
        self.requests = []
        self.beta = SimpleNamespace(messages=SimpleNamespace(stream=self._stream))

    def _stream(self, **kwargs):
        self.requests.append(copy.deepcopy(kwargs))
        return FakeStream(self.script.pop(0))


class AgentLoopTests(unittest.TestCase):
    def setUp(self):
        self.store = new_store()
        self.hub = Hub(self.store)
        self.agent = ag.Agent(self.store, renderer=None, hub=self.hub, exports=None)
        self.pid = self.store.create_project("Loop", "9:16")["id"]

    def run_turn(self, req, script):
        client = FakeClient(script)
        self.agent._client = client
        self.agent.start(self.pid, req)
        deadline = time.time() + 10
        while self.agent.running(self.pid) and time.time() < deadline:
            time.sleep(0.02)
        self.assertFalse(self.agent.running(self.pid))
        return client

    def test_style_question_then_scenes(self):
        options = [{"id": "a", "name": "Bold type", "description": "Big words snap in", "palette": ["#0b1020", "#6366f1"], "motion": "snappy"}]
        c1 = self.run_turn({"text": "A reel about caching"}, [message([block("text", text="One question first."), block("tool_use", id="tu_ask", name="ask_style", input={"question": "Which look?", "options": options})])])
        req = c1.requests[0]
        self.assertEqual(req["model"], "claude-opus-5-5")
        self.assertEqual(req["thinking"]["display"], "updates")
        self.assertIn("server-side-fallback-2026-07-01", req["betas"])
        self.assertEqual(req["system"][0]["cache_control"], {"type": "ephemeral"})
        self.assertIn("<project_state", req["messages"][0]["content"][-1]["text"])
        chat = self.store.load_chat(self.pid)
        self.assertEqual(chat["pending"]["toolUseId"], "tu_ask")
        style = [e for e in self.hub.log(self.pid) if e["kind"] == "style"]
        self.assertEqual(style[0]["options"][0]["name"], "Bold type")

        board = {"scenes": [{"id": "s1", "name": "Hook", "idea": "x", "duration": 3, "transition": "fade"}]}
        c2 = self.run_turn(
            {"styleChoice": {"optionId": "a"}},
            [
                message([block("tool_use", id="tu_board", name="write_storyboard", input=board)], n=2),
                message([block("tool_use", id="tu_scene", name="write_scene", input={"id": "s1", "html": SCENE, "props": {"title": "Caching"}})], n=3),
                message([block("text", text="Done: one scene.")], stop="end_turn", n=4),
            ],
        )
        first = c2.requests[0]["messages"]
        answer = first[-1]["content"][0]
        self.assertEqual((answer["type"], answer["tool_use_id"]), ("tool_result", "tu_ask"))  # the pick answers the open question first
        self.assertIn("Bold type", answer["content"])
        third = c2.requests[2]["messages"]
        self.assertEqual(third[-1]["content"][0]["tool_use_id"], "tu_scene")
        self.assertEqual(third[-2]["role"], "assistant")
        p = self.store.get_project(self.pid)
        self.assertEqual(p["scenes"][0]["status"], "written")
        self.assertIsNone(self.store.load_chat(self.pid)["pending"])
        kinds = [e["kind"] for e in self.hub.log(self.pid)]
        self.assertIn("usage", kinds)
        self.assertIsNotNone(self.store.undo_info(self.pid))  # a snapshot was taken before Claude's first change

    def test_tool_errors_go_back_to_claude(self):
        storyboard(self.store, self.pid)
        client = self.run_turn(
            {"text": "fix it"},
            [
                message([block("tool_use", id="tu_p", name="patch_scene", input={"id": "s1", "edits": [{"find": "x", "replace": "y"}]})]),
                message([block("text", text="ok")], stop="end_turn", n=2),
            ],
        )
        result = client.requests[1]["messages"][-1]["content"][0]
        self.assertTrue(result["is_error"])
        self.assertIn("no code yet", result["content"])

    def test_an_unfinished_build_is_sent_back(self):
        self.store.write_storyboard(self.pid, [
            {"id": "s1", "name": "One", "idea": "a", "duration": 3, "transition": "fade"},
            {"id": "s2", "name": "Two", "idea": "b", "duration": 3, "transition": "fade"},
        ])
        client = self.run_turn(
            {"text": "build it"},
            [
                message([block("tool_use", id="tu_1", name="write_scene", input={"id": "s1", "html": SCENE})]),
                message([block("text", text="Scene one is done. Shall I go on?")], stop="end_turn", n=2),
                message([block("tool_use", id="tu_2", name="write_scene", input={"id": "s2", "html": SCENE})], n=3),
                message([block("text", text="All done.")], stop="end_turn", n=4),
            ],
        )
        self.assertEqual(len(client.requests), 4)
        reminder = client.requests[2]["messages"][-1]
        self.assertEqual(reminder["role"], "user")
        self.assertIn("automatic message from the tool", reminder["content"][0]["text"])
        self.assertIn("(s2)", reminder["content"][0]["text"])
        self.assertTrue(all(s["status"] == "written" for s in self.store.get_project(self.pid)["scenes"]))
        notes = [e["text"] for e in self.hub.log(self.pid) if e["kind"] == "note"]
        self.assertIn("Continuing the build: 1 scene to go.", notes)

    def test_a_reminder_without_progress_hands_back(self):
        storyboard(self.store, self.pid)
        client = self.run_turn(
            {"text": "write one scene, then show me"},
            [
                message([block("tool_use", id="tu_1", name="write_scene", input={"id": "s1", "html": SCENE})]),
                message([block("text", text="Here is the first one.")], stop="end_turn", n=2),
                message([block("text", text="You asked to see one first, so I'll wait.")], stop="end_turn", n=3),
            ],
        )
        self.assertEqual(len(client.requests), 3)  # one reminder, then back to the user
        notes = [e["text"] for e in self.hub.log(self.pid) if e["kind"] == "note"]
        self.assertTrue(any("2 scenes still to write" in n for n in notes), notes)

    def test_claude_code_is_sent_back_too(self):
        self.store.write_storyboard(self.pid, [
            {"id": "s1", "name": "One", "idea": "a", "duration": 3, "transition": "fade"},
            {"id": "s2", "name": "Two", "idea": "b", "duration": 3, "transition": "fade"},
        ])
        calls = []

        def fake_run(agent, pid, blocks, model, effort, stop, ctx, session):
            # a stand-in for one Claude Code run that writes one scene and stops
            calls.append((blocks, session))
            agent.store.write_scene(pid, "s1" if len(calls) == 1 else "s2", SCENE)
            return {"sessionId": "sess-1", "turns": 2, "cost": 0.05, "usage": {"input_tokens": 10, "output_tokens": 5}}

        with mock.patch("motion.claude_code.run_turn", fake_run):
            self.agent.start(self.pid, {"text": "build it", "engine": "claude-code"})
            deadline = time.time() + 10
            while self.agent.running(self.pid) and time.time() < deadline:
                time.sleep(0.02)
        self.assertEqual(len(calls), 2)
        self.assertEqual(calls[1][1], "sess-1")  # the reminder resumes the same session
        self.assertIn("automatic message from the tool", calls[1][0][0]["text"])
        usage = [e for e in self.hub.log(self.pid) if e["kind"] == "usage"][-1]
        self.assertEqual((usage["steps"], usage["input"], usage["cost"]), (4, 20, 0.1))

    def test_one_turn_at_a_time(self):
        gate = threading.Event()

        class Slow(FakeClient):
            def _stream(self, **kwargs):
                gate.wait(5)
                return super()._stream(**kwargs)

        self.agent._client = Slow([message([block("text", text="hi")], stop="end_turn")])
        self.agent.start(self.pid, {"text": "one"})
        with self.assertRaises(StoreError):
            self.agent.start(self.pid, {"text": "two"})
        gate.set()
        deadline = time.time() + 5
        while self.agent.running(self.pid) and time.time() < deadline:
            time.sleep(0.02)

    def test_cost(self):
        self.assertAlmostEqual(ag.cost_of("claude-opus-5-5", {"input": 1_000_000, "output": 0, "cacheRead": 0, "cacheWrite": 0}), 4.0)
        self.assertAlmostEqual(ag.cost_of("claude-opus-5-5", {"input": 0, "output": 0, "cacheRead": 1_000_000, "cacheWrite": 0}), 0.2)
        self.assertAlmostEqual(ag.cost_of("claude-opus-5-5", {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 1_000_000}), 5.0)


class ApiTests(unittest.TestCase):
    def test_project_routes(self):
        from fastapi.testclient import TestClient

        import app

        c = TestClient(app.app)
        r = c.post("/api/motion/projects", json={"title": "API", "aspect": "16:9", "sourceText": "hello world", "sourceTitle": "A talk"})
        self.assertEqual(r.status_code, 200)
        pid = r.json()["project"]["id"]
        self.assertEqual(r.json()["attachments"], ["transcript-a-talk.txt"])
        self.assertEqual(c.get(f"/api/motion/projects/{pid}/bundle").json()["width"], 1920)
        up = c.post(f"/api/motion/projects/{pid}/assets", files={"files": ("notes.md", b"# notes", "text/markdown")})
        self.assertEqual(up.json()[0]["name"], "notes.md")
        r = c.get(f"/api/motion/projects/{pid}/assets/notes.md")
        self.assertEqual(r.headers.get("access-control-allow-origin"), "*")  # the sandboxed preview can load it
        self.assertEqual(c.get("/api/motion/projects/nope00000000").status_code, 404)
        self.assertEqual(c.post(f"/api/motion/projects/{pid}/chat", json={}).status_code, 400)
        ev = c.get(f"/api/motion/projects/{pid}/events", params={"after": 0, "boot": "old", "timeout": 0}).json()
        self.assertEqual(ev["events"][0]["op"], "reload")
        self.assertEqual(json.loads(c.delete(f"/api/motion/projects/{pid}").text), {"ok": True})

    def test_publish_kit_zip(self):
        import io
        import zipfile

        from fastapi.testclient import TestClient

        import app

        c = TestClient(app.app)
        pid = c.post("/api/motion/projects", json={"title": "Kit Test", "brandKitId": "algoinsight-paper"}).json()["project"]["id"]
        self.assertEqual(c.get(f"/api/motion/projects/{pid}/publish-kit.zip").status_code, 404)  # nothing to give yet
        store = Store(store_mod.DATA_DIR)  # the same folder the app works in
        store.write_storyboard(pid, [
            {"id": "a", "name": "One", "idea": "x", "transition": "tear", "part": "Part 1 · Start", "narration": "Meera opens the app. <cue/> It works."},
            {"id": "b", "name": "Two", "idea": "y", "transition": "tear", "part": "Part 2 · Next", "narration": "Then she closes it."},
        ])
        store.write_doc(pid, "YOUTUBE.md", "# Titles\n")
        r = c.get(f"/api/motion/projects/{pid}/publish-kit.zip")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn('filename="kit-test-publish-kit.zip"', r.headers["content-disposition"])
        z = zipfile.ZipFile(io.BytesIO(r.content))
        self.assertEqual(sorted(z.namelist()), ["YOUTUBE.md", "kit-test-chapters.txt", "kit-test.srt", "kit-test.vtt"])
        self.assertTrue(z.read("kit-test.vtt").startswith(b"WEBVTT"))
        self.assertEqual(z.read("kit-test-chapters.txt").decode().splitlines()[0], "0:00 Part 1 · Start")
        c.delete(f"/api/motion/projects/{pid}")

    def test_video_settings_route(self):
        from fastapi.testclient import TestClient

        import app

        c = TestClient(app.app)
        pid = c.post("/api/motion/projects", json={"title": "Settings", "brandKitId": "algoinsight-paper"}).json()["project"]["id"]
        r = c.patch(f"/api/motion/projects/{pid}", json={"closing": {"promo": True}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(c.get(f"/api/motion/projects/{pid}").json()["project"]["closing"]["promo"])
        r = c.patch(f"/api/motion/projects/{pid}", json={"destination": "udemy"})
        self.assertEqual(r.status_code, 200, r.text)
        brand = c.get(f"/api/motion/projects/{pid}/bundle").json()["brand"]
        self.assertEqual((brand["showLogo"], brand["showUrl"], brand["tagline"]), (True, False, ""))
        self.assertEqual(c.patch(f"/api/motion/projects/{pid}", json={"closing": {"promo": True}}).status_code, 400)
        c.delete(f"/api/motion/projects/{pid}")

    def test_busy_route(self):
        """What the dev runner (dev.py) waits for before a restart: a transcription here, a Motion export."""
        from fastapi.testclient import TestClient

        import app

        c = TestClient(app.app)
        self.assertEqual(c.get("/api/busy").json(), {"busy": False, "transcriptions": 0, "exports": 0, "voice": 0, "claude": 0, "clips": 0})
        with app._lock:
            app._jobs["busytest0001"] = {"id": "busytest0001", "state": "done", "frames": {"state": "running"}}  # screenshots still going
        try:
            r = c.get("/api/busy").json()
            self.assertTrue(r["busy"])
            self.assertEqual(r["transcriptions"], 1)
        finally:
            with app._lock:
                app._jobs.pop("busytest0001", None)
        self.assertFalse(c.get("/api/busy").json()["busy"])


class DevRunnerTests(unittest.TestCase):
    def test_why_and_describe(self):
        import dev

        self.assertEqual(dev.why([dev.RS]), "rs typed")
        self.assertEqual(dev.why(["motion\\api.py", dev.RS, "app.py", "app.py"]), "app.py, motion\\api.py changed")
        self.assertEqual(dev.describe({"busy": True, "transcriptions": 0, "exports": 1, "voice": 2, "claude": 0}), "1 export, 2 voice jobs")

    def test_snapshot_skips_tests_and_venv(self):
        import dev

        files = [os.path.relpath(p, dev.HERE) for p in dev.snapshot()]
        self.assertIn("app.py", files)
        self.assertIn(os.path.join("motion", "api.py"), files)
        self.assertFalse(any(f.startswith(".venv") or os.path.basename(f).startswith("test_") for f in files))


class ClosingTests(unittest.TestCase):
    """What a video adds after its own scenes (the promo, the end screen) and where it is going."""

    def setUp(self):
        self.store = new_store()
        self.agent = ag.Agent(self.store, renderer=None, hub=Hub(self.store), exports=None)
        self.pid = self.store.create_project("Closing", "16:9", "algoinsight-paper")["id"]
        self.store.write_storyboard(self.pid, [
            {"id": "a", "name": "One", "idea": "x", "transition": "tear", "narration": "Meera opens the app. <cue/> It works."},
            {"id": "b", "name": "Two", "idea": "y", "transition": "turn", "narration": "Then she closes it."},
        ])

    def ids(self):
        return [(s["id"], s["kind"]) for s in self.store.get_project(self.pid)["scenes"]]

    def test_a_paper_video_ends_with_the_end_screen(self):
        self.assertEqual(self.ids(), [("a", "scene"), ("b", "scene"), ("end", "endscreen")])
        b = self.store.bundle(self.pid)
        self.assertEqual((b["destination"], b["brand"]["showLogo"], b["brand"]["showUrl"]), ("youtube", True, True))
        self.assertIn("made for: YouTube; the video's settings add logo card, web address, end screen", self.store.state_summary(self.pid))

    def test_the_promo_comes_and_goes(self):
        p = self.store.update_project(self.pid, {"closing": {"promo": True}})
        self.assertEqual([i for i, _ in self.ids()], ["a", "b", "algoinsight-1", "algoinsight-2", "algoinsight-3", "algoinsight-4", "end"])
        promo = [s for s in p["scenes"] if s["kind"] == "promo"]
        for s in promo:
            self.assertTrue((self.store._dir(self.pid) / s["file"]).exists())
            self.assertEqual(vc.check_narration(s["narration"]), [], s["id"])  # the voice rules hold for our own words too
        seconds = sum(s["duration"] for s in promo)
        self.assertTrue(55 <= seconds <= 75, seconds)  # about a minute
        said = {e["written"]: e["spoken"] for e in p["pronunciations"]}
        self.assertEqual((said["algoinsight.io"], said["DSA"]), ("AlgoInsight dot I-O", "D-S-A"))
        self.assertIn("AlgoInsight dot I-O", self.store.timing(self.pid, p, promo[-1])["spoken"])
        # Claude's storyboard keeps the closing where it is, and Claude can't edit it
        self.store.write_storyboard(self.pid, [{"id": "a", "name": "One", "idea": "x", "transition": "tear"}, {"id": "c", "name": "New", "idea": "z", "transition": "turn"}])
        self.assertEqual([i for i, _ in self.ids()][-5:], ["algoinsight-1", "algoinsight-2", "algoinsight-3", "algoinsight-4", "end"])
        with self.assertRaises(StoreError):
            self.agent._tool(self.pid, "patch_scene", {"id": "algoinsight-2", "edits": [{"find": "x", "replace": "y"}]})
        with self.assertRaises(StoreError):
            self.agent._tool(self.pid, "write_script", {"scenes": [{"id": "end", "narration": "Bye."}]})
        self.store.update_timeline(self.pid, order=["c", "a"])  # the closing stays last without being listed
        self.assertEqual([i for i, _ in self.ids()][:3], ["c", "a", "algoinsight-1"])
        self.store.update_project(self.pid, {"closing": {"promo": False}})
        self.assertEqual(self.ids()[-1], ("end", "endscreen"))
        self.assertFalse((self.store._dir(self.pid) / "scenes" / "algoinsight-1.html").exists())

    def test_udemy_shows_only_our_logo_card(self):
        self.store.update_project(self.pid, {"closing": {"promo": True}})
        self.store.update_project(self.pid, {"destination": "udemy"})
        self.assertEqual(self.ids(), [("a", "scene"), ("b", "scene")])
        b = self.store.bundle(self.pid)
        # the logo card (icon and wordmark, no tagline), no web address
        self.assertEqual((b["brand"]["showLogo"], b["brand"]["showUrl"], b["brand"]["tagline"]), (True, False, ""))
        self.assertIn("made for: Udemy", self.store.state_summary(self.pid))
        self.assertIn("the frame draws the AlgoInsight logo card", self.store.state_summary(self.pid))
        for change in ({"endscreen": True}, {"url": True}, {"promo": True}, {"logo": False}):
            with self.assertRaises(StoreError):
                self.store.update_project(self.pid, {"closing": change})
        self.store.update_project(self.pid, {"closing": {"logo": True, "promo": False}})  # what it already is: fine
        # a Udemy video saved before the logo card (all four off) shows it now
        p = self.store.get_project(self.pid)
        p["closing"] = {"logo": False, "url": False, "promo": False, "endscreen": False}
        store_mod.write_json(self.store._dir(self.pid) / "project.json", p)
        self.assertTrue(self.store.get_project(self.pid)["closing"]["logo"])
        self.assertTrue(self.store.bundle(self.pid)["brand"]["showLogo"])
        self.store.update_project(self.pid, {"destination": "youtube"})
        self.assertEqual(self.store.get_project(self.pid)["closing"], {"logo": True, "url": True, "promo": False, "endscreen": True})
        self.assertEqual(self.ids()[-1], ("end", "endscreen"))

    def test_the_same_words_are_voiced_once_for_every_video(self):
        other = self.store.create_project("Other", "16:9", "algoinsight-paper")["id"]
        self.store.write_storyboard(other, [{"id": "z", "name": "Z", "idea": "z", "transition": "fade", "narration": "Then she closes it."}])
        p = self.store.get_project(self.pid)
        t = self.store.timing(self.pid, p, p["scenes"][1])
        vc.save_clip(self.store.voice_dir(self.pid), t["hash"], t["spoken"], b"ID3", [0.05 * i for i in range(len(t["spoken"]))], None)
        self.store.share_clip(self.pid, t["hash"])
        rows = {r["id"]: r["state"] for r in self.store.voice_status(other)["scenes"]}
        self.assertEqual(rows["z"], "ready")  # costs nothing: the cache has these words in this voice
        self.assertIsNotNone(self.store.find_clip(other, t["hash"]))
        self.assertTrue((self.store.voice_dir(other) / f"{t['hash']}.mp3").exists())


# ── publishing: captions, the audio finish, the thumbnail, the timing checks ──


JPEG = b"\xff\xd8\xff\xe0 a stand-in thumbnail"
CLEAN_DIAG = {"errors": [], "visible": [{"id": "head", "text": "WAIT LESS"}], "offStage": [], "outsideSafe": [], "inZone": [], "overlaps": [], "crowded": [], "smallText": [], "words": 2}
THUMB = """<style>.h { font: 800 180px/1 var(--font-display); color: var(--ink); }</style>
<h1 class="h" data-id="head">{{headline}}</h1>"""


class StubRenderer:
    """A stand-in for the headless browser: records each call and answers it like the real one would."""

    def __init__(self, rows=None):
        self.calls = []
        self.rows = rows or []

    def player_built(self):
        return True

    async def preview_frame(self, *args):  # never awaited: call() answers for it
        raise AssertionError

    async def audit(self, *args):
        raise AssertionError

    async def export(self, *args):
        raise AssertionError

    def call(self, fn, *args, timeout=0, **kwargs):
        self.calls.append((fn.__name__, args))
        self.kwargs = kwargs
        if fn.__name__ == "preview_frame":
            return JPEG, dict(CLEAN_DIAG)
        if fn.__name__ == "audit":
            return self.rows
        if fn.__name__ == "export":
            return {"file": args[3].name, "bytes": 1, "width": 1920, "height": 1080, "seconds": 1.0, "renderedScenes": 1, "cachedScenes": 0, "took": 0.1, "loudness": None}
        raise AssertionError(fn.__name__)


class CaptionTests(unittest.TestCase):
    """The captions: the written narration, timed by the voice (or the estimate before it exists)."""

    NARRATION = "An LLM reads the whole question first. <cue/> Then it writes the answer, one word at a time."

    def setUp(self):
        self.store = new_store()
        self.pid = self.store.create_project("Captions", "16:9", "algoinsight-paper")["id"]
        self.store.write_storyboard(self.pid, [
            {"id": "a", "name": "One", "idea": "x", "transition": "tear", "narration": self.NARRATION},
            {"id": "b", "name": "Two", "idea": "y", "transition": "turn", "narration": "The second page has no voice yet."},
        ])

    def voice_scene_a(self, step=0.06):
        """A fake clip for scene a: every character of the spoken text `step` seconds after the one before."""
        p = self.store.get_project(self.pid)
        t = self.store.timing(self.pid, p, p["scenes"][0])
        text = t["spoken"]
        vc.save_clip(self.store.voice_dir(self.pid), t["hash"], text, b"ID3", [round(step * i, 3) for i in range(len(text))], None)
        self.store.link_voice(self.pid, "a", t["hash"])
        return text

    def test_srt_and_vtt_keep_the_written_form(self):
        srt = self.store.captions(self.pid, "srt")
        vtt = self.store.captions(self.pid, "vtt")
        self.assertTrue(srt.startswith("1\n00:00:00,750 --> "), srt[:60])  # the voice starts after the page change
        self.assertRegex(srt, r"\n\d\d:\d\d:\d\d,\d{3} --> \d\d:\d\d:\d\d,\d{3}\n")
        self.assertTrue(vtt.startswith("WEBVTT\n\n00:00:00.750 --> "), vtt[:60])
        self.assertNotRegex(vtt, r"\d\d:\d\d:\d\d,\d{3}")  # VTT times use a full stop
        for text in (srt, vtt):
            self.assertIn("An LLM reads the whole question first.", text)
            self.assertNotIn("L-L-M", text)  # the table changes only what the voice is sent
            self.assertNotIn("cue", text)
        with self.assertRaises(StoreError):
            self.store.captions(self.pid, "txt")

    def test_timed_by_the_voice(self):
        text = self.voice_scene_a()
        self.assertIn("L-L-M", text)  # the clip said the short form the table's way
        cues = self.store.caption_cues(self.pid)
        self.assertEqual(cues[0]["text"], "An LLM reads the whole question first.")
        self.assertAlmostEqual(cues[0]["start"], 0.75)
        # the next sentence starts its own caption at the time its first character was spoken
        then = next(c for c in cues if c["text"].startswith("Then"))
        self.assertAlmostEqual(then["start"], 0.75 + 0.06 * text.index("Then"), places=3)
        self.assertLessEqual(cues[0]["end"], then["start"])
        # the unvoiced second scene: the estimate, from where its voice will start
        p = self.store.get_project(self.pid)
        b_start = p["scenes"][0]["duration"]
        last = cues[-1]
        self.assertEqual(last["text"], "The second page has no voice yet.")
        self.assertAlmostEqual(last["start"], b_start + 0.75, places=3)

    def test_cue_lengths_and_lines(self):
        long = "In the evening rush, Meera opens the app, checks the estimate, and waits for the dosa stall to call her number " * 4
        self.store.write_script(self.pid, [{"id": "a", "narration": long + "Then she pays and goes home."}])
        cues = self.store.caption_cues(self.pid)
        self.assertGreater(len(cues), 6)
        for i, c in enumerate(cues):
            lines = vc.caption_lines(c["text"])
            self.assertIsNotNone(lines, c["text"])
            self.assertLessEqual(len(lines), 2)
            self.assertTrue(all(len(ln) <= 42 for ln in lines), lines)
            self.assertGreaterEqual(c["end"] - c["start"], 1.0 - 1e-6, c)
            self.assertLessEqual(c["end"] - c["start"], 7.0 + 1e-6, c)
            if i:
                self.assertLessEqual(cues[i - 1]["end"], c["start"])  # never overlapping
        # a caption that has to break mid-sentence breaks at a comma when it can
        self.assertTrue(any(c["text"].endswith(",") for c in cues), [c["text"] for c in cues])

    def test_a_table_entry_of_two_words_falls_back_to_proportional(self):
        table = [{"written": "Claude Code", "spoken": "Clawd Code"}]
        words = "Open Claude Code and ask it".split()
        text = vc.spoken("Open Claude Code and ask it", table)[0]
        spans = vc.word_spans(words, table, text)
        self.assertEqual(len(spans), len(words))
        self.assertEqual(spans, sorted(spans))
        self.assertTrue(all(0 <= a < b <= len(text) for a, b in spans))
        exact = vc.word_spans("An LLM, then".split(), [{"written": "LLM", "spoken": "L-L-M"}], "An L-L-M, then")
        self.assertEqual(exact, [(0, 2), (3, 9), (10, 14)])  # word by word, the punctuation kept with its word

    def test_routes(self):
        from fastapi.testclient import TestClient

        import app

        c = TestClient(app.app)
        pid = c.post("/api/motion/projects", json={"title": "Caption Route", "brandKitId": "algoinsight-paper"}).json()["project"]["id"]
        Store(store_mod.DATA_DIR).write_storyboard(pid, [{"id": "a", "name": "One", "idea": "x", "transition": "tear", "narration": self.NARRATION}])
        r = c.get(f"/api/motion/projects/{pid}/captions.srt")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertIn('filename="caption-route.srt"', r.headers["content-disposition"])
        self.assertIn("An LLM reads", r.text)
        r = c.get(f"/api/motion/projects/{pid}/captions.vtt")
        self.assertTrue(r.text.startswith("WEBVTT"))
        self.assertIn('filename="caption-route.vtt"', r.headers["content-disposition"])
        c.delete(f"/api/motion/projects/{pid}")

    def test_the_export_writes_captions_next_to_the_mp4(self):
        from motion.jobs import Exports

        stub = StubRenderer()
        exports = Exports(self.store, stub, Hub(self.store), lambda: None)
        bundle = self.store.bundle(self.pid)
        cues = self.store.caption_cues(self.pid)
        exports._jobs[self.pid] = {"state": "queued"}
        exports._run(self.pid, bundle, None, "ffmpeg", 1080, threading.Event(), True, True, False, {"srt": vc.to_srt(cues), "vtt": vc.to_vtt(cues)})
        job = exports.status(self.pid)
        self.assertEqual(job["state"], "done", job)
        self.assertFalse(stub.calls[0][1][-1])  # loudness off reached the renderer
        links = job["result"]["captions"]
        mp4 = job["result"]["file"]
        for fmt in ("srt", "vtt"):
            self.assertEqual(links[fmt], f"/api/motion/projects/{self.pid}/renders/{mp4[:-4]}.{fmt}")
            f = self.store.renders_dir(self.pid) / f"{mp4[:-4]}.{fmt}"
            self.assertIn("An LLM reads", f.read_text(encoding="utf-8"))


class ParallelExportTests(unittest.TestCase):
    """Several videos export at once, each on a lane (a renderer) of its own; one more waits for a free lane."""

    def test_two_videos_export_at_once_and_a_third_waits(self):
        from motion import jobs as jb

        store = new_store()
        release = threading.Event()
        seen = {"inside": 0, "most": 0, "lanes": set(), "pages": []}
        lock = threading.Lock()

        class LaneStub(StubRenderer):
            def clone(self):
                return LaneStub()

            async def release(self):
                return None

            def call(self, fn, *args, timeout=0, **kwargs):
                if fn.__name__ == "release":
                    return None
                if fn.__name__ == "export":
                    with lock:
                        seen["inside"] += 1
                        seen["most"] = max(seen["most"], seen["inside"])
                        seen["lanes"].add(id(self))
                        seen["pages"].append(kwargs.get("pages"))
                    release.wait(10)
                    with lock:
                        seen["inside"] -= 1
                return super().call(fn, *args, timeout=timeout, **kwargs)

        main = LaneStub()
        exports = jb.Exports(store, main, Hub(store), lambda: None, slots=2)
        pids = [store.create_project(f"Video {i}", "16:9", "algoinsight-paper")["id"] for i in range(3)]

        def submit(pid):
            exports._jobs[pid] = {"state": "queued"}
            exports._pool.submit(exports._run, pid, store.bundle(pid), None, "ffmpeg", 1080, threading.Event(), False, False, False, None)

        def wait_inside(n):
            end = time.time() + 10
            while seen["most"] < n and time.time() < end:
                time.sleep(0.02)

        submit(pids[0])  # the first alone, then two more while it runs
        wait_inside(1)
        submit(pids[1])
        submit(pids[2])
        wait_inside(2)
        time.sleep(0.2)  # the third would have started by now if it could
        self.assertEqual(seen["most"], 2)
        self.assertEqual(sum(1 for pid in pids if exports.status(pid)["state"] == "queued"), 1)
        self.assertEqual(set(exports.live()), set(pids))  # the library's cards: two running, one waiting
        release.set()
        exports._pool.shutdown(wait=True)
        self.assertEqual([exports.status(pid)["state"] for pid in pids], ["done"] * 3)
        self.assertEqual(seen["most"], 2)
        self.assertEqual(len(seen["lanes"]), 2)  # two lanes, reused by the third; never the editor's renderer
        self.assertNotIn(id(main), seen["lanes"])
        # alone, an export takes every page it wants; beside another, its share of the budget
        self.assertEqual(seen["pages"][0], rd.DEFAULT_PAGES)
        self.assertEqual(seen["pages"][1], max(1, jb.PAGE_BUDGET // 2))
        self.assertEqual(exports.live(), {})


def _ffmpeg():
    """FFmpeg found the way the app finds it (FFMPEG_LOCATION, PATH, then the winget install)."""
    import transcriber as tr

    return rd.ffmpeg_exe(tr.find_ffmpeg())


@unittest.skipUnless(_ffmpeg(), "FFmpeg is not installed")
class LoudnessTests(unittest.TestCase):
    """The export's audio finish on generated tones: the music ducked under the voice, the mix at -14 LUFS."""

    TOTAL = 12.0

    @classmethod
    def setUpClass(cls):
        import subprocess

        cls.ff = _ffmpeg()
        cls.dir = Path(tempfile.mkdtemp(prefix="mix-", dir=TMP))

        def make(*args):
            subprocess.run([cls.ff, "-hide_banner", "-loglevel", "error", "-y", *args], check=True, timeout=120)

        t = cls.TOTAL
        make("-f", "lavfi", "-i", f"color=c=black:s=160x90:r=30:d={t}", "-c:v", "libx264", "-pix_fmt", "yuv420p", str(cls.dir / "video.mp4"))
        # the "voice": a 440 Hz tone, two seconds on and one off (lavfi's sine is 1/8 of full scale: x2.4 is about -12 dBFS)
        make("-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={t}", "-af", "volume=2.4,volume='if(lt(mod(t,3),2),1,0)':eval=frame", "-c:a", "aac", str(cls.dir / "narration.m4a"))
        # the "music": a 220 Hz tone at about -6 dBFS
        make("-f", "lavfi", "-i", f"sine=frequency=220:sample_rate=48000:duration={t}", "-af", "volume=4", "-c:a", "libmp3lame", str(cls.dir / "music.mp3"))
        # a loud burst as a paper sound, so the mix has peaks too high for a plain linear gain
        sfx = cls.dir / "assets" / "motion" / "sfx"
        sfx.mkdir(parents=True)
        make("-f", "lavfi", "-i", "anoisesrc=d=0.08:c=white:a=1:r=48000:seed=7", "-c:a", "libmp3lame", str(sfx / "stamp.mp3"))
        cls.rs = rd.RenderService("http://127.0.0.1:9", cls.dir)  # dist_dir: where the paper sounds are found

    def mix(self, name, events=(), loudness=True):
        import asyncio

        out = self.dir / f"{name}.mp4"
        report = asyncio.run(self.rs._mix_audio(self.ff, self.dir / "video.mp4", out, self.TOTAL, self.dir / "narration.m4a", self.dir / "music.mp3", list(events), loudness))
        return report, rd.loudness_of(self.ff, out)

    def test_the_music_is_ducked_by_the_voice(self):
        _, parts = self.rs._mix_parts(self.TOTAL, self.dir / "narration.m4a", self.dir / "music.mp3", [], base=1)
        graph = ";".join(parts)
        self.assertIn("asplit=2[nar][key0]", graph)
        self.assertIn("[bed][key]sidechaincompress=", graph)  # the voice is the key, the music is compressed

    def test_the_mix_lands_on_minus_14_lufs(self):
        report, measured = self.mix("tones")
        self.assertEqual(report["mode"], "linear")
        self.assertFalse(report["limited"])
        self.assertLessEqual(abs(measured["integrated"] - (-14.0)), 1.0, measured)
        _, raw = self.mix("raw", loudness=False)
        self.assertGreater(abs(raw["integrated"] - measured["integrated"]), 0.5)  # it really changed the level

    def test_high_peaks_are_held_so_the_gain_stays_linear(self):
        report, measured = self.mix("peaks", [{"t": t, "name": "stamp", "gain": 1.6} for t in (1.0, 4.5, 8.2)])
        self.assertTrue(report["limited"])
        self.assertEqual(report["mode"], "linear")
        self.assertGreater(report["measured"]["truePeak"], -1.5)  # before: over the ceiling
        self.assertLessEqual(report["truePeak"], -1.5)  # after: the mix leaves loudnorm under it
        self.assertLessEqual(abs(measured["integrated"] - (-14.0)), 1.0, measured)
        # the AAC encoder can push a burst of white noise back over a little, never to clipping
        self.assertLess(measured["truePeak"], 0.0, measured)


class ThumbnailTests(unittest.TestCase):
    """The YouTube thumbnail: stored like a scene, rendered by the player as a one-scene bundle."""

    def setUp(self):
        self.store = new_store()
        self.pid = self.store.create_project("Thumbs", "16:9", "algoinsight-paper")["id"]
        self.store.write_storyboard(self.pid, [{"id": "a", "name": "One", "idea": "x", "transition": "tear", "duration": 3}])

    def test_store_paths(self):
        self.assertIn("thumbnail: none yet", self.store.state_summary(self.pid))
        self.assertEqual(self.store.thumbnail_view(self.pid), {"html": None, "props": {}, "rev": 0, "url": None})
        with self.assertRaises(StoreError) as none:
            self.store.thumbnail_bundle(self.pid)
        self.assertEqual(none.exception.status, 404)
        p, warnings = self.store.write_thumbnail(self.pid, THUMB, {"headline": "Wait less"})
        self.assertEqual(warnings, [])  # a still needs no script, and two words are fine
        self.assertEqual(p["thumbnail"]["rev"], 1)
        self.assertTrue((self.store._dir(self.pid) / "thumbnail.html").exists())
        self.assertIn('thumbnail: written (rev 1), props {"headline": "Wait less"}', self.store.state_summary(self.pid))
        b = self.store.thumbnail_bundle(self.pid)
        self.assertEqual((b["width"], b["height"], b["duration"], b["narration"]), (1600, 900, 3.0, None))
        self.assertEqual(len(b["scenes"]), 1)
        s = b["scenes"][0]
        self.assertEqual((s["id"], s["kind"], s["duration"], s["transition"], s["lead"], s["cues"], s["status"]), ("thumbnail", "thumbnail", 3.0, "cut", 0.3, [0.3], "written"))
        self.assertEqual(set(self.store.bundle(self.pid)["scenes"][0]) - set(s), set())  # every field a bundle scene has
        _, warnings = self.store.write_thumbnail(self.pid, THUMB, {"headline": "How the queue really decides who waits"})
        self.assertTrue(any("1 to 4 very large words" in w for w in warnings), warnings)
        with self.assertRaises(StoreError) as stale:
            self.store.write_thumbnail(self.pid, THUMB, {"headline": "x"}, base_rev=1)
        self.assertEqual(stale.exception.status, 409)
        # a 9:16 video still gets a 16:9 thumbnail
        reel = self.store.create_project("Reel", "9:16", "algoinsight")["id"]
        self.store.write_thumbnail(reel, THUMB, {"headline": "Wait less"})
        self.assertEqual((self.store.thumbnail_bundle(reel)["width"], self.store.thumbnail_bundle(reel)["height"]), (1920, 1080))

    def test_undo_puts_the_thumbnail_back(self):
        self.store.snapshot(self.pid, "Before: first")
        self.store.write_thumbnail(self.pid, THUMB, {"headline": "One"})
        self.store.snapshot(self.pid, "Before: second")
        self.store.write_thumbnail(self.pid, THUMB.replace("180px", "200px"), {"headline": "Two"})
        p = self.store.undo(self.pid)
        self.assertEqual(p["thumbnail"]["props"], {"headline": "One"})
        self.assertIn("180px", self.store.thumbnail_source(self.pid))
        p = self.store.undo(self.pid)
        self.assertIsNone(p["thumbnail"])
        self.assertIsNone(self.store.thumbnail_source(self.pid))

    def test_the_tool_saves_renders_and_shows_it(self):
        stub = StubRenderer()
        hub = Hub(self.store)
        agent = ag.Agent(self.store, renderer=stub, hub=hub, exports=None)
        self.assertIn("write_thumbnail", ag.MUTATING)
        content, label = agent._tool(self.pid, "write_thumbnail", {"html": THUMB, "props": {"headline": "Wait less"}})
        self.assertEqual(label, "Designed the thumbnail (rev 1)")
        self.assertEqual(content[0]["type"], "image")
        self.assertIn("Thumbnail saved (rev 1)", content[1]["text"])
        self.assertIn("No layout problems found.", content[1]["text"])
        name, args = stub.calls[-1]
        self.assertEqual((name, args[1:]), ("preview_frame", ("thumbnail", 2.95, 1280, 92)))
        self.assertEqual(args[0]["scenes"][0]["kind"], "thumbnail")
        shot = self.store.renders_dir(self.pid) / f"thumbnail-{rd.thumbnail_hash(args[0])}.jpg"
        self.assertEqual(shot.read_bytes(), JPEG)
        # served from the cache until the design changes
        from motion.jobs import thumbnail_image

        f, diag = thumbnail_image(self.store, stub, self.pid)
        self.assertEqual((f, diag, len(stub.calls)), (shot, None, 1))
        self.store.write_thumbnail(self.pid, THUMB, {"headline": "Wait much less"})
        f2, _ = thumbnail_image(self.store, stub, self.pid)
        self.assertNotEqual(f2, shot)
        self.assertFalse(shot.exists())  # the old picture is removed
        frames = [e for e in hub.log(self.pid) if e["kind"] == "frame"]
        self.assertEqual(frames[0]["sceneId"], "thumbnail")

    def test_an_unchanged_thumbnail_is_served_without_building_the_bundle(self):
        from motion.jobs import thumbnail_image

        stub = StubRenderer()
        self.store.write_thumbnail(self.pid, THUMB, {"headline": "Wait less"})
        first, _ = thumbnail_image(self.store, stub, self.pid)
        with mock.patch.object(self.store, "thumbnail_bundle", side_effect=AssertionError("the bundle was built")):
            again, diag = thumbnail_image(self.store, stub, self.pid)
            before = self.store.thumbnail_key(self.pid, rd.RUNTIME_VERSION)
            self.store.write_script(self.pid, [{"id": "a", "label": "A NEW LABEL"}])  # a scene edit: not in the picture
            self.assertEqual(self.store.thumbnail_key(self.pid, rd.RUNTIME_VERSION), before)
            self.assertEqual(thumbnail_image(self.store, stub, self.pid)[0], first)
        self.assertEqual((again, diag, len(stub.calls)), (first, None, 1))
        key = self.store.thumbnail_key(self.pid, rd.RUNTIME_VERSION)
        self.store.update_kit("algoinsight-paper", {"tagline": "A NEW TAGLINE"})  # the brand shows in the picture: a new key
        self.assertNotEqual(self.store.thumbnail_key(self.pid, rd.RUNTIME_VERSION), key)
        # a new player version is a new picture too (any version other than the current one)
        self.assertNotEqual(self.store.thumbnail_key(self.pid, rd.RUNTIME_VERSION + "-next"), self.store.thumbnail_key(self.pid, rd.RUNTIME_VERSION))
        view = self.store.thumbnail_view(self.pid, rd.RUNTIME_VERSION)
        self.assertRegex(view["url"], rf"/api/motion/projects/{self.pid}/thumbnail\.jpg\?v=1-[0-9a-f]{{8}}$")

    def test_routes(self):
        from fastapi.testclient import TestClient

        import app

        c = TestClient(app.app)
        pid = c.post("/api/motion/projects", json={"title": "Thumb Route", "brandKitId": "algoinsight-paper"}).json()["project"]["id"]
        self.assertEqual(c.get(f"/api/motion/projects/{pid}/thumbnail.jpg").status_code, 404)
        self.assertIsNone(c.get(f"/api/motion/projects/{pid}/thumbnail").json()["html"])
        r = c.put(f"/api/motion/projects/{pid}/thumbnail", json={"html": THUMB, "props": {"headline": "Wait less"}})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual((r.json()["rev"], r.json()["warnings"]), (1, []))
        got = c.get(f"/api/motion/projects/{pid}/thumbnail").json()
        self.assertEqual((got["html"], got["props"], got["rev"]), (THUMB, {"headline": "Wait less"}, 1))
        self.assertEqual(c.put(f"/api/motion/projects/{pid}/thumbnail", json={"html": THUMB, "baseRev": 0}).status_code, 409)
        # a rendered picture (a stand-in file in the cache, so no browser is needed): a versioned link is kept
        # by the browser for good, a bare one is checked every time
        from motion import jobs

        app_store = Store(store_mod.DATA_DIR)
        shot = app_store.renders_dir(pid) / "thumbnail-test.jpg"
        shot.write_bytes(JPEG)
        jobs._thumb_index[(pid, app_store.thumbnail_key(pid, rd.RUNTIME_VERSION))] = shot
        r = c.get(got["url"])
        self.assertEqual((r.status_code, r.content), (200, JPEG))
        self.assertEqual(r.headers["cache-control"], "private, max-age=31536000, immutable")
        self.assertEqual(c.get(f"/api/motion/projects/{pid}/thumbnail.jpg").headers["cache-control"], "no-cache")
        r = c.get(f"/api/motion/projects/{pid}/thumbnail.jpg?download=1")
        self.assertIn('filename="thumb-route-thumbnail.jpg"', r.headers["content-disposition"])
        c.delete(f"/api/motion/projects/{pid}")


class TimingAuditTests(unittest.TestCase):
    """The player's timing check folded into the audit, and how Claude reads it."""

    def test_diag_lines(self):
        self.assertEqual(
            ag._diag_line({"gaps": [[12.4, 19.0]]}),
            "nothing moves from 12.4 to 19.0 s while the voice talks: add a change, a camera move or a flow there",
        )
        # as the audit hands it on: the player's item (nextCue is a time) plus the cue number and the overrun
        late = {"id": "chip-a", "at": 15.3, "cue": 2, "plus": 3.2, "nextCue": 14.2, "nextIndex": 3, "into": 1.1}
        self.assertEqual(
            ag._diag_line({"late": [late]}),
            "chip-a arrives late: cue(2) + 3.2 s lands 1.1 s into the next phrase (cue(3) at 14.2 s); pin it to cue(3) or shorten the offset",
        )
        self.assertEqual(ag._issue_count({"gaps": [[1, 2]], "late": [late]}), 2)
        after = {"id": "note", "at": 21.0, "cue": 4, "plus": 2.5, "nextCue": 20.4, "nextIndex": None, "into": 0.6}
        self.assertEqual(
            ag._diag_line({"late": [after]}),
            "note arrives late: cue(4) + 2.5 s lands 0.6 s after the voice ends (at 20.4 s); bring it in while the voice still talks, or shorten the offset",
        )

    def test_pen_mark_lines(self):
        """Straight arrows and hugging loops: the report names a pen mark over words and a curved hand-drawn arrow."""
        d = {"penOver": [["circle-lb", "a3-label"], ["link-oc-lb", "note"]], "curvedArrow": ["arr-1"]}
        line = ag._diag_line(d)
        self.assertIn("a red pen mark runs over words or another card (move them apart, or link from a nearer side): circle-lb over a3-label, link-oc-lb over note", line)
        self.assertIn("curved arrow drawn by hand: draw it straight (M x y L x y) or as an elbow (arr-1)", line)
        self.assertEqual(ag._issue_count(d), 3)

    def test_audit_folds_in_the_timing_check(self):
        import asyncio

        class Page:
            def __init__(self, timing):
                self.timing = timing

            async def evaluate(self, js, arg=None):
                if "typeof" in js:
                    return self.timing is not None
                if "diagnose" in js:
                    return dict(CLEAN_DIAG)
                return self.timing

        scene = {"id": "s1", "source": "<div></div>", "kind": "scene", "duration": 20.0, "cues": [0.75, 5.0, 9.0, 14.2]}
        bundle = {"projectId": "p", "scenes": [scene]}
        rs = rd.RenderService("http://127.0.0.1:9", Path(TMP))
        # the player's report: nextCue is the next phrase's start in seconds (here cue(3), at 14.2 s)
        for timing, expect in ((None, 0), ({"gaps": [[12.4, 19.0]], "late": [{"id": "chip-a", "at": 15.3, "cue": 2, "plus": 6.3, "nextCue": 14.2}]}, 2)):
            handle = {"page": Page(timing), "errors": []}

            async def fake_handle(b, handle=handle):
                return handle

            rs._preview_handle = fake_handle
            rows = asyncio.run(rs.audit(bundle))
            timed = [r for r in rows if "gaps" in r or "late" in r]
            self.assertEqual(len(timed), expect)
        late = next(r for r in timed if "late" in r)
        self.assertEqual((late["t"], late["late"][0]["nextIndex"], late["late"][0]["into"]), (15.3, 3, 1.1))  # which cue, from the scene's cue times
        self.assertIn("cue(2) + 6.3 s lands 1.1 s into the next phrase (cue(3) at 14.2 s)", ag._diag_line(late))

    def test_audit_video_reports_them(self):
        store = new_store()
        pid = store.create_project("Audit", "16:9", "algoinsight-paper")["id"]
        store.write_storyboard(pid, [{"id": "s1", "name": "One", "idea": "x", "transition": "tear", "duration": 20}])
        rows = [
            {"id": "s1", "t": 1.45, **CLEAN_DIAG},
            {"id": "s1", "t": 12.4, "gaps": [[12.4, 19.0]]},
            {"id": "s1", "t": 15.3, "late": [{"id": "chip-a", "at": 15.3, "cue": 2, "plus": 3.2, "nextCue": 14.2, "nextIndex": 3, "into": 1.1}]},
        ]
        agent = ag.Agent(store, renderer=StubRenderer(rows), hub=Hub(store), exports=None)
        text, label = agent._tool(pid, "audit_video", {})
        self.assertIn("1 scenes checked at 1 moments and for their timing; 2 problems", text)
        self.assertIn("- s1 at 12.40 s: nothing moves from 12.4 to 19.0 s while the voice talks", text)
        self.assertIn("- s1 at 15.30 s: chip-a arrives late: cue(2) + 3.2 s lands 1.1 s into the next phrase", text)
        self.assertEqual(label, "Audited 1 scenes: 2 problems")


def fake_jpeg(width: int, height: int, tag: int = 0) -> bytes:
    """The start of a JPEG (its size header) and its end: enough for the asset list and an image block."""
    import struct

    return b"\xff\xd8\xff\xc0\x00\x11\x08" + struct.pack(">HH", height, width) + b"\x03\x01\x22\x00\x02\x11\x01\x03\x11\x01" + bytes([tag]) + b"\xff\xd9"


class ReferenceTests(unittest.TestCase):
    """Screenshots of the source brought in from a transcription: assets, REFERENCES.md, project.references,
    the state line and view_references (no renderer, no Claude, no voice)."""

    FRAMES = [(75.6, "Workers take jobs | one at a time."), (1.0, "Welcome to the lesson."), (608.2, "")]

    def setUp(self):
        self.store = new_store()
        self.pid = self.store.create_project("Refs", "16:9", "algoinsight-paper")["id"]
        self.src = Path(tempfile.mkdtemp(prefix="frames-", dir=TMP))
        self.frames = []
        for i, (t, text) in enumerate(self.FRAMES):
            f = self.src / f"frame-{i}.jpg"
            f.write_bytes(fake_jpeg(1280, 720, i))
            self.frames.append({"t": t, "path": f, "text": text})
        self.agent = ag.Agent(self.store, renderer=None, hub=Hub(self.store), exports=None)

    def test_import_assets_doc_and_project(self):
        refs = self.store.add_references(self.pid, self.frames, "Queues, explained", "https://example.com/v")
        self.assertEqual([r["asset"] for r in refs], ["ref-00m01s.jpg", "ref-01m15s.jpg", "ref-10m08s.jpg"])  # time order
        p = self.store.get_project(self.pid)
        self.assertEqual(p["references"], refs)
        self.assertEqual(p["references"][1], {"t": 75.6, "asset": "ref-01m15s.jpg", "text": "Workers take jobs | one at a time."})
        assets = {a["name"]: a for a in self.store.list_assets(self.pid)}
        self.assertEqual((assets["ref-01m15s.jpg"]["width"], assets["ref-01m15s.jpg"]["height"]), (1280, 720))
        md = self.store.read_doc(self.pid, "REFERENCES.md")
        self.assertIn("Source: Queues, explained (https://example.com/v)", md)
        self.assertIn("| Time | Asset | What is said |", md)
        self.assertIn("| 1:15 | ref-01m15s.jpg | Workers take jobs \\| one at a time. |", md)
        self.assertIn("| 10:08 | ref-10m08s.jpg | (no speech) |", md)
        self.assertIn("never copies their layout", md)
        # the state line, and the references kept out of the assets line
        self.store.save_asset(self.pid, "logo.png", b"\x89PNG\r\n\x1a\n" + b"\x00" * 8 + b"\x00\x00\x00\x10\x00\x00\x00\x10")
        state = self.store.state_summary(self.pid)
        self.assertIn("references: 3 screenshots of the source, 0:01-10:08 (view_references", state)
        assets_line = next(ln for ln in state.splitlines() if ln.startswith("assets: "))
        self.assertIn("logo.png", assets_line)
        self.assertNotIn("ref-", assets_line)
        self.assertEqual(self.store.add_references(self.pid, [{"t": 3, "path": self.src / "missing.jpg", "text": ""}]), [])  # nothing to bring

    def test_view_references(self):
        content, label = self.agent._tool(self.pid, "view_references", {})
        self.assertEqual(content, "This video has no screenshots of its source (they come with a transcript made with Screenshots on).")
        self.store.add_references(self.pid, self.frames)

        content, label = self.agent._tool(self.pid, "view_references", {})
        images = [b for b in content if b["type"] == "image"]
        texts = [b["text"] for b in content if b["type"] == "text"]
        self.assertEqual(len(images), 3)
        self.assertEqual(images[0]["source"]["media_type"], "image/jpeg")
        self.assertTrue(texts[0].startswith("3 of 3 screenshots of the whole source, 0:01-10:08. Each image"), texts[0])
        self.assertIn("never show these screenshots in the video", texts[0])
        self.assertEqual(texts[2], '[1:15] ref-01m15s.jpg: "Workers take jobs | one at a time."')
        self.assertEqual(texts[3], "[10:08] ref-10m08s.jpg: (no speech)")
        self.assertEqual([b["type"] for b in content], ["text", "image", "text", "image", "text", "image", "text"])  # each image, then its time and words
        self.assertEqual(label, "Looked at 3 screenshots of the source (0:01-10:08)")

        content, label = self.agent._tool(self.pid, "view_references", {"from": "1:00", "to": "1:15"})
        self.assertEqual(sum(b["type"] == "image" for b in content), 1)  # whole seconds: 75.6 is 1:15
        self.assertTrue(content[0]["text"].startswith("1 of 1 screenshots between 1:00 and 1:15."))
        self.assertEqual(label, "Looked at 1 screenshot of the source (1:15-1:15)")
        content, _ = self.agent._tool(self.pid, "view_references", {"limit": 2})
        self.assertEqual([b["text"][:6] for b in content if b["type"] == "text"][1:], ["[0:01]", "[10:08"])  # spread: first and last
        self.assertIn("2 of 3 screenshots", content[0]["text"])
        self.assertIn("raise limit up to 12", content[0]["text"])
        content, _ = self.agent._tool(self.pid, "view_references", {"limit": 99})
        self.assertEqual(sum(b["type"] == "image" for b in content), 3)  # held to 12, and there are 3
        content, label = self.agent._tool(self.pid, "view_references", {"from": "20:00"})
        self.assertEqual(content, "No screenshots from 20:00 on. They run from 0:01 to 10:08.")
        for bad in ({"from": "soon"}, {"to": 5}, {"limit": "six"}):
            with self.assertRaises(StoreError):
                self.agent._tool(self.pid, "view_references", bad)

    def test_a_reference_shown_in_a_scene_is_reported(self):
        self.store.add_references(self.pid, self.frames)
        self.store.write_storyboard(self.pid, [{"id": "s1", "name": "Hook", "idea": "a", "duration": 3, "transition": "fade"}])
        html = SCENE.replace("{{title}}", '<img data-id="pic" src="asset://ref-01m15s.jpg">')
        _, warnings = self.store.write_scene(self.pid, "s1", html, {"title": "Hi"})
        self.assertTrue(any("ref-01m15s.jpg is a screenshot of the source" in w for w in warnings), warnings)
        _, warnings = self.store.write_scene(self.pid, "s1", SCENE, {"title": "Hi", "img": "asset://ref-00m01s.jpg"})
        self.assertTrue(any("ref-00m01s.jpg is a screenshot of the source" in w for w in warnings), warnings)
        _, warnings = self.store.write_scene(self.pid, "s1", SCENE, {"title": "Hi"})
        self.assertFalse(any("screenshot of the source" in w for w in warnings))

    def test_list_assets_leaves_them_to_view_references(self):
        self.store.add_references(self.pid, self.frames)
        text, _ = self.agent._tool(self.pid, "list_assets", {})
        self.assertNotIn("ref-01m15s.jpg", text.splitlines()[0])
        self.assertIn("Also 3 screenshots of the source", text)

    def test_make_a_motion_video_takes_the_frames_along(self):
        from fastapi.testclient import TestClient

        import app
        import screenshots

        job = "f00dfeed0001"
        folder = screenshots.FRAMES_DIR / job
        folder.mkdir(parents=True, exist_ok=True)
        manifest = []
        for i, (t, text) in enumerate(self.FRAMES):
            name = screenshots.frame_name(t)
            (folder / name).write_bytes(fake_jpeg(1280, 720, i))
            manifest.append({"t": t, "file": name, "text": text})
        (folder / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
        (folder / "job.json").write_text(json.dumps({"title": "Queues", "url": "https://example.com/v", "state": "done"}), encoding="utf-8")

        c = TestClient(app.app)
        r = c.post("/api/motion/projects", json={"title": "With refs", "brandKitId": "algoinsight-paper", "sourceText": "[0:00] hi", "sourceTitle": "Queues", "framesJob": job})
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["references"], 3)
        pid = r.json()["project"]["id"]
        p = c.get(f"/api/motion/projects/{pid}").json()["project"]
        self.assertEqual([x["asset"] for x in p["references"]], ["ref-00m01s.jpg", "ref-01m15s.jpg", "ref-10m08s.jpg"])
        self.assertEqual(c.get(f"/api/motion/projects/{pid}/assets/ref-01m15s.jpg").content, fake_jpeg(1280, 720, 0))
        self.assertIn("| 1:15 | ref-01m15s.jpg |", c.get(f"/api/motion/projects/{pid}/docs/REFERENCES.md").text)
        # no screenshots, an unknown job or a bad id: the video is still made, without references
        for bad in ("000000000000", "../../etc", 5):
            r = c.post("/api/motion/projects", json={"title": "No refs", "framesJob": bad})
            self.assertEqual((r.status_code, r.json()["references"]), (200, 0))
            c.delete(f"/api/motion/projects/{r.json()['project']['id']}")
        c.delete(f"/api/motion/projects/{pid}")

    def test_the_tool_is_wired(self):
        from motion.prompts import SYSTEM_PROMPT, TOOL_LABELS, TOOLS

        spec = next(t for t in TOOLS if t["name"] == "view_references")
        self.assertEqual(set(spec["input_schema"]["properties"]), {"from", "to", "limit"})
        self.assertEqual(spec["input_schema"]["properties"]["limit"]["maximum"], 12)
        self.assertIn("view_references", TOOL_LABELS)
        self.assertIn("you may look at them (view_references) to see how that video showed an idea", SYSTEM_PROMPT)
        self.assertIn("Never copy their layout, words, brand, logos, characters, numbers or images", SYSTEM_PROMPT)
        self.assertIn("never show them in the video", SYSTEM_PROMPT)


class PublishingPromptTests(unittest.TestCase):
    def test_the_prompt_documents_the_new_tools(self):
        from motion.prompts import SYSTEM_PROMPT, TOOL_LABELS, TOOLS

        self.assertIn("write_thumbnail", {t["name"] for t in TOOLS})
        self.assertIn("write_thumbnail", TOOL_LABELS)
        for phrase in ("fx.focus(target, at, opts)", "fx.flow(path, at, opts)", "fx.link(fromEl, toEl, at, opts)", 'class="p-code"', "fx.line(el, n, at)", 'data-carry="key"', "part sting", "bottom-right corner", "write_thumbnail", "captions"):
            self.assertIn(phrase, SYSTEM_PROMPT)
        self.assertNotIn("\u2014", SYSTEM_PROMPT)  # hyphens, never em dashes
        self.assertGreaterEqual(int(rd.RUNTIME_VERSION), 6)  # the player that has these tools (cached scenes redone)


    def test_the_prompt_follows_the_reference_and_decides_everything(self):
        """A reference sets what the video covers and how long it runs; Claude decides everything itself and leaves
        no places for the user's words (the founder, 2026-11-19)."""
        from motion.prompts import SYSTEM_PROMPT, TOOLS

        for phrase in (
            "the video covers EVERY point it makes, nothing dropped, and runs about as long as it does",
            "a three-minute reference is a three-minute video, never ten",
            "Decide everything yourself. Never ask the user for their take",
            "never as an invented memory of the user's or a made-up real event",
            "Our own words always (a run of eight or more of its words in a row is refused)",
            "there is no review step",
            "never change it unless they ask, and then send it with replaceOwnWords: true",
        ):
            self.assertIn(phrase, SYSTEM_PROMPT)
        for gone in ("Ask first. Before any outline", "[[you: what goes here, in a few words]]", "write_scene is refused until then", "is research only", "sourceSkips", "10 to 30 minutes"):
            self.assertNotIn(gone, SYSTEM_PROMPT)
        by_name = {t["name"]: t["input_schema"]["properties"] for t in TOOLS}
        self.assertEqual(by_name["write_storyboard"]["plan"]["properties"]["shape"]["enum"], list(store_mod.SHAPES))
        self.assertNotIn("covers", by_name["write_storyboard"]["scenes"]["items"]["properties"])
        for tool in ("write_storyboard", "write_script", "write_scene"):
            self.assertIn("replaceOwnWords", by_name[tool])
            self.assertNotIn("sourceSkips", by_name[tool])


if __name__ == "__main__":
    unittest.main()
