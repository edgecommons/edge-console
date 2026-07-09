import React from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
// Brand tokens first: index.scss maps them onto Carbon's --cds-* variables.
import "./styles/edgecommons-tokens.css";
import "./index.scss";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
