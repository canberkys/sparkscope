import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: mode === "demo" ? "./" : "/",
  build: { outDir: mode === "demo" ? "dist-demo" : "dist" },
  server: {
    port: 5178,
    strictPort: true,
    proxy: { "/api": { target: "http://127.0.0.1:8010", ws: true } },
  },
}));
