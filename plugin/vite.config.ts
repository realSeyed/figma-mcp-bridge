import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { viteSingleFile } from "vite-plugin-singlefile";
import { pluginBuildId } from "./build-identity";

export default defineConfig({
  plugins: [react(), viteSingleFile()],
  define: { __PLUGIN_BUILD__: JSON.stringify(pluginBuildId()) },
  root: "./src/ui",
  build: {
    target: "es2015",
    cssCodeSplit: false,
    outDir: "../../dist",
    rollupOptions: {
      output: {
        inlineDynamicImports: true,
      },
    },
    emptyOutDir: true,
  },
});
