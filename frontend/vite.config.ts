import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The page talks to the Python backend on 127.0.0.1:8765.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: { "/api": "http://127.0.0.1:8765" },
  },
});
