import { countOutboundMedia } from "openclaw/plugin-sdk/reply-payload";
export function evaluateChantyNoVisibleReply(params) {
    if (params.outcome !== "empty") {
        return null;
    }
    const finalText = typeof params.payload.text === "string" ? params.payload.text.trim() : "";
    const mediaUrlCount = countOutboundMedia(params.payload);
    if (finalText.length === 0 && mediaUrlCount === 0) {
        return null;
    }
    return {
        reason: "no-visible-reply-after-final-delivery",
        outcome: params.outcome,
        finalTextLength: finalText.length,
        mediaUrlCount,
    };
}
export function formatChantyNoVisibleReplyLog(params) {
    return (`chanty no-visible-reply: ${params.violation.reason}` +
        ` to=${params.to}` +
        ` accountId=${params.accountId}` +
        ` agentId=${params.agentId ?? "unknown"}` +
        ` outcome=${params.violation.outcome}` +
        ` finalTextLength=${params.violation.finalTextLength}` +
        ` mediaUrlCount=${params.violation.mediaUrlCount}`);
}
