import React from "react";
import { createRoot } from "react-dom/client";
import { setupMonaco } from "./lib/monaco-setup";
import { App } from "./App";
import "./styles.css";

setupMonaco();

const container = document.getElementById("root");
if (!container) {
  throw new Error("#root not found in index.html");
}
createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
