// Chanty helper module supports channel config shared behavior.
import { describeAccountSnapshot } from "openclaw/plugin-sdk/account-helpers";
import { formatNormalizedAllowFromEntries } from "openclaw/plugin-sdk/allow-from";
import { adaptScopedAccountAccessor, createScopedChannelConfigAdapter, } from "openclaw/plugin-sdk/channel-config-helpers";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveChantyGatewayAuthBypassPaths } from "./gateway-auth-bypass.js";
import { listChantyAccountIds, resolveDefaultChantyAccountId, resolveChantyAccount, } from "./chanty/accounts.js";
export const chantyMeta = {
    id: "chanty",
    label: "Chanty",
    selectionLabel: "Chanty (plugin)",
    detailLabel: "Chanty Bot",
    docsPath: "/channels/chanty",
    docsLabel: "chanty",
    systemImage: "bubble.left.and.bubble.right",
    blurb: "Connect OpenClaw to Chanty.",
    quickstartAllowFrom: true,
};
export function normalizeChantyAllowEntry(entry) {
    return normalizeLowercaseStringOrEmpty(entry
        .trim()
        .replace(/^(chanty|user):/i, "")
        .replace(/^@/, ""));
}
function formatChantyAllowEntry(entry) {
    const trimmed = entry.trim();
    if (!trimmed) {
        return "";
    }
    if (trimmed.startsWith("@")) {
        const username = trimmed.slice(1).trim();
        return username ? `@${normalizeLowercaseStringOrEmpty(username)}` : "";
    }
    return normalizeLowercaseStringOrEmpty(trimmed.replace(/^(chanty|user):/i, ""));
}
export { resolveChantyGatewayAuthBypassPaths };
export const chantyConfigAdapter = createScopedChannelConfigAdapter({
    sectionKey: "chanty",
    listAccountIds: listChantyAccountIds,
    resolveAccount: adaptScopedAccountAccessor(resolveChantyAccount),
    defaultAccountId: resolveDefaultChantyAccountId,
    clearBaseFields: ["botToken", "baseUrl", "name"],
    resolveAllowFrom: (account) => account.config.allowFrom,
    formatAllowFrom: (allowFrom) => formatNormalizedAllowFromEntries({
        allowFrom,
        normalizeEntry: formatChantyAllowEntry,
    }),
});
export function isChantyConfigured(account) {
    return Boolean(account.botToken && account.baseUrl);
}
export function describeChantyAccount(account) {
    return describeAccountSnapshot({
        account,
        configured: isChantyConfigured(account),
        extra: {
            baseUrl: account.baseUrl,
        },
    });
}
