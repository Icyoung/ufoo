import React from "react";
import ReactDOM from "react-dom/client";
import "./styles.css";
import { App } from "./App";

if (window.matchMedia("(pointer: coarse)").matches) {
  const viewport = document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (viewport) viewport.content += ", maximum-scale=1, user-scalable=no";
  document.addEventListener("gesturestart", event => event.preventDefault(), { passive: false });
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
