# Video Transcriber

Paste a video link and get a transcript with timestamps. You can copy it, search it, or download it as
`.txt`, `.srt` or `.vtt`.

The app runs **on your own computer** at http://127.0.0.1:8765. Nothing is sent to an outside AI
service, and there is no account, API key or cost per video.

---

## Contents

1. [How it works](#1-how-it-works)
2. [What you need](#2-what-you-need)
3. [Installation (once)](#3-installation-once)
4. [Starting the app](#4-starting-the-app)
5. [Using the app](#5-using-the-app)
6. [Speech models: speed and accuracy](#6-speech-models-speed-and-accuracy)
7. [Which sites work](#7-which-sites-work)
8. [Keeping it working (updates)](#8-keeping-it-working-updates)
9. [Troubleshooting](#9-troubleshooting)
10. [For developers](#10-for-developers)
11. [Cost, privacy and fair use](#11-cost-privacy-and-fair-use)
12. [Hosting it online](#12-hosting-it-online)
13. [Uninstalling](#13-uninstalling)

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

**To start with a different default speech model** (see [section 6](#6-speech-models-speed-and-accuracy)):

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
| **Speech model** | Only used for videos without captions. Faster or more accurate, see [section 6](#6-speech-models-speed-and-accuracy). |
| **Ignore the video's captions** | Always use speech-to-text, for example when the automatic captions are poor. |

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

---

## 6. Speech models: speed and accuracy

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

## 7. Which sites work

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

## 8. Keeping it working (updates)

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

## 9. Troubleshooting

| Problem | Cause and fix |
|---------|---------------|
| **"Access is denied"** when running `python` or `node` | Defender blocks that old version. Install the current one (Python 3.13, Node 24) as in [section 3](#3-installation-once). Check the cause in *Event Viewer → Applications and Services → Microsoft → Windows → Windows Defender → Operational* (event 1116, `TvmWarn`). Do not try to unblock it. |
| **"running scripts is disabled on this system"** for `setup.ps1` / `run.ps1` | Your PowerShell blocks scripts. Use the "by hand" commands in steps 5 and 4. |
| **"Download failed … not enough bytes were received"** during setup | The network dropped a large download. Run the command again; it resumes. |
| The page shows **"The transcriber service is not running"** | Start it with `.\backend\run.ps1` and reload the page. |
| **http://127.0.0.1:8765 shows `{"detail":"Not Found"}`** | The page was not built. Run step 6 (`npm run build`), then restart the app. |
| **"error while attempting to bind on address … 8765"** | The app is already running in another terminal, or something else uses port 8765. Close the other one, or find it with `Get-NetTCPConnection -LocalPort 8765`. |
| **"FFmpeg was not found"** banner | Install it (step 2) and open a new terminal, or point to its `bin` folder: `$env:FFMPEG_LOCATION = "C:\path\to\ffmpeg\bin"`. |
| **"The site asked for a sign-in to prove this is not a bot"** | YouTube is limiting downloads from your network. Wait and try later, and update yt-dlp (section 8). On cloud servers this happens a lot. |
| **"This site only lets signed-in users download this video"** | For example Vimeo. Not supported. |
| **Speech model download fails** (first run of a model) | The network blocks or drops `huggingface.co`. Try again, or copy the folder `%USERPROFILE%\.cache\huggingface\hub\models--Systran--faster-whisper-small` from a colleague's machine to the same place on yours. |
| **"open() got an unexpected keyword argument 'metadata_errors'"** | An old copy of `transcriber.py`. Newer PyAV versions broke faster-whisper's own audio reader, and the current code decodes with FFmpeg instead. Update the project files. |
| Transcribing is **very slow** | Use `base` or `tiny` under *Options*. Close heavy apps. Long videos without captions take minutes (section 6). |
| Transcript has **wrong words** or the wrong language | Set the *Language* option, or pick `medium`. For videos with poor automatic captions, tick *Ignore the video's captions*. |
| Wrong caption language picked | Type the language code in *Options → Language*. |
| A video worked yesterday but not today | Update yt-dlp (section 8). |

The terminal running the server shows the full error for anything the page reports as
"Something went wrong".

---

## 10. For developers

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
.\.venv\Scripts\python.exe -m unittest -v          # caption parsing, track choice, formats, errors
.\.venv\Scripts\python.exe check_captions.py <url>  # can this machine read a video and its captions?
.\.venv\Scripts\python.exe check_audio.py <url> ... # can it download the audio?
cd ..\frontend
npx tsc -b                                          # type-check the page
```

### HTTP API

| Call | What it does |
|------|--------------|
| `GET /api/health` | `{ ok, ffmpeg, models, defaultModel }` |
| `POST /api/jobs` with body `{ "url": "...", "language": "en", "model": "small", "forceWhisper": false }` | Starts a transcription and returns `{ "id": "..." }`. Only `url` is required. |
| `GET /api/jobs/{id}` | `state` (`queued` / `running` / `done` / `error`), `stage`, `percent`, `message`, and `transcript` when done |
| `GET /api/jobs/{id}/download?format=txt\|srt\|vtt&timestamps=true\|false` | The transcript as a file |

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
| `backend/app.py` | FastAPI: the job queue (one worker thread, jobs in memory, at most 50 kept), the endpoints, and serving `frontend/dist`. |
| `backend/test_transcriber.py` | Offline unit tests. |
| `frontend/src/App.tsx` | The page: form, options, progress, transcript, search, copy and download, and the video prompt under a transcript. |
| `frontend/src/api.ts` | Calls to the server. |
| `frontend/src/format.ts` | Time format, paragraph grouping, "open the video at this time" links. |
| `frontend/src/PromptPanel.tsx` | The video prompt under a transcript: its details, the short forms table, copy and download. |
| `frontend/src/videoPrompt.ts` | The prompt itself: the standing instructions, filled in with the video's details, its short forms and the transcript. |
| `frontend/src/shortForms.ts` | Finds short forms (Latin letters, and English letters written in Hindi) and suggests how each is said. |
| `frontend/src/styles.css` | Light and dark theme (follows the system setting), phone layout. |

### Settings

| Environment variable | Default | What it does |
|----------------------|---------|--------------|
| `WHISPER_MODEL` | `small` | Default speech model (`tiny`, `base`, `small`, `medium`) |
| `FFMPEG_LOCATION` | found automatically | Folder that contains `ffmpeg.exe` |

The server listens on `127.0.0.1` only, so other computers on the network can't reach it.

---

## 11. Cost, privacy and fair use

**Cost:** free, now and later. Whisper (model and code) is open source under the MIT licence.
faster-whisper is MIT, yt-dlp is public domain, FFmpeg is GPL/LGPL, and FastAPI and React are MIT.
There is no subscription, key or per-minute charge. OpenAI's *paid* Whisper cloud API is a
different product and is **not** used. The only costs are your laptop's CPU time and ~0.5–1.5 GB of
disk space for a model.

**Privacy:** the audio and transcripts stay on your computer. The only outside connections are to the
video site and, once per model, to Hugging Face for the download. Transcripts disappear when the
server stops.

**AI:** only Whisper, a speech-to-text model, and only for videos without captions. It runs on your
machine. There is no chatbot or language model, and nothing is summarised or rewritten.

**Fair use:** many sites' terms limit downloading. Use this for videos you are allowed to use, such as
your own, your company's, or public talks for personal notes. Respect copyright, and do not publish
other people's transcripts.

---

## 12. Hosting it online

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

## 13. Uninstalling

1. Stop the app (**Ctrl + C**).
2. Delete the `video-transcriber` folder.
3. Delete the downloaded speech models: `%USERPROFILE%\.cache\huggingface\hub\models--Systran--faster-whisper-*`.
4. If you don't need them for anything else, uninstall Python 3.13, FFmpeg and Node.js from
   **Settings → Apps**, or with `winget uninstall Python.Python.3.13`,
   `winget uninstall Gyan.FFmpeg.Essentials`, `winget uninstall OpenJS.NodeJS.LTS`.
