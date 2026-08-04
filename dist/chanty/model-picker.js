import { createHash } from "node:crypto";
import { resolveStoredModelOverride, } from "openclaw/plugin-sdk/command-auth-native";
import { parseStrictInteger } from "openclaw/plugin-sdk/number-runtime";
import { normalizeProviderId } from "openclaw/plugin-sdk/provider-model-shared";
import { getSessionEntry, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString, normalizeStringifiedOptionalString, } from "openclaw/plugin-sdk/string-coerce-runtime";
const CHANTY_MODEL_PICKER_CONTEXT_KEY = "oc_model_picker";
const MODELS_PAGE_SIZE = 8;
const ACTION_IDS = {
    providers: "mdlprov",
    list: "mdllist",
    select: "mdlsel",
    back: "mdlback",
};
function splitModelRef(modelRef) {
    const trimmed = normalizeOptionalString(modelRef);
    const match = trimmed?.match(/^([^/]+)\/(.+)$/u);
    if (!match) {
        return null;
    }
    const provider = normalizeProviderId(match[1]);
    const model = normalizeOptionalString(match[2]);
    if (!provider || !model) {
        return null;
    }
    return { provider, model };
}
function readContextString(context, key, fallback = "") {
    const value = context[key];
    return typeof value === "string" ? value : fallback;
}
function readContextNumber(context, key) {
    const value = context[key];
    if (typeof value === "number" && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === "string") {
        return parseStrictInteger(value);
    }
    return undefined;
}
function normalizePage(value) {
    if (!Number.isFinite(value)) {
        return 1;
    }
    return Math.max(1, Math.floor(value));
}
function paginateItems(items, page, pageSize = MODELS_PAGE_SIZE) {
    const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
    const safePage = Math.max(1, Math.min(normalizePage(page), totalPages));
    const start = (safePage - 1) * pageSize;
    return {
        items: items.slice(start, start + pageSize),
        page: safePage,
        totalPages,
        hasPrev: safePage > 1,
        hasNext: safePage < totalPages,
        totalItems: items.length,
    };
}
function buildContext(state) {
    return {
        [CHANTY_MODEL_PICKER_CONTEXT_KEY]: true,
        ...state,
    };
}
function buildButtonId(state) {
    const digest = createHash("sha256").update(JSON.stringify(state)).digest("hex").slice(0, 12);
    return `${ACTION_IDS[state.action]}${digest}`;
}
function buildButton(params) {
    const baseState = params.action === "providers" || params.action === "back"
        ? {
            action: params.action,
            ownerUserId: params.ownerUserId,
        }
        : params.action === "list"
            ? {
                action: "list",
                ownerUserId: params.ownerUserId,
                provider: normalizeProviderId(params.provider ?? ""),
                page: normalizePage(params.page),
            }
            : {
                action: "select",
                ownerUserId: params.ownerUserId,
                provider: normalizeProviderId(params.provider ?? ""),
                page: normalizePage(params.page),
                model: normalizeStringifiedOptionalString(params.model) ?? "",
            };
    return {
        id: buildButtonId(baseState),
        text: params.text,
        ...(params.style ? { style: params.style } : {}),
        context: buildContext(baseState),
    };
}
function getProviderModels(data, provider) {
    return [...(data.byProvider.get(normalizeProviderId(provider)) ?? new Set())].toSorted();
}
function formatCurrentModelLine(currentModel) {
    const parsed = splitModelRef(currentModel);
    if (!parsed) {
        return "Current: default";
    }
    return `Current: ${parsed.provider}/${parsed.model}`;
}
export function resolveChantyModelPickerEntry(commandText) {
    const normalized = commandText.trim().replace(/\s+/g, " ");
    if (/^\/model$/i.test(normalized)) {
        return { kind: "summary" };
    }
    if (/^\/models$/i.test(normalized)) {
        return { kind: "providers" };
    }
    const providerMatch = normalized.match(/^\/models\s+(\S+)$/i);
    if (!providerMatch?.[1]) {
        return null;
    }
    return {
        kind: "models",
        provider: normalizeProviderId(providerMatch[1]),
    };
}
export function parseChantyModelPickerContext(context) {
    if (!context || context[CHANTY_MODEL_PICKER_CONTEXT_KEY] !== true) {
        return null;
    }
    const ownerUserId = normalizeOptionalString(readContextString(context, "ownerUserId")) ?? "";
    const action = normalizeOptionalString(readContextString(context, "action")) ?? "";
    if (!ownerUserId) {
        return null;
    }
    if (action === "providers" || action === "back") {
        return { action, ownerUserId };
    }
    const provider = normalizeProviderId(readContextString(context, "provider"));
    const page = readContextNumber(context, "page");
    if (!provider) {
        return null;
    }
    if (action === "list") {
        return {
            action,
            ownerUserId,
            provider,
            page: normalizePage(page),
        };
    }
    if (action === "select") {
        const model = normalizeOptionalString(readContextString(context, "model")) ?? "";
        if (!model) {
            return null;
        }
        return {
            action,
            ownerUserId,
            provider,
            page: normalizePage(page),
            model,
        };
    }
    return null;
}
export function buildChantyAllowedModelRefs(data) {
    const refs = new Set();
    for (const provider of data.providers) {
        for (const model of data.byProvider.get(provider) ?? []) {
            refs.add(`${provider}/${model}`);
        }
    }
    return refs;
}
export function resolveChantyModelPickerCurrentModel(params) {
    const fallback = `${params.data.resolvedDefault.provider}/${params.data.resolvedDefault.model}`;
    try {
        const storePath = resolveStorePath(params.cfg.session?.store, {
            agentId: params.route.agentId,
        });
        const sessionEntry = getSessionEntry({
            storePath,
            sessionKey: params.route.sessionKey,
            ...(params.readConsistency === "latest" ? { readConsistency: "latest" } : {}),
        });
        const override = resolveStoredModelOverride({
            sessionEntry,
            loadSessionEntry: (sessionKey) => getSessionEntry({
                storePath,
                sessionKey,
                ...(params.readConsistency === "latest" ? { readConsistency: "latest" } : {}),
            }),
            sessionKey: params.route.sessionKey,
            parentSessionKey: sessionEntry?.parentSessionKey,
            defaultProvider: params.data.resolvedDefault.provider,
        });
        if (!override?.model) {
            return fallback;
        }
        const provider = (override.provider || params.data.resolvedDefault.provider).trim();
        return provider ? `${provider}/${override.model}` : fallback;
    }
    catch {
        return fallback;
    }
}
export function renderChantyModelSummaryView(params) {
    return {
        text: [
            formatCurrentModelLine(params.currentModel),
            "",
            "Tap below to browse models, or use:",
            "/oc_model <provider/model> to switch",
            "Browse keeps the current runtime; use /oc_model <provider/model> --runtime <runtime> to switch runtime too",
            "/oc_model status for details",
        ].join("\n"),
        buttons: [
            [
                buildButton({
                    action: "providers",
                    ownerUserId: params.ownerUserId,
                    text: "Browse providers",
                    style: "primary",
                }),
            ],
        ],
    };
}
export function renderChantyProviderPickerView(params) {
    const currentProvider = splitModelRef(params.currentModel)?.provider;
    const rows = params.data.providers.map((provider) => [
        buildButton({
            action: "list",
            ownerUserId: params.ownerUserId,
            text: `${provider} (${params.data.byProvider.get(provider)?.size ?? 0})`,
            provider,
            page: 1,
            style: provider === currentProvider ? "primary" : "default",
        }),
    ]);
    return {
        text: [formatCurrentModelLine(params.currentModel), "", "Select a provider:"].join("\n"),
        buttons: rows,
    };
}
export function renderChantyModelsPickerView(params) {
    const provider = normalizeProviderId(params.provider);
    const models = getProviderModels(params.data, provider);
    const current = splitModelRef(params.currentModel);
    if (models.length === 0) {
        return {
            text: [formatCurrentModelLine(params.currentModel), "", `Unknown provider: ${provider}`].join("\n"),
            buttons: [
                [
                    buildButton({
                        action: "back",
                        ownerUserId: params.ownerUserId,
                        text: "Back to providers",
                    }),
                ],
            ],
        };
    }
    const page = paginateItems(models, params.page);
    const rows = page.items.map((model) => {
        const isCurrent = current?.provider === provider && current?.model === model;
        return [
            buildButton({
                action: "select",
                ownerUserId: params.ownerUserId,
                text: isCurrent ? `${model} [current]` : model,
                provider,
                model,
                page: page.page,
                style: isCurrent ? "primary" : "default",
            }),
        ];
    });
    const navRow = [];
    if (page.hasPrev) {
        navRow.push(buildButton({
            action: "list",
            ownerUserId: params.ownerUserId,
            text: "Prev",
            provider,
            page: page.page - 1,
        }));
    }
    if (page.hasNext) {
        navRow.push(buildButton({
            action: "list",
            ownerUserId: params.ownerUserId,
            text: "Next",
            provider,
            page: page.page + 1,
        }));
    }
    if (navRow.length > 0) {
        rows.push(navRow);
    }
    rows.push([
        buildButton({
            action: "back",
            ownerUserId: params.ownerUserId,
            text: "Back to providers",
        }),
    ]);
    return {
        text: [
            `Models (${provider}) - ${page.totalItems} available`,
            formatCurrentModelLine(params.currentModel),
            `Page ${page.page}/${page.totalPages}`,
            "Select a model to switch immediately.",
        ].join("\n"),
        buttons: rows,
    };
}
