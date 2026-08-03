// Chanty plugin module implements approval auth behavior.
import { createResolvedApproverActionAuthAdapter, resolveApprovalApprovers, } from "openclaw/plugin-sdk/approval-auth-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveChantyAccount } from "./chanty/accounts.js";
const CHANTY_USER_ID_RE = /^[a-z0-9]{26}$/;
function normalizeChantyApproverId(value) {
    const normalized = String(value)
        .trim()
        .replace(/^(chanty|user):/i, "")
        .replace(/^@/, "")
        .trim();
    const lowered = normalizeLowercaseStringOrEmpty(normalized);
    return CHANTY_USER_ID_RE.test(lowered) ? lowered : undefined;
}
export const chantyApprovalAuth = createResolvedApproverActionAuthAdapter({
    channelLabel: "Chanty",
    resolveApprovers: ({ cfg, accountId }) => {
        const account = resolveChantyAccount({ cfg, accountId }).config;
        return resolveApprovalApprovers({
            allowFrom: account.allowFrom,
            normalizeApprover: normalizeChantyApproverId,
        });
    },
    normalizeSenderId: (value) => normalizeChantyApproverId(value),
});
