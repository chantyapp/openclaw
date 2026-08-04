import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
export function normalizeChantyMessagingTarget(raw) {
    const trimmed = raw.trim();
    if (!trimmed) {
        return undefined;
    }
    const lower = normalizeLowercaseStringOrEmpty(trimmed);
    if (lower.startsWith("channel:")) {
        const id = trimmed.slice("channel:".length).trim();
        return id ? `channel:${id}` : undefined;
    }
    if (lower.startsWith("group:")) {
        const id = trimmed.slice("group:".length).trim();
        return id ? `channel:${id}` : undefined;
    }
    if (lower.startsWith("user:")) {
        const id = trimmed.slice("user:".length).trim();
        return id ? `user:${id}` : undefined;
    }
    if (lower.startsWith("chanty:")) {
        const id = trimmed.slice("chanty:".length).trim();
        return id ? `user:${id}` : undefined;
    }
    if (trimmed.startsWith("@")) {
        const id = trimmed.slice(1).trim();
        return id ? `@${id}` : undefined;
    }
    if (trimmed.startsWith("#")) {
        return undefined;
    }
    return undefined;
}
export function looksLikeChantyTargetId(raw, _normalized) {
    const trimmed = raw.trim();
    if (!trimmed) {
        return false;
    }
    if (/^(user|channel|group|chanty):/i.test(trimmed)) {
        return true;
    }
    if (trimmed.startsWith("@")) {
        return true;
    }
    return /^[a-z0-9]{26}$/i.test(trimmed) || /^[a-z0-9]{26}__[a-z0-9]{26}$/i.test(trimmed);
}
