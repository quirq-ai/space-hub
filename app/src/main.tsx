// The hub's app: open-chat's interface for every space and project on the hub.
import "blobatar/motion.css";
import "blobatar/gaze.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { HubApp } from "./hub-app";

createRoot(document.getElementById("root")!).render(<StrictMode><HubApp /></StrictMode>);
