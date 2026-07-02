import { defineConfig } from "vite";
import { resolve } from "path";

export default defineConfig({
  // Must match your GitHub repo name for Pages deployment
  base: "/exodus-craft-editor/",
  build: {
    outDir: "dist",
    sourcemap: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
      },
    },
  },
  server: {
    port: 3000,
    open: true,
  },
});
