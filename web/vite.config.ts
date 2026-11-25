import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwind from "@tailwindcss/vite";

const API = process.env.DEVFORGE_API ?? "http://localhost:4000";

export default defineConfig({
  plugins: [react(), tailwind()],
  server: {
    port: 5173,
    proxy: { "/api": { target: API, changeOrigin: false, ws: true } },
  },
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("three") || id.includes("@react-three")) return "three";
          if (id.includes("@xyflow")) return "flow";
          if (id.includes("recharts") || id.includes("d3-")) return "charts";
        },
      },
    },
  },
  test: { environment: "jsdom" },
} as any);
