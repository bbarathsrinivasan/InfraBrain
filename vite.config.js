import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      // REST calls (/api/chat, /api/kg, /api/metrics, etc.) proxied to backend
      "/api": {
        target:       "http://localhost:8002",
        changeOrigin: true,
      },
    },
  },
});
