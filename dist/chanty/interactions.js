import { createHmac } from "node:crypto";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString, normalizeStringifiedOptionalString, } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getChantyRuntime } from "../runtime.js";
import { updateChantyPost } from "./client.js";
import { isTrustedProxyAddress, readRequestBodyWithLimit, resolveClientIp, } from "./runtime-api.js";
const INTERACTION_MAX_BODY_BYTES = 64 * 1024;
const INTERACTION_BODY_TIMEOUT_MS = 10_000;
const SIGNED_CHANNEL_ID_CONTEXT_KEY = "__openclaw_channel_id";
const callbackUrls = new Map();
export function setInteractionCallbackUrl(accountId, url) {
    callbackUrls.set(accountId, url);
}
export function resolveInteractionCallbackPath(accountId) {
    return `/chanty/interactions/${accountId}`;
}
function isWildcardBindHost(rawHost) {
    const trimmed = rawHost.trim();
    if (!trimmed) {
        return false;
    }
    const host = trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
    return host === "0.0.0.0" || host === "::" || host === "0:0:0:0:0:0:0:0" || host === "::0";
}
function normalizeCallbackBaseUrl(baseUrl) {
    return baseUrl.trim().replace(/\/+$/, "");
}
function headerValue(value) {
    if (Array.isArray(value)) {
        return normalizeOptionalString(value[0]);
    }
    return normalizeOptionalString(value);
}
function isAllowedInteractionSource(params) {
    const { allowedSourceIps } = params;
    if (!allowedSourceIps?.length) {
        return true;
    }
    const clientIp = resolveClientIp({
        remoteAddr: params.req.socket?.remoteAddress,
        forwardedFor: headerValue(params.req.headers["x-forwarded-for"]),
        realIp: headerValue(params.req.headers["x-real-ip"]),
        trustedProxies: params.trustedProxies,
        allowRealIpFallback: params.allowRealIpFallback,
    });
    return isTrustedProxyAddress(clientIp, allowedSourceIps);
}
export function computeInteractionCallbackUrl(accountId, cfg) {
    const path = resolveInteractionCallbackPath(accountId);
    const callbackBaseUrl = normalizeOptionalString(cfg?.interactions?.callbackBaseUrl) ??
        normalizeOptionalString(cfg?.channels?.chanty?.interactions?.callbackBaseUrl);
    if (callbackBaseUrl) {
        return `${normalizeCallbackBaseUrl(callbackBaseUrl)}${path}`;
    }
    const port = typeof cfg?.gateway?.port === "number" ? cfg.gateway.port : 18789;
    let host = cfg?.gateway?.customBindHost && !isWildcardBindHost(cfg.gateway.customBindHost)
        ? cfg.gateway.customBindHost.trim()
        : "localhost";
    if (host.includes(":") && !(host.startsWith("[") && host.endsWith("]"))) {
        host = `[${host}]`;
    }
    return `http://${host}:${port}${path}`;
}
export function resolveInteractionCallbackUrl(accountId, cfg) {
    const cached = callbackUrls.get(accountId);
    if (cached) {
        return cached;
    }
    return computeInteractionCallbackUrl(accountId, cfg);
}
const interactionSecrets = new Map();
let defaultInteractionSecret;
function deriveInteractionSecret(botToken) {
    return createHmac("sha256", "openclaw-chanty-interactions").update(botToken).digest("hex");
}
export function setInteractionSecret(accountIdOrBotToken, botToken) {
    if (typeof botToken === "string") {
        interactionSecrets.set(accountIdOrBotToken, deriveInteractionSecret(botToken));
        return;
    }
    defaultInteractionSecret = deriveInteractionSecret(accountIdOrBotToken);
}
export function getInteractionSecret(accountId) {
    const scoped = accountId ? interactionSecrets.get(accountId) : undefined;
    if (scoped) {
        return scoped;
    }
    if (defaultInteractionSecret) {
        return defaultInteractionSecret;
    }
    if (interactionSecrets.size === 1) {
        const first = interactionSecrets.values().next().value;
        if (typeof first === "string") {
            return first;
        }
    }
    throw new Error("Interaction secret not initialized — call setInteractionSecret(accountId, botToken) first");
}
function canonicalizeInteractionContext(value) {
    if (Array.isArray(value)) {
        return value.map((item) => canonicalizeInteractionContext(item));
    }
    if (value && typeof value === "object") {
        const entries = Object.entries(value)
            .filter(([, entryValue]) => entryValue !== undefined)
            .toSorted(([left], [right]) => left.localeCompare(right))
            .map(([key, entryValue]) => [key, canonicalizeInteractionContext(entryValue)]);
        return Object.fromEntries(entries);
    }
    return value;
}
export function generateInteractionToken(context, accountId) {
    const secret = getInteractionSecret(accountId);
    const payload = JSON.stringify(canonicalizeInteractionContext(context));
    return createHmac("sha256", secret).update(payload).digest("hex");
}
export function verifyInteractionToken(context, token, accountId) {
    const expected = generateInteractionToken(context, accountId);
    return safeEqualSecret(expected, token);
}
function sanitizeActionId(id) {
    return id.replace(/[-_]/g, "");
}
export function buildButtonAttachments(params) {
    const actions = params.buttons.map((btn) => {
        const safeId = sanitizeActionId(btn.id);
        const context = {
            action_id: safeId,
            ...btn.context,
        };
        const token = generateInteractionToken(context, params.accountId);
        return {
            id: safeId,
            type: "button",
            name: btn.name,
            style: btn.style,
            integration: {
                url: params.callbackUrl,
                context: {
                    ...context,
                    _token: token,
                },
            },
        };
    });
    return [
        {
            text: params.text ?? "",
            actions,
        },
    ];
}
export function buildButtonProps(params) {
    const rawButtons = params.buttons.flatMap((item) => Array.isArray(item) ? item : [item]);
    const buttons = rawButtons
        .map((btn) => ({
        id: normalizeStringifiedOptionalString(btn.id ?? btn.callback_data) ?? "",
        name: normalizeStringifiedOptionalString(btn.text ?? btn.name ?? btn.label) ?? "",
        style: btn.style ?? "default",
        context: typeof btn.context === "object" && btn.context !== null
            ? {
                ...btn.context,
                [SIGNED_CHANNEL_ID_CONTEXT_KEY]: params.channelId,
            }
            : { [SIGNED_CHANNEL_ID_CONTEXT_KEY]: params.channelId },
    }))
        .filter((btn) => btn.id && btn.name);
    if (buttons.length === 0) {
        return undefined;
    }
    return {
        attachments: buildButtonAttachments({
            callbackUrl: params.callbackUrl,
            accountId: params.accountId,
            buttons,
            text: params.text,
        }),
    };
}
function readInteractionBody(req) {
    return readRequestBodyWithLimit(req, {
        maxBytes: INTERACTION_MAX_BODY_BYTES,
        timeoutMs: INTERACTION_BODY_TIMEOUT_MS,
    });
}
export function createChantyInteractionHandler(params) {
    const { client, accountId, log } = params;
    const core = getChantyRuntime();
    function parseInteractionPayload(raw) {
        try {
            return JSON.parse(raw);
        }
        catch {
            throw new Error("Chanty interaction body was malformed JSON");
        }
    }
    return async (req, res) => {
        if (req.method !== "POST") {
            res.statusCode = 405;
            res.setHeader("Allow", "POST");
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Method Not Allowed" }));
            return;
        }
        if (!isAllowedInteractionSource({
            req,
            allowedSourceIps: params.allowedSourceIps,
            trustedProxies: params.trustedProxies,
            allowRealIpFallback: params.allowRealIpFallback,
        })) {
            log?.(`chanty interaction: rejected callback source remote=${req.socket?.remoteAddress ?? "?"}`);
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Forbidden origin" }));
            return;
        }
        let payload;
        try {
            const raw = await readInteractionBody(req);
            payload = parseInteractionPayload(raw);
        }
        catch (err) {
            log?.(`chanty interaction: failed to parse body: ${String(err)}`);
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Invalid request body" }));
            return;
        }
        const context = payload.context;
        if (!context) {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Missing context" }));
            return;
        }
        const token = context["_token"];
        if (typeof token !== "string") {
            log?.("chanty interaction: missing _token in context");
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Missing token" }));
            return;
        }
        const { _token, ...contextWithoutToken } = context;
        if (!verifyInteractionToken(contextWithoutToken, token, accountId)) {
            log?.("chanty interaction: invalid _token");
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Invalid token" }));
            return;
        }
        const actionId = context.action_id;
        if (typeof actionId !== "string") {
            res.statusCode = 400;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Missing action_id in context" }));
            return;
        }
        const signedChannelId = typeof contextWithoutToken[SIGNED_CHANNEL_ID_CONTEXT_KEY] === "string"
            ? contextWithoutToken[SIGNED_CHANNEL_ID_CONTEXT_KEY].trim()
            : "";
        if (signedChannelId && signedChannelId !== payload.channel_id) {
            log?.(`chanty interaction: signed channel mismatch payload=${payload.channel_id} signed=${signedChannelId}`);
            res.statusCode = 403;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Channel mismatch" }));
            return;
        }
        const userName = payload.user_name ?? payload.user_id;
        let originalMessage;
        let originalPost;
        let clickedButtonName = null;
        try {
            originalPost = await client.request(`/posts/${payload.post_id}`);
            const postChannelId = originalPost.channel_id?.trim();
            if (!postChannelId || postChannelId !== payload.channel_id) {
                log?.(`chanty interaction: post channel mismatch payload=${payload.channel_id} post=${postChannelId ?? "<missing>"}`);
                res.statusCode = 403;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "Post/channel mismatch" }));
                return;
            }
            originalMessage = originalPost.message ?? "";
            const postAttachments = Array.isArray(originalPost?.props?.attachments)
                ? originalPost.props.attachments
                : [];
            for (const att of postAttachments) {
                const match = att.actions?.find((a) => a.id === actionId);
                if (match?.name) {
                    clickedButtonName = match.name;
                    break;
                }
            }
            if (clickedButtonName === null) {
                log?.(`chanty interaction: action ${actionId} not found in post ${payload.post_id}`);
                res.statusCode = 403;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "Unknown action" }));
                return;
            }
        }
        catch (err) {
            log?.(`chanty interaction: failed to validate post ${payload.post_id}: ${String(err)}`);
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Failed to validate interaction" }));
            return;
        }
        if (!originalPost) {
            log?.(`chanty interaction: missing fetched post ${payload.post_id}`);
            res.statusCode = 500;
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ error: "Failed to load interaction post" }));
            return;
        }
        log?.(`chanty interaction: action=${actionId} user=${payload.user_name ?? payload.user_id} ` +
            `post=${payload.post_id} channel=${payload.channel_id}`);
        if (params.authorizeButtonClick) {
            try {
                const authorization = await params.authorizeButtonClick({
                    payload,
                    post: originalPost,
                });
                if (!authorization.ok) {
                    res.statusCode = authorization.statusCode ?? 200;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify(authorization.response ?? {
                        ephemeral_text: "You are not allowed to use this action here.",
                    }));
                    return;
                }
            }
            catch (err) {
                log?.(`chanty interaction: authorization failed: ${String(err)}`);
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "Interaction authorization failed" }));
                return;
            }
        }
        if (params.handleInteraction) {
            try {
                const response = await params.handleInteraction({
                    payload,
                    userName,
                    actionId,
                    actionName: clickedButtonName,
                    originalMessage,
                    context: contextWithoutToken,
                    post: originalPost,
                });
                if (response !== null) {
                    res.statusCode = 200;
                    res.setHeader("Content-Type", "application/json");
                    res.end(JSON.stringify(response));
                    return;
                }
            }
            catch (err) {
                log?.(`chanty interaction: custom handler failed: ${String(err)}`);
                res.statusCode = 500;
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ error: "Interaction handler failed" }));
                return;
            }
        }
        try {
            const eventLabel = `Chanty button click: action="${actionId}" ` +
                `by ${payload.user_name ?? payload.user_id} ` +
                `in channel ${payload.channel_id}`;
            const sessionKey = params.resolveSessionKey
                ? await params.resolveSessionKey({
                    channelId: payload.channel_id,
                    userId: payload.user_id,
                    post: originalPost,
                })
                : `agent:main:chanty:${accountId}:${payload.channel_id}`;
            core.system.enqueueSystemEvent(eventLabel, {
                sessionKey,
                contextKey: `chanty:interaction:${payload.post_id}:${actionId}`,
            });
        }
        catch (err) {
            log?.(`chanty interaction: system event dispatch failed: ${String(err)}`);
        }
        try {
            await updateChantyPost(client, payload.post_id, {
                message: originalMessage,
                props: {
                    attachments: [
                        {
                            text: `✓ **${clickedButtonName}** selected by @${userName}`,
                        },
                    ],
                },
            });
        }
        catch (err) {
            log?.(`chanty interaction: failed to update post ${payload.post_id}: ${String(err)}`);
        }
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json");
        res.end("{}");
        if (params.dispatchButtonClick) {
            try {
                await params.dispatchButtonClick({
                    channelId: payload.channel_id,
                    userId: payload.user_id,
                    userName,
                    actionId,
                    actionName: clickedButtonName,
                    postId: payload.post_id,
                    post: originalPost,
                });
            }
            catch (err) {
                log?.(`chanty interaction: dispatchButtonClick failed: ${String(err)}`);
            }
        }
    };
}
