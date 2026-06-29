import React from "react";
import ReactDOM from "react-dom/client";
import { ChakraProvider } from "./components/ChakraProvider";
import { ErrorBoundary } from "./components/ErrorBoundary";
import App from "./App";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/index.css";

// Only suppress native context menus inside terminal surfaces so text inputs,
// DevTools, and other UI keep their default right-click behavior.
window.addEventListener("contextmenu", (event) => {
  const target = event.target as Element | null;
  if (target && (target.closest?.(".xterm") || target.closest?.(".terminal-shell"))) {
    event.preventDefault();
  }
});

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ChakraProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </ChakraProvider>
  </React.StrictMode>,
);
