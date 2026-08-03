import { getAgentScopedMediaLocalRoots } from "openclaw/plugin-sdk/media-runtime";
import { deliverTextOrMediaReply, isReasoningReplyPayload, resolveSendableOutboundReplyParts, } from "openclaw/plugin-sdk/reply-payload";
import { resolveChantyReplyDeliveryBarrierTimeoutMs, } from "./client.js";
export function createChantyReplyDeliveryBarrier(params) {
    let activeDmChannelResolutions = 0;
    let queuedDeliveryCount = 0;
    let settledDeliveryCount = 0;
    const trackDmChannelResolution = (resolution) => {
        activeDmChannelResolutions += 1;
        void Promise.resolve(resolution).then(() => {
            activeDmChannelResolutions -= 1;
        }, () => {
            activeDmChannelResolutions -= 1;
        });
    };
    const markDeliverySettled = () => {
        settledDeliveryCount += 1;
    };
    const resolveTimeoutPolicy = (context) => {
        const { queuedCounts } = context;
        queuedDeliveryCount = Object.values(queuedCounts).reduce((sum, count) => sum + count, 0);
        const maxTimeoutMs = resolveChantyReplyDeliveryBarrierTimeoutMs({
            isDirect: params.isDirect,
            dmRetryOptions: params.dmRetryOptions,
            queuedCounts,
            humanDelayBudgetMs: context.humanDelayBudgetMs,
        });
        if (maxTimeoutMs === undefined) {
            return undefined;
        }
        return {
            maxTimeoutMs,
            shouldExtend: () => activeDmChannelResolutions > 0 || settledDeliveryCount < queuedDeliveryCount,
        };
    };
    return {
        trackDmChannelResolution,
        markDeliverySettled,
        resolveTimeoutPolicy,
    };
}
export async function deliverChantyReplyPayload(params) {
    if (isReasoningReplyPayload(params.payload)) {
        return "reasoning_skipped";
    }
    const reply = resolveSendableOutboundReplyParts(params.payload, {
        text: params.core.channel.text.convertMarkdownTables(params.payload.text ?? "", params.tableMode),
    });
    const mediaLocalRoots = getAgentScopedMediaLocalRoots(params.cfg, params.agentId);
    const chunkMode = params.core.channel.text.resolveChunkMode(params.cfg, "chanty", params.accountId);
    return await deliverTextOrMediaReply({
        payload: params.payload,
        text: reply.text,
        chunkText: (value) => params.core.channel.text.chunkMarkdownTextWithMode(value, params.textLimit, chunkMode),
        sendText: async (chunk) => {
            await params.sendMessage(params.to, chunk, {
                cfg: params.cfg,
                accountId: params.accountId,
                replyToId: params.replyToId,
                ...(params.onDmChannelResolution
                    ? { onDmChannelResolution: params.onDmChannelResolution }
                    : {}),
            });
        },
        sendMedia: async ({ mediaUrl, caption }) => {
            await params.sendMessage(params.to, caption ?? "", {
                cfg: params.cfg,
                accountId: params.accountId,
                mediaUrl,
                mediaLocalRoots,
                replyToId: params.replyToId,
                ...(params.onDmChannelResolution
                    ? { onDmChannelResolution: params.onDmChannelResolution }
                    : {}),
            });
        },
    });
}
