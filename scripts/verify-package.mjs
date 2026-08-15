import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const constantsSource = await readFile(join(root, "src/constants.ts"), "utf8");

if (manifest.name !== "opencode-acpx") {
  throw new Error(`Unexpected package name: ${String(manifest.name)}`);
}
if (manifest.version !== "0.0.1") {
  throw new Error(`Unexpected release version: ${String(manifest.version)}`);
}
if (manifest.private === true || manifest.license !== "MIT") {
  throw new Error("The release package must be public and MIT licensed");
}
if (manifest.publishConfig?.access !== "public") {
  throw new Error("publishConfig.access must be public");
}
if (!constantsSource.includes(`PACKAGE_VERSION = "${manifest.version}"`)) {
  throw new Error("Runtime package version must match package.json");
}
if (manifest.dependencies?.acpx !== undefined) {
  throw new Error("Patched Acpx must be bundled, not installed by consumers");
}
const rootModule = await import(pathToFileURL(join(root, "dist/provider.js")));
const serverModule = await import(pathToFileURL(join(root, "dist/server.js")));
const tuiModule = await import(pathToFileURL(join(root, "dist/tui.js")));

const factories = Object.keys(rootModule).filter((name) =>
  name.startsWith("create"),
);
if (factories.length !== 1) {
  throw new Error(
    `Provider root must expose exactly one create* factory; found ${factories.join(", ") || "none"}`,
  );
}
const factory = rootModule[factories[0]];
const provider = factory({
  name: "acp.fixture",
  pluginInstanceId: "package-verification",
  serverId: "fixture",
});
if (
  provider instanceof Promise ||
  typeof provider?.languageModel !== "function"
) {
  throw new Error("The provider factory must return a synchronous SDK object");
}
const model = provider.languageModel("default");
if (model instanceof Promise || model?.specificationVersion !== "v3") {
  throw new Error("languageModel() must return a synchronous LanguageModelV3");
}

if (
  typeof serverModule.default !== "object" ||
  serverModule.default?.id !== "opencode-acpx" ||
  typeof serverModule.default?.server !== "function"
) {
  throw new Error("The ./server export must default-export { id, server }");
}
if (
  typeof tuiModule.default !== "object" ||
  tuiModule.default?.id !== "opencode-acpx" ||
  typeof tuiModule.default?.tui !== "function"
) {
  throw new Error("The ./tui export must default-export { id, tui }");
}

await access(join(root, "dist/worker.js"));
await access(join(root, "LICENSE"));
if (manifest.exports?.["./server"] === undefined) {
  throw new Error("package.json must export ./server");
}
if (manifest.exports?.["./tui"] === undefined) {
  throw new Error("package.json must export ./tui");
}

process.stdout.write("Package entrypoint verification passed.\n");
