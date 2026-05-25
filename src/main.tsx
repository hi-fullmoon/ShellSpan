import React from "react";
import ReactDOM from "react-dom/client";
import { ChakraProvider } from "./components/ChakraProvider";
import App from "./App";
import SettingsWindow from "./SettingsWindow";
import "ag-grid-community/styles/ag-grid.css";
import "ag-grid-community/styles/ag-theme-quartz.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/index.css";

window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
});

const isSettingsWindow = window.location.hash === "#settings";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ChakraProvider>
      {isSettingsWindow ? <SettingsWindow /> : <App />}
    </ChakraProvider>
  </React.StrictMode>,
);
