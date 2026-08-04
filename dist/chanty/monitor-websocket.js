import { randomUUID } from "node:crypto";
import { captureWsEvent, createDebugProxyWebSocketAgent, resolveDebugProxySettings, } from "openclaw/plugin-sdk/proxy-capture";
import WebSocket from "ws";
import { rawDataToString } from "./monitor-helpers.js";
export const CHANTY_WEBSOCKET_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const ChantyEventPayloadSchema = {};
function parseChantyEventPayload(raw) {
    return JSON.parse(raw);
}
function parseChantyPost(value) {
    return {};
}
export class WebSocketClosedBeforeOpenError extends Error {
    code;
    reason;
    constructor(code, reason) {
        super(`websocket closed before open (code ${code})`);
        this.code = code;
        this.reason = reason;
        this.name = "WebSocketClosedBeforeOpenError";
    }
}
const defaultChantyWebSocketFactory = (url) => {
    const agent = createDebugProxyWebSocketAgent(resolveDebugProxySettings());
    return new WebSocket(url, {
        ...(agent ? { agent } : {}),
        maxPayload: CHANTY_WEBSOCKET_MAX_PAYLOAD_BYTES,
    });
};
function parsePostedPayload(payload) {
    if (payload.event !== "posted") {
        return null;
    }
    const postData = payload.data?.post;
    if (!postData) {
        return null;
    }
    const post = parseChantyPost(postData);
    if (!post) {
        return null;
    }
    return { payload, post };
}
export function createChantyConnectOnce(opts) {
    const webSocketFactory = opts.webSocketFactory ?? defaultChantyWebSocketFactory;
    const healthCheckIntervalMs = opts.healthCheckIntervalMs ?? 30_000;
    const pingIntervalMs = opts.pingIntervalMs ?? 30_000;
    const pongTimeoutMs = opts.pongTimeoutMs ?? 10_000;
    return async () => {
        const flowId = randomUUID();
        const ws = webSocketFactory(opts.wsUrl);
        const onAbort = () => ws.terminate();
        opts.abortSignal?.addEventListener("abort", onAbort, { once: true });
        const getBotUpdateAt = opts.getBotUpdateAt;
        opts.client.ws = ws;
        try {
            return await new Promise((resolve, reject) => {
                let opened = false;
                let settled = false;
                let healthCheckEnabled = false;
                let healthCheckInFlight = false;
                let healthCheckTimer;
                let protocolKeepaliveEnabled = true;
                let protocolPingInterval;
                let initialUpdateAt;
                const clearTimers = () => {
                    if (healthCheckTimer !== undefined) {
                        clearTimeout(healthCheckTimer);
                        healthCheckTimer = undefined;
                    }
                    if (protocolPingInterval !== undefined) {
                        clearInterval(protocolPingInterval);
                        protocolPingInterval = undefined;
                    }
                };
                const stopHealthChecks = () => {
                    healthCheckEnabled = false;
                    protocolKeepaliveEnabled = false;
                    clearTimers();
                };
                const sendProtocolPing = () => {
                    if (!protocolKeepaliveEnabled || settled) {
                        return;
                    }
                    try {
                        const p = `ping:${new Date().getTime()}`;
                        ws.send(p);
                    }
                    catch (err) {
                        if (!protocolKeepaliveEnabled || settled) {
                            return;
                        }
                        opts.runtime.error?.(`chanty websocket ping failed: ${String(err)}`);
                        stopHealthChecks();
                        ws.terminate();
                    }
                };
                const scheduleProtocolPing = () => {
                    if (!protocolKeepaliveEnabled || settled || protocolPingInterval !== undefined) {
                        return;
                    }
                    protocolPingInterval = setInterval(() => {
                        protocolPingInterval = undefined;
                        sendProtocolPing();
                    }, pingIntervalMs);
                };
                const scheduleHealthCheck = () => {
                    if (!getBotUpdateAt || !healthCheckEnabled || settled || healthCheckInFlight) {
                        return;
                    }
                    healthCheckTimer = setTimeout(() => {
                        healthCheckTimer = undefined;
                        void runHealthCheck();
                    }, healthCheckIntervalMs);
                };
                const runHealthCheck = async () => {
                    if (!getBotUpdateAt || !healthCheckEnabled || settled || healthCheckInFlight) {
                        return;
                    }
                    healthCheckInFlight = true;
                    try {
                        const current = await getBotUpdateAt();
                        if (!healthCheckEnabled || settled) {
                            return;
                        }
                        if (initialUpdateAt === undefined) {
                            initialUpdateAt = current;
                            return;
                        }
                        if (current !== initialUpdateAt) {
                            opts.runtime.log?.(`chanty: bot account updated (update_at changed: ${initialUpdateAt} → ${current}) — reconnecting`);
                            stopHealthChecks();
                            ws.terminate();
                        }
                    }
                    catch (err) {
                        if (!healthCheckEnabled || settled) {
                            return;
                        }
                        const label = initialUpdateAt === undefined
                            ? "chanty: failed to get initial update_at"
                            : "chanty: health check error";
                        opts.runtime.error?.(`${label}: ${String(err)}`);
                    }
                    finally {
                        healthCheckInFlight = false;
                        scheduleHealthCheck();
                    }
                };
                const resolveOnce = () => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    stopHealthChecks();
                    resolve();
                };
                const rejectOnce = (error) => {
                    if (settled) {
                        return;
                    }
                    settled = true;
                    stopHealthChecks();
                    reject(error);
                };
                ws.on("open", () => {
                    opened = true;
                    captureWsEvent({
                        url: opts.wsUrl,
                        direction: "local",
                        kind: "ws-open",
                        flowId,
                        meta: { subsystem: "chanty-websocket" },
                    });
                    opts.statusSink?.({
                        connected: true,
                        lastConnectedAt: Date.now(),
                        lastError: null,
                    });
                    scheduleProtocolPing();
                    if (getBotUpdateAt) {
                    }
                });
                ws.on("message", async (data) => {
                    captureWsEvent({
                        url: opts.wsUrl,
                        direction: "inbound",
                        kind: "ws-frame",
                        flowId,
                        payload: Buffer.from(rawDataToString(data)),
                        meta: { subsystem: "chanty-websocket" },
                    });
                    const raw = rawDataToString(data);
                    const payload = parseChantyEventPayload(raw);
                    if (!payload) {
                        return;
                    }
                    if (payload?.eventType !== "message_post") {
                        return;
                    }
                    try {
                        await opts.onPosted(payload);
                    }
                    catch (err) {
                        opts.runtime.error?.(`chanty handler failed: ${String(err)}`);
                    }
                });
                ws.on("close", (code, reason) => {
                    captureWsEvent({
                        url: opts.wsUrl,
                        direction: "local",
                        kind: "ws-close",
                        flowId,
                        closeCode: code,
                        payload: reason,
                        meta: { subsystem: "chanty-websocket" },
                    });
                    stopHealthChecks();
                    const message = reasonToString(reason);
                    opts.statusSink?.({
                        connected: false,
                        lastDisconnect: {
                            at: Date.now(),
                            status: code,
                            error: message || undefined,
                        },
                    });
                    if (opened) {
                        resolveOnce();
                        return;
                    }
                    rejectOnce(new WebSocketClosedBeforeOpenError(code, message || undefined));
                });
                ws.on("error", (err) => {
                    captureWsEvent({
                        url: opts.wsUrl,
                        direction: "local",
                        kind: "error",
                        flowId,
                        errorText: String(err),
                        meta: { subsystem: "chanty-websocket" },
                    });
                    opts.runtime.error?.(`chanty websocket error: ${String(err)}`);
                    opts.statusSink?.({
                        lastError: String(err),
                    });
                    try {
                        ws.close();
                    }
                    catch { }
                });
            });
        }
        catch (e) {
            console.warn(e);
        }
        finally {
            opts.abortSignal?.removeEventListener("abort", onAbort);
        }
    };
}
function reasonToString(reason) {
    if (!reason) {
        return "";
    }
    if (typeof reason === "string") {
        return reason;
    }
    return reason.length > 0 ? reason.toString("utf8") : "";
}
