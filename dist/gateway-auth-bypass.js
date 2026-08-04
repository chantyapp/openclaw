const DEFAULT_SLASH_CALLBACK_PATH = "/api/channels/chanty/command";
function readTrimmedString(value) {
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
function normalizeCallbackPath(value) {
    const trimmed = readTrimmedString(value);
    if (!trimmed) {
        return DEFAULT_SLASH_CALLBACK_PATH;
    }
    return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
function readChantyCommands(value) {
    return value && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
function isChantyBypassPath(path) {
    return path === DEFAULT_SLASH_CALLBACK_PATH || path.startsWith("/api/channels/chanty/");
}
export function collectChantySlashCallbackPaths(raw) {
    const paths = new Set([normalizeCallbackPath(raw?.callbackPath)]);
    const callbackUrl = readTrimmedString(raw?.callbackUrl);
    if (callbackUrl) {
        try {
            const pathname = new URL(callbackUrl).pathname;
            if (pathname) {
                paths.add(pathname);
            }
        }
        catch {
        }
    }
    return [...paths];
}
export function resolveChantyGatewayAuthBypassPaths(cfg) {
    const base = cfg.channels?.chanty && typeof cfg.channels.chanty === "object"
        ? cfg.channels.chanty
        : undefined;
    const callbackPaths = new Set(collectChantySlashCallbackPaths(readChantyCommands(base?.commands)).filter(isChantyBypassPath));
    const accounts = base?.accounts ?? {};
    for (const account of Object.values(accounts)) {
        const accountConfig = account && typeof account === "object" && !Array.isArray(account)
            ? account
            : undefined;
        for (const path of collectChantySlashCallbackPaths(readChantyCommands(accountConfig?.commands))) {
            if (isChantyBypassPath(path)) {
                callbackPaths.add(path);
            }
        }
    }
    return [...callbackPaths];
}
