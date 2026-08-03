// Chanty plugin module implements monitor resources behavior.
import { formatInboundMediaUnavailableText } from "openclaw/plugin-sdk/channel-inbound";
import { asDateTimestampMs, resolveExpiresAtMsFromDurationMs, } from "openclaw/plugin-sdk/number-runtime";
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
import { fetchChantyChannel, fetchChantyUser, sendChantyTyping, } from "./client.js";
export function formatChantyInboundMediaText(params) {
    const unavailableCount = Math.max(0, params.expectedCount - params.mediaCount);
    if (unavailableCount === 0) {
        return params.body;
    }
    return formatInboundMediaUnavailableText({
        body: params.body,
        mediaPlaceholder: params.mediaCount === 0 ? params.mediaPlaceholder : undefined,
        notice: `[chanty ${unavailableCount > 1 ? `${unavailableCount} attachments` : "attachment"} unavailable]`,
    });
}
const CHANNEL_CACHE_TTL_MS = 5 * 60_000;
const USER_CACHE_TTL_MS = 10 * 60_000;
export function createChantyMonitorResources(params) {
    const { accountId, callbackUrl, client, logger, mediaMaxBytes, saveRemoteMedia, mediaKindFromMime, } = params;
    const channelCache = new Map();
    const userCache = new Map();
    const getCachedValue = (cache, key, nowMs) => {
        const cached = cache.get(key);
        if (!cached) {
            return undefined;
        }
        if (nowMs !== undefined && cached.expiresAt > nowMs) {
            return cached.value;
        }
        cache.delete(key);
        return undefined;
    };
    const setCachedValue = (cache, key, value, ttlMs, rawNowMs) => {
        const expiresAt = resolveExpiresAtMsFromDurationMs(ttlMs, { nowMs: rawNowMs });
        if (expiresAt !== undefined) {
            cache.set(key, { value, expiresAt });
        }
    };
    const resolveChantyMedia = async (fileIds) => {
        const ids = normalizeStringEntries(fileIds ?? []);
        if (ids.length === 0) {
            return [];
        }
        const out = [];
        for (const fileId of ids) {
            try {
                const saved = await saveRemoteMedia({
                    url: `${client.baseUrl}/files/${fileId}`,
                    requestInit: {
                        headers: {
                            Authorization: `Bearer ${client.token}`,
                        },
                    },
                    filePathHint: fileId,
                    maxBytes: mediaMaxBytes,
                    ssrfPolicy: { allowedHostnames: [new URL(client.baseUrl).hostname] },
                });
                const contentType = saved.contentType ?? undefined;
                out.push({
                    path: saved.path,
                    contentType,
                    kind: mediaKindFromMime(contentType) ?? "unknown",
                });
            }
            catch (err) {
                logger.debug?.(`chanty: failed to download file ${fileId}: ${String(err)}`);
            }
        }
        return out;
    };
    const sendTypingIndicator = async (channelId, parentId) => {
        await sendChantyTyping(client, { channelId, parentId });
    };
    const resolveChannelInfo = async (channelId) => {
        const rawNow = Date.now();
        const cached = getCachedValue(channelCache, channelId, asDateTimestampMs(rawNow));
        if (cached !== undefined) {
            return cached;
        }
        try {
            const info = await fetchChantyChannel(client, channelId);
            setCachedValue(channelCache, channelId, info, CHANNEL_CACHE_TTL_MS, rawNow);
            return info;
        }
        catch (err) {
            logger.debug?.(`chanty: channel lookup failed: ${String(err)}`);
            setCachedValue(channelCache, channelId, null, CHANNEL_CACHE_TTL_MS, rawNow);
            return null;
        }
    };
    const resolveUserInfo = async (userId) => {
        const rawNow = Date.now();
        const cached = getCachedValue(userCache, userId, asDateTimestampMs(rawNow));
        if (cached !== undefined) {
            return cached;
        }
        try {
            const info = await fetchChantyUser(client, userId);
            setCachedValue(userCache, userId, info, USER_CACHE_TTL_MS, rawNow);
            return info;
        }
        catch (err) {
            logger.debug?.(`chanty: user lookup failed: ${String(err)}`);
            setCachedValue(userCache, userId, null, USER_CACHE_TTL_MS, rawNow);
            return null;
        }
    };
    /* const buildModelPickerProps = (
      channelId: string,
      buttons: Array<unknown>,
    ): Record<string, unknown> | undefined =>
      buildButtonProps({
        callbackUrl,
        accountId,
        channelId,
        buttons,
      }); */
    /* const updateModelPickerPost = async (paramsLocal: {
      channelId: string;
      postId: string;
      message: string;
      buttons?: Array<unknown>;
    }): Promise<ChantyInteractionResponse> => {
      const props = buildModelPickerProps(paramsLocal.channelId, paramsLocal.buttons ?? []) ?? {
        attachments: [],
      };
      await updateChantyPost(client, paramsLocal.postId, {
        message: paramsLocal.message,
        props,
      });
      return {};
    }; */
    return {
        resolveChantyMedia,
        sendTypingIndicator,
        resolveChannelInfo,
        resolveUserInfo,
        // updateModelPickerPost,
    };
}
