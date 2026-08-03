// Chanty plugin module implements group mentions behavior.
import { resolveChannelGroupRequireMention } from "openclaw/plugin-sdk/channel-policy";
import { resolveChantyAccount } from "./chanty/accounts.js";
export function resolveChantyGroupRequireMention(params) {
    const account = resolveChantyAccount({
        cfg: params.cfg,
        accountId: params.accountId,
    });
    const requireMentionOverride = typeof params.requireMentionOverride === "boolean"
        ? params.requireMentionOverride
        : account.requireMention;
    return resolveChannelGroupRequireMention({
        cfg: params.cfg,
        channel: "chanty",
        groupId: params.groupId,
        accountId: params.accountId,
        requireMentionOverride,
    });
}
