import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/jetbrains-mono/400-italic.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/700-italic.css";
import "@fontsource/jetbrains-mono/700.css";

import { App } from "./app.js";
import "./styles.css";

const root = document.querySelector("#root");
if (root == null) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
