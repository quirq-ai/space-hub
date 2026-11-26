// The hub's app: a desktop-style interface for every space and project on the hub.
import "blobatar/motion.css";
import "blobatar/gaze.css";
import "./content.css";
import "./shell.css";
import "./app.css";
import "./feed.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import { watchFetch } from "./lib/signed-out";

// Every answer passes here first: one the hub sends when it signs this viewer out takes the app to sign in.
watchFetch();

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);
