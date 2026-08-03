// Chanty plugin module implements monitor onchar behavior.
import { normalizeStringEntries } from "openclaw/plugin-sdk/string-coerce-runtime";
const DEFAULT_ONCHAR_PREFIXES = [">", "!"];
export function resolveOncharPrefixes(prefixes) {
    const cleaned = prefixes ? normalizeStringEntries(prefixes) : DEFAULT_ONCHAR_PREFIXES;
    return cleaned.length > 0 ? cleaned : DEFAULT_ONCHAR_PREFIXES;
}
export function stripOncharPrefix(text, prefixes) {
    const trimmed = text.trimStart();
    for (const prefix of prefixes) {
        if (!prefix) {
            continue;
        }
        if (trimmed.startsWith(prefix)) {
            return {
                triggered: true,
                stripped: trimmed.slice(prefix.length).trimStart(),
            };
        }
    }
    return { triggered: false, stripped: text };
}
