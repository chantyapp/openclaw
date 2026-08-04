import { createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { createChannelMessageAdapterFromOutbound } from "openclaw/plugin-sdk/channel-outbound";
import { createLoggedPairingApprovalNotifier } from "openclaw/plugin-sdk/channel-pairing";
import { createRestrictSendersChannelSecurity } from "openclaw/plugin-sdk/channel-policy";
import { attachChannelToResult, createAttachedChannelResultAdapter, } from "openclaw/plugin-sdk/channel-send-result";
import { createChannelDirectoryAdapter } from "openclaw/plugin-sdk/directory-runtime";
import { buildPassiveProbedChannelStatusSummary } from "openclaw/plugin-sdk/extension-shared";
import { normalizeMessagePresentation, renderMessagePresentationFallbackText, resolveMessagePresentationControlValue, } from "openclaw/plugin-sdk/interactive-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { resolvePayloadMediaUrls, sendTextMediaPayload } from "openclaw/plugin-sdk/reply-payload";
import { isPrivateNetworkOptInEnabled } from "openclaw/plugin-sdk/ssrf-runtime";
import { createComputedAccountStatusAdapter, createDefaultChannelRuntimeState, } from "openclaw/plugin-sdk/status-helpers";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { sanitizeAssistantVisibleText } from "openclaw/plugin-sdk/text-chunking";
import { chantyApprovalAuth } from "./approval-auth.js";
import { chunkTextForOutbound, createAccountStatusSink, DEFAULT_ACCOUNT_ID, } from "./channel-api.js";
import { describeChantyAccount, isChantyConfigured, chantyConfigAdapter, chantyMeta as meta, normalizeChantyAllowEntry as normalizeAllowEntry, resolveChantyGatewayAuthBypassPaths, } from "./channel-config-shared.js";
import { ChantyChannelConfigSchema } from "./config-surface.js";
import { chantyDoctor } from "./doctor.js";
import { resolveChantyGroupRequireMention } from "./group-mentions.js";
import { listChantyAccountIds, resolveDefaultChantyAccountId, resolveChantyAccount, resolveChantyReplyToMode, } from "./chanty/accounts.js";
import { looksLikeChantyTargetId, normalizeChantyMessagingTarget } from "./normalize.js";
import { collectRuntimeConfigAssignments, secretTargetRegistryEntries } from "./secret-contract.js";
import { resolveChantyOutboundSessionRoute } from "./session-route.js";
import { chantySetupAdapter } from "./setup-core.js";
import { chantySetupWizard } from "./setup-surface.js";
const loadChantyChannelRuntime = createLazyRuntimeModule(() => import("./channel.runtime.js"));
function buildChantyPresentationButtons(presentation) {
    return presentation.blocks
        .filter((block) => block.type === "buttons")
        .map((block) => block.buttons.flatMap((button) => {
        if (button.action) {
            return [];
        }
        const value = resolveMessagePresentationControlValue(button);
        return value
            ? [
                {
                    id: value,
                    text: button.label,
                    callback_data: value,
                    context: {
                        callback_data: value,
                    },
                    style: button.style,
                },
            ]
            : [];
    }))
        .filter((row) => row.length > 0);
}
const CHANTY_PRESENTATION_CAPABILITIES = {
    supported: true,
    buttons: true,
    selects: false,
    context: true,
    divider: false,
    limits: {
        text: {
            markdownDialect: "markdown",
        },
    },
};
function hasChantyPresentationButtons(presentation) {
    return buildChantyPresentationButtons(presentation).some((row) => row.length > 0);
}
function readChantyPresentationButtons(payload) {
    const buttons = payload.channelData?.chanty
        ?.presentationButtons;
    return Array.isArray(buttons) ? buttons : undefined;
}
const chantySecurityAdapter = createRestrictSendersChannelSecurity({
    channelKey: "chanty",
    resolveDmPolicy: (account) => account.config.dmPolicy,
    resolveDmAllowFrom: (account) => account.config.allowFrom,
    resolveGroupPolicy: (account) => account.config.groupPolicy,
    surface: "Chanty channels",
    openScope: "any member",
    groupPolicyPath: "channels.chanty.groupPolicy",
    groupAllowFromPath: "channels.chanty.groupAllowFrom",
    policyPathSuffix: "dmPolicy",
    normalizeDmEntry: (raw) => normalizeAllowEntry(raw),
});
function describeChantyMessageTool({ cfg, accountId, }) {
    const enabledAccounts = (accountId
        ? [resolveChantyAccount({ cfg, accountId })]
        : listChantyAccountIds(cfg).map((listedAccountId) => resolveChantyAccount({ cfg, accountId: listedAccountId })))
        .filter((account) => account.enabled)
        .filter((account) => Boolean(account.botToken?.trim() && account.baseUrl?.trim()));
    const actions = [];
    if (enabledAccounts.length > 0) {
        actions.push("send");
    }
    const actionsConfig = cfg.channels?.chanty?.actions;
    const baseReactions = actionsConfig?.reactions;
    const hasReactionCapableAccount = enabledAccounts.some((account) => {
        const accountActions = account.config.actions;
        return accountActions?.reactions ?? baseReactions ?? true;
    });
    if (hasReactionCapableAccount) {
        actions.push("react");
    }
    return {
        actions,
        capabilities: enabledAccounts.length > 0 ? ["presentation"] : [],
    };
}
function hasConfiguredChantyDirectoryAccount({ cfg, accountId, }) {
    const accounts = accountId
        ? [resolveChantyAccount({ cfg, accountId })]
        : listChantyAccountIds(cfg).map((listedAccountId) => resolveChantyAccount({ cfg, accountId: listedAccountId }));
    return accounts.some((account) => Boolean(account.enabled && account.botToken?.trim() && account.baseUrl?.trim()));
}
function extractChantyToolSend(args) {
    if (normalizeOptionalString(args.action) !== "send") {
        return null;
    }
    const to = normalizeOptionalString(args.to) ?? normalizeOptionalString(args.target);
    if (!to) {
        return null;
    }
    const threadId = normalizeOptionalString(args.threadId) ??
        normalizeOptionalString(args.replyToId) ??
        normalizeOptionalString(args.replyTo);
    const threadSuppressed = args.topLevel === true || args.threadId === null;
    return {
        to,
        accountId: normalizeOptionalString(args.accountId),
        ...(threadId ? { threadId } : {}),
        ...(!threadId && !threadSuppressed ? { threadImplicit: true } : {}),
        ...(threadSuppressed ? { threadSuppressed: true } : {}),
    };
}
function extractChantyToolSendResult(result, send) {
    if (!result || typeof result !== "object") {
        return null;
    }
    const details = result.details;
    if (!details || typeof details !== "object") {
        return null;
    }
    const toolSend = details.toolSend;
    if (!toolSend || typeof toolSend !== "object") {
        return null;
    }
    const record = toolSend;
    const to = normalizeOptionalString(record.to);
    if (!to) {
        return null;
    }
    const threadId = normalizeOptionalString(record.threadId);
    const originalTarget = normalizeOptionalString(send.to);
    const preserveOriginalTarget = originalTarget?.startsWith("user:") === true || originalTarget?.startsWith("@") === true;
    return {
        to: preserveOriginalTarget ? originalTarget : to,
        ...(threadId ? { threadId } : {}),
    };
}
function resolveChantyAutoThreadId(params) {
    const replyToId = normalizeOptionalString(params.replyToId);
    const context = params.toolContext;
    const currentThreadId = normalizeOptionalString(context?.currentThreadTs);
    const currentMessageId = typeof context?.currentMessageId === "number"
        ? String(context.currentMessageId)
        : normalizeOptionalString(context?.currentMessageId);
    const currentTarget = normalizeChantyThreadTarget(context?.currentChannelId);
    if (currentThreadId && currentTarget === normalizeChantyThreadTarget(params.to)) {
        if (replyToId === currentMessageId) {
            return currentThreadId;
        }
        if (!replyToId) {
            const replyToMode = context?.replyToMode;
            const canInheritThread = replyToMode === "all" ||
                (replyToMode === "first" && context?.hasRepliedRef?.value !== true);
            return canInheritThread ? currentThreadId : undefined;
        }
    }
    return replyToId;
}
function normalizeChantyThreadTarget(raw) {
    const normalized = raw ? normalizeChantyMessagingTarget(raw) : undefined;
    if (normalized) {
        return normalized;
    }
    const trimmed = normalizeOptionalString(raw);
    return trimmed && /^[a-z0-9]{26}$/i.test(trimmed) ? `channel:${trimmed}` : undefined;
}
function matchesChantyToolContextTarget(params) {
    const target = normalizeChantyThreadTarget(params.target);
    if (!target) {
        return false;
    }
    return [params.toolContext.currentChannelId, params.toolContext.currentMessagingTarget].some((currentTarget) => normalizeChantyThreadTarget(currentTarget) === target);
}
function normalizeChantyThreadId(value) {
    return typeof value === "number" ? String(value) : normalizeOptionalString(value);
}
function buildChantyThreadingToolContext(params) {
    const account = resolveChantyAccount({
        cfg: params.cfg,
        accountId: params.accountId ?? resolveDefaultChantyAccountId(params.cfg),
    });
    const chatType = params.context.ChatType === "direct" ||
        params.context.ChatType === "group" ||
        params.context.ChatType === "channel"
        ? params.context.ChatType
        : "channel";
    const configuredReplyToMode = resolveChantyReplyToMode(account, chatType);
    const currentThreadTs = normalizeChantyThreadId(params.context.MessageThreadId) ??
        normalizeChantyThreadId(params.context.TransportThreadId) ??
        normalizeOptionalString(params.context.ReplyToId);
    const currentMessageId = normalizeChantyThreadId(params.context.CurrentMessageId);
    const hasExistingThread = Boolean(currentThreadTs) && (!currentMessageId || currentThreadTs !== currentMessageId);
    const currentChannelId = params.context.To
        ? normalizeChantyMessagingTarget(params.context.To)
        : undefined;
    return {
        currentChannelId,
        currentThreadTs,
        currentMessageId: params.context.CurrentMessageId,
        replyToMode: hasExistingThread ? "all" : configuredReplyToMode,
        hasRepliedRef: params.hasRepliedRef,
        sameChannelThreadRequired: Boolean(currentThreadTs),
    };
}
async function listChantyDirectoryGroups(params) {
    if (!hasConfiguredChantyDirectoryAccount(params)) {
        return [];
    }
    return (await loadChantyChannelRuntime()).listChantyDirectoryGroups(params);
}
async function listChantyDirectoryPeers(params) {
    if (!hasConfiguredChantyDirectoryAccount(params)) {
        return [];
    }
    return (await loadChantyChannelRuntime()).listChantyDirectoryPeers(params);
}
const chantyMessageActions = {
    describeMessageTool: describeChantyMessageTool,
    extractToolSend: ({ args }) => extractChantyToolSend(args),
    extractToolSendResult: ({ result, send }) => extractChantyToolSendResult(result, send),
    supportsAction: ({ action }) => {
        return action === "send" || action === "react";
    },
    handleAction: async ({ action, params, cfg, accountId, mediaAccess, mediaLocalRoots, mediaReadFile, }) => {
        if (action === "react") {
            const resolvedAccountId = accountId ?? resolveDefaultChantyAccountId(cfg);
            const chantyConfig = cfg.channels?.chanty;
            const account = resolveChantyAccount({ cfg, accountId: resolvedAccountId });
            const reactionsEnabled = account.config.actions?.reactions ?? chantyConfig?.actions?.reactions ?? true;
            if (!reactionsEnabled) {
                throw new Error("Chanty reactions are disabled in config");
            }
            const { postId, emojiName, remove } = parseChantyReactActionParams(params);
            if (remove) {
                const result = await (await loadChantyChannelRuntime()).removeChantyReaction({
                    cfg,
                    postId,
                    emojiName,
                    accountId: resolvedAccountId,
                });
                if (!result.ok) {
                    throw new Error(result.error);
                }
                return {
                    content: [
                        { type: "text", text: `Removed reaction :${emojiName}: from ${postId}` },
                    ],
                    details: {},
                };
            }
            const result = await (await loadChantyChannelRuntime()).addChantyReaction({
                cfg,
                postId,
                emojiName,
                accountId: resolvedAccountId,
            });
            if (!result.ok) {
                throw new Error(result.error);
            }
            return {
                content: [{ type: "text", text: `Reacted with :${emojiName}: on ${postId}` }],
                details: {},
            };
        }
        if (action !== "send") {
            throw new Error(`Unsupported Chanty action: ${action}`);
        }
        const to = typeof params.to === "string"
            ? params.to.trim()
            : typeof params.target === "string"
                ? params.target.trim()
                : "";
        if (!to) {
            throw new Error("Chanty send requires a target (to).");
        }
        const presentation = normalizeMessagePresentation(params.presentation);
        const message = presentation
            ? renderMessagePresentationFallbackText({
                text: typeof params.message === "string" ? params.message : "",
                presentation,
            })
            : typeof params.message === "string"
                ? params.message
                : "";
        const replyToId = normalizeOptionalString(params.replyToId) ??
            normalizeOptionalString(params.threadId) ??
            normalizeOptionalString(params.replyTo);
        const resolvedAccountId = accountId || undefined;
        const attachmentMedia = collectChantyAttachmentMedia(params);
        if (attachmentMedia.hasUnsupportedAttachmentPayload) {
            throw new Error("Chanty send attachments require media, mediaUrl, path, filePath, fileUrl, mediaUrls, or attachments[] with one of those fields; buffer/base64 payloads are not supported.");
        }
        if (attachmentMedia.mediaUrls.length > 1) {
            throw new Error("Chanty send supports one attachment per message; split multiple mediaUrls or attachments[] entries into separate sends.");
        }
        const buttons = presentation ? buildChantyPresentationButtons(presentation) : [];
        const result = await (await loadChantyChannelRuntime()).sendMessageChanty(to, message, {
            cfg,
            accountId: resolvedAccountId,
            replyToId,
            buttons: buttons.length > 0 ? buttons : undefined,
            attachmentText: typeof params.attachmentText === "string" ? params.attachmentText : undefined,
            mediaUrl: attachmentMedia.mediaUrls[0],
            mediaLocalRoots: mediaLocalRoots ?? mediaAccess?.localRoots,
            mediaReadFile: mediaReadFile ?? mediaAccess?.readFile,
            ...(mediaAccess?.workspaceDir ? { workspaceDir: mediaAccess.workspaceDir } : {}),
            requireMediaUpload: requiresChantyMediaUpload(attachmentMedia.mediaUrls[0])
                ? true
                : undefined,
        });
        return {
            content: [
                {
                    type: "text",
                    text: JSON.stringify({
                        ok: true,
                        channel: "chanty",
                        messageId: result.messageId,
                        channelId: result.channelId,
                    }),
                },
            ],
            details: {
                toolSend: {
                    to: `channel:${result.channelId}`,
                    ...(replyToId ? { threadId: replyToId } : {}),
                },
            },
        };
    },
};
function parseChantyReactActionParams(params) {
    const postId = normalizeOptionalString(params.messageId) ?? normalizeOptionalString(params.postId);
    if (!postId) {
        throw new Error("Chanty react requires messageId (post id)");
    }
    const emojiName = normalizeOptionalString(params.emoji)?.replace(/^:+|:+$/g, "");
    if (!emojiName) {
        throw new Error("Chanty react requires emoji");
    }
    return {
        postId,
        emojiName,
        remove: params.remove === true,
    };
}
function collectNonBlankStrings(values) {
    const collected = [];
    const seen = new Set();
    for (const value of values) {
        const trimmed = value?.trim();
        if (trimmed && !seen.has(trimmed)) {
            seen.add(trimmed);
            collected.push(trimmed);
        }
    }
    return collected;
}
function toSnakeCaseKey(key) {
    return key
        .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
        .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
        .toLowerCase();
}
function readChantyParam(params, key) {
    if (Object.hasOwn(params, key)) {
        return params[key];
    }
    const snakeKey = toSnakeCaseKey(key);
    return snakeKey === key || !Object.hasOwn(params, snakeKey) ? undefined : params[snakeKey];
}
function readChantyStringParam(params, key) {
    const raw = readChantyParam(params, key);
    return typeof raw === "string" ? normalizeOptionalString(raw) : undefined;
}
function readChantyStringArrayParam(params, key) {
    const raw = readChantyParam(params, key);
    if (Array.isArray(raw)) {
        return raw
            .filter((entry) => typeof entry === "string")
            .flatMap((entry) => {
            const normalized = normalizeOptionalString(entry);
            return normalized ? [normalized] : [];
        });
    }
    if (typeof raw === "string") {
        const normalized = normalizeOptionalString(raw);
        return normalized ? [normalized] : [];
    }
    return [];
}
function requiresChantyMediaUpload(mediaUrl) {
    const normalized = normalizeOptionalString(mediaUrl);
    return Boolean(normalized && !/^https?:\/\//i.test(normalized));
}
function collectChantyAttachmentMedia(params) {
    const mediaUrlCandidates = [
        readChantyStringParam(params, "media"),
        readChantyStringParam(params, "mediaUrl"),
        readChantyStringParam(params, "path"),
        readChantyStringParam(params, "filePath"),
        readChantyStringParam(params, "fileUrl"),
    ];
    mediaUrlCandidates.push(...readChantyStringArrayParam(params, "mediaUrls"));
    let hasUnsupportedAttachmentPayload = typeof params.buffer === "string" || typeof params.base64 === "string";
    if (Array.isArray(params.attachments)) {
        for (const attachment of params.attachments) {
            if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
                continue;
            }
            const record = attachment;
            mediaUrlCandidates.push(readChantyStringParam(record, "media"), readChantyStringParam(record, "mediaUrl"), readChantyStringParam(record, "path"), readChantyStringParam(record, "filePath"), readChantyStringParam(record, "fileUrl"), readChantyStringParam(record, "url"));
            hasUnsupportedAttachmentPayload ||= typeof record.buffer === "string";
            hasUnsupportedAttachmentPayload ||= typeof record.base64 === "string";
        }
    }
    return {
        mediaUrls: collectNonBlankStrings(mediaUrlCandidates),
        hasUnsupportedAttachmentPayload,
    };
}
const chantyOutbound = {
    deliveryMode: "direct",
    chunker: chunkTextForOutbound,
    chunkerMode: "markdown",
    textChunkLimit: 4000,
    sanitizeText: ({ text }) => sanitizeAssistantVisibleText(text),
    deliveryCapabilities: {
        durableFinal: {
            text: true,
            media: true,
            payload: true,
            replyTo: true,
            thread: true,
            messageSendingHooks: true,
        },
    },
    presentationCapabilities: CHANTY_PRESENTATION_CAPABILITIES,
    renderPresentation: ({ payload, presentation }) => {
        if (payload.mediaUrls && payload.mediaUrls.length > 1) {
            return null;
        }
        const buttons = buildChantyPresentationButtons(presentation);
        if (!hasChantyPresentationButtons(presentation)) {
            return null;
        }
        return {
            ...payload,
            text: renderMessagePresentationFallbackText({ text: payload.text, presentation }),
            channelData: {
                ...payload.channelData,
                chanty: {
                    ...payload.channelData?.chanty,
                    presentationButtons: buttons,
                },
            },
        };
    },
    sendPayload: async (ctx) => {
        const buttons = readChantyPresentationButtons(ctx.payload);
        if (buttons?.length) {
            const mediaUrl = resolvePayloadMediaUrls({
                ...ctx.payload,
                mediaUrl: ctx.payload.mediaUrl ?? ctx.mediaUrl,
            })
                .map((url) => url.trim())
                .find(Boolean);
            const result = await (await loadChantyChannelRuntime()).sendMessageChanty(ctx.to, ctx.payload.text ?? ctx.text, {
                cfg: ctx.cfg,
                accountId: ctx.accountId ?? undefined,
                mediaUrl,
                mediaLocalRoots: ctx.mediaLocalRoots ?? ctx.mediaAccess?.localRoots,
                mediaReadFile: ctx.mediaReadFile ?? ctx.mediaAccess?.readFile,
                ...(ctx.mediaAccess?.workspaceDir ? { workspaceDir: ctx.mediaAccess.workspaceDir } : {}),
                requireMediaUpload: requiresChantyMediaUpload(mediaUrl) ? true : undefined,
                replyToId: ctx.replyToId ?? (ctx.threadId != null ? String(ctx.threadId) : undefined),
                buttons,
            });
            return attachChannelToResult("chanty", result);
        }
        return await sendTextMediaPayload({ channel: "chanty", ctx, adapter: chantyOutbound });
    },
    resolveTarget: ({ to }) => {
        const trimmed = to?.trim();
        if (!trimmed) {
            return {
                ok: false,
                error: new Error("Delivering to Chanty requires --to <channelId|@username|user:ID|channel:ID>"),
            };
        }
        return { ok: true, to: trimmed };
    },
    ...createAttachedChannelResultAdapter({
        channel: "chanty",
        sendText: async ({ cfg, to, text, accountId, replyToId, threadId }) => await (await loadChantyChannelRuntime()).sendMessageChanty(to, text, {
            cfg,
            accountId: accountId ?? undefined,
            replyToId: replyToId ?? (threadId != null ? String(threadId) : undefined),
        }),
        sendMedia: async ({ cfg, to, text, mediaUrl, mediaAccess, mediaLocalRoots, mediaReadFile, accountId, replyToId, threadId, }) => await (await loadChantyChannelRuntime()).sendMessageChanty(to, text, {
            cfg,
            accountId: accountId ?? undefined,
            mediaUrl,
            mediaLocalRoots: mediaLocalRoots ?? mediaAccess?.localRoots,
            mediaReadFile: mediaReadFile ?? mediaAccess?.readFile,
            ...(mediaAccess?.workspaceDir ? { workspaceDir: mediaAccess.workspaceDir } : {}),
            requireMediaUpload: requiresChantyMediaUpload(mediaUrl) ? true : undefined,
            replyToId: replyToId ?? (threadId != null ? String(threadId) : undefined),
        }),
    }),
};
const chantyMessageAdapter = createChannelMessageAdapterFromOutbound({
    id: "chanty",
    outbound: chantyOutbound,
    live: {
        capabilities: {
            draftPreview: false,
            previewFinalization: false,
            progressUpdates: false,
        },
        finalizer: {
            capabilities: {
                finalEdit: true,
                normalFallback: true,
                discardPending: true,
            },
        },
    },
});
export const chantyPlugin = createChatChannelPlugin({
    base: {
        id: "chanty",
        meta: {
            ...meta,
        },
        setup: chantySetupAdapter,
        setupWizard: chantySetupWizard,
        capabilities: {
            chatTypes: ["direct", "channel", "group", "thread"],
            reactions: true,
            threads: true,
            media: true,
            nativeCommands: true,
        },
        streaming: {
            blockStreamingCoalesceDefaults: { minChars: 1500, idleMs: 1000 },
        },
        reload: { configPrefixes: ["channels.chanty"] },
        configSchema: ChantyChannelConfigSchema,
        config: {
            ...chantyConfigAdapter,
            isConfigured: isChantyConfigured,
            describeAccount: describeChantyAccount,
        },
        approvalCapability: chantyApprovalAuth,
        doctor: chantyDoctor,
        groups: {
            resolveRequireMention: resolveChantyGroupRequireMention,
        },
        actions: chantyMessageActions,
        message: chantyMessageAdapter,
        secrets: {
            secretTargetRegistryEntries,
            collectRuntimeConfigAssignments,
        },
        directory: createChannelDirectoryAdapter({
            listGroups: listChantyDirectoryGroups,
            listGroupsLive: listChantyDirectoryGroups,
            listPeers: listChantyDirectoryPeers,
            listPeersLive: listChantyDirectoryPeers,
        }),
        messaging: {
            targetPrefixes: ["chanty"],
            defaultMarkdownTableMode: "off",
            normalizeTarget: normalizeChantyMessagingTarget,
            resolveDeliveryTarget: ({ conversationId, parentConversationId }) => {
                const parent = parentConversationId?.trim();
                const child = conversationId.trim();
                return parent && parent !== child
                    ? { to: `channel:${parent}`, threadId: child }
                    : { to: normalizeChantyMessagingTarget(`channel:${child}`) };
            },
            resolveOutboundSessionRoute: (params) => resolveChantyOutboundSessionRoute(params),
            targetResolver: {
                looksLikeId: looksLikeChantyTargetId,
                hint: "<channelId|user:ID|channel:ID>",
                resolveTarget: async ({ cfg, accountId, input }) => {
                    const resolved = await (await loadChantyChannelRuntime()).resolveChantyOpaqueTarget({
                        input,
                        cfg,
                        accountId,
                    });
                    if (!resolved) {
                        return null;
                    }
                    return {
                        to: resolved.to,
                        kind: resolved.kind,
                        source: "directory",
                    };
                },
            },
        },
        status: createComputedAccountStatusAdapter({
            defaultRuntime: createDefaultChannelRuntimeState(DEFAULT_ACCOUNT_ID, {
                connected: false,
                lastConnectedAt: null,
                lastDisconnect: null,
            }),
            buildChannelSummary: ({ snapshot }) => buildPassiveProbedChannelStatusSummary(snapshot, {
                connected: snapshot.connected ?? false,
                baseUrl: snapshot.baseUrl ?? null,
            }),
            probeAccount: async ({ account, timeoutMs }) => {
                const token = account.botToken?.trim();
                const baseUrl = account.baseUrl?.trim();
                if (!token || !baseUrl) {
                    return { ok: false, error: "bot token or baseUrl missing" };
                }
                return await (await loadChantyChannelRuntime()).probeChanty(baseUrl, token, timeoutMs, isPrivateNetworkOptInEnabled(account.config));
            },
            resolveAccountSnapshot: ({ account, runtime }) => ({
                accountId: account.accountId,
                name: account.name,
                enabled: account.enabled,
                configured: Boolean(account.botToken && account.baseUrl),
                extra: {
                    baseUrl: account.baseUrl,
                    dmPolicy: account.config.dmPolicy ?? "pairing",
                    connected: runtime?.connected ?? false,
                    lastConnectedAt: runtime?.lastConnectedAt ?? null,
                    lastDisconnect: runtime?.lastDisconnect ?? null,
                },
            }),
        }),
        gateway: {
            resolveGatewayAuthBypassPaths: ({ cfg }) => resolveChantyGatewayAuthBypassPaths(cfg),
            startAccount: async (ctx) => {
                const account = ctx.account;
                const statusSink = createAccountStatusSink({
                    accountId: ctx.accountId,
                    setStatus: ctx.setStatus,
                });
                statusSink({
                    baseUrl: account.baseUrl,
                });
                ctx.log?.info(`[${account.accountId}] starting channel`);
                ctx.log?.info(JSON.stringify(account));
                return (await loadChantyChannelRuntime()).monitorChantyProvider({
                    botToken: account.botToken ?? undefined,
                    baseUrl: account.baseUrl ?? undefined,
                    accountId: account.accountId,
                    config: ctx.cfg,
                    runtime: ctx.runtime,
                    abortSignal: ctx.abortSignal,
                    statusSink,
                });
            },
        },
    },
    pairing: {
        text: {
            idLabel: "chantyUserId",
            message: "OpenClaw: your access has been approved.",
            normalizeAllowEntry: (entry) => normalizeAllowEntry(entry),
            notify: createLoggedPairingApprovalNotifier(({ id }) => `[chanty] User ${id} approved for pairing`),
        },
    },
    threading: {
        buildToolContext: (params) => buildChantyThreadingToolContext(params),
        scopedAccountReplyToMode: {
            resolveAccount: (cfg, accountId) => resolveChantyAccount({
                cfg,
                accountId: accountId ?? resolveDefaultChantyAccountId(cfg),
            }),
            resolveReplyToMode: (account, chatType) => resolveChantyReplyToMode(account, chatType === "direct" || chatType === "group" || chatType === "channel"
                ? chatType
                : "channel"),
        },
        resolveAutoThreadId: ({ to, replyToId, toolContext }) => resolveChantyAutoThreadId({ to, replyToId, toolContext }),
        matchesToolContextTarget: ({ target, toolContext }) => matchesChantyToolContextTarget({ target, toolContext }),
        resolveReplyTransport: ({ threadId, replyToId, replyToIsExplicit, replyDelivery }) => {
            const ambientThreadId = threadId != null ? String(threadId) : undefined;
            const resolvedThreadId = replyDelivery?.chatType === "direct"
                ? undefined
                : replyDelivery
                    ? replyToIsExplicit
                        ? (replyToId ?? ambientThreadId)
                        : (ambientThreadId ?? replyToId ?? undefined)
                    : (ambientThreadId ?? replyToId);
            return {
                replyToId: replyDelivery?.chatType === "direct" ? null : resolvedThreadId,
                threadId: resolvedThreadId ?? null,
            };
        },
    },
    security: chantySecurityAdapter,
    outbound: chantyOutbound,
});
