import { createDangerousNameMatchingMutableAllowlistWarningCollector } from "openclaw/plugin-sdk/channel-policy";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { legacyConfigRules as CHANTY_LEGACY_CONFIG_RULES, normalizeCompatibilityConfig as normalizeChantyCompatibilityConfig, } from "./doctor-contract.js";
function isChantyMutableAllowEntry(raw) {
    const text = raw.trim();
    if (!text || text === "*") {
        return false;
    }
    const normalized = text
        .replace(/^(chanty|user):/i, "")
        .replace(/^@/, "")
        .trim();
    const lowered = normalizeLowercaseStringOrEmpty(normalized);
    if (/^[a-z0-9]{26}$/.test(lowered)) {
        return false;
    }
    return true;
}
const collectChantyMutableAllowlistWarnings = createDangerousNameMatchingMutableAllowlistWarningCollector({
    channel: "chanty",
    detector: isChantyMutableAllowEntry,
    collectLists: (scope) => [
        {
            pathLabel: `${scope.prefix}.allowFrom`,
            list: scope.account.allowFrom,
        },
        {
            pathLabel: `${scope.prefix}.groupAllowFrom`,
            list: scope.account.groupAllowFrom,
        },
    ],
});
export const chantyDoctor = {
    legacyConfigRules: CHANTY_LEGACY_CONFIG_RULES,
    normalizeCompatibilityConfig: normalizeChantyCompatibilityConfig,
    collectMutableAllowlistWarnings: collectChantyMutableAllowlistWarnings,
};
