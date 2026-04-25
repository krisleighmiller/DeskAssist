import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

// SECURITY (M10): in production builds the CSP `connect-src` must NOT
// include `http://localhost:*` and friends — those entries exist solely
// for the Vite dev server's HMR/WebSocket connection and have no
// business in packaged builds where all content is served via `file://`.
// This plugin rewrites the `<meta http-equiv="Content-Security-Policy">`
// tag during the `build` step, stripping the dev-only origins.
function stripDevCsp(): Plugin {
  return {
    name: "strip-dev-csp",
    apply: "build",
    transformIndexHtml(html: string) {
      // Remove the dev-only connect-src origins. The production CSP
      // keeps only `'self'` for connect-src so XHR/fetch/WebSocket
      // from the renderer can only reach the Electron process itself.
      return html.replace(
        /connect-src\s+'self'\s+[^;"]+/,
        "connect-src 'self'"
      );
    },
  };
}

// Vite is configured to build the renderer from `renderer/` into
// `renderer/dist/`. `base: "./"` is required so the built index.html uses
// relative asset paths and Electron can load it via file://.
export default defineConfig({
  root: path.resolve(import.meta.dirname, "renderer"),
  base: "./",
  plugins: [react(), stripDevCsp()],
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
