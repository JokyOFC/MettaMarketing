import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/raleway/latin-200.css";
import "@fontsource/raleway/latin-300.css";
import "@fontsource/manrope/latin-400.css";
import "@fontsource/manrope/latin-500.css";
import "@fontsource/cormorant-garamond/latin-400-italic.css";
import "./style.css";

import App from "./App.jsx";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
