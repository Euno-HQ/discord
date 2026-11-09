// This file gets manually copied into build/ as part of deployment. Doing it
// this way avoids a ton of weird compat hacks with react-router v7.

import "dotenv/config";

import express from "express";

// This only exists after a production build, when this file is copied into Docker
import { app as rrApp } from "./build/server/index.js";

const app = express();

console.log("Starting production webserver");

app.use(
  "/assets",
  express.static("build/client/assets", { immutable: true, maxAge: "1y" }),
);
app.use(express.static("build/client", { maxAge: "1h" }));
app.use(rrApp);

/** ERROR TRACKING
  Must go after route handlers
*/
const errorHandler = (error) => {
  if (error instanceof Error) {
    console.log("[UNCAUGHT ERROR]", error.message, error.stack);
  } else if (typeof error === "string") {
    console.log("[UNCAUGHT ERROR]", error);
  }
};

process.on("uncaughtException", errorHandler);
process.on("unhandledRejection", errorHandler);

const PORT = process.env.PORT ?? "3000";
app.listen(PORT, "0.0.0.0", async () => {
  console.log(
    "INI",
    "Now listening on port",
    PORT,
    "commit",
    process.env.GIT_SHA ?? "unknown",
  );
});
