// Chanty plugin module implements probe behavior.
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard, ssrfPolicyFromPrivateNetworkOptIn, } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeChantyBaseUrl, readChantyError } from "./client.js";
export async function probeChanty(baseUrl, botToken, timeoutMs = 2500, allowPrivateNetwork = false) {
    const normalized = normalizeChantyBaseUrl(baseUrl);
    if (!normalized) {
        return { ok: false, error: "baseUrl missing" };
    }
    const url = `${normalized}/api/oauth/user/auth/get`;
    const start = Date.now();
    const resolvedTimeoutMs = timeoutMs > 0 ? resolveTimerTimeoutMs(timeoutMs, 2500) : 0;
    const controller = resolvedTimeoutMs > 0 ? new AbortController() : undefined;
    let timer = null;
    if (controller) {
        timer = setTimeout(() => controller.abort(), resolvedTimeoutMs);
    }
    try {
        const { response: res, release } = await fetchWithSsrFGuard({
            url,
            init: {
                method: 'POST',
                headers: { Authorization: `Bearer ${botToken}` },
                signal: controller?.signal,
            },
            auditContext: "chanty-probe",
            policy: ssrfPolicyFromPrivateNetworkOptIn(allowPrivateNetwork),
        });
        try {
            const elapsedMs = Date.now() - start;
            if (!res.ok) {
                const detail = await readChantyError(res);
                return {
                    ok: false,
                    status: res.status,
                    error: detail || res.statusText,
                    elapsedMs,
                };
            }
            const bot = await readProviderJsonResponse(res, "Chanty probe /users/me");
            return {
                ok: true,
                status: res.status,
                elapsedMs,
                bot,
            };
        }
        finally {
            await release();
        }
    }
    catch (err) {
        const message = formatErrorMessage(err);
        return {
            ok: false,
            status: null,
            error: message,
            elapsedMs: Date.now() - start,
        };
    }
    finally {
        if (timer) {
            clearTimeout(timer);
        }
    }
}
