import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

import { reactRouter } from "@react-router/dev/vite";

export default defineConfig(({ isSsrBuild }) => ({
  build: {
    target: isSsrBuild ? "esnext" : undefined,
    sourcemap: true,
    rollupOptions: isSsrBuild ? { input: "./app/server.ts" } : undefined,
  },
  server: { port: 3000, origin: "localhost:3000" },
  // Force a single React instance in the SSR dev bundle. Without this, Vite's
  // dev resolver can pull in duplicate copies of React across the SSR graph,
  // which trips React's DEV-only child-key validation with a `_store` proxy
  // invariant error (#394: GET /app/admin/jobs 500 in dev only).
  resolve: { dedupe: ["react", "react-dom"] },
  plugins: [tailwindcss(), reactRouter()],
}));
