import { readFile } from "node:fs/promises";
import { URL } from "node:url";

const manifest = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const expectedTag = `v${manifest.version}`;
const actualTag =
  process.argv.slice(2).find((argument) => argument !== "--") ??
  process.env.GITHUB_REF_NAME;

if (manifest.name !== "opencode-acpx") {
  throw new Error(`Unexpected package name: ${String(manifest.name)}`);
}
if (manifest.version !== "0.0.1") {
  throw new Error(`Unexpected release version: ${String(manifest.version)}`);
}
if (manifest.private === true || manifest.license !== "MIT") {
  throw new Error("Release manifest must be public and MIT licensed");
}
if (manifest.publishConfig?.access !== "public") {
  throw new Error("Release manifest must publish publicly");
}
if (actualTag !== undefined && actualTag !== expectedTag) {
  throw new Error(`Tag ${actualTag} does not match ${expectedTag}`);
}

process.stdout.write(
  `Release metadata verified for ${manifest.name}@${manifest.version}.\n`,
);
