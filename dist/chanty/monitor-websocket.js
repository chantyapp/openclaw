// Chanty plugin module implements monitor websocket behavior.
import { randomUUID } from "node:crypto";
import { captureWsEvent, createDebugProxyWebSocketAgent, resolveDebugProxySettings, } from "openclaw/plugin-sdk/proxy-capture";
import WebSocket from "ws";
import { rawDataToString } from "./monitor-helpers.js";
// Chanty events can include double-encoded post props plus server/plugin metadata.
// Keep channel-compatible headroom while bounding ws's 100 MiB default before parsing.
export const CHANTY_WEBSOCKET_MAX_PAYLOAD_BYTES = 16 * 1024 * 1024;
const ChantyEventPayloadSchema = {}; /* z.object({
  eventType: z.string().required()
}) as z.ZodType<ChantyEventPayload>; */
function parseChantyEventPayload(raw) {
    return JSON.parse(raw); //safeParseJsonWithSchema(ChantyEventPayloadSchema, raw);
}
function parseChantyPost(value) {
    // @todo
    return {};
    /* if (typeof value === "string") {
      return safeParseJsonWithSchema(ChantyPostSchema, value);
    }
    return safeParseWithSchema(ChantyPostSchema, value); */
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
                let healthCheckEnabled = false; // getBotUpdateAt != null;
                let healthCheckInFlight = false;
                let healthCheckTimer;
                let protocolKeepaliveEnabled = true;
                let protocolPingInterval;
                // let protocolPongTimer: ReturnType<typeof setTimeout> | undefined;
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
                    /* if (protocolPongTimer !== undefined) {
                      clearTimeout(protocolPongTimer);
                      protocolPongTimer = undefined;
                    } */
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
                    /* if (protocolPongTimer !== undefined) {
                      clearTimeout(protocolPongTimer);
                    }
                    protocolPongTimer = setTimeout(() => {
                      protocolPongTimer = undefined;
                      if (!protocolKeepaliveEnabled || settled) {
                        return;
                      }
                      opts.runtime.error?.("chanty websocket pong timeout — reconnecting");
                      stopHealthChecks();
                      ws.terminate();
                    }, pongTimeoutMs); */
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
                    /* const authPayload = JSON.stringify({
                      seq: opts.nextSeq(),
                      action: "authentication_challenge",
                      data: { token: opts.botToken },
                    });
                    captureWsEvent({
                      url: opts.wsUrl,
                      direction: "outbound",
                      kind: "ws-frame",
                      flowId,
                      payload: authPayload,
                      meta: { subsystem: "chanty-websocket", eventType: "authentication_challenge" },
                    });
                    ws.send(authPayload); */
                    scheduleProtocolPing();
                    // Periodically check if the bot account was modified (e.g. disable/enable).
                    // After such a cycle the WebSocket silently stops delivering events even
                    // though the connection itself stays alive.  Comparing update_at detects
                    // this reliably regardless of how quickly the cycle happens.
                    if (getBotUpdateAt) {
                        // Use a recursive timeout so only one REST poll can be in flight at a time.
                        // void runHealthCheck();
                    }
                });
                /* ws.on("pong", () => {
                  if (protocolPongTimer !== undefined) {
                    clearTimeout(protocolPongTimer);
                    protocolPongTimer = undefined;
                  }
                  scheduleProtocolPing();
                }); */
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
                    /* if (payload.event === "reaction_added" || payload.event === "reaction_removed") {
                      if (!opts.onReaction) {
                        return;
                      }
                      try {
                        await opts.onReaction(payload);
                      } catch (err) {
                        opts.runtime.error?.(`chanty reaction handler failed: ${String(err)}`);
                      }
                      return;
                    } */
                    if (payload?.eventType !== "message_post") {
                        return;
                    }
                    /* const parsed = parsePostedPayload(payload);
                    if (!parsed) {
                      return;
                    } */
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
