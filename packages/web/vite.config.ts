import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The Reef daemon (`reef serve`) runs on 4300 by default. In dev, proxy the API
// so the browser talks to same-origin `/sessions` and SSE just works.
const API = process.env.REEF_SERVER ?? "http://127.0.0.1:4300";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 4310,
    proxy: {
      "/sessions": { target: API, changeOrigin: true },
      "/health": { target: API, changeOrigin: true },
    },
  },
});
