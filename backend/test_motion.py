"""Offline tests for Motion: the project store, scene checks, patches, undo, cache hashes, brand colour
parsing and the chat loop with a stand-in for Claude (no network, no browser, no API key).
Run: python -m unittest -v"""

import os
import shutil
import tempfile

# every test works under one temporary folder (deleted at the end), never in motion-data
TMP = tempfile.mkdtemp(prefix="motion-test-")
os.environ["MOTION_DATA_DIR"] = os.path.join(TMP, "app-data")
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
        self.assertIn("target length: 10:00; the whole video must run between 9:00 and 15:00", self.store.state_summary(self.pid))

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


class SourceTests(unittest.TestCase):
    """The reference transcript: the points a video must cover, its length and its own wording."""

    def setUp(self):
        self.store = new_store()
        self.hub = Hub(self.store)
        self.agent = ag.Agent(self.store, renderer=None, hub=self.hub, exports=None)
        self.pid = self.store.create_project("From a talk", "16:9", "algoinsight-paper")["id"]
        self.store.save_asset(self.pid, "transcript-lesson1.txt", SOURCE.encode())

    def attach(self):
        return self.agent._attachment_blocks(self.pid, "transcript-lesson1.txt")

    def test_a_timed_attachment_sets_the_target_and_the_points(self):
        blocks = self.attach()
        self.assertIn("aims for 10:08", blocks[-1]["text"])  # the source's length, inside 10 to 30 minutes
        p = self.store.get_project(self.pid)
        self.assertEqual(p["targetSeconds"], 608)
        src = self.store.get_source(self.pid)
        self.assertEqual(len(src["lines"]), 6)  # the title and the link are not points
        self.assertEqual(src["lines"][3], {"t": 270.0, "text": "The time between a request and its answer is called latency."})
        self.assertEqual(store_mod.target_from_source(200), 600)
        self.assertEqual(store_mod.target_from_source(4000), 1800)

    def test_transcript_formats(self):
        srt = "1\n00:00:01,000 --> 00:00:04,000\nHello there\nand welcome\n\n2\n00:01:05,500 --> 00:01:08,000\nSecond cue\n"
        self.assertEqual(store_mod.parse_source(srt), [{"t": 1.0, "text": "Hello there and welcome"}, {"t": 65.0, "text": "Second cue"}])
        self.assertEqual(store_mod.parse_source("1:02:03 Late in a long talk\nstill talking")[0], {"t": 3723.0, "text": "Late in a long talk still talking"})
        self.assertEqual(store_mod.clean_covers(["1:40-2:17", "2:30", " 0:09 to 0:03 "]), ["1:40-2:17", "2:30", "0:03-0:09"])
        with self.assertRaises(StoreError):
            store_mod.clean_covers(["the start"])
        with self.assertRaises(StoreError):
            store_mod.clean_skips([{"range": "9:40"}])  # a skip needs its reason

    def test_scene_code_waits_for_a_full_own_script(self):
        self.attach()
        self.store.write_storyboard(self.pid, [
            {"id": "a", "name": "Models", "idea": "x", "transition": "tear", "narration": talk(60), "covers": ["0:00-0:09"]},
            {"id": "b", "name": "Latency", "idea": "y", "transition": "turn", "narration": talk(60, "Kabir")},
        ])
        review = self.store.plan_review(self.pid)
        joined = " ".join(review["problems"])
        self.assertIn("must run at least 9:07", joined)  # 90 percent of 10:08
        self.assertIn("3 of the source's 6 timed lines", joined)
        self.assertIn("[4:30] The time between", joined)
        with self.assertRaises(StoreError) as refused:
            self.agent._tool(self.pid, "write_scene", {"id": "a", "html": SCENE})
        self.assertIn("isn't ready for scene code", str(refused.exception))
        self.assertIn("before any scene code", self.store.state_summary(self.pid))

        # copying the source word for word is refused too
        self.store.write_script(self.pid, [{"id": "b", "narration": "A model is a function whose behavior is learned from data, not written by a developer."}])
        self.assertIn('b: "a model is a function whose behavior is learned from data not written by a developer"', " ".join(self.store.plan_review(self.pid)["problems"]))

        # the whole script, in its own words, covering or skipping every line: the build may start
        self.store.write_script(
            self.pid,
            [{"id": "a", "narration": talk(800), "covers": ["0:00-0:09"]}, {"id": "b", "narration": talk(800, "Kabir"), "covers": ["4:30", "10:08"]}],
            source_skips=[{"range": "9:40", "reason": "a plug for their channel"}],
        )
        review = self.store.plan_review(self.pid)
        self.assertEqual(review["problems"], [], review["problems"])
        self.assertEqual((review["coverage"]["covered"], review["coverage"]["skipped"]), (5, 1))
        content, _ = self.agent._tool(self.pid, "write_scene", {"id": "a", "html": SCENE})
        self.assertIn("Scene a saved", content)
        listing, _ = self.agent._tool(self.pid, "read_source", {"from": "4:00"})
        self.assertIn("[4:30] The time between a request and its answer is called latency.  <- b", listing)
        self.assertIn("[9:40] Like and subscribe for more videos like this one.  <- skipped", listing)
        md = self.store.script_markdown(self.pid)
        self.assertIn("5 of 6 timed lines covered, 1 skipped, 0 not covered", md)
        self.assertIn("Source: 4:30, 10:08", md)

        # rewriting a scene that already has code is an edit: never held up by the script check
        self.store.write_script(self.pid, [{"id": "b", "narration": talk(30, "Kabir")}])
        self.assertTrue(self.store.plan_review(self.pid)["problems"])
        self.agent._tool(self.pid, "write_scene", {"id": "a", "html": SCENE})

    def test_a_short_from_a_long_talk(self):
        self.attach()
        p, _ = self.store.write_storyboard(self.pid, [{"id": "a", "name": "Reel", "idea": "x", "transition": "fade", "duration": 30}], target_minutes=0.5)
        self.assertEqual(p["targetSeconds"], 30)
        self.assertEqual(self.store.plan_review(self.pid)["problems"], [])  # a short needn't cover every point
        self.agent._tool(self.pid, "write_scene", {"id": "a", "html": SCENE})


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
        self.assertIn("isn't logged in", cc._assistant_error("Invalid API key · Please run /login"))
        self.assertIn("usage limit", cc._assistant_error("Claude AI usage limit reached"))

    def test_source_length_from_timestamps(self):
        self.assertEqual(ag.source_seconds("[0:00] a\n[10:08] b"), 608)
        self.assertEqual(ag.source_seconds("00:01:02.000 --> 00:01:05.500"), 65)
        self.assertEqual(ag.source_seconds("no times here"), 0)

    def test_tests_never_use_claude_code(self):
        self.assertEqual(ag.default_engine(), "api")


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
        self.assertFalse(c.get(f"/api/motion/projects/{pid}/bundle").json()["brand"]["showLogo"])
        self.assertEqual(c.patch(f"/api/motion/projects/{pid}", json={"closing": {"promo": True}}).status_code, 400)
        c.delete(f"/api/motion/projects/{pid}")


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

    def test_udemy_shows_nothing_of_ours(self):
        self.store.update_project(self.pid, {"closing": {"promo": True}})
        self.store.update_project(self.pid, {"destination": "udemy"})
        self.assertEqual(self.ids(), [("a", "scene"), ("b", "scene")])
        b = self.store.bundle(self.pid)
        self.assertEqual((b["brand"]["showLogo"], b["brand"]["showUrl"]), (False, False))
        self.assertIn("made for: Udemy", self.store.state_summary(self.pid))
        with self.assertRaises(StoreError):
            self.store.update_project(self.pid, {"closing": {"endscreen": True}})
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


if __name__ == "__main__":
    unittest.main()
