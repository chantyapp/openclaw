// Chanty helper module supports config surface behavior.
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/channel-config-primitives";
import { ChantyConfigSchema } from "./config-schema-core.js";
import { chantyChannelConfigUiHints } from "./config-ui-hints.js";
export const ChantyChannelConfigSchema = buildChannelConfigSchema(ChantyConfigSchema, {
    uiHints: chantyChannelConfigUiHints,
});
