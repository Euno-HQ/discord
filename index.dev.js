import "dotenv/config";

import express from "express";
import * as vite from "vite";

const app = express();

/**
Route handlers and static hosting
*/

console.log("Starting development server");
const viteDevServer = await vite.createServer({
  server: { middlewareMode: true },
});

// Track the current server module to enable hot reloading
let currentServerApp = null;
let installGracefulShutdown = null;

// Function to load/reload the server module
async function loadServerModule() {
  try {
    const source = await viteDevServer.ssrLoadModule("./app/server.ts");
    currentServerApp = source.app;
    installGracefulShutdown ??= source.installGracefulShutdown;
    console.log("Server module (re)loaded");
  } catch (error) {
    if (error instanceof Error) {
      viteDevServer.ssrFixStacktrace(error);
    }
    console.error("Error loading server module:", error);
  }
}

// Initial load
const initialLoad = loadServerModule();

// Add Vite middleware first
app.use(viteDevServer.middlewares);

// Proxy all requests to the current server app
// This allows us to hot-swap the server without restarting Express
app.use((req, res, next) => {
  if (currentServerApp) {
    currentServerApp(req, res, next);
  } else {
    res.status(503).send("Server module not loaded");
  }
});

// Listen for file changes and reload server module
viteDevServer.watcher.on("change", async (file) => {
  // Only reload for server-side files (not client components)
  if (
    file.includes("/app/server.ts") ||
    file.includes("/app/discord/") ||
    file.includes("/app/commands/") ||
    file.includes("/app/helpers/") ||
    file.includes("/app/models/")
  ) {
    console.log(`Server file changed: ${file}, reloading...`);
    // Invalidate Vite's module cache
    const modules = viteDevServer.moduleGraph.getModulesByFile(file);
    if (modules) {
      for (const mod of modules) {
        viteDevServer.moduleGraph.invalidateModule(mod);
      }
    }
    // Reload the server module
    await loadServerModule();
  }
});

// Fix stack traces for unhandled errors using Vite's source map support
process.on("uncaughtException", (error) => {
  if (error instanceof Error) {
    viteDevServer.ssrFixStacktrace(error);
  }
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  if (reason instanceof Error) {
    viteDevServer.ssrFixStacktrace(reason);
  }
  console.error("Unhandled Rejection:", reason);
  process.exit(1);
});

const PORT = process.env.PORT ?? "3000";
const server = app.listen(PORT, async () => {
  console.log("INI", "Now listening on port", PORT);
});
// Installed once from the first load (it guards itself too); the shutdown
// sequence works off globals, so HMR reloads don't need to reinstall it.
// Vite (via a plugin-created server) registers its own SIGTERM listener that
// closes Vite and calls process.exit(143) right away, cutting our ordered
// teardown off mid-dispose. Drop it: the process exits at the end of ours.
void initialLoad.then(() => {
  process.removeAllListeners("SIGTERM");
  installGracefulShutdown?.(server);
});
