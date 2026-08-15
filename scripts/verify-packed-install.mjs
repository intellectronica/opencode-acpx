import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = process.cwd();
const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const artifactDirectory = join(root, ".artifacts");
const tarball = join(
  artifactDirectory,
  `${manifest.name}-${manifest.version}.tgz`,
);
const sandbox = await mkdtemp(join(tmpdir(), "opencode-acpx-pack-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
  } catch (error) {
    const stdout = error?.stdout?.toString().trim();
    const stderr = error?.stderr?.toString().trim();
    throw new Error(
      [`${command} ${args.join(" ")} failed`, stdout, stderr]
        .filter(Boolean)
        .join("\n"),
      { cause: error },
    );
  }
}

await mkdir(artifactDirectory, { recursive: true });
run(pnpm, ["pack", "--pack-destination", artifactDirectory]);
await writeFile(
  join(sandbox, "package.json"),
  JSON.stringify({ private: true, type: "module" }),
);
run(
  npm,
  [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--save-exact",
    tarball,
  ],
  { cwd: sandbox },
);

const smokeFile = join(sandbox, "smoke.mjs");
await writeFile(
  smokeFile,
  `
    import * as providerModule from "opencode-acpx";
    import server from "opencode-acpx/server";
    import tui from "opencode-acpx/tui";

    const factories = Object.keys(providerModule).filter((name) => name.startsWith("create"));
    if (factories.length !== 1) throw new Error("Expected one provider factory");
    const provider = providerModule[factories[0]]({
      name: "acp.fixture",
      pluginInstanceId: "packed-install",
      serverId: "fixture",
    });
    if (typeof provider?.languageModel !== "function") throw new Error("Missing provider API");
    if (provider.languageModel("default")?.specificationVersion !== "v3") {
      throw new Error("Missing LanguageModelV3 API");
    }
    if (server?.id !== "opencode-acpx" || typeof server?.server !== "function") {
      throw new Error("Invalid server export");
    }
    if (tui?.id !== "opencode-acpx" || typeof tui?.tui !== "function") {
      throw new Error("Invalid TUI export");
    }
  `,
);
run(process.execPath, [smokeFile], { cwd: sandbox });

const installedManifest = JSON.parse(
  await readFile(
    join(sandbox, "node_modules", manifest.name, "package.json"),
    "utf8",
  ),
);
if (installedManifest.version !== manifest.version) {
  throw new Error("Packed install version does not match the source manifest");
}
if (installedManifest.dependencies?.acpx !== undefined) {
  throw new Error(
    "Packed consumers must not install an unpatched Acpx runtime",
  );
}

process.stdout.write("Fresh packed-package install verification passed.\n");
