# Video Transcriber

Paste a video link and get a transcript with timestamps. You can copy it, search it, or download it as
`.txt`, `.srt` or `.vtt`.

The app runs **on your own computer** at http://127.0.0.1:8765. Transcribing sends nothing to an outside
AI service, and there is no account, API key or cost per video.

It also has **Motion** ([section 6](#6-motion-animated-videos-made-by-claude)): describe a short animated
video and Claude writes it as code, which plays live next to the chat and exports to MP4, from short clips
to narrated 10 to 30 minute explainers in the AlgoInsight daily-film look. Motion is the one part that uses
outside AI services: Claude (through Claude Code with your Claude login, or an API key) and ElevenLabs for
the narration voice.

---

## Contents

1. [How it works](#1-how-it-works)
2. [What you need](#2-what-you-need)
3. [Installation (once)](#3-installation-once)
4. [Starting the app](#4-starting-the-app)
5. [Using the app](#5-using-the-app)
6. [Motion: animated videos made by Claude](#6-motion-animated-videos-made-by-claude)
7. [Speech models: speed and accuracy](#7-speech-models-speed-and-accuracy)
8. [Which sites work](#8-which-sites-work)
9. [Keeping it working (updates)](#9-keeping-it-working-updates)
10. [Troubleshooting](#10-troubleshooting)
11. [For developers](#11-for-developers)
12. [Cost, privacy and fair use](#12-cost-privacy-and-fair-use)
13. [Hosting it online](#13-hosting-it-online)
14. [Uninstalling](#14-uninstalling)

---

## 1. How it works

When you click **Transcribe**, the app:

1. **Reads the video page** (title, length, which captions exist) with
   [yt-dlp](https://github.com/yt-dlp/yt-dlp). Nothing is downloaded yet.
2. **Uses the video's own captions if it has any.** Captions written by people are used first, then
   the site's automatic captions. This takes about 2 seconds, whatever the video's length.
3. **Otherwise, transcribes the speech on your computer.** It downloads only the audio, converts it
   with FFmpeg, and runs **Whisper**, a free speech-recognition AI model from OpenAI, through
   [faster-whisper](https://github.com/SYSTRAN/faster-whisper). The audio file is deleted afterwards.

The result is labelled with where it came from: **Captions**, **Auto-captions** or **Speech-to-text**.

```
 Browser (React page)  ──►  Python server (FastAPI, 127.0.0.1:8765)
                               │
                               ├─ yt-dlp ──► video page, captions, audio
                               ├─ FFmpeg ──► audio → 16 kHz mono
                               └─ Whisper (faster-whisper, CPU) ──► text with timestamps
```

---

## 2. What you need

| What | Version | Why |
|------|---------|-----|
| Windows 10 or 11 | — | These steps are written for Windows. macOS and Linux work too, with the same tools. |
| **Python** | **3.13** | Runs the server. ⚠️ On Zema laptops, Microsoft Defender blocks Python 3.12.10 ("Access is denied"), so use 3.13. |
| **FFmpeg** | any recent version | Converts the audio for Whisper, and is needed for some streamed videos. |
| **Node.js** | **24** (LTS) | Only needed to build the web page, once, and again after page changes. ⚠️ Defender blocks Node 22.12.0 and 22.22.0 on Zema laptops. |
| Disk space | ~1.5 GB | ~600 MB of Python packages, ~460 MB for the default speech model, the rest for the page tools. |
| Internet | — | To install the tools, download the speech model once, and fetch the videos. |

You do **not** need a graphics card (GPU), administrator rights, or any API key.

---

## 3. Installation (once)

Use **PowerShell** for every command below. In VS Code, open it with **Terminal → New Terminal**.

### Step 1: Install Python 3.13

```powershell
winget install --id Python.Python.3.13 --scope user
```

Close the terminal, open a new one, and check it:

```powershell
& "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe" --version
# Python 3.13.x
```

> No `winget`? Download the "Windows installer (64-bit)" for Python 3.13 from
> https://www.python.org/downloads/windows/ and run it. Choose "Install for me only".

### Step 2: Install FFmpeg

```powershell
winget install --id Gyan.FFmpeg.Essentials
```

Close the terminal and open a new one. The app finds FFmpeg in any of these places, in this order:

1. the folder in the `FFMPEG_LOCATION` environment variable, if you set one;
2. any `ffmpeg` on your `PATH`;
3. the winget install folder,
   `%LOCALAPPDATA%\Microsoft\WinGet\Packages\Gyan.FFmpeg.Essentials_*\...\bin`.

You do not need to add it to `PATH` yourself.

### Step 3: Install Node.js 24

```powershell
winget install --id OpenJS.NodeJS.LTS
```

Open a new terminal and check it:

```powershell
node --version
# v24.x.x
```

> If `node` says **"Access is denied"**, Defender is blocking an older Node that is still first on your
> `PATH`, for example one from `nvm`. With nvm-windows, run `nvm install 24` and then, in an
> **administrator** PowerShell, `nvm use 24`. Do not try to unblock the old version; updating is the fix.

### Step 4: Get the project

Copy or clone the `video-transcriber` folder to your machine, for example
`C:\Users\<you>\projects\Zema-Projects\video-transcriber`. Then go into it:

```powershell
cd C:\Users\<you>\projects\Zema-Projects\video-transcriber
```

The folder looks like this:

```
video-transcriber/
├─ backend/          Python server (yt-dlp + Whisper)
│  ├─ app.py         HTTP API, and serves the built page
│  ├─ transcriber.py captions, audio download, Whisper, output formats
│  ├─ requirements.txt
│  ├─ setup.ps1      one-time Python setup
│  └─ run.ps1        starts the app
└─ frontend/         React page (Vite + TypeScript)
```

### Step 5: Set up the Python part

```powershell
.\backend\setup.ps1
```

This creates a private Python environment in `backend\.venv` and installs yt-dlp, faster-whisper,
FastAPI and uvicorn. It takes **5–20 minutes**, because `faster-whisper` pulls in large packages
(`ctranslate2`, `onnxruntime`).

<details>
<summary>The same steps by hand, if you can't run <code>.ps1</code> scripts</summary>

```powershell
cd backend
& "$env:LOCALAPPDATA\Programs\Python\Python313\python.exe" -m venv .venv
.\.venv\Scripts\python.exe -m pip install --upgrade pip
.\.venv\Scripts\python.exe -m pip install --timeout 180 --resume-retries 50 -r requirements.txt
cd ..
```

</details>

> **"Download failed … not enough bytes were received"**: the network dropped a large download.
> Run the same command again. `--resume-retries` continues where it stopped.

Check that it worked:

```powershell
.\backend\.venv\Scripts\python.exe -c "import yt_dlp, faster_whisper; print('ok')"
# ok
```

### Step 6: Build the web page

```powershell
cd frontend
npm install
npm run build
cd ..
```

This creates `frontend\dist`, which the Python server serves. Run `npm run build` again whenever
the page code changes.

> `npm warn install-scripts … esbuild` is only a warning. The build works without it.

### Step 7: Check everything (optional)

```powershell
cd backend
.\.venv\Scripts\python.exe -m unittest -v
.\.venv\Scripts\python.exe check_captions.py "https://www.youtube.com/watch?v=jNQXAC9IVRw"
cd ..
```

The tests should end with `OK`. The second command should print "Me at the zoo" and its captions.

Installation is done.

---

## 4. Starting the app

```powershell
cd C:\Users\<you>\projects\Zema-Projects\video-transcriber
.\backend\run.ps1
```

When you see `Uvicorn running on http://127.0.0.1:8765`, open **http://127.0.0.1:8765** in your
browser.

- Keep the terminal open while you use the app.
- To stop it, press **Ctrl + C** in that terminal.

<details>
<summary>Start it without the script</summary>

```powershell
cd backend
.\.venv\Scripts\python.exe app.py
```

</details>

**To start with a different default speech model** (see [section 7](#7-speech-models-speed-and-accuracy)):

```powershell
$env:WHISPER_MODEL = "base"; .\backend\run.ps1
```

---

## 5. Using the app

1. Paste the video link into **Video URL** and click **Transcribe**.
2. Wait. You will see the steps: *Reading the video → Looking for captions*, and for videos without
   captions also *Downloading the audio → Loading the speech model → Preparing the audio →
   Turning speech into text*, with a percentage.
3. Read the transcript. On the result:

| Control | What it does |
|---------|--------------|
| **Copy** | Copies the whole transcript, with or without timestamps (follows the *Timestamps* switch). |
| **.txt** | Downloads plain text, one line per caption with `[hh:mm:ss]` timestamps. Untick *Timestamps* for flowing text. |
| **.srt** / **.vtt** | Downloads subtitle files you can load into a video player or editor. |
| **Search** | Shows only the paragraphs that contain your words, and highlights them. |
| **Timestamps** | Shows or hides the times. On YouTube, clicking a time opens the video at that moment. |
| Title | Opens the original video. |

**Options** (click *Options* under the URL box):

| Option | When to use it |
|--------|----------------|
| **Language** | Leave empty to detect it automatically. Type a code (`en`, `hi`, `fr`, `de`…) to pick that caption language, or to tell Whisper which language is spoken. |
| **Speech model** | Only used for videos without captions. Faster or more accurate, see [section 7](#7-speech-models-speed-and-accuracy). |
| **Ignore the video's captions** | Always use speech-to-text, for example when the automatic captions are poor. |
| **Screenshots for layout references** | On by default. After the transcript, takes stills of the video with what is said at each (see [Screenshots](#screenshots-layout-references-for-motion)). Untick it to skip the video download. |

The first time a speech model is used, it is downloaded from Hugging Face (`small` is ~460 MB, about
a minute). After that it is loaded from
`%USERPROFILE%\.cache\huggingface\hub` and works without that download.

Transcripts are kept only while the server runs. Download anything you want to keep.

### The video prompt

Under every finished transcript there is a **Video prompt**: the prompt that asks Claude to build an
AlgoInsight daily-series video from this video, written as soon as the transcript is ready. Paste it to
Claude as it is (**Copy prompt**) or save it (**.md**).

- **The details** at the top (topic, language, length, episode, stop for an OK after the script,
  anything special) fill in the prompt's first lines. The language, the length and the two
  transcript ticks are remembered for the next video.
- **Short forms and how to say them** lists every short form in the transcript (CI/CD, API, YAML,
  GitHub, K8s...) with how the voice should say it: letters joined by hyphens (C-I C-D), a word
  (YAML is "yammel") or the name as written (GitHub). Short forms that auto-captions of Hindi videos
  write in Hindi letters are found too (सीआईसीडी is CI/CD, एपीआई is API). A guess worth a second look
  is marked **check**. Untick a row to leave it out, edit what is written or said, or **Add a short
  form** of your own. They go into the prompt's section 4, which also tells Claude how to check each
  one against the speech lexicon.
- **Put the transcript in the prompt** adds the transcript at the end, so one paste does it all.

Nothing leaves your computer: the prompt is written in the page.

### Screenshots (layout references for Motion)

After the transcript (captions or Whisper), the app takes **screenshots** of the video and pairs each with
what is said then. The transcript shows at once; the **Screenshots** section under it shows the progress
(*Downloading the video → Finding the scene changes → Taking screenshots*), then a grid of stills, each with
its time and the line being said. Click one to see it large (left and right step through them).
**Download all (.zip)** gives the JPEGs with `REFERENCES.md` (a table of time, file and what is said) and
`references.json`.

- **When:** at every new scene (FFmpeg's scene-change detection) and at least every 15 seconds, never two
  within 4 seconds, at most 120 per video. Each is a JPEG 1280 wide.
- **What is said:** the transcript lines from 4 seconds before to 6 seconds after, trimmed to about two
  sentences.
- **How:** a video-only stream of at most 720p is downloaded to a temp folder and deleted afterwards. If the
  video can't be downloaded or FFmpeg fails, the transcript is still fine and the section says why there are
  no screenshots.
- **Where:** `transcriber-data\frames\<job id>\` next to `backend` (ignored by Git; `TRANSCRIBER_DATA_DIR`
  moves it), so they outlive a restart. Folders older than 14 days are deleted when the app starts.

**In Motion.** **Make a Motion video** takes the screenshots along (wait until they are done): they become
the video's assets `ref-<mm>m<ss>s.jpg`, with `docs\REFERENCES.md` (time, asset, what is said). The project
state tells Claude they exist, and its `view_references` tool shows it the screenshots for a stretch of the
source (6 by default, up to 12), each with its time and words. Claude looks at them before designing the
scenes that cover that part, to see what the source shows at each point and how much it puts on one screen,
then designs its own page in the paper look. It never copies their layout, words, brand, logos, characters,
numbers or images, and they are never shown in the video (a scene that uses one gets a warning).

---

## 6. Motion: animated videos made by Claude

Open the **Motion** tab at the top of the page. Motion makes two kinds of video:

- **Short clips** (a 6-second logo sting, a 30-second reel, an animated chart): describe it in one sentence,
  pick a look from the cards Claude shows, and watch the scenes appear.
- **Narrated explainers of 10 to 30 minutes in the AlgoInsight daily-film look**: graph paper, the logo card,
  torn labels, sticky notes, stamps, red pen, page tears and turns, the end screen, read by the YouTube
  voice (Pooja on ElevenLabs Eleven v4). Attach a competitor's transcript and Motion makes **its own
  version**: every point the transcript teaches, in its own story, examples and words, at about the same
  length (never under 10 or over 30 minutes).

Claude writes every scene as code (HTML, CSS and a GSAP animation), checks its own work (a layout report
for every scene at every cue: text off the frame or in the logo, label, title or narrator zones,
overlapping or tiny text, too many words) and fixes what it finds. It is not a video-generation model: it
animates text, shapes, diagrams, charts, icons and your images; it can't make realistic footage or people,
run programs or record screens (where a real recording belongs it leaves a marked placeholder).

### Setting it up (once)

1. **The Python packages** (the Claude Agent SDK with Claude Code inside it, Anthropic's SDK, Playwright,
   uploads):

   ```powershell
   .\backend\.venv\Scripts\python.exe -m pip install -r backend\requirements.txt
   ```

2. **Claude.** Motion runs on **Claude Code with your Claude login** by default (your plan, not per-token
   billing). If Claude Code has never been logged in on this computer, open a terminal, run `claude` and log
   in once. Motion doesn't load your personal Claude Code settings, memory or hooks, and its Claude can only
   touch the video (and search the web for facts). To use an **API key** instead, choose *API key* under
   **Claude** in the editor and put `ANTHROPIC_API_KEY=sk-ant-...` in `backend\.env`.
3. **The voice.** Put your ElevenLabs key in `backend\.env` (the file is ignored by Git):

   ```
   ELEVENLABS_API_KEY=...
   ```

   Restart the app afterwards. Audio is only made when you press **Generate voice**; Claude can't.
4. **Rebuild the page** (`cd frontend; npm install; npm run build`), which also builds `motion-player.html`,
   the page that plays the videos.
5. **A browser for exports.** The export uses the Microsoft Edge (or Chrome) already on the computer, in the
   background. Without either, run `.\backend\.venv\Scripts\python.exe -m playwright install chromium`.

### A narrated explainer, step by step

1. **Start** with the *AlgoInsight daily (narrated)* starter, or **Make a Motion video** under a finished
   transcript (it opens in the paper look with the transcript attached). A timed transcript sets the
   **target**: its own length, held to 10 to 30 minutes. Its timed lines become the **points to cover**.
2. Claude **checks the facts** (web search when it runs on Claude Code) and writes them to FACTS.md, plans
   the **storyboard** in parts with one running story, writes the **script** for every scene (three passes,
   simple English, the voice rules: no digits, dashes, brackets, symbols or SSML), and sets the
   **pronunciations** for every short form (AI said A-I, LLM said L-L-M, ...). Each scene names the source
   times it teaches.
3. **The script check.** No scene code is written until the script passes three checks:
   - **Length:** the video runs 90 to 150 percent of the target.
   - **Coverage:** every timed line of the source is taught by some scene, or skipped with a reason (a
     greeting, an ad, a plug for their channel).
   - **Own words:** no run of eight or more of the source's words in a row.
4. **Script** in the top bar shows the whole narration with its parts, labels, timings, cue marks and source
   times, the **Chapters** (one per part), the **Source coverage** and Claude's documents (FACTS.md,
   YOUTUBE.md with titles, description, tags and the thumbnail idea). Download or copy any of them.
5. Claude writes **every** scene, pinning every element to a `<cue/>` in the narration, then audits them. If
   it stops part-way, Motion sends it back to the remaining scenes. If it stops again without progress
   (or a turn hits an error), **Continue building** in the chat picks up where it left off.
6. **Voice** in the top bar, then **Generate voice**. Each scene's narration goes to ElevenLabs with the time
   of every character; scenes whose words didn't change reuse their audio for free. Every cue then moves to
   its spoken word, so the whole video re-times by itself. Edit the **pronunciation table** there too. Then
   ask Claude to audit again: the real voice runs faster than the estimate, and the timing checks show
   what now lands late.
7. Claude designs the **thumbnail** at the hand-off (see below).
8. **Export** at 1080p or 4K with the narration, the paper sounds (rip, page, stamp, pop, pencil, crumple)
   and an optional music bed mixed in. The captions are written next to the MP4.

### Making and changing a video

| What | How |
|------|-----|
| **Start** | **+ New video**, or a starter. Under a finished transcript, **Make a Motion video**. |
| **Attach material** | The paperclip, drag and drop, or paste: images, PDFs, text files, audio. A transcript with timestamps sets the target length and the points to cover. |
| **Pick the look** | Click a style card, or **Other / my brand** and describe it. Paper videos skip this. |
| **Change something** | Say it in the chat ("the estimate is thirty minutes", "make part two shorter"). Claude patches only what you asked for. |
| **Point at it** | **Comment**, then click an element in the preview and write what should change. |
| **Edit it yourself** | The panel under the preview: a scene's narration, torn label, part, hold, transition, and its props (text, numbers, colours, images). **Code** shows the scene's source. A changed narration needs its voice again. |
| **Undo** | Undoes Claude's last turn or your last edit, one step at a time. |
| **Commands** | Type `/export`, `/undo`, `/clear` (a new chat that keeps the scenes) or `/new`. |
| **Play** | Space plays and pauses (with the narration and sounds once the voice exists); left and right step one frame (Shift: one second); up and down move between scenes. **Guides** shows the safe area, **Sound** mutes the preview. |
| **Find a scene** | The scene strip under the preview: every scene with its number, name, length and voice dot, grouped by part; the promo and the end screen are marked. The arrows in the scene panel step through scenes too. |
| **YouTube or Udemy** | The **For YouTube / For Udemy** button in the top bar. YouTube: choose the logo card, the web address, the AlgoInsight promo and the end screen. Udemy: none of them (a Udemy film shows no website, URL, price or platform of ours), and Claude is told to leave AlgoInsight out of the narration. The target length lives there too. |

### The paper look

It follows the AlgoInsight film style guide: the 1600 x 900 frame, pale blue graph paper with grain, the
logo card and tagline top-left, the film's title and the part tag top-right, the web address bottom-right,
each page's torn black label at x 340, the content box x 140-1460 and y 150-849, and the narrator corner kept
clear. A new part tears the last page away, the next page in a part turns over like a book's page, and the
video ends on the paper end screen with Watch next, More from the series and Subscribe. Scenes use the
components (cards, sticky notes, marker headings, pen notes and arrows, ink stamps, badges, recording
windows) and the entrances (pop, unfold, tear on, write on, marker wipe, draw, stamp slam, crumple) with
the films' timings. Arrowheads are drawn by the player on the line's real end, and the layout check also
reports blocks of words closer than 18 px.

**Animation tools** for explaining, not just revealing: a **camera** that zooms and pans to the part being
explained and back (`fx.focus`, `fx.unfocus`); the **flow kit**: packets travelling along a path for
requests and data on the move (`fx.flow`), any element moved along a path (`fx.travel`), a red-pen arrow
drawn between two elements (`fx.link`), a pen ring around one (`fx.circle`), a bar or queue filling
(`fx.grow`) and text that changes with a small pop (`fx.change`); **code walkthroughs**: one code panel,
highlighted with line numbers, typed on line by line (`fx.code`) with a marker band moving to the lines the
voice explains (`fx.line`). Code on screen is always copied from your files or a real run, never written up
by Claude. An element marked `data-carry` in two scenes in a row moves across the page change instead of
leaving with the page, and each new part opens with a short sting.

**Timing checks.** Besides the layout, the audit reads each scene's timing: **still stretches** (nothing
moves for a while as the voice talks) and **late entrances** (an element pinned to a cue with an offset
that lands it in the next phrase, for example `cue(2) + 3.2 s` arriving 1.1 s after `cue(3)`). Claude
fixes both, and checks again after Generate voice.

**The thumbnail.** Claude designs the YouTube thumbnail as one more scene: a still on the 1600 x 900 paper
stage, 3 to 5 very large words, one marker stroke, one focal element, high contrast, the bottom-right corner
left clear for YouTube's time stamp, no frame chrome and no real people. It is rendered at 1280 x 720
(JPEG) the first time it is asked for after each change and kept in `renders\thumbnail-<hash>.jpg`; undo
covers it like the scenes. You can also edit its code and props yourself.

**The AlgoInsight promo** (YouTube only, a tick in the video's settings): four narrated paper scenes of
about a minute, before the end screen: the road from the first lesson to the first offer, nearly 700
narrated lessons and the animations, 640+ problems in 30+ patterns and the four AI mock interviews, the AI
mentor and the prep planner, then algoinsight.io. The claims follow the live site's home page. Its scenes
live in `backend\motion\seed\promo`; a video gets its own copy when the promo is ticked. Its narration is
voiced like any scene, and every voice clip is also kept in `motion-data\voice-cache`, so the same words
are never paid for twice: the promo's minute costs nothing after the first video.

### Brand kits

A brand kit holds the colours by role, the fonts (Google Fonts or system fonts; Motion keeps a copy of each
Google font in `motion-data\fonts` so every frame uses the real font), radius, motion, logo, icon, wordmark,
tagline, end card, style notes and the theme (*plain* or *paper*). Two kits come ready: **AlgoInsight** (navy
with the indigo-to-purple gradient) and **AlgoInsight Paper** (the daily-film look). Make your own under
**Brand kits**, or **Read from a website**. Claude never changes an existing kit (other videos use it).

### Exporting

**Export**, then 1080p, 4K or 720p. The panel shows what goes in: the **narration** (included on its own
once the voice exists; it says how many scenes are voiced), the **paper sounds**, and optional **music under
the voice** (Motion has no built-in music: **Upload...** an MP3 or WAV you have the rights to). Every frame
is captured in the background browser and each scene is encoded to H.264 at 30 fps, then joined; the
narration, the sounds and any music are mixed last.

**The audio finish.** The music is **ducked** under the voice: a sidechain compressor keyed by the
narration pulls it about 10 dB down while the voice talks and lets it back up in the pauses and page
changes. Then the whole mix is brought to YouTube's loudness, **-14 LUFS integrated with the true peak at
-1.5 dBTP**, in two passes: the first measures it, the second applies one linear gain (a look-ahead limiter
first holds the few peaks that would cross the ceiling, so the gain stays linear instead of riding the
level). The export result reports the loudness it measured and set. A video with only paper sounds keeps
them at their own level. To leave the loudness alone, send `"loudness": false` with the export.

**Captions.** Every export writes `<the MP4's name>.srt` and `.vtt` next to it, for YouTube's subtitles
upload. They show the narration as written (LLM, not L-L-M, and no cue marks), timed by the voice: each word
appears when the voice says it (scenes without their voice yet use the estimate). Each caption is at most two
lines of 42 characters and stays up 1 to 7 seconds, broken at the end of a sentence first, then at a comma.
The current captions are also at `/api/motion/projects/<id>/captions.srt` and `captions.vtt`. Unchanged
scenes are reused from the last export, so after a small edit only that scene (and the one that tears or
turns from it) is rendered again. Measured on this laptop: 32 seconds of paper video at 1080p took 81 seconds
the first time, so a 30-minute film takes roughly 40 to 50 minutes (4K about twice that). Files are under
`motion-data\projects\<id>\renders\` and the Download button.

### Models and cost

**Claude** in the editor's top bar picks the engine (Claude Code or API key), the model (Claude Opus 5.5 by
default, Sonnet 5.5 or Haiku 5.5) and the effort. Each Claude turn ends with a line of tokens and their API
price; on Claude Code that's counted against your plan, not billed per token. ElevenLabs bills the voice by
characters; the Voice menu says how many characters a Generate will send.

### Where it is kept

Everything is in the `motion-data` folder next to `backend` (ignored by Git): one folder per video with
`project.json`, one HTML file per scene, the thumbnail (`thumbnail.html`), uploads, the timed source
(`source.json`), the voice clips, documents, the chat, undo snapshots and exports with their captions. Set
`MOTION_DATA_DIR` to keep it elsewhere.

---

## 7. Speech models: speed and accuracy

Only used for videos **without** captions.

| Model | Download | Time for 1 hour of audio on a laptop CPU | Accuracy |
|-------|----------|------------------------------------------|----------|
| `tiny` | ~75 MB | ~4 min (estimate) | Fair: fine for clear speech |
| `base` | ~145 MB | ~7 min (estimate) | Good |
| `small` | ~460 MB | **~14 min (measured)**, the default | Very good |
| `medium` | ~1.5 GB | ~40 min (estimate) | Best: accents, noisy audio |

Measured on this laptop: a 15-minute talk took **3 min 33 s** with `small`. A rough rule is **1 minute of
waiting for every 4 minutes of video**. Videos *with* captions take a few seconds whatever their
length.

Whisper uses all CPU cores, so the app transcribes **one video at a time**. Others wait in a queue.

---

## 8. Which sites work

yt-dlp supports more than 1,000 sites. The full list is at
https://github.com/yt-dlp/yt-dlp/blob/master/supportedsites.md.

| Tested and working | Supported by yt-dlp, not tested here | Does not work (on purpose) |
|--------------------|--------------------------------------|----------------------------|
| YouTube: captions, auto-captions and speech-to-text | X / Twitter, LinkedIn, Facebook, TikTok, Reddit, Dailymotion, news sites… (public videos) | Videos that need a login: **Vimeo** now needs one for downloads; Instagram often does |
| Direct `.mp4` links | Direct `.webm`, `.mov`, `.mp3`, `.m4a`, `.m3u8` links | Private and members-only videos |
| | | DRM services: Netflix, Prime Video, Disney+… |
| | | Live streams that have not ended yet |

When a video can't be fetched, the page says why, for example *"This site only lets signed-in users
download this video"*. The app does not use your browser's logins or cookies.

---

## 9. Keeping it working (updates)

**Update yt-dlp every few weeks.** YouTube and other sites change often, and yt-dlp releases fixes
quickly. If videos that used to work start failing, do this first:

```powershell
.\backend\.venv\Scripts\python.exe -m pip install --upgrade yt-dlp
```

Then restart the app.

Update everything:

```powershell
.\backend\.venv\Scripts\python.exe -m pip install --upgrade -r backend\requirements.txt
cd frontend; npm install; npm run build; cd ..
```

---

## 10. Troubleshooting

| Problem | Cause and fix |
|---------|---------------|
| **"Access is denied"** when running `python` or `node` | Defender blocks that old version. Install the current one (Python 3.13, Node 24) as in [section 3](#3-installation-once). Check the cause in *Event Viewer → Applications and Services → Microsoft → Windows → Windows Defender → Operational* (event 1116, `TvmWarn`). Do not try to unblock it. |
| **"running scripts is disabled on this system"** for `setup.ps1` / `run.ps1` | Your PowerShell blocks scripts. Use the "by hand" commands in steps 5 and 4. |
| **"Download failed … not enough bytes were received"** during setup | The network dropped a large download. Run the command again; it resumes. |
| The page shows **"The transcriber service is not running"** | Start it with `.\backend\run.ps1` and reload the page. |
| **http://127.0.0.1:8765 shows `{"detail":"Not Found"}`** | The page was not built. Run step 6 (`npm run build`), then restart the app. |
| **"error while attempting to bind on address … 8765"** | The app is already running in another terminal, or something else uses port 8765. Close the other one, or find it with `Get-NetTCPConnection -LocalPort 8765`. |
| **"FFmpeg was not found"** banner | Install it (step 2) and open a new terminal, or point to its `bin` folder: `$env:FFMPEG_LOCATION = "C:\path\to\ffmpeg\bin"`. |
| **"The site asked for a sign-in to prove this is not a bot"** | YouTube is limiting downloads from your network. Wait and try later, and update yt-dlp (section 9). On cloud servers this happens a lot. |
| **"This site only lets signed-in users download this video"** | For example Vimeo. Not supported. |
| **Speech model download fails** (first run of a model) | The network blocks or drops `huggingface.co`. Try again, or copy the folder `%USERPROFILE%\.cache\huggingface\hub\models--Systran--faster-whisper-small` from a colleague's machine to the same place on yours. |
| **"open() got an unexpected keyword argument 'metadata_errors'"** | An old copy of `transcriber.py`. Newer PyAV versions broke faster-whisper's own audio reader, and the current code decodes with FFmpeg instead. Update the project files. |
| Transcribing is **very slow** | Use `base` or `tiny` under *Options*. Close heavy apps. Long videos without captions take minutes (section 7). |
| Transcript has **wrong words** or the wrong language | Set the *Language* option, or pick `medium`. For videos with poor automatic captions, tick *Ignore the video's captions*. |
| Wrong caption language picked | Type the language code in *Options → Language*. |
| A video worked yesterday but not today | Update yt-dlp (section 9). |

The terminal running the server shows the full error for anything the page reports as
"Something went wrong".

---

## 11. For developers

### Run the page in development mode (live reload)

Terminal 1 (the server):

```powershell
.\backend\run.ps1
```

Terminal 2 (the page):

```powershell
cd frontend
npm run dev
```

Open http://localhost:5180. Calls to `/api` are passed to the server on port 8765.

### Tests and checks

```powershell
cd backend
.\.venv\Scripts\python.exe -m unittest -v          # captions, formats, errors; Motion's store, patches, undo, hashes, chat loop
.\.venv\Scripts\python.exe check_captions.py <url>  # can this machine read a video and its captions?
.\.venv\Scripts\python.exe check_audio.py <url> ... # can it download the audio?
cd ..\frontend
npx tsc -b                                          # type-check the page
```

### HTTP API

| Call | What it does |
|------|--------------|
| `GET /api/health` | `{ ok, ffmpeg, models, defaultModel }` |
| `POST /api/jobs` with body `{ "url": "...", "language": "en", "model": "small", "forceWhisper": false, "screenshots": true }` | Starts a transcription and returns `{ "id": "..." }`. Only `url` is required. |
| `GET /api/jobs/{id}` | `state` (`queued` / `running` / `done` / `error`), `stage`, `percent`, `message`, `transcript` when done, and `frames` (how the screenshots are going) |
| `GET /api/jobs/{id}/download?format=txt\|srt\|vtt&timestamps=true\|false` | The transcript as a file |
| `GET /api/jobs/{id}/frames` | The screenshots: `{ state, percent, message, items: [{ t, url, file, text }] }`. `state` is `off`, `waiting`, `running`, `done` or `none` (then `message` says why). Answered from disk after a restart. |
| `GET /api/jobs/{id}/frames/{file}` | One screenshot (JPEG) |
| `GET /api/jobs/{id}/frames.zip` | Every screenshot with `REFERENCES.md` and `references.json` |
| `/api/motion/...` | Motion: projects, scenes, undo, assets, chat (with long-polled live updates), export, brand kits. The list is at the top of `backend/motion/api.py`. |

Example:

```powershell
$job = Invoke-RestMethod -Method Post http://127.0.0.1:8765/api/jobs -ContentType "application/json" `
  -Body '{"url":"https://www.youtube.com/watch?v=jNQXAC9IVRw"}'
Invoke-RestMethod "http://127.0.0.1:8765/api/jobs/$($job.id)"
```

### Code map

| File | What is in it |
|------|---------------|
| `backend/transcriber.py` | `transcribe_url()` runs the whole flow: `fetch_info` → `fetch_captions` (picks the track, reads json3 / VTT / SRT, follows HLS caption playlists, removes rolling repeats) → `download_audio` → `decode_audio` (FFmpeg) → `run_whisper`. Also friendly error messages and the `to_txt` / `to_srt` / `to_vtt` formats. |
| `backend/screenshots.py` | The screenshots: `download_video` (720p video only), `scene_changes` and `pick_moments` (scene cuts plus the 15 s grid), `extract_frame`, `text_around` (what is said then), `take_screenshots` (all of that on a local file), the job folder, the zip and the 14-day clean-up. |
| `backend/app.py` | FastAPI: the job queue (one worker thread, jobs in memory, at most 50 kept), the endpoints, and serving `frontend/dist`. |
| `backend/test_transcriber.py` | Offline unit tests (the screenshots run on a test video FFmpeg makes). |
| `frontend/src/App.tsx` | The page: form, options, progress, transcript, search, copy and download, and the video prompt under a transcript. |
| `frontend/src/api.ts` | Calls to the server. |
| `frontend/src/format.ts` | Time format, paragraph grouping, "open the video at this time" links. |
| `frontend/src/PromptPanel.tsx` | The video prompt under a transcript: its details, the short forms table, copy and download. |
| `frontend/src/Screenshots.tsx` | The Screenshots section: progress, the grid, one screenshot large, the zip. |
| `frontend/src/videoPrompt.ts` | The prompt itself: the standing instructions, filled in with the video's details, its short forms and the transcript. |
| `frontend/src/shortForms.ts` | Finds short forms (Latin letters, and English letters written in Hindi) and suggests how each is said. |
| `frontend/src/styles.css` | Light and dark theme (follows the system setting), phone layout. |
| `backend/motion/store.py` | Motion's projects on disk: scenes, props, storyboard, patches, undo snapshots, assets, brand kits (and the two AlgoInsight kits), the bundle the player draws, the project state Claude sees, and the checks run on every scene Claude writes. |
| `backend/motion/prompts.py` | Claude's system prompt (how to make a video, the scene file contract, the rules) and its tools. |
| `backend/motion/agent.py` | The chat loop on the API: streams Claude's reply into the chat, runs its tools, the style question, error handling, cost. |
| `backend/motion/claude_code.py` | The same turn on Claude Code (the Claude Agent SDK): Motion's tools served in-process, web search for facts, your login. |
| `backend/motion/voice.py` | Narration: the pronunciation table, cue positions, ElevenLabs with-timestamps (Pooja, Eleven v4), cue times, the narration track. |
| `frontend/src/motion/player/paper.ts` | The paper look: the frame, torn labels, components, tear and turn, the end screen, the fx entrances and their sounds. |
| `backend/motion/render.py` | Headless Edge/Chrome through Playwright: one frame with a layout report (for Claude's checks and posters), and the MP4 export (per-scene H.264, content-hash cache, concat, soundtrack). |
| `backend/motion/brand.py`, `hub.py`, `jobs.py`, `api.py` | Brand kit from a website; the chat log and live updates; the export queue; the HTTP routes. |
| `backend/test_motion.py` | Offline Motion tests (no API key, browser or network). |
| `frontend/motion-player.html`, `frontend/src/motion/player/` | The player: builds each scene in its own shadow root with a paused GSAP timeline and shows any moment on request. The preview and the export both use it, so the MP4 matches the preview. |
| `frontend/src/motion/` | The Motion pages: library, editor, chat, preview, properties, brand kit dialog. |

### Settings

| Environment variable | Default | What it does |
|----------------------|---------|--------------|
| `WHISPER_MODEL` | `small` | Default speech model (`tiny`, `base`, `small`, `medium`) |
| `FFMPEG_LOCATION` | found automatically | Folder that contains `ffmpeg.exe` |
| `ANTHROPIC_API_KEY` | none | Claude's API key, for the API-key engine (or put it in `backend\.env`) |
| `ELEVENLABS_API_KEY` | none | The ElevenLabs key for Generate voice (or put it in `backend\.env`) |
| `MOTION_ENGINE` | `claude-code` when installed | `claude-code` (your Claude login) or `api` (an API key) |
| `MOTION_VOICE_ID` | `fydPJq00SigRIaPxWgiS` (Pooja) | The ElevenLabs voice for new videos |
| `MOTION_MODEL`, `MOTION_EFFORT` | `claude-opus-5-5`, `high` | Motion's default model and effort (each video can change them) |
| `TRANSCRIBER_DATA_DIR` | `transcriber-data` next to `backend` | Where the screenshots are kept (`frames\<job id>\`) |
| `MOTION_DATA_DIR` | `motion-data` next to `backend` | Where Motion keeps its videos and brand kits |
| `MOTION_BROWSER_CHANNEL` | `msedge`, then `chrome` | Which installed browser renders Motion's frames |
| `MOTION_RENDER_PAGES` | `3` | Browser pages that render scenes at the same time during an export |

The server listens on `127.0.0.1` only, so other computers on the network can't reach it.

---

## 12. Cost, privacy and fair use

**Cost:** free, now and later. Whisper (model and code) is open source under the MIT licence.
faster-whisper is MIT, yt-dlp is public domain, FFmpeg is GPL/LGPL, and FastAPI and React are MIT.
There is no subscription, key or per-minute charge. OpenAI's *paid* Whisper cloud API is a
different product and is **not** used. The only costs are your laptop's CPU time and ~0.5–1.5 GB of
disk space for a model. **Motion** is the exception: Claude turns count against your Claude plan (on
Claude Code) or are billed to your Anthropic API account (with an API key), and Generate voice is billed by
ElevenLabs per character. The chat shows each turn's tokens; the Voice menu shows the characters.

**Privacy:** the audio and transcripts stay on your computer. The only outside connections are to the
video site and, once per model, to Hugging Face for the download. Transcripts disappear when the
server stops. **Motion** sends what you write in its chat, the files you attach there, the project's
scenes and the frames Claude checks to Anthropic (through Claude Code or the API), and each scene's
narration to ElevenLabs when you press Generate voice; the brand kit reader fetches the website you give
it, Claude may search the web for facts, and fonts come from Google Fonts once. Motion's videos stay in
`motion-data` on your computer.

**AI:** for transcripts, only Whisper, a speech-to-text model, and only for videos without captions. It
runs on your machine, and nothing is summarised or rewritten. Motion uses Claude, a language model, to
write the videos.

**Fair use:** many sites' terms limit downloading. Use this for videos you are allowed to use, such as
your own, your company's, or public talks for personal notes. Respect copyright, and do not publish
other people's transcripts.

---

## 13. Hosting it online

It is built to run locally. Serverless hosts like **Netlify** and **Vercel** can host the page but
**not** the full app:

- the Whisper model, FFmpeg and the libraries are larger than their function size limits;
- long transcriptions take longer than their function time limits;
- jobs are kept in the server's memory, which serverless functions don't keep between requests;
- YouTube often blocks downloads from cloud servers ("confirm you're not a bot").

To share it with a team, run the whole app unchanged on one small server, for example the company's
AWS. Put it behind a sign-in with usage limits, get approval first, and test YouTube access from that
server before you rely on it.

---

## 14. Uninstalling

1. Stop the app (**Ctrl + C**).
2. Delete the `video-transcriber` folder (Motion's videos are in its `motion-data` folder: copy them out first
   if you want to keep them).
3. Delete the downloaded speech models: `%USERPROFILE%\.cache\huggingface\hub\models--Systran--faster-whisper-*`.
4. If you don't need them for anything else, uninstall Python 3.13, FFmpeg and Node.js from
   **Settings → Apps**, or with `winget uninstall Python.Python.3.13`,
   `winget uninstall Gyan.FFmpeg.Essentials`, `winget uninstall OpenJS.NodeJS.LTS`.
