import type { TuiPluginModule } from "@opencode-ai/plugin/tui";

import { PACKAGE_NAME, PROVIDER_PREFIX } from "./constants.js";

interface StatusCommandLayer {
  commands: {
    name: string;
    title: string;
    desc: string;
    category: string;
    namespace: "palette";
    slashName: string;
    slashAliases: string[];
    run: () => void;
  }[];
}

interface StatusKeymap {
  registerLayer(layer: StatusCommandLayer): () => void;
}

const tuiModule = {
  id: PACKAGE_NAME,
  tui: (api) => {
    const keymap = api.keymap as unknown as StatusKeymap;
    keymap.registerLayer({
      commands: [
        {
          name: "opencode-acpx.status",
          title: "ACP provider status",
          desc: "Show configured ACP providers and model counts",
          category: "ACP",
          namespace: "palette",
          slashName: "acpx-status",
          slashAliases: ["acp-status"],
          run: () => {
            const providers = api.state.provider.filter((provider) =>
              provider.id.startsWith(`${PROVIDER_PREFIX}.`),
            );
            const message =
              providers.length === 0
                ? "No ACP providers are currently available."
                : providers
                    .map(
                      (provider) =>
                        `${provider.name}: ${String(Object.keys(provider.models).length)} model(s)`,
                    )
                    .join("; ");
            api.ui.toast({
              variant: providers.length === 0 ? "warning" : "info",
              title: "ACP providers",
              message,
            });
          },
        },
      ],
    });
    return Promise.resolve();
  },
} satisfies TuiPluginModule;

export default tuiModule;
