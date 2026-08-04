import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { readProviderJsonResponse, readResponseTextLimited, } from "openclaw/plugin-sdk/provider-http";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { sleep } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithSsrFGuard, ssrfPolicyFromPrivateNetworkOptIn, } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString, } from "openclaw/plugin-sdk/string-coerce-runtime";
const CHANTY_ERROR_BODY_LIMIT_BYTES = 8 * 1024;
const CHANTY_TEXT_RESPONSE_LIMIT_BYTES = 64 * 1024;
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);
export const ChantyPostSchema = {};
export function normalizeChantyBaseUrl(raw) {
    const trimmed = raw?.trim();
    if (!trimmed) {
        return undefined;
    }
    const withoutTrailing = trimmed.replace(/\/+$/, "");
    return withoutTrailing;
}
function buildChantyApiUrl(baseUrl, path) {
    const normalized = normalizeChantyBaseUrl(baseUrl);
    if (!normalized) {
        throw new Error("Chanty baseUrl is required");
    }
    const suffix = path.startsWith("/") ? path : `/${path}`;
    return `${normalized}${suffix}`;
}
async function readChantySuccessText(res, path) {
    const bytes = await readResponseWithLimit(res, CHANTY_TEXT_RESPONSE_LIMIT_BYTES, {
        onOverflow: ({ maxBytes }) => new Error(`Chanty API ${path}: text response exceeds ${maxBytes} bytes`),
    });
    return new TextDecoder().decode(bytes);
}
export async function readChantyError(res) {
    const contentType = res.headers.get("content-type") ?? "";
    const text = await readResponseTextLimited(res, CHANTY_ERROR_BODY_LIMIT_BYTES);
    if (contentType.includes("application/json")) {
        try {
            const data = JSON.parse(text);
            if (data?.message) {
                return data.message;
            }
            return JSON.stringify(data);
        }
        catch {
            return text;
        }
    }
    return text;
}
function responseWithRelease(response, release) {
    let released = false;
    const releaseOnce = async () => {
        if (released) {
            return;
        }
        released = true;
        await release();
    };
    if (!response.body || NULL_BODY_STATUSES.has(response.status)) {
        void releaseOnce();
        return new Response(null, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    }
    const reader = response.body.getReader();
    const body = new ReadableStream({
        async pull(controller) {
            try {
                const { done, value } = await reader.read();
                if (done) {
                    await releaseOnce();
                    controller.close();
                    return;
                }
                if (value) {
                    controller.enqueue(value);
                }
            }
            catch (error) {
                await releaseOnce();
                throw error;
            }
        },
        async cancel(reason) {
            await reader.cancel(reason).catch(() => undefined);
            await releaseOnce();
        },
    });
    return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
    });
}
export function createChantyClient(params) {
    const baseUrl = normalizeChantyBaseUrl(params.baseUrl);
    if (!baseUrl) {
        throw new Error("Chanty baseUrl is required");
    }
    const token = params.botToken.trim();
    const externalFetchImpl = params.fetchImpl;
    const guardedFetchImpl = async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const { response, release } = await fetchWithSsrFGuard({
            url,
            init,
            auditContext: "chanty-api",
            policy: ssrfPolicyFromPrivateNetworkOptIn(params.allowPrivateNetwork),
        });
        return responseWithRelease(response, release);
    };
    const fetchImpl = externalFetchImpl ?? guardedFetchImpl;
    const request = async (path, init) => {
        const url = buildChantyApiUrl(baseUrl, path);
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${token}`);
        if (typeof init?.body === "string" && !headers.has("Content-Type")) {
            headers.set("Content-Type", "application/json");
        }
        const res = await fetchImpl(url, { ...init, headers, method: 'POST' });
        if (!res.ok) {
            const detail = await readChantyError(res);
            throw new Error(`Chanty API ${res.status} ${res.statusText}: ${detail || "unknown error"}`);
        }
        if (res.status === 204) {
            return undefined;
        }
        const contentType = res.headers.get("content-type") ?? "";
        if (contentType.includes("application/json")) {
            return await readProviderJsonResponse(res, `Chanty API ${path}`);
        }
        return (await readChantySuccessText(res, path));
    };
    return { baseUrl, token, request, fetchImpl };
}
export async function fetchChantyMe(client) {
    return (await client.request("/api/oauth2/user/auth/get"))?.data;
}
export async function fetchChantyUser(client, userId) {
    return await client.request(`/users/${userId}`);
}
export async function fetchChantyUserByUsername(client, username) {
    return await client.request(`/users/username/${encodeURIComponent(username)}`);
}
export async function fetchChantyChannel(client, channelId) {
    return await client.request(`/channels/${channelId}`);
}
export async function fetchChantyChannelByName(client, teamId, channelName) {
    return await client.request(`/teams/${teamId}/channels/name/${encodeURIComponent(channelName)}`);
}
export async function sendChantyTyping(client, params) {
    try {
        client.ws?.send(`typing:${params.channelId}`);
    }
    catch (e) {
        console.warn(e);
    }
}
export async function createChantyDirectChannel(client, userIds, signal) {
    return await client.request("/channels/direct", {
        method: "POST",
        body: JSON.stringify(userIds),
        signal,
    });
}
const DM_REPLY_DELIVERY_BARRIER_TIMEOUT_MS = 60_000;
export function resolveChantyReplyDeliveryBarrierTimeoutMs(params) {
    if (!params.isDirect) {
        return undefined;
    }
    const deliveryCount = Object.values(params.queuedCounts).reduce((sum, count) => sum + count, 0);
    if (deliveryCount === 0) {
        return undefined;
    }
    const maxRetries = params.dmRetryOptions?.maxRetries ?? 3;
    const maxDelayMs = params.dmRetryOptions?.maxDelayMs ?? 10_000;
    const timeoutMs = params.dmRetryOptions?.timeoutMs ?? 30_000;
    const perDeliveryTimeoutMs = (maxRetries + 1) * timeoutMs + maxRetries * maxDelayMs + DM_REPLY_DELIVERY_BARRIER_TIMEOUT_MS;
    const totalTimeoutMs = perDeliveryTimeoutMs * deliveryCount + Math.max(0, params.humanDelayBudgetMs ?? 0);
    return resolveTimerTimeoutMs(Number.isFinite(totalTimeoutMs) ? totalTimeoutMs : Number.MAX_SAFE_INTEGER, perDeliveryTimeoutMs);
}
const RETRYABLE_NETWORK_ERROR_CODES = new Set([
    "ECONNRESET",
    "ECONNREFUSED",
    "ETIMEDOUT",
    "ESOCKETTIMEDOUT",
    "ECONNABORTED",
    "ENOTFOUND",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "EPIPE",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_DNS_RESOLVE_FAILED",
    "UND_ERR_CONNECT",
    "UND_ERR_SOCKET",
    "UND_ERR_HEADERS_TIMEOUT",
    "UND_ERR_BODY_TIMEOUT",
]);
const RETRYABLE_NETWORK_ERROR_NAMES = new Set([
    "AbortError",
    "TimeoutError",
    "ConnectTimeoutError",
    "HeadersTimeoutError",
    "BodyTimeoutError",
]);
const RETRYABLE_NETWORK_MESSAGE_SNIPPETS = [
    "network error",
    "timeout",
    "timed out",
    "abort",
    "connection refused",
    "econnreset",
    "econnrefused",
    "etimedout",
    "enotfound",
    "socket hang up",
    "getaddrinfo",
];
export async function createChantyDirectChannelWithRetry(client, userIds, options = {}) {
    const { maxRetries = 3, initialDelayMs = 1000, maxDelayMs = 10000, timeoutMs: rawTimeoutMs = 30000, onRetry, } = options;
    const timeoutMs = resolveTimerTimeoutMs(rawTimeoutMs, 30000);
    let lastError;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const result = await createChantyDirectChannel(client, userIds, controller.signal);
                return result;
            }
            finally {
                clearTimeout(timeoutId);
            }
        }
        catch (err) {
            lastError = err instanceof Error ? err : new Error(String(err));
            if (attempt >= maxRetries) {
                break;
            }
            if (!isRetryableError(lastError)) {
                throw lastError;
            }
            const exponentialDelay = initialDelayMs * 2 ** attempt;
            const jitter = Math.random() * exponentialDelay;
            const delayMs = Math.min(exponentialDelay + jitter, maxDelayMs);
            if (onRetry) {
                onRetry(attempt + 1, delayMs, lastError);
            }
            await sleep(delayMs);
        }
    }
    throw lastError ?? new Error("Failed to create DM channel after retries");
}
function isRetryableError(error) {
    const candidates = collectErrorCandidates(error);
    const messages = candidates
        .map((candidate) => normalizeLowercaseStringOrEmpty(readErrorMessage(candidate)))
        .filter((message) => Boolean(message));
    if (messages.some((message) => /chanty api 5\d{2}\b/.test(message))) {
        return true;
    }
    if (messages.some((message) => /chanty api 429\b/.test(message) || message.includes("too many requests"))) {
        return true;
    }
    for (const message of messages) {
        const clientErrorMatch = message.match(/chanty api (4\d{2})\b/);
        if (!clientErrorMatch) {
            continue;
        }
        const statusCode = Number.parseInt(clientErrorMatch[1], 10);
        if (statusCode >= 400 && statusCode < 500) {
            return false;
        }
    }
    const hasChantyApiStatusCode = messages.some((message) => /chanty api \d{3}\b/.test(message));
    if (hasChantyApiStatusCode) {
        return false;
    }
    const codes = [];
    for (const candidate of candidates) {
        const code = readErrorCode(candidate);
        if (code) {
            codes.push(code);
        }
    }
    if (codes.some((code) => RETRYABLE_NETWORK_ERROR_CODES.has(code))) {
        return true;
    }
    const names = [];
    for (const candidate of candidates) {
        const name = readErrorName(candidate);
        if (name) {
            names.push(name);
        }
    }
    if (names.some((name) => RETRYABLE_NETWORK_ERROR_NAMES.has(name))) {
        return true;
    }
    return messages.some((message) => RETRYABLE_NETWORK_MESSAGE_SNIPPETS.some((pattern) => message.includes(pattern)));
}
function collectErrorCandidates(error) {
    const queue = [error];
    let queueIndex = 0;
    const seen = new Set();
    const candidates = [];
    while (queueIndex < queue.length) {
        const current = queue[queueIndex];
        queueIndex += 1;
        if (!current || seen.has(current)) {
            continue;
        }
        seen.add(current);
        candidates.push(current);
        if (typeof current !== "object") {
            continue;
        }
        const nested = current;
        queue.push(nested.cause, nested.reason);
        if (Array.isArray(nested.errors)) {
            queue.push(...nested.errors);
        }
    }
    return candidates;
}
function readErrorMessage(error) {
    if (!error || typeof error !== "object") {
        return undefined;
    }
    const message = error.message;
    return typeof message === "string" && message.trim() ? message : undefined;
}
function readErrorName(error) {
    if (!error || typeof error !== "object") {
        return undefined;
    }
    const name = error.name;
    return typeof name === "string" && name.trim() ? name : undefined;
}
function readErrorCode(error) {
    if (!error || typeof error !== "object") {
        return undefined;
    }
    const { code, errno } = error;
    const raw = typeof code === "string" && code.trim() ? code : errno;
    if (typeof raw === "string" && raw.trim()) {
        return raw.trim().toUpperCase();
    }
    if (typeof raw === "number" && Number.isFinite(raw)) {
        return String(raw);
    }
    return undefined;
}
export async function createChantyPost(client, params) {
    const payload = {
        channel_id: params.channelId,
        message: params.message,
    };
    if (params.rootId) {
        payload.root_id = params.rootId;
    }
    if (params.fileIds?.length) {
        payload.file_ids = params.fileIds;
    }
    if (params.props) {
        payload.props = params.props;
    }
    return await client.request("/api/v1/message/post", {
        method: "POST",
        body: JSON.stringify({
            convType: 'direct',
            convJid: params.channelId,
            text: params.message
        }),
    });
}
export async function fetchChantyUserTeams(client, userId) {
    return await client.request(`/users/${userId}/teams`);
}
export async function updateChantyPost(client, postId, params) {
    const payload = { id: postId };
    if (params.message !== undefined) {
        payload.message = params.message;
    }
    if (params.props !== undefined) {
        payload.props = params.props;
    }
    return await client.request(`/posts/${postId}`, {
        method: "PUT",
        body: JSON.stringify(payload),
    });
}
export async function deleteChantyPost(client, postId) {
    await client.request(`/posts/${postId}`, {
        method: "DELETE",
    });
}
export async function uploadChantyFile(client, params) {
    const form = new FormData();
    const fileName = normalizeOptionalString(params.fileName) ?? "upload";
    const bytes = Uint8Array.from(params.buffer);
    const blob = params.contentType
        ? new Blob([bytes], { type: params.contentType })
        : new Blob([bytes]);
    form.append("files", blob, fileName);
    form.append("channel_id", params.channelId);
    const res = await client.fetchImpl(`${client.baseUrl}/files`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${client.token}`,
        },
        body: form,
    });
    if (!res.ok) {
        const detail = await readChantyError(res);
        throw new Error(`Chanty API ${res.status} ${res.statusText}: ${detail || "unknown error"}`);
    }
    const data = await readProviderJsonResponse(res, "Chanty API /files");
    const info = data.file_infos?.[0];
    if (!info?.id) {
        throw new Error("Chanty file upload failed");
    }
    return info;
}
