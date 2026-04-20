// Configure Monaco for an Electron + Vite + file:// renderer.
//
// Two things matter:
// 1. `@monaco-editor/react` defaults to loading Monaco from a CDN (jsDelivr).
//    Inside packaged Electron there is no guaranteed network, so we hand it
//    the locally-bundled `monaco-editor` module instead.
// 2. Monaco language services run in web workers. Vite's `?worker` import
//    bundles each worker script and gives us a constructor we can hand to
//    `self.MonacoEnvironment`.
import * as monaco from "monaco-editor";
import { loader } from "@monaco-editor/react";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import JsonWorker from "monaco-editor/esm/vs/language/json/json.worker?worker";
import CssWorker from "monaco-editor/esm/vs/language/css/css.worker?worker";
import HtmlWorker from "monaco-editor/esm/vs/language/html/html.worker?worker";
import TsWorker from "monaco-editor/esm/vs/language/typescript/ts.worker?worker";

let configured = false;

export function setupMonaco(): void {
  if (configured) {
    return;
  }
  configured = true;

  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker(_workerId, label) {
      switch (label) {
        case "json":
          return new JsonWorker();
        case "css":
        case "scss":
        case "less":
          return new CssWorker();
        case "html":
        case "handlebars":
        case "razor":
          return new HtmlWorker();
        case "typescript":
        case "javascript":
          return new TsWorker();
        default:
          return new EditorWorker();
      }
    },
  };

  loader.config({ monaco });
}
