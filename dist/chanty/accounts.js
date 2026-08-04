import { createAccountListHelpers, hasConfiguredAccountValue, } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution";
import { resolveChannelStreamingBlockCoalesce, resolveChannelStreamingBlockEnabled, resolveChannelStreamingChunkMode, resolveChannelPreviewStreamMode, } from "openclaw/plugin-sdk/channel-outbound";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { normalizeResolvedSecretInputString, normalizeSecretInputString } from "../secret-input.js";
import { normalizeChantyBaseUrl } from "./client.js";
const chantyAccountHelpers = createAccountListHelpers("chanty", {
    hasImplicitDefaultAccount: (cfg) => {
        const chanty = cfg.channels?.chanty;
        return Boolean(chanty?.baseUrl?.trim() &&
            (hasConfiguredAccountValue(chanty.botToken) || process.env.CHANTY_BOT_TOKEN?.trim()));
    },
});
export function listChantyAccountIds(cfg) {
    return chantyAccountHelpers.listAccountIds(cfg);
}
export function resolveDefaultChantyAccountId(cfg) {
    return chantyAccountHelpers.resolveDefaultAccountId(cfg);
}
function mergeChantyAccountConfig(cfg, accountId) {
    return resolveMergedAccountConfig({
        channelConfig: cfg.channels?.chanty,
        accounts: cfg.channels?.chanty?.accounts,
        accountId,
        omitKeys: ["defaultAccount"],
        nestedObjectKeys: ["commands"],
    });
}
function resolveChantyRequireMention(config) {
    if (config.chatmode === "oncall") {
        return true;
    }
    if (config.chatmode === "onmessage") {
        return false;
    }
    if (config.chatmode === "onchar") {
        return true;
    }
    return config.requireMention;
}
export function resolveChantyAccount(params) {
    const accountId = normalizeAccountId(params.accountId ?? resolveDefaultChantyAccountId(params.cfg));
    const baseEnabled = params.cfg.channels?.chanty?.enabled !== false;
    const merged = mergeChantyAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
    const envToken = allowEnv ? process.env.CHANTY_BOT_TOKEN?.trim() : undefined;
    const envUrl = allowEnv ? process.env.CHANTY_URL?.trim() : undefined;
    const configToken = params.allowUnresolvedSecretRef
        ? normalizeSecretInputString(merged.botToken)
        : normalizeResolvedSecretInputString({
            value: merged.botToken,
            path: `channels.chanty.accounts.${accountId}.botToken`,
        });
    const configUrl = merged.baseUrl?.trim();
    const botToken = configToken || envToken;
    const baseUrl = normalizeChantyBaseUrl(configUrl || envUrl);
    const requireMention = resolveChantyRequireMention(merged);
    return {
        accountId,
        enabled,
        name: normalizeOptionalString(merged.name),
        botToken,
        baseUrl,
        config: merged,
        chatmode: merged.chatmode,
        oncharPrefixes: merged.oncharPrefixes,
        requireMention,
        textChunkLimit: merged.textChunkLimit,
        chunkMode: resolveChannelStreamingChunkMode(merged) ?? merged.chunkMode,
        streamingMode: resolveChannelPreviewStreamMode(merged, "partial"),
        blockStreaming: resolveChannelStreamingBlockEnabled(merged) ?? merged.blockStreaming,
        blockStreamingCoalesce: resolveChannelStreamingBlockCoalesce(merged) ?? merged.blockStreamingCoalesce,
    };
}
export function resolveChantyReplyToMode(account, kind) {
    if (kind === "direct") {
        return "off";
    }
    return account.config.replyToMode ?? "off";
}
