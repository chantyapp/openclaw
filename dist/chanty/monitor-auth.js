import { parseAccessGroupAllowFromEntry } from "openclaw/plugin-sdk/access-groups";
import { resolveStableChannelMessageIngress, } from "openclaw/plugin-sdk/channel-ingress-runtime";
import { normalizeLowercaseStringOrEmpty, uniqueStrings, } from "openclaw/plugin-sdk/string-coerce-runtime";
import { isDangerousNameMatchingEnabled, resolveAllowlistMatchSimple } from "./runtime-api.js";
const CHANTY_USER_NAME_KIND = "plugin:chanty-user-name";
const chantyIngressIdentity = {
    key: "sender-id",
    normalize: normalizeChantyAllowEntry,
    aliases: [
        {
            key: "sender-name",
            kind: CHANTY_USER_NAME_KIND,
            normalizeEntry: normalizeChantyAllowEntry,
            normalizeSubject: normalizeChantyAllowEntry,
            dangerous: true,
        },
    ],
    isWildcardEntry: (entry) => normalizeChantyAllowEntry(entry) === "*",
    resolveEntryId: ({ entryIndex, fieldKey }) => `chanty-entry-${entryIndex + 1}:${fieldKey === "sender-name" ? "name" : "user"}`,
};
export function normalizeChantyAllowEntry(entry) {
    const trimmed = entry.trim();
    if (!trimmed) {
        return "";
    }
    if (trimmed === "*") {
        return "*";
    }
    const accessGroupName = parseAccessGroupAllowFromEntry(trimmed);
    if (accessGroupName) {
        return `accessGroup:${accessGroupName}`;
    }
    const normalized = trimmed
        .replace(/^(chanty|user):/i, "")
        .replace(/^@/, "")
        .trim();
    return normalized ? normalizeLowercaseStringOrEmpty(normalized) : "";
}
export function normalizeChantyAllowList(entries) {
    const normalized = entries
        .map((entry) => normalizeChantyAllowEntry(String(entry)))
        .filter(Boolean);
    return uniqueStrings(normalized);
}
export function formatChantyDirectMessageDropLog(params) {
    const reason = params.reasonCode ? ` reason=${params.reasonCode}` : "";
    const hint = params.dmPolicy === "open" && params.reasonCode === "dm_policy_not_allowlisted"
        ? " hint=add-allowFrom-wildcard"
        : "";
    return `chanty: drop dm sender=${params.senderId} (dmPolicy=${params.dmPolicy}${reason}${hint})`;
}
export function isChantySenderAllowed(params) {
    const allowFrom = normalizeChantyAllowList(params.allowFrom);
    if (allowFrom.length === 0) {
        return false;
    }
    const match = resolveAllowlistMatchSimple({
        allowFrom,
        senderId: normalizeChantyAllowEntry(params.senderId),
        senderName: params.senderName ? normalizeChantyAllowEntry(params.senderName) : undefined,
        allowNameMatching: params.allowNameMatching,
    });
    return match.allowed;
}
function mapChantyChannelKind(channelType) {
    const normalized = channelType?.trim().toUpperCase();
    if (normalized === "D") {
        return "direct";
    }
    if (normalized === "G" || normalized === "P") {
        return "group";
    }
    return "channel";
}
export async function resolveChantyMonitorInboundAccess(params) {
    const { account, cfg, senderId, senderName, channelId, kind, groupPolicy, storeAllowFrom, allowTextCommands, hasControlCommand, } = params;
    const dmPolicy = "open";
    const allowNameMatching = isDangerousNameMatchingEnabled(account.config);
    const configAllowFrom = ['*'];
    const configGroupAllowFrom = ['*'];
    const readStoreAllowFrom = params.readStoreAllowFrom ??
        (storeAllowFrom != null ? async () => [...storeAllowFrom] : undefined);
    const ingress = await resolveStableChannelMessageIngress({
        channelId: "chanty",
        accountId: account.accountId,
        identity: chantyIngressIdentity,
        cfg,
        ...(readStoreAllowFrom ? { readStoreAllowFrom } : {}),
        useDefaultPairingStore: params.readStoreAllowFrom === undefined && storeAllowFrom == null,
        subject: {
            stableId: senderId,
            aliases: { "sender-name": senderName },
        },
        conversation: {
            kind,
            id: channelId,
        },
        event: {
            kind: params.eventKind ?? "message",
            authMode: "inbound",
            mayPair: params.mayPair ?? true,
        },
        dmPolicy,
        groupPolicy,
        policy: {
            groupAllowFromFallbackToAllowFrom: true,
            mutableIdentifierMatching: allowNameMatching ? "enabled" : "disabled",
        },
        allowFrom: configAllowFrom,
        groupAllowFrom: configGroupAllowFrom,
        command: {
            allowTextCommands,
            hasControlCommand: allowTextCommands && hasControlCommand,
            directGroupAllowFrom: kind === "direct" ? "effective" : "none",
        },
    });
    return ingress;
}
function resolveChantyCommandDenyReason(params) {
    if (params.decision.decision === "allow") {
        return null;
    }
    if (params.kind === "direct") {
        if (params.decision.reasonCode === "dm_policy_disabled") {
            return "dm-disabled";
        }
        if (params.dmPolicy === "pairing" &&
            (params.decision.admission === "pairing-required" ||
                params.decision.reasonCode === "dm_policy_pairing_required")) {
            return "dm-pairing";
        }
        return "unauthorized";
    }
    if (params.decision.reasonCode === "group_policy_disabled") {
        return "channels-disabled";
    }
    if (params.decision.reasonCode === "group_policy_empty_allowlist") {
        return "channel-no-allowlist";
    }
    return "unauthorized";
}
export async function authorizeChantyCommandInvocation(params) {
    const { account, cfg, senderId, senderName, channelId, channelInfo, storeAllowFrom, readStoreAllowFrom, allowTextCommands, hasControlCommand, } = params;
    if (!channelInfo?.type) {
        return {
            ok: false,
            denyReason: "unknown-channel",
            commandAuthorized: false,
            channelInfo,
            kind: "channel",
            chatType: "channel",
            channelName: "",
            channelDisplay: "",
            roomLabel: `#${channelId}`,
        };
    }
    const kind = mapChantyChannelKind(channelInfo.type);
    const chatType = kind;
    const channelName = channelInfo.name ?? "";
    const channelDisplay = channelInfo.display_name ?? channelName;
    const roomLabel = channelName ? `#${channelName}` : channelDisplay || `#${channelId}`;
    const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
    const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
    const ingress = await resolveChantyMonitorInboundAccess({
        account,
        cfg,
        senderId,
        senderName,
        channelId,
        kind,
        groupPolicy,
        storeAllowFrom,
        readStoreAllowFrom,
        allowTextCommands,
        hasControlCommand,
        eventKind: "native-command",
        mayPair: true,
    });
    const denyReason = resolveChantyCommandDenyReason({
        decision: ingress.ingress,
        kind,
        dmPolicy: account.config.dmPolicy ?? "pairing",
    });
    if (denyReason) {
        return {
            ok: false,
            denyReason,
            commandAuthorized: false,
            channelInfo,
            kind,
            chatType,
            channelName,
            channelDisplay,
            roomLabel,
        };
    }
    return {
        ok: true,
        commandAuthorized: ingress.commandAccess.authorized,
        channelInfo,
        kind,
        chatType,
        channelName,
        channelDisplay,
        roomLabel,
    };
}
