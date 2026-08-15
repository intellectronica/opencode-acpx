import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    provider: "src/provider.ts",
    server: "src/server.ts",
    tui: "src/tui.ts",
    worker: "src/worker/main.ts",
  },
  format: ["esm"],
  target: "node22",
  platform: "node",
  dts: true,
  sourcemap: true,
  clean: true,
  splitting: true,
  treeshake: true,
  external: ["@opencode-ai/plugin"],
  noExternal: ["acpx"],
});
