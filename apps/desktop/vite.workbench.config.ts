import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist-workbench", rollupOptions: { input: "workbench.html" }, license: { fileName: "licenses.md" } },
  server: { host: "127.0.0.1", port: 1423, strictPort: true },
});
