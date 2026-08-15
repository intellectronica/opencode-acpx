import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const root = process.cwd();
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
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
if (manifest.exports?.["./server"] === undefined) {
  throw new Error("package.json must export ./server");
}
if (manifest.exports?.["./tui"] === undefined) {
  throw new Error("package.json must export ./tui");
}

process.stdout.write("Package entrypoint verification passed.\n");
