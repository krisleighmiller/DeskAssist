import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Vite is configured to build the renderer from `renderer/` into
// `renderer/dist/`. `base: "./"` is required so the built index.html uses
// relative asset paths and Electron can load it via file://.
export default defineConfig({
  root: path.resolve(__dirname, "renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.resolve(__dirname, "renderer/dist"),
    emptyOutDir: true,
    sourcemap: true,
    target: "chrome120",
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  worker: {
    format: "es",
  },
});
