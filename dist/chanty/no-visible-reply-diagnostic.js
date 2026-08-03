// Chanty plugin module implements no visible reply diagnostic behavior.
import { countOutboundMedia } from "openclaw/plugin-sdk/reply-payload";
/**
 * Detects the #80501 symptom: `deliverChantyReplyPayload` accepted a
 * substantive (non-reasoning) payload, called the underlying
 * `deliverTextOrMediaReply`, and the outcome was `"empty"` — meaning the
 * payload had no text and no media to send, so no Chanty API call
 * happened. The agent's run completes successfully, but no visible
 * channel/thread reply ever surfaces to the user.
 *
 * Returns a structured violation when the outcome is `"empty"` for a payload
 * that nominally carried user-facing content (text or media bytes that ended
 * up dropped by `resolveSendableOutboundReplyParts`/`sendMediaWithLeadingCaption`).
 * Returns `null` for `"reasoning_skipped"` (intentional suppression),
 * `"text"`, or `"media"` (successful visible sends).
 */
export function evaluateChantyNoVisibleReply(params) {
    if (params.outcome !== "empty") {
        return null;
    }
    const finalText = typeof params.payload.text === "string" ? params.payload.text.trim() : "";
    const mediaUrlCount = countOutboundMedia(params.payload);
    // If the payload had no text and no media even nominally, the run had
    // nothing to send and "empty" is the correct outcome — do not flag.
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
