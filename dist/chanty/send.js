import { createMessageReceiptFromOutboundResults, } from "openclaw/plugin-sdk/channel-outbound";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString, } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getChantyRuntime } from "../runtime.js";
import { resolveChantyAccount } from "./accounts.js";
import { createChantyClient, createChantyPost, fetchChantyChannelByName, fetchChantyMe, fetchChantyUserByUsername, fetchChantyUserTeams, normalizeChantyBaseUrl, } from "./client.js";
import { isChantyId, resolveChantyOpaqueTarget } from "./target-resolution.js";
const botUserCache = new Map();
const userByNameCache = new Map();
const channelByNameCache = new Map();
const dmChannelCache = new Map();
const getCore = () => getChantyRuntime();
function createChantySendReceipt(params) {
    const messageIds = params.messageId.trim() && params.messageId !== "unknown" ? [params.messageId] : [];
    return createMessageReceiptFromOutboundResults({
        kind: params.kind,
        ...(params.replyToId ? { replyToId: params.replyToId } : {}),
        results: messageIds.map((messageId) => ({
            channel: "chanty",
            messageId,
            channelId: params.channelId,
        })),
    });
}
function resolveChantyReceiptKind(params) {
    if (params.fileIds?.length) {
        return "media";
    }
    if (params.buttons?.length || params.props) {
        return "card";
    }
    return "text";
}
function recordChantyOutboundActivity(accountId) {
    try {
        getCore().channel.activity.record({
            channel: "chanty",
            accountId,
            direction: "outbound",
        });
    }
    catch (error) {
        if (!(error instanceof Error) || error.message !== "Chanty runtime not initialized") {
            throw error;
        }
    }
}
function cacheKey(baseUrl, token) {
    return `${baseUrl}::${token}`;
}
function normalizeMessage(text, mediaUrl) {
    const trimmed = normalizeOptionalString(text) ?? "";
    const media = normalizeOptionalString(mediaUrl);
    return [trimmed, media].filter(Boolean).join("\n");
}
function isHttpUrl(value) {
    return /^https?:\/\//i.test(value);
}
export function parseChantyTarget(raw) {
    const trimmed = raw.trim();
    if (!trimmed) {
        throw new Error("Recipient is required for Chanty sends");
    }
    const lower = normalizeLowercaseStringOrEmpty(trimmed);
    if (lower.startsWith("channel:")) {
        const id = trimmed.slice("channel:".length).trim();
        if (!id) {
            throw new Error("Channel id is required for Chanty sends");
        }
        if (id.startsWith("#")) {
            const name = id.slice(1).trim();
            if (!name) {
                throw new Error("Channel name is required for Chanty sends");
            }
            return { kind: "channel-name", name };
        }
        if (!isChantyId(id)) {
            return { kind: "channel-name", name: id };
        }
        return { kind: "channel", id };
    }
    if (lower.startsWith("user:")) {
        const id = trimmed.slice("user:".length).trim();
        if (!id) {
            throw new Error("User id is required for Chanty sends");
        }
        return { kind: "user", id };
    }
    if (lower.startsWith("chanty:")) {
        const id = trimmed.slice("chanty:".length).trim();
        if (!id) {
            throw new Error("User id is required for Chanty sends");
        }
        return { kind: "user", id };
    }
    if (trimmed.startsWith("@")) {
        const username = trimmed.slice(1).trim();
        if (!username) {
            throw new Error("Username is required for Chanty sends");
        }
        return { kind: "user", username };
    }
    if (trimmed.startsWith("#")) {
        const name = trimmed.slice(1).trim();
        if (!name) {
            throw new Error("Channel name is required for Chanty sends");
        }
        return { kind: "channel-name", name };
    }
    if (!isChantyId(trimmed)) {
        return { kind: "channel-name", name: trimmed };
    }
    return { kind: "channel", id: trimmed };
}
async function resolveBotUser(baseUrl, token, allowPrivateNetwork) {
    const key = cacheKey(baseUrl, token);
    const cached = botUserCache.get(key);
    if (cached) {
        return cached;
    }
    const client = createChantyClient({ baseUrl, botToken: token, allowPrivateNetwork });
    const user = await fetchChantyMe(client);
    botUserCache.set(key, user);
    return user;
}
async function resolveUserIdByUsername(params) {
    const { baseUrl, token, username } = params;
    const key = `${cacheKey(baseUrl, token)}::${normalizeLowercaseStringOrEmpty(username)}`;
    const cached = userByNameCache.get(key);
    if (cached?.id) {
        return cached.id;
    }
    const client = createChantyClient({
        baseUrl,
        botToken: token,
        allowPrivateNetwork: params.allowPrivateNetwork,
    });
    const user = await fetchChantyUserByUsername(client, username);
    userByNameCache.set(key, user);
    return user.id;
}
async function resolveChannelIdByName(params) {
    const { baseUrl, token, name } = params;
    const key = `${cacheKey(baseUrl, token)}::channel::${normalizeLowercaseStringOrEmpty(name)}`;
    const cached = channelByNameCache.get(key);
    if (cached) {
        return cached;
    }
    const client = createChantyClient({
        baseUrl,
        botToken: token,
        allowPrivateNetwork: params.allowPrivateNetwork,
    });
    const me = await fetchChantyMe(client);
    const teams = await fetchChantyUserTeams(client, me.id);
    for (const team of teams) {
        try {
            const channel = await fetchChantyChannelByName(client, team.id, name);
            if (channel?.id) {
                channelByNameCache.set(key, channel.id);
                return channel.id;
            }
        }
        catch {
        }
    }
    throw new Error(`Chanty channel "#${name}" not found in any team the bot belongs to`);
}
function mergeDmRetryOptions(base, override) {
    const merged = {
        maxRetries: override?.maxRetries ?? base?.maxRetries,
        initialDelayMs: override?.initialDelayMs ?? base?.initialDelayMs,
        maxDelayMs: override?.maxDelayMs ?? base?.maxDelayMs,
        timeoutMs: override?.timeoutMs ?? base?.timeoutMs,
        onRetry: override?.onRetry,
    };
    if (merged.maxRetries === undefined &&
        merged.initialDelayMs === undefined &&
        merged.maxDelayMs === undefined &&
        merged.timeoutMs === undefined &&
        merged.onRetry === undefined) {
        return undefined;
    }
    return merged;
}
async function resolveTargetChannelId(params) {
    return params.target?.name;
}
async function resolveChantySendContext(to, opts) {
    const core = getCore();
    const logger = core.logging.getChildLogger({ module: "chanty" });
    if (!opts?.cfg) {
        throw new Error("Chanty send requires a resolved runtime config. Load and resolve config at the command or gateway boundary, then pass cfg through the runtime path.");
    }
    const cfg = requireRuntimeConfig(opts.cfg, "Chanty send");
    const account = resolveChantyAccount({
        cfg,
        accountId: opts.accountId,
    });
    const token = normalizeOptionalString(opts.botToken) ?? normalizeOptionalString(account.botToken);
    if (!token) {
        throw new Error(`Chanty bot token missing for account "${account.accountId}" (set channels.chanty.accounts.${account.accountId}.botToken or CHANTY_BOT_TOKEN for default).`);
    }
    const baseUrl = normalizeChantyBaseUrl(opts.baseUrl ?? account.baseUrl);
    if (!baseUrl) {
        throw new Error(`Chanty baseUrl missing for account "${account.accountId}" (set channels.chanty.accounts.${account.accountId}.baseUrl or CHANTY_URL for default).`);
    }
    const trimmedTo = normalizeOptionalString(to) ?? "";
    const opaqueTarget = await resolveChantyOpaqueTarget({
        input: trimmedTo,
        token,
        baseUrl,
    });
    const target = opaqueTarget?.kind === "user"
        ? { kind: "user", id: opaqueTarget.id }
        : opaqueTarget?.kind === "channel"
            ? { kind: "channel", id: opaqueTarget.id }
            : parseChantyTarget(trimmedTo);
    const accountRetryConfig = account.config.dmChannelRetry
        ? {
            maxRetries: account.config.dmChannelRetry.maxRetries,
            initialDelayMs: account.config.dmChannelRetry.initialDelayMs,
            maxDelayMs: account.config.dmChannelRetry.maxDelayMs,
            timeoutMs: account.config.dmChannelRetry.timeoutMs,
        }
        : undefined;
    const dmRetryOptions = mergeDmRetryOptions(accountRetryConfig, opts.dmRetryOptions);
    const allowPrivateNetwork = isPrivateNetworkOptInEnabled(account.config);
    const channelId = await resolveTargetChannelId({
        target,
        baseUrl,
        token,
        allowPrivateNetwork,
        dmRetryOptions,
        onDmChannelResolution: opts.onDmChannelResolution,
        logger: core.logging.shouldLogVerbose() ? logger : undefined,
    });
    return {
        cfg,
        accountId: account.accountId,
        token,
        baseUrl,
        channelId,
        allowPrivateNetwork,
    };
}
export async function sendMessageChanty(to, text, opts) {
    const core = getCore();
    const logger = core.logging.getChildLogger({ module: "chanty" });
    try {
        const { cfg, accountId, token, baseUrl, channelId, allowPrivateNetwork } = await resolveChantySendContext(to, opts);
        const client = createChantyClient({ baseUrl, botToken: token, allowPrivateNetwork });
        let props = opts.props;
        let message = normalizeOptionalString(text) ?? "";
        let fileIds;
        let uploadError;
        const mediaUrl = opts.mediaUrl?.trim();
        if (!message && (!fileIds || fileIds.length === 0)) {
            if (uploadError) {
                throw new Error(`Chanty media upload failed: ${uploadError.message}`, {
                    cause: uploadError,
                });
            }
            throw new Error("Chanty message is empty");
        }
        const post = await createChantyPost(client, {
            channelId,
            message,
            rootId: opts.replyToId,
            fileIds,
            props,
        });
        recordChantyOutboundActivity(accountId);
        const messageId = post.id ?? "unknown";
        return {
            messageId,
            channelId,
            receipt: createChantySendReceipt({
                messageId,
                channelId,
                kind: resolveChantyReceiptKind({
                    fileIds,
                    buttons: opts.buttons,
                    props,
                }),
                replyToId: opts.replyToId,
            }),
        };
    }
    catch (e) {
        console.error(2222, e);
    }
}
