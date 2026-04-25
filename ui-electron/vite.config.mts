import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// Vite is configured to build the renderer from `renderer/` into
// `renderer/dist/`. `base: "./"` is required so the built index.html uses
// relative asset paths and Electron can load it via file://.
export default defineConfig({
  root: path.resolve(import.meta.dirname, "renderer"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.resolve(import.meta.dirname, "renderer/dist"),
    emptyOutDir: true,
    sourcemap: true,
    target: "chrome120",
    // Monaco ships large language workers by design. The default 500 kB
    // warning is tuned for web apps, but DeskAssist is an Electron app
    // where these local worker chunks are expected and not network-loaded.
    chunkSizeWarningLimit: 6500,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes("node_modules")) return;
          if (id.includes("monaco-editor") || id.includes("@monaco-editor")) {
            return "monaco";
          }
          if (id.includes("react") || id.includes("react-dom")) {
            return "react";
          }
        },
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
  worker: {
    format: "es",
  },
});
