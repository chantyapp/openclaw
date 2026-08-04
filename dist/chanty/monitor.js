import { defineFinalizableLivePreviewAdapter, deliverWithFinalizableLivePreviewAdapter, } from "openclaw/plugin-sdk/channel-outbound";
import { buildChannelProgressDraftLineForEntry, createChannelProgressDraftCompositor, resolveChannelStreamingPreviewToolProgress, } from "openclaw/plugin-sdk/channel-outbound";
import { createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { buildTtsSupplementMediaPayload, getReplyPayloadTtsSupplement, isReasoningReplyPayload, } from "openclaw/plugin-sdk/reply-payload";
import { resolveInboundLastRouteSessionKey } from "openclaw/plugin-sdk/routing";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty, normalizeOptionalString, normalizeTrimmedStringList, uniqueStrings, } from "openclaw/plugin-sdk/string-coerce-runtime";
import { getChantyRuntime } from "../runtime.js";
import { resolveChantyAccount, resolveChantyReplyToMode, } from "./accounts.js";
import { createChantyClient, fetchChantyMe, normalizeChantyBaseUrl, updateChantyPost, } from "./client.js";
import { createChantyDraftStream } from "./draft-stream.js";
import { normalizeChantyAllowEntry, resolveChantyMonitorInboundAccess, } from "./monitor-auth.js";
import { mapChantyChannelTypeToChatType, resolveChantyTrustedChatKind, } from "./monitor-gating.js";
import { formatInboundFromLabel, normalizeMention, resolveThreadSessionKeys, shouldDropEmptyChantyBody, } from "./monitor-helpers.js";
import { resolveOncharPrefixes, stripOncharPrefix } from "./monitor-onchar.js";
import { createChantyMonitorResources, formatChantyInboundMediaText, } from "./monitor-resources.js";
import { createChantyConnectOnce, } from "./monitor-websocket.js";
import { evaluateChantyNoVisibleReply, formatChantyNoVisibleReplyLog, } from "./no-visible-reply-diagnostic.js";
import { runWithReconnect } from "./reconnect.js";
import { createChantyReplyDeliveryBarrier, deliverChantyReplyPayload, } from "./reply-delivery.js";
import { buildAgentMediaPayload, createChannelHistoryWindow, createChannelPairingController, createChannelMessageReplyPipeline, DEFAULT_GROUP_HISTORY_LIMIT, logTypingFailure, resolveAllowlistProviderRuntimeGroupPolicy, resolveChannelMediaMaxBytes, resolveDefaultGroupPolicy, warnMissingProviderGroupPolicyFallbackOnce, } from "./runtime-api.js";
import { sendMessageChanty } from "./send.js";
import { hasChantyThreadParticipationWithPersistence, recordChantyThreadParticipation, } from "./thread-participation.js";
export { evaluateChantyMentionGate, mapChantyChannelTypeToChatType, resolveChantyTrustedChatKind, } from "./monitor-gating.js";
export function shouldUpdateChantyDraftToolProgress(account) {
    return (account.streamingMode !== "off" && resolveChannelStreamingPreviewToolProgress(account.config));
}
export function shouldSuppressChantyDefaultToolProgressMessages(account) {
    return account.streamingMode !== "off";
}
const RECENT_CHANTY_MESSAGE_TTL_MS = 5 * 60_000;
const RECENT_CHANTY_MESSAGE_MAX = 2000;
function normalizeInteractionSourceIps(values) {
    return normalizeTrimmedStringList(values);
}
const recentInboundMessages = createClaimableDedupe({
    ttlMs: RECENT_CHANTY_MESSAGE_TTL_MS,
    memoryMaxSize: RECENT_CHANTY_MESSAGE_MAX,
});
export class ChantyRetryableInboundError extends Error {
    constructor(message, options) {
        super(message, options);
        this.name = "ChantyRetryableInboundError";
    }
}
export function buildChantyModelPickerSelectMessageSid(params) {
    const provider = normalizeLowercaseStringOrEmpty(params.provider);
    const model = normalizeLowercaseStringOrEmpty(params.model);
    return `interaction:${params.postId}:select:${provider}/${model}`;
}
function buildChantyInboundReplayKeys(params) {
    return uniqueStrings(params.messageIds.map((id) => `${params.accountId}:${id.trim()}`)).filter((key) => !key.endsWith(":"));
}
export async function processChantyReplayGuardedPost(params) {
    try {
        await params.handlePost();
        return "processed";
    }
    catch (error) {
        throw error;
    }
}
function resolveRuntime(opts) {
    return (opts.runtime ?? {
        log: console.log,
        error: console.error,
        exit: (code) => {
            throw new Error(`exit ${code}`);
        },
    });
}
function isSystemPost(post) {
    return normalizeOptionalString(post.type) !== undefined;
}
function channelChatType(kind) {
    if (kind === "direct") {
        return "direct";
    }
    if (kind === "group") {
        return "group";
    }
    return "channel";
}
export function resolveChantyReplyRootId(params) {
    if (params.kind === "direct") {
        return undefined;
    }
    const threadRootId = normalizeOptionalString(params.threadRootId);
    if (threadRootId) {
        return threadRootId;
    }
    return normalizeOptionalString(params.replyToId);
}
export function canFinalizeChantyPreviewInPlace(params) {
    return (resolveChantyReplyRootId({
        kind: params.kind,
        threadRootId: params.threadRootId,
        replyToId: params.replyToId,
    }) === params.previewRootId?.trim());
}
function createDisabledChantyDraftStream() {
    const noopAsync = async () => { };
    return {
        update: () => { },
        flush: noopAsync,
        postId: () => undefined,
        clear: noopAsync,
        discardPending: noopAsync,
        seal: noopAsync,
        stop: noopAsync,
        forceNewMessage: () => { },
    };
}
export async function deliverChantyReplyWithDraftPreview(params) {
    if (isReasoningReplyPayload(params.payload)) {
        return;
    }
    await deliverWithFinalizableLivePreviewAdapter({
        kind: params.info.kind,
        payload: params.payload,
        adapter: defineFinalizableLivePreviewAdapter({
            draft: {
                flush: params.draftStream.flush,
                clear: params.draftStream.clear,
                discardPending: params.draftStream.discardPending,
                seal: params.draftStream.seal,
                id: params.draftStream.postId,
            },
            buildFinalEdit: (payload) => {
                const hasMedia = Boolean(payload.mediaUrl) || (payload.mediaUrls?.length ?? 0) > 0;
                const ttsSupplement = getReplyPayloadTtsSupplement(payload);
                const previewFinalText = params.resolvePreviewFinalText(payload.text ?? ttsSupplement?.spokenText);
                if ((hasMedia && !ttsSupplement) ||
                    typeof previewFinalText !== "string" ||
                    payload.isError ||
                    !canFinalizeChantyPreviewInPlace({
                        kind: params.kind,
                        previewRootId: params.effectiveReplyToId,
                        threadRootId: params.effectiveReplyToId,
                        replyToId: payload.replyToId,
                    })) {
                    return undefined;
                }
                return { message: previewFinalText };
            },
            editFinal: async (previewPostId, edit) => {
                await updateChantyPost(params.client, previewPostId, edit);
            },
            onPreviewFinalized: () => {
                params.previewState.finalizedViaPreviewPost = true;
                params.recordThreadParticipation?.();
            },
            buildSupplementalPayload: (payload) => getReplyPayloadTtsSupplement(payload) ? buildTtsSupplementMediaPayload(payload) : undefined,
            deliverSupplemental: async (payload) => {
                await params.deliverPayload(payload);
            },
            logPreviewEditFailure: (err) => {
                params.logVerboseMessage(`chanty preview final edit failed; falling back to normal send (${String(err)})`);
            },
        }),
        deliverNormally: async (payload) => {
            const supplement = getReplyPayloadTtsSupplement(payload);
            await params.deliverPayload(supplement && !payload.text?.trim() && supplement.visibleTextAlreadyDelivered !== true
                ? { ...payload, text: supplement.spokenText }
                : payload);
        },
    });
}
export function formatChantyFinalDeliveryOutcomeLog(params) {
    const violation = evaluateChantyNoVisibleReply({
        outcome: params.outcome,
        payload: params.payload,
    });
    if (violation) {
        return formatChantyNoVisibleReplyLog({
            violation,
            to: params.to,
            accountId: params.accountId,
            agentId: params.agentId,
        });
    }
    if (params.outcome === "text" || params.outcome === "media") {
        return `delivered reply to ${params.to}`;
    }
    return undefined;
}
export function resolveChantyEffectiveReplyToId(params) {
    if (params.kind === "direct") {
        return undefined;
    }
    const threadRootId = normalizeOptionalString(params.threadRootId);
    if (threadRootId) {
        return threadRootId;
    }
    const postId = normalizeOptionalString(params.postId);
    if (!postId) {
        return undefined;
    }
    return params.replyToMode === "all" ||
        params.replyToMode === "first" ||
        params.replyToMode === "batched"
        ? postId
        : undefined;
}
export function resolveChantyThreadSessionContext(params) {
    const effectiveReplyToId = resolveChantyEffectiveReplyToId({
        kind: params.kind,
        postId: params.postId,
        replyToMode: params.replyToMode,
        threadRootId: params.threadRootId,
    });
    const threadKeys = resolveThreadSessionKeys({
        baseSessionKey: params.baseSessionKey,
        threadId: effectiveReplyToId,
        parentSessionKey: effectiveReplyToId ? params.baseSessionKey : undefined,
    });
    return {
        effectiveReplyToId,
        sessionKey: threadKeys.sessionKey,
        parentSessionKey: threadKeys.parentSessionKey,
    };
}
export function resolveChantyReactionChannelId(payload) {
    return (normalizeOptionalString(payload.broadcast?.channel_id) ??
        normalizeOptionalString(payload.data?.channel_id));
}
function buildChantyAttachmentPlaceholder(mediaList) {
    if (mediaList.length === 0) {
        return "";
    }
    if (mediaList.length === 1) {
        const kind = mediaList[0].kind === "unknown" ? "document" : mediaList[0].kind;
        return `<media:${kind}>`;
    }
    const allImages = mediaList.every((media) => media.kind === "image");
    const label = allImages ? "image" : "file";
    const suffix = mediaList.length === 1 ? label : `${label}s`;
    const tag = allImages ? "<media:image>" : "<media:document>";
    return `${tag} (${mediaList.length} ${suffix})`;
}
function buildChantyWsUrl(userData, token) {
    return `${userData.ws}?jid=${encodeURIComponent(userData.user.jid)}&token=${encodeURIComponent(token)}`;
}
export async function monitorChantyProvider(opts = {}) {
    const core = getChantyRuntime();
    const runtime = resolveRuntime(opts);
    const cfg = (opts.config ?? core.config.current());
    const account = resolveChantyAccount({
        cfg,
        accountId: opts.accountId,
    });
    const pairing = createChannelPairingController({
        core,
        channel: "chanty",
        accountId: account.accountId,
    });
    const botToken = normalizeOptionalString(opts.botToken) ?? normalizeOptionalString(account.botToken);
    if (!botToken) {
        throw new Error(`Chanty bot token missing for account "${account.accountId}" (set channels.chanty.accounts.${account.accountId}.botToken or CHANTY_BOT_TOKEN for default).`);
    }
    const baseUrl = normalizeChantyBaseUrl(opts.baseUrl ?? account.baseUrl);
    if (!baseUrl) {
        throw new Error(`Chanty baseUrl missing for account "${account.accountId}" (set channels.chanty.accounts.${account.accountId}.baseUrl or CHANTY_URL for default).`);
    }
    const client = createChantyClient({
        baseUrl,
        botToken,
        allowPrivateNetwork: isPrivateNetworkOptInEnabled(account.config),
    });
    let botUser;
    await runWithReconnect(async () => {
        botUser = await fetchChantyMe(client);
    }, {
        abortSignal: opts.abortSignal,
        jitterRatio: 0.2,
        shouldReconnect: ({ outcome }) => outcome === "rejected",
        onError: (err) => {
            runtime.error?.(`chanty: API auth failed: ${String(err)}`);
            opts.statusSink?.({ lastError: String(err), connected: false });
        },
        onReconnect: (delayMs) => {
            runtime.log?.(`chanty: API not accessible, retrying in ${Math.round(delayMs / 1000)}s`);
        },
    });
    if (opts.abortSignal?.aborted) {
        return;
    }
    const botUserId = botUser?.user?.jid;
    const botUsername = normalizeOptionalString(botUser?.user?.name);
    runtime.log?.(`chanty connected as ${botUserId}`);
    const logger = core.logging.getChildLogger({ module: "chanty" });
    const logVerboseMessage = (message) => {
        if (!core.logging.shouldLogVerbose()) {
            return;
        }
        logger.debug?.(message);
    };
    const mediaMaxBytes = resolveChannelMediaMaxBytes({
        cfg,
        resolveChannelLimitMb: () => undefined,
        accountId: account.accountId,
    }) ?? 8 * 1024 * 1024;
    const historyLimit = Math.max(0, cfg.messages?.groupChat?.historyLimit ?? DEFAULT_GROUP_HISTORY_LIMIT);
    const channelHistories = new Map();
    const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
    const dmPolicy = account.config.dmPolicy ?? "pairing";
    const { groupPolicy, providerMissingFallbackApplied } = resolveAllowlistProviderRuntimeGroupPolicy({
        providerConfigPresent: cfg.channels?.chanty !== undefined,
        groupPolicy: account.config.groupPolicy,
        defaultGroupPolicy,
    });
    warnMissingProviderGroupPolicyFallbackOnce({
        providerMissingFallbackApplied,
        providerKey: "chanty",
        accountId: account.accountId,
        log: (message) => logVerboseMessage(message),
    });
    const { resolveChantyMedia, sendTypingIndicator, resolveChannelInfo, resolveUserInfo, } = createChantyMonitorResources({
        accountId: account.accountId,
        callbackUrl: "",
        client,
        logger: {
            debug: (message) => logger.debug?.(String(message)),
        },
        mediaMaxBytes,
        saveRemoteMedia: (params) => core.channel.media.saveRemoteMedia(params),
        mediaKindFromMime: (contentType) => core.media.mediaKindFromMime(contentType),
    });
    const handlePost = async (payload, messageIds) => {
        const post = { ...payload };
        const channelId = post.convJid;
        if (!channelId) {
            logVerboseMessage("chanty: drop post (missing channel id)");
            return;
        }
        const allMessageIds = messageIds?.length ? messageIds : post.uri ? [post.uri] : [];
        if (allMessageIds.length === 0) {
            logVerboseMessage("chanty: drop post (missing message id)");
            return;
        }
        const replayResult = await processChantyReplayGuardedPost({
            accountId: account.accountId,
            messageIds: allMessageIds,
            handlePost: async () => {
                const senderId = post.createdBy.jid;
                if (!senderId) {
                    logVerboseMessage("chanty: drop post (missing sender id)");
                    return;
                }
                if (senderId === botUserId) {
                    logVerboseMessage(`chanty: drop post (self sender=${senderId})`);
                    return;
                }
                if (post.msgType !== 'chat') {
                    return;
                }
                const channelInfo = {};
                const channelType = payload.convType;
                if (!channelType) {
                    logVerboseMessage(`chanty: drop post (cannot resolve channel type for ${channelId})`);
                    return;
                }
                const kind = resolveChantyTrustedChatKind({
                    channelType,
                });
                const chatType = channelChatType(kind);
                const senderName = senderId;
                const rawPostText = post.text;
                const rawText = normalizeOptionalString(rawPostText) ?? "";
                const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
                    cfg,
                    surface: "chanty",
                });
                const isControlCommand = false;
                const accessDecision = await resolveChantyMonitorInboundAccess({
                    account,
                    cfg,
                    senderId,
                    senderName,
                    channelId,
                    kind,
                    groupPolicy,
                    readStoreAllowFrom: pairing.readAllowFromStore,
                    allowTextCommands,
                    hasControlCommand: isControlCommand,
                    eventKind: "message",
                    mayPair: true,
                });
                const commandAuthorized = accessDecision.commandAccess.authorized;
                const teamId = undefined;
                const channelName = payload.convJid;
                const channelDisplay = payload.convJid;
                const roomLabel = channelName ? `#${channelName}` : channelDisplay || `#${channelId}`;
                const route = core.channel.routing.resolveAgentRoute({
                    cfg,
                    channel: "chanty",
                    accountId: account.accountId,
                    teamId,
                    peer: {
                        kind,
                        id: kind === "direct" ? senderId : channelId,
                    },
                });
                const baseSessionKey = route.sessionKey;
                const threadRootId = normalizeOptionalString(post.root_id);
                const replyToMode = resolveChantyReplyToMode(account, kind);
                const threadContext = resolveChantyThreadSessionContext({
                    baseSessionKey,
                    kind,
                    postId: post.id,
                    replyToMode,
                    threadRootId,
                });
                const { effectiveReplyToId, sessionKey, parentSessionKey } = threadContext;
                const historyKey = kind === "direct" ? null : sessionKey;
                const mentionRegexes = core.channel.mentions.buildMentionRegexes(cfg, route.agentId);
                const wasMentioned = kind !== "direct" &&
                    ((botUsername
                        ? normalizeLowercaseStringOrEmpty(rawText).includes(`@${normalizeLowercaseStringOrEmpty(botUsername)}`)
                        : false) ||
                        core.channel.mentions.matchesMentionPatterns(rawText, mentionRegexes));
                const pendingBody = rawText ||
                    (post.file_ids?.length
                        ? `[Chanty ${post.file_ids.length === 1 ? "file" : "files"}]`
                        : "");
                const pendingSender = senderName;
                const recordPendingHistory = () => {
                    const trimmed = pendingBody.trim();
                    createChannelHistoryWindow({ historyMap: channelHistories }).record({
                        limit: historyLimit,
                        historyKey: historyKey ?? "",
                        entry: historyKey && trimmed
                            ? {
                                sender: pendingSender,
                                body: trimmed,
                                timestamp: typeof post.create_at === "number" ? post.create_at : undefined,
                                messageId: post.id ?? undefined,
                            }
                            : null,
                    });
                };
                const oncharEnabled = account.chatmode === "onchar" && kind !== "direct";
                const oncharPrefixes = oncharEnabled ? resolveOncharPrefixes(account.oncharPrefixes) : [];
                const oncharResult = oncharEnabled
                    ? stripOncharPrefix(rawText, oncharPrefixes)
                    : { triggered: false, stripped: rawText };
                const oncharTriggered = oncharResult.triggered;
                const canDetectMention = Boolean(botUsername) || mentionRegexes.length > 0;
                const threadAlreadyEngaged = kind !== "direct" && effectiveReplyToId
                    ? await hasChantyThreadParticipationWithPersistence({
                        accountId: account.accountId,
                        channelId,
                        threadRootId: effectiveReplyToId,
                    })
                    : false;
                const fileIds = uniqueStrings(normalizeTrimmedStringList(post.file_ids ?? []));
                const mediaList = await resolveChantyMedia(fileIds);
                const mediaPlaceholder = buildChantyAttachmentPlaceholder(mediaList);
                const bodySource = oncharTriggered ? oncharResult.stripped : rawText;
                const downloadedText = [bodySource, mediaPlaceholder].filter(Boolean).join("\n").trim();
                const baseText = formatChantyInboundMediaText({
                    body: downloadedText,
                    mediaPlaceholder,
                    expectedCount: fileIds.length,
                    mediaCount: mediaList.length,
                });
                const bodyText = normalizeMention(baseText, botUsername);
                if (shouldDropEmptyChantyBody({ bodyText, rawText: rawPostText, botUsername })) {
                    logVerboseMessage(`chanty: drop message (empty body after normalization channel=${channelId} sender=${senderId} wasMentioned=${wasMentioned})`);
                    return;
                }
                const bodyForAgent = bodyText || rawText.trim();
                core.channel.activity.record({
                    channel: "chanty",
                    accountId: account.accountId,
                    direction: "inbound",
                });
                const fromLabel = formatInboundFromLabel({
                    isGroup: kind !== "direct",
                    groupLabel: channelDisplay || roomLabel,
                    groupId: channelId,
                    groupFallback: roomLabel || "Channel",
                    directLabel: senderName,
                    directId: senderId,
                });
                const textWithId = `${bodyText}\n[chanty message id: ${post.id ?? "unknown"} channel: ${channelId}]`;
                const body = core.channel.reply.formatInboundEnvelope({
                    channel: "Chanty",
                    from: fromLabel,
                    timestamp: typeof post.create_at === "number" ? post.create_at : undefined,
                    body: textWithId,
                    chatType,
                    sender: { name: senderName, id: senderId },
                });
                let combinedBody = body;
                if (historyKey) {
                    const channelHistory = createChannelHistoryWindow({ historyMap: channelHistories });
                    combinedBody = channelHistory.buildPendingContext({
                        historyKey,
                        limit: historyLimit,
                        currentMessage: combinedBody,
                        formatEntry: (entry) => core.channel.reply.formatInboundEnvelope({
                            channel: "Chanty",
                            from: fromLabel,
                            timestamp: entry.timestamp,
                            body: `${entry.body}${entry.messageId ? ` [id:${entry.messageId} channel:${channelId}]` : ""}`,
                            chatType,
                            senderLabel: entry.sender,
                        }),
                    });
                }
                const to = kind === "direct" ? `user:${senderId}` : `channel:${channelId}`;
                const mediaPayload = buildAgentMediaPayload(mediaList);
                const commandBody = rawText.trim();
                const inboundHistory = historyKey && historyLimit > 0
                    ? createChannelHistoryWindow({ historyMap: channelHistories }).buildInboundHistory({
                        historyKey,
                        limit: historyLimit,
                    })
                    : undefined;
                const ctxPayload = core.channel.reply.finalizeInboundContext({
                    Body: combinedBody,
                    BodyForAgent: bodyForAgent,
                    InboundHistory: inboundHistory,
                    RawBody: commandBody,
                    CommandBody: commandBody,
                    BodyForCommands: commandBody,
                    From: kind === "direct"
                        ? `chanty:${senderId}`
                        : kind === "group"
                            ? `chanty:group:${channelId}`
                            : `chanty:channel:${channelId}`,
                    To: to,
                    SessionKey: sessionKey,
                    ParentSessionKey: parentSessionKey,
                    AccountId: route.accountId,
                    ChatType: chatType,
                    ConversationLabel: fromLabel,
                    GroupSubject: kind !== "direct" ? channelDisplay || roomLabel : undefined,
                    GroupChannel: channelName ? `#${channelName}` : undefined,
                    GroupSpace: teamId,
                    SenderName: senderName,
                    SenderId: senderId,
                    Provider: "chanty",
                    Surface: "chanty",
                    MessageSid: post.id ?? undefined,
                    MessageSids: allMessageIds.length > 1 ? allMessageIds : undefined,
                    MessageSidFirst: allMessageIds.length > 1 ? allMessageIds[0] : undefined,
                    MessageSidLast: allMessageIds.length > 1 ? allMessageIds[allMessageIds.length - 1] : undefined,
                    ReplyToId: effectiveReplyToId,
                    MessageThreadId: effectiveReplyToId,
                    Timestamp: typeof post.create_at === "number" ? post.create_at : undefined,
                    WasMentioned: undefined,
                    CommandAuthorized: commandAuthorized,
                    CommandSource: commandAuthorized && isControlCommand ? "text" : undefined,
                    OriginatingChannel: "chanty",
                    OriginatingTo: to,
                    ...mediaPayload,
                });
                const pinnedMainDmOwner = kind === "direct"
                    ? resolvePinnedMainDmOwnerFromAllowlist({
                        dmScope: cfg.session?.dmScope,
                        allowFrom: account.config.allowFrom,
                        normalizeEntry: normalizeChantyAllowEntry,
                    })
                    : null;
                const storePath = core.channel.session.resolveStorePath(cfg.session?.store, {
                    agentId: route.agentId,
                });
                const previewLine = bodyText.slice(0, 200).replace(/\n/g, "\\n");
                logVerboseMessage(`chanty inbound: from=${ctxPayload.From} len=${bodyText.length} preview="${previewLine}"`);
                const textLimit = core.channel.text.resolveTextChunkLimit(cfg, "chanty", account.accountId, {
                    fallbackLimit: account.textChunkLimit ?? 4000,
                });
                const tableMode = core.channel.text.resolveMarkdownTableMode({
                    cfg,
                    channel: "chanty",
                    accountId: account.accountId,
                });
                const { onModelSelected, typingCallbacks, ...replyPipeline } = createChannelMessageReplyPipeline({
                    cfg,
                    agentId: route.agentId,
                    channel: "chanty",
                    accountId: account.accountId,
                    typing: {
                        keepaliveIntervalMs: 5_000,
                        start: () => sendTypingIndicator(channelId, effectiveReplyToId),
                        onStartError: (err) => {
                            logTypingFailure({
                                log: (message) => logger.debug?.(message),
                                channel: "chanty",
                                target: channelId,
                                error: err,
                            });
                        },
                    },
                });
                const draftPreviewEnabled = false;
                const draftToolProgressEnabled = shouldUpdateChantyDraftToolProgress(account);
                const suppressDefaultToolProgressMessages = shouldSuppressChantyDefaultToolProgressMessages(account);
                const draftStream = draftPreviewEnabled
                    ? createChantyDraftStream({
                        client,
                        channelId,
                        rootId: effectiveReplyToId,
                        throttleMs: 1200,
                        log: logVerboseMessage,
                        warn: logVerboseMessage,
                    })
                    : createDisabledChantyDraftStream();
                let lastPartialText = "";
                const progressDraft = createChannelProgressDraftCompositor({
                    entry: account.config,
                    mode: account.streamingMode,
                    active: draftPreviewEnabled,
                    seed: `${account.accountId}:${channelId}`,
                    update: async (previewText, options) => {
                        draftStream.update(previewText);
                        if (options?.flush) {
                            await draftStream.flush();
                        }
                    },
                });
                const previewState = {
                    finalizedViaPreviewPost: false,
                };
                const resolvePreviewFinalText = (text) => {
                    if (typeof text !== "string") {
                        return undefined;
                    }
                    const formatted = core.channel.text.convertMarkdownTables(text, tableMode);
                    const chunkMode = core.channel.text.resolveChunkMode(cfg, "chanty", account.accountId);
                    const chunks = core.channel.text.chunkMarkdownTextWithMode(formatted, textLimit, chunkMode);
                    if (!chunks.length && formatted) {
                        chunks.push(formatted);
                    }
                    if (chunks.length != 1) {
                        return undefined;
                    }
                    const trimmed = chunks[0]?.trim();
                    if (!trimmed) {
                        return undefined;
                    }
                    if (lastPartialText &&
                        lastPartialText.startsWith(trimmed) &&
                        trimmed.length < lastPartialText.length) {
                        return undefined;
                    }
                    return trimmed;
                };
                const updateDraftFromPartial = (text) => {
                    const cleaned = text?.trim();
                    if (!cleaned) {
                        return;
                    }
                    if (cleaned === lastPartialText) {
                        return;
                    }
                    if (lastPartialText &&
                        lastPartialText.startsWith(cleaned) &&
                        cleaned.length < lastPartialText.length) {
                        return;
                    }
                    lastPartialText = cleaned;
                    draftStream.update(cleaned);
                };
                const deliveryBarrier = createChantyReplyDeliveryBarrier({
                    isDirect: kind === "direct",
                    dmRetryOptions: account.config.dmChannelRetry,
                });
                const { dispatcher, replyOptions, markDispatchIdle, markRunComplete } = core.channel.reply.createReplyDispatcherWithTyping({
                    ...replyPipeline,
                    resolveFollowupAdmissionBarrierTimeoutPolicy: deliveryBarrier.resolveTimeoutPolicy,
                    onDeliverySettled: deliveryBarrier.markDeliverySettled,
                    humanDelay: core.channel.reply.resolveHumanDelayConfig(cfg, route.agentId),
                    typingCallbacks,
                    deliver: async (payloadEntry, info) => {
                        if (info.kind === "final") {
                            progressDraft.markFinalReplyStarted();
                        }
                        const markThreadParticipation = () => {
                            if (kind !== "direct" && effectiveReplyToId) {
                                recordChantyThreadParticipation(account.accountId, channelId, effectiveReplyToId, { agentId: route.agentId });
                            }
                        };
                        await deliverChantyReplyWithDraftPreview({
                            payload: payloadEntry,
                            info,
                            kind,
                            client,
                            draftStream,
                            effectiveReplyToId,
                            resolvePreviewFinalText,
                            previewState,
                            logVerboseMessage,
                            recordThreadParticipation: markThreadParticipation,
                            deliverPayload: async (payloadToDeliver) => {
                                const outcome = await deliverChantyReplyPayload({
                                    core,
                                    cfg,
                                    payload: payloadToDeliver,
                                    to,
                                    accountId: account.accountId,
                                    agentId: route.agentId,
                                    replyToId: resolveChantyReplyRootId({
                                        kind,
                                        threadRootId: effectiveReplyToId,
                                        replyToId: payloadToDeliver.replyToId,
                                    }),
                                    textLimit,
                                    tableMode,
                                    sendMessage: sendMessageChanty,
                                    onDmChannelResolution: deliveryBarrier.trackDmChannelResolution,
                                });
                                if (outcome === "text" || outcome === "media") {
                                    markThreadParticipation();
                                }
                                const deliveryLog = formatChantyFinalDeliveryOutcomeLog({
                                    outcome,
                                    payload: payloadToDeliver,
                                    to,
                                    accountId: account.accountId,
                                    agentId: route.agentId,
                                });
                                if (deliveryLog) {
                                    runtime.log?.(deliveryLog);
                                }
                            },
                        });
                        if (info.kind === "final") {
                            progressDraft.markFinalReplyDelivered();
                        }
                    },
                    onError: (err, info) => {
                        runtime.error?.(`chanty ${info.kind} reply failed: ${String(err)}`);
                    },
                });
                const inboundLastRouteSessionKey = resolveInboundLastRouteSessionKey({
                    route,
                    sessionKey: route.sessionKey,
                });
                let dispatchSettledBeforeStart = false;
                try {
                    await core.channel.inbound.run({
                        channel: "chanty",
                        accountId: route.accountId,
                        raw: post,
                        adapter: {
                            ingest: () => ({
                                id: post.id ?? `${to}:${Date.now()}`,
                                timestamp: post.create_at ?? undefined,
                                rawText,
                                textForAgent: ctxPayload.BodyForAgent,
                                textForCommands: ctxPayload.CommandBody,
                                raw: post,
                            }),
                            resolveTurn: () => ({
                                channel: "chanty",
                                accountId: route.accountId,
                                routeSessionKey: route.sessionKey,
                                storePath,
                                ctxPayload,
                                recordInboundSession: core.channel.session.recordInboundSession,
                                record: {
                                    updateLastRoute: kind === "direct"
                                        ? {
                                            sessionKey: inboundLastRouteSessionKey,
                                            channel: "chanty",
                                            to,
                                            accountId: route.accountId,
                                            mainDmOwnerPin: inboundLastRouteSessionKey === route.mainSessionKey && pinnedMainDmOwner
                                                ? {
                                                    ownerRecipient: pinnedMainDmOwner,
                                                    senderRecipient: normalizeChantyAllowEntry(senderId),
                                                    onSkip: ({ ownerRecipient, senderRecipient, }) => {
                                                        logVerboseMessage(`chanty: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`);
                                                    },
                                                }
                                                : undefined,
                                        }
                                        : undefined,
                                    onRecordError: (err) => {
                                        logVerboseMessage(`chanty: failed updating session meta id=${post.id ?? "unknown"}: ${String(err)}`);
                                    },
                                },
                                history: {
                                    isGroup: Boolean(historyKey),
                                    historyKey: historyKey ?? undefined,
                                    historyMap: channelHistories,
                                    limit: historyLimit,
                                },
                                onPreDispatchFailure: async () => {
                                    dispatchSettledBeforeStart = true;
                                    await core.channel.reply.settleReplyDispatcher({
                                        dispatcher,
                                        onSettled: () => {
                                            markRunComplete();
                                            markDispatchIdle();
                                        },
                                    });
                                },
                                runDispatch: () => core.channel.reply.withReplyDispatcher({
                                    dispatcher,
                                    onSettled: () => {
                                        markDispatchIdle();
                                    },
                                    run: () => core.channel.reply.dispatchReplyFromConfig({
                                        ctx: ctxPayload,
                                        cfg,
                                        dispatcher,
                                        replyOptions: {
                                            ...replyOptions,
                                            allowProgressCallbacksWhenSourceDeliverySuppressed: draftToolProgressEnabled ? true : undefined,
                                            onObservedReplyDelivery: draftToolProgressEnabled
                                                ? () => draftStream.clear()
                                                : undefined,
                                            disableBlockStreaming: true,
                                            ...(suppressDefaultToolProgressMessages
                                                ? { suppressDefaultToolProgressMessages: true }
                                                : {}),
                                            onModelSelected,
                                            onPartialReply: (payloadResult) => {
                                                if (account.streamingMode !== "progress") {
                                                    updateDraftFromPartial(payloadResult.text);
                                                }
                                            },
                                            onAssistantMessageStart: () => {
                                                lastPartialText = "";
                                                progressDraft.resetReasoningProgress();
                                                if (account.streamingMode !== "progress") {
                                                    progressDraft.reset();
                                                }
                                            },
                                            onReasoningEnd: () => {
                                                lastPartialText = "";
                                                progressDraft.resetReasoningProgress();
                                                if (account.streamingMode !== "progress") {
                                                    progressDraft.reset();
                                                }
                                            },
                                            onReasoningStream: async (payloadResult) => {
                                                if (account.streamingMode === "progress") {
                                                    await progressDraft.pushReasoningProgress(payloadResult.text || "Thinking…", { snapshot: payloadResult.isReasoningSnapshot === true });
                                                    return;
                                                }
                                                if (!lastPartialText) {
                                                    draftStream.update("Thinking…");
                                                }
                                            },
                                            onToolStart: async (payloadValue) => {
                                                if (!draftToolProgressEnabled) {
                                                    return;
                                                }
                                                await progressDraft.pushToolProgress(buildChannelProgressDraftLineForEntry(account.config, {
                                                    event: "tool",
                                                    itemId: payloadValue.itemId,
                                                    toolCallId: payloadValue.toolCallId,
                                                    name: payloadValue.name,
                                                    phase: payloadValue.phase,
                                                    args: payloadValue.args,
                                                }, payloadValue.detailMode
                                                    ? { detailMode: payloadValue.detailMode }
                                                    : undefined), { startImmediately: true });
                                            },
                                            onItemEvent: async (payloadLocal) => {
                                                if (!draftToolProgressEnabled) {
                                                    return;
                                                }
                                                await progressDraft.pushToolProgress(buildChannelProgressDraftLineForEntry(account.config, {
                                                    event: "item",
                                                    itemId: payloadLocal.itemId,
                                                    itemKind: payloadLocal.kind,
                                                    title: payloadLocal.title,
                                                    name: payloadLocal.name,
                                                    phase: payloadLocal.phase,
                                                    status: payloadLocal.status,
                                                    summary: payloadLocal.summary,
                                                    progressText: payloadLocal.progressText,
                                                    meta: payloadLocal.meta,
                                                }), { startImmediately: true });
                                            },
                                        },
                                    }),
                                }),
                            }),
                        },
                    });
                }
                finally {
                    try {
                        await draftStream.stop();
                    }
                    catch (err) {
                        logVerboseMessage(`chanty draft preview cleanup failed: ${String(err)}`);
                    }
                    if (!dispatchSettledBeforeStart) {
                        markRunComplete();
                    }
                }
            },
        });
        if (replayResult === "duplicate") {
            logVerboseMessage(`chanty: drop post (dedupe account=${account.accountId} ids=${allMessageIds.length})`);
        }
    };
    const handleReactionEvent = async (payload) => {
        const reactionData = payload.data?.reaction;
        if (!reactionData) {
            return;
        }
        let reaction = null;
        if (typeof reactionData === "string") {
            try {
                reaction = JSON.parse(reactionData);
            }
            catch {
                return;
            }
        }
        else if (typeof reactionData === "object") {
            reaction = reactionData;
        }
        if (!reaction) {
            return;
        }
        const userId = reaction.user_id?.trim();
        const postId = reaction.post_id?.trim();
        const emojiName = reaction.emoji_name?.trim();
        if (!userId || !postId || !emojiName) {
            return;
        }
        if (userId === botUserId) {
            return;
        }
        const isRemoved = payload.event === "reaction_removed";
        const action = isRemoved ? "removed" : "added";
        const senderInfo = await resolveUserInfo(userId);
        const senderName = normalizeOptionalString(senderInfo?.username) ?? userId;
        const channelId = resolveChantyReactionChannelId(payload);
        if (!channelId) {
            logVerboseMessage(`chanty: drop reaction (no channel_id in broadcast, cannot enforce policy)`);
            return;
        }
        const channelInfo = await resolveChannelInfo(channelId);
        if (!channelInfo?.type) {
            logVerboseMessage(`chanty: drop reaction (cannot resolve channel type for ${channelId})`);
            return;
        }
        const kind = mapChantyChannelTypeToChatType(channelInfo.type);
        const reactionAccess = await resolveChantyMonitorInboundAccess({
            account,
            cfg,
            senderId: userId,
            senderName,
            channelId,
            kind,
            groupPolicy,
            readStoreAllowFrom: pairing.readAllowFromStore,
            allowTextCommands: false,
            hasControlCommand: false,
            eventKind: "reaction",
            mayPair: false,
        });
        if (reactionAccess.ingress.decision !== "allow") {
            if (kind === "direct") {
                logVerboseMessage(`chanty: drop reaction (dmPolicy=${dmPolicy} sender=${userId} reason=${reactionAccess.senderAccess.reasonCode})`);
            }
            else {
                logVerboseMessage(`chanty: drop reaction (groupPolicy=${groupPolicy} sender=${userId} reason=${reactionAccess.senderAccess.reasonCode} channel=${channelId})`);
            }
            return;
        }
        const teamId = channelInfo?.team_id ?? undefined;
        const route = core.channel.routing.resolveAgentRoute({
            cfg,
            channel: "chanty",
            accountId: account.accountId,
            teamId,
            peer: {
                kind,
                id: kind === "direct" ? userId : channelId,
            },
        });
        const sessionKey = route.sessionKey;
        const eventText = `Chanty reaction ${action}: :${emojiName}: by @${senderName} on post ${postId} in channel ${channelId}`;
        core.system.enqueueSystemEvent(eventText, {
            sessionKey,
            contextKey: `chanty:reaction:${postId}:${emojiName}:${userId}:${action}`,
        });
        logVerboseMessage(`chanty reaction: ${action} :${emojiName}: by ${senderName} on ${postId}`);
    };
    const inboundDebounceMs = core.channel.debounce.resolveInboundDebounceMs({
        cfg,
        channel: "chanty",
    });
    const debouncer = core.channel.debounce.createInboundDebouncer({
        debounceMs: inboundDebounceMs,
        buildKey: (entry) => {
            return `chanty:${account.accountId}:${entry.payload.uri}`;
        },
        shouldDebounce: (entry) => {
            return true;
        },
        onFlush: async (entries) => {
            const last = entries.at(-1);
            if (!last) {
                return;
            }
            entries.forEach(async () => {
                await handlePost(last.payload);
            });
            return;
        },
        onError: (err) => {
            runtime.error?.(`chanty debounce flush failed: ${String(err)}`);
        },
    });
    const wsUrl = buildChantyWsUrl(botUser, botToken);
    let seq = 1;
    const connectOnce = createChantyConnectOnce({
        wsUrl,
        client,
        abortSignal: opts.abortSignal,
        statusSink: opts.statusSink,
        runtime,
        webSocketFactory: opts.webSocketFactory,
        nextSeq: () => seq++,
        onPosted: async (payload) => {
            await debouncer.enqueue({ payload });
        },
        onReaction: async (payload) => {
            await handleReactionEvent(payload);
        },
    });
    try {
        await runWithReconnect(connectOnce, {
            abortSignal: opts.abortSignal,
            jitterRatio: 0.2,
            onError: (err) => {
                runtime.error?.(`chanty connection failed: ${String(err)}`);
                opts.statusSink?.({ lastError: String(err), connected: false });
            },
            onReconnect: (delayMs) => {
                runtime.log?.(`chanty reconnecting in ${Math.round(delayMs / 1000)}s`);
            },
        });
    }
    finally {
    }
}
