// Chanty plugin module implements secret contract behavior.
import { collectSimpleChannelFieldAssignments, getChannelSurface, } from "openclaw/plugin-sdk/channel-secret-basic-runtime";
export const secretTargetRegistryEntries = [
    {
        id: "channels.chanty.accounts.*.botToken",
        targetType: "channels.chanty.accounts.*.botToken",
        configFile: "openclaw.json",
        pathPattern: "channels.chanty.accounts.*.botToken",
        secretShape: "secret_input",
        expectedResolvedValue: "string",
        includeInPlan: true,
        includeInConfigure: true,
        includeInAudit: true,
    },
    {
        id: "channels.chanty.botToken",
        targetType: "channels.chanty.botToken",
        configFile: "openclaw.json",
        pathPattern: "channels.chanty.botToken",
        secretShape: "secret_input",
        expectedResolvedValue: "string",
        includeInPlan: true,
        includeInConfigure: true,
        includeInAudit: true,
    },
];
export function collectRuntimeConfigAssignments(params) {
    const resolved = getChannelSurface(params.config, "chanty");
    if (!resolved) {
        return;
    }
    const { channel: chanty, surface } = resolved;
    collectSimpleChannelFieldAssignments({
        channelKey: "chanty",
        field: "botToken",
        channel: chanty,
        surface,
        defaults: params.defaults,
        context: params.context,
        topInactiveReason: "no enabled account inherits this top-level Chanty botToken.",
        accountInactiveReason: "Chanty account is disabled.",
    });
}
export const channelSecrets = {
    secretTargetRegistryEntries,
    collectRuntimeConfigAssignments,
};
