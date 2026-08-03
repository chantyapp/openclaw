// Chanty plugin module implements target resolution behavior.
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveChantyAccount } from "./accounts.js";
import { createChantyClient, fetchChantyUser, normalizeChantyBaseUrl, } from "./client.js";
const chantyOpaqueTargetCache = new Map();
function cacheKey(baseUrl, token, id) {
    return `${baseUrl}::${token}::${id}`;
}
/** Chanty IDs are 26-character lowercase alphanumeric strings. */
export function isChantyId(value) {
    return /^[a-z0-9]{26}$/.test(value);
}
export function isExplicitChantyTarget(raw) {
    const trimmed = raw.trim();
    if (!trimmed) {
        return false;
    }
    return (/^(channel|user|chanty):/i.test(trimmed) ||
        trimmed.startsWith("@") ||
        trimmed.startsWith("#"));
}
export function parseChantyApiStatus(err) {
    if (!err || typeof err !== "object") {
        return undefined;
    }
    const msg = "message" in err && typeof err.message === "string" ? err.message : "";
    const match = /Chanty API (\d{3})\b/.exec(msg);
    if (!match) {
        return undefined;
    }
    const code = Number(match[1]);
    return Number.isFinite(code) ? code : undefined;
}
export async function resolveChantyOpaqueTarget(params) {
    const input = params.input.trim();
    if (!input || isExplicitChantyTarget(input) || !isChantyId(input)) {
        return null;
    }
    const account = params.cfg && (!params.token || !params.baseUrl)
        ? resolveChantyAccount({ cfg: params.cfg, accountId: params.accountId })
        : null;
    const token = normalizeOptionalString(params.token) ?? normalizeOptionalString(account?.botToken);
    const baseUrl = normalizeChantyBaseUrl(params.baseUrl ?? account?.baseUrl);
    if (!token || !baseUrl) {
        return null;
    }
    const key = cacheKey(baseUrl, token, input);
    const cached = chantyOpaqueTargetCache.get(key);
    if (cached === true) {
        return { kind: "user", id: input, to: `user:${input}` };
    }
    if (cached === false) {
        return { kind: "channel", id: input, to: `channel:${input}` };
    }
    const client = createChantyClient({
        baseUrl,
        botToken: token,
        allowPrivateNetwork: isPrivateNetworkOptInEnabled(account?.config),
    });
    try {
        await fetchChantyUser(client, input);
        chantyOpaqueTargetCache.set(key, true);
        return { kind: "user", id: input, to: `user:${input}` };
    }
    catch (err) {
        if (parseChantyApiStatus(err) === 404) {
            chantyOpaqueTargetCache.set(key, false);
        }
        return { kind: "channel", id: input, to: `channel:${input}` };
    }
}
export function resetChantyOpaqueTargetCacheForTests() {
    chantyOpaqueTargetCache.clear();
}
