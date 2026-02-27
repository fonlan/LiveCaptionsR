import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./i18n";

const markStartupReady = () => {
  document.body.classList.add("app-booted");
  const splash = document.getElementById("boot-splash");
  if (!splash) return;

  splash.addEventListener(
    "transitionend",
    () => {
      splash.remove();
    },
    { once: true },
  );

  window.setTimeout(() => {
    splash.remove();
  }, 320);
};

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

window.requestAnimationFrame(() => {
  window.requestAnimationFrame(markStartupReady);
});
