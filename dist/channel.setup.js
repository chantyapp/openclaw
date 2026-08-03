import { describeChantyAccount, isChantyConfigured, chantyConfigAdapter, chantyMeta, resolveChantyGatewayAuthBypassPaths, } from "./channel-config-shared.js";
import { ChantyChannelConfigSchema } from "./config-surface.js";
import { chantySetupAdapter } from "./setup-core.js";
import { chantySetupWizard } from "./setup-surface.js";
export const chantySetupPlugin = {
    id: "chanty",
    meta: {
        ...chantyMeta,
    },
    capabilities: {
        chatTypes: ["direct", "channel", "group", "thread"],
        reactions: true,
        threads: true,
        media: true,
        nativeCommands: true,
    },
    reload: { configPrefixes: ["channels.chanty"] },
    configSchema: ChantyChannelConfigSchema,
    config: {
        ...chantyConfigAdapter,
        isConfigured: isChantyConfigured,
        describeAccount: describeChantyAccount,
    },
    gateway: {
        resolveGatewayAuthBypassPaths: ({ cfg }) => resolveChantyGatewayAuthBypassPaths(cfg),
    },
    setup: chantySetupAdapter,
    setupWizard: chantySetupWizard,
};
