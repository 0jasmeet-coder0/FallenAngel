import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import SmoothScroll from "./components/SmoothScroll";
import "./styles.css";

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <SmoothScroll />
    <App />
  </React.StrictMode>
);