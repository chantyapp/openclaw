// Chanty plugin module implements draft stream behavior.
import { createFinalizableDraftLifecycle } from "openclaw/plugin-sdk/channel-outbound";
import { sliceUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { createChantyPost, deleteChantyPost, updateChantyPost, } from "./client.js";
const CHANTY_STREAM_MAX_CHARS = 4000;
const DEFAULT_THROTTLE_MS = 1000;
function normalizeChantyDraftText(text, maxChars) {
    const trimmed = text.trim();
    if (!trimmed) {
        return "";
    }
    if (trimmed.length <= maxChars) {
        return trimmed;
    }
    return `${sliceUtf16Safe(trimmed, 0, Math.max(0, maxChars - 3)).trimEnd()}...`;
}
export function createChantyDraftStream(params) {
    const maxChars = Math.min(params.maxChars ?? CHANTY_STREAM_MAX_CHARS, CHANTY_STREAM_MAX_CHARS);
    const throttleMs = Math.max(250, params.throttleMs ?? DEFAULT_THROTTLE_MS);
    const streamState = { stopped: false, final: false };
    let streamPostId;
    let lastSentText = "";
    const sendOrEditStreamMessage = async (text) => {
        if (streamState.stopped && !streamState.final) {
            return false;
        }
        const rendered = params.renderText?.(text) ?? text;
        const normalized = normalizeChantyDraftText(rendered, maxChars);
        if (!normalized) {
            return false;
        }
        if (normalized === lastSentText) {
            return true;
        }
        try {
            if (streamPostId) {
                await updateChantyPost(params.client, streamPostId, {
                    message: normalized,
                });
            }
            else {
                const sent = await createChantyPost(params.client, {
                    channelId: params.channelId,
                    message: normalized,
                    rootId: params.rootId,
                });
                const postId = sent.id?.trim();
                if (!postId) {
                    streamState.stopped = true;
                    params.warn?.("chanty stream preview stopped (missing post id from create)");
                    return false;
                }
                streamPostId = postId;
            }
            lastSentText = normalized;
            return true;
        }
        catch (err) {
            streamState.stopped = true;
            params.warn?.(`chanty stream preview failed: ${err instanceof Error ? err.message : String(err)}`);
            return false;
        }
    };
    const { loop, update, stop, clear, discardPending, seal } = createFinalizableDraftLifecycle({
        throttleMs,
        state: streamState,
        sendOrEditStreamMessage,
        readMessageId: () => streamPostId,
        clearMessageId: () => {
            streamPostId = undefined;
        },
        isValidMessageId: (value) => typeof value === "string" && value.length > 0,
        deleteMessage: async (postId) => {
            await deleteChantyPost(params.client, postId);
        },
        warn: params.warn,
        warnPrefix: "chanty stream preview cleanup failed",
    });
    const forceNewMessage = () => {
        streamPostId = undefined;
        lastSentText = "";
        loop.resetPending();
        loop.resetThrottleWindow();
    };
    params.log?.(`chanty stream preview ready (maxChars=${maxChars}, throttleMs=${throttleMs})`);
    return {
        update,
        flush: loop.flush,
        postId: () => streamPostId,
        clear,
        discardPending,
        seal,
        stop,
        forceNewMessage,
    };
}
