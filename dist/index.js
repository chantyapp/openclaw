import { defineBundledChannelEntry, } from "openclaw/plugin-sdk/channel-entry-contract";
export default defineBundledChannelEntry({
    id: "chanty",
    name: "Chanty",
    description: "Chanty channel plugin",
    importMetaUrl: import.meta.url,
    plugin: {
        specifier: "./channel-plugin-api.js",
        exportName: "chantyPlugin",
    },
    secrets: {
        specifier: "./secret-contract-api.js",
        exportName: "channelSecrets",
    },
    runtime: {
        specifier: "./runtime-api.js",
        exportName: "setChantyRuntime",
    },
    registerFull(api) {
    },
});
