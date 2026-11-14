"""
Motion: short animated videos written as code by Claude.

A video is a project folder with an ordered list of scenes. Each scene is one small HTML file (markup, a
<style> block and a <script> that animates the markup on a GSAP timeline), so a change to one word, colour
or timing touches only that scene. The page plays the scenes live in the browser, and the export captures
every frame in headless Edge or Chrome and encodes it with FFmpeg.

    store.py    projects, scenes, assets, brand kits, chat history and undo snapshots on disk
    brand.py    turns a website into a draft brand kit (colours, fonts, logo)
    render.py   headless-browser frames and the MP4 export (per-scene encode, cache, concat, audio)
    prompts.py  the system prompt and the tools Claude gets
    agent.py    the chat loop with Claude: streaming, tools, style questions, cost
    api.py      the HTTP routes under /api/motion
"""
