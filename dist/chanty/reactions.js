// Chanty plugin module implements reactions behavior.
import { asDateTimestampMs, resolveExpiresAtMsFromDurationMs, } from "openclaw/plugin-sdk/number-runtime";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolveChantyAccount } from "./accounts.js";
import { createChantyClient, fetchChantyMe, } from "./client.js";
const BOT_USER_CACHE_TTL_MS = 10 * 60_000;
const botUserIdCache = new Map();
async function resolveBotUserId(client, cacheKey) {
    const rawNow = Date.now();
    const now = asDateTimestampMs(rawNow);
    const cached = botUserIdCache.get(cacheKey);
    if (cached) {
        if (now !== undefined && cached.expiresAt > now) {
            return cached.userId;
        }
        botUserIdCache.delete(cacheKey);
    }
    const me = await fetchChantyMe(client);
    const userId = me?.id?.trim();
    if (!userId) {
        return null;
    }
    const expiresAt = resolveExpiresAtMsFromDurationMs(BOT_USER_CACHE_TTL_MS, { nowMs: rawNow });
    if (expiresAt !== undefined) {
        botUserIdCache.set(cacheKey, { userId, expiresAt });
    }
    return userId;
}
export async function addChantyReaction(params) {
    return runChantyReaction(params, {
        action: "add",
        mutation: createReaction,
    });
}
export async function removeChantyReaction(params) {
    return runChantyReaction(params, {
        action: "remove",
        mutation: deleteReaction,
    });
}
export function resetChantyReactionBotUserCacheForTests() {
    botUserIdCache.clear();
}
async function runChantyReaction(params, options) {
    const resolved = resolveChantyAccount({ cfg: params.cfg, accountId: params.accountId });
    const baseUrl = resolved.baseUrl?.trim();
    const botToken = resolved.botToken?.trim();
    if (!baseUrl || !botToken) {
        return { ok: false, error: "Chanty botToken/baseUrl missing." };
    }
    const client = createChantyClient({
        baseUrl,
        botToken,
        fetchImpl: params.fetchImpl,
        allowPrivateNetwork: isPrivateNetworkOptInEnabled(resolved.config),
    });
    const cacheKey = `${baseUrl}:${botToken}`;
    const userId = await resolveBotUserId(client, cacheKey);
    if (!userId) {
        return { ok: false, error: "Chanty reactions failed: could not resolve bot user id." };
    }
    try {
        await options.mutation(client, {
            userId,
            postId: params.postId,
            emojiName: params.emojiName,
        });
    }
    catch (err) {
        return { ok: false, error: `Chanty ${options.action} reaction failed: ${String(err)}` };
    }
    return { ok: true };
}
async function createReaction(client, params) {
    await client.request("/reactions", {
        method: "POST",
        body: JSON.stringify({
            user_id: params.userId,
            post_id: params.postId,
            emoji_name: params.emojiName,
        }),
    });
}
async function deleteReaction(client, params) {
    const emoji = encodeURIComponent(params.emojiName);
    await client.request(`/users/${params.userId}/posts/${params.postId}/reactions/${emoji}`, {
        method: "DELETE",
    });
}
