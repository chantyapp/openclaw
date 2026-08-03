export function mapChantyChannelTypeToChatType(channelType) {
    const normalized = channelType?.trim().toUpperCase();
    if (!normalized) {
        return "direct";
    }
    if (normalized === "D") {
        return "direct";
    }
    if (normalized === "G" || normalized === "P") {
        return "group";
    }
    return "channel";
}
export function resolveChantyTrustedChatKind(params) {
    const channelType = params.channelType?.trim();
    if (channelType) {
        return mapChantyChannelTypeToChatType(channelType);
    }
    return params.fallback ?? "direct";
}
export function evaluateChantyMentionGate(params) {
    const shouldRequireMention = params.kind !== "direct" &&
        params.resolveRequireMention({
            cfg: params.cfg,
            channel: "chanty",
            accountId: params.accountId,
            groupId: params.channelId,
            requireMentionOverride: params.requireMentionOverride,
        });
    const shouldBypassMention = params.isControlCommand &&
        shouldRequireMention &&
        !params.wasMentioned &&
        params.commandAuthorized;
    const effectiveWasMentioned = params.wasMentioned ||
        shouldBypassMention ||
        params.oncharTriggered ||
        params.threadAlreadyEngaged === true;
    if (params.oncharEnabled &&
        !params.oncharTriggered &&
        !params.wasMentioned &&
        !params.isControlCommand &&
        params.threadAlreadyEngaged !== true) {
        return {
            shouldRequireMention,
            shouldBypassMention,
            effectiveWasMentioned,
            dropReason: "onchar-not-triggered",
        };
    }
    if (params.kind !== "direct" &&
        shouldRequireMention &&
        params.canDetectMention &&
        !effectiveWasMentioned) {
        return {
            shouldRequireMention,
            shouldBypassMention,
            effectiveWasMentioned,
            dropReason: "missing-mention",
        };
    }
    return {
        shouldRequireMention,
        shouldBypassMention,
        effectiveWasMentioned,
        dropReason: null,
    };
}
