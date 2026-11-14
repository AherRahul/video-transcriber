import { resolve } from "node:path";

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The page talks to the Python backend on 127.0.0.1:8765.
// Two pages are built: the app (index.html) and Motion's player (motion-player.html), which the editor
// shows in a sandboxed iframe and the export drives in a headless browser.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        player: resolve(__dirname, "motion-player.html"),
      },
    },
  },
  server: {
    port: 5180,
    proxy: { "/api": "http://127.0.0.1:8765" },
    // the sandboxed player iframe has an opaque origin, so its scripts need CORS in development too
    cors: { origin: "*" },
  },
});
