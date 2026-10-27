// The hub's app: a desktop-style interface for every space and project on the hub.
import "blobatar/motion.css";
import "blobatar/gaze.css";
import "./content.css";
import "./app.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
