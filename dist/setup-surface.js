// Chanty plugin module implements setup surface behavior.
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { applySetupAccountConfigPatch, createStandardChannelSetupStatus, formatDocsLink, createSetupTranslator, } from "openclaw/plugin-sdk/setup";
import { applyChantySetupConfigPatch, isChantyConfigured, resolveChantyAccountWithSecrets, } from "./setup-core.js";
import { normalizeChantyBaseUrl } from "./setup.client.runtime.js";
import { hasConfiguredSecretInput } from "./setup.secret-input.runtime.js";
const t = createSetupTranslator();
const channel = "chanty";
export { chantySetupAdapter } from "./setup-core.js";
export const chantySetupWizard = {
    channel,
    status: createStandardChannelSetupStatus({
        channelLabel: "Chanty",
        configuredLabel: t("wizard.channels.statusConfigured"),
        unconfiguredLabel: t("wizard.channels.statusNeedsTokenUrl"),
        configuredHint: t("wizard.channels.statusConfigured"),
        unconfiguredHint: t("wizard.channels.statusNeedsSetup"),
        configuredScore: 2,
        unconfiguredScore: 1,
        resolveConfigured: ({ cfg, accountId }) => isChantyConfigured(resolveChantyAccountWithSecrets(cfg, accountId ?? DEFAULT_ACCOUNT_ID)),
    }),
    introNote: {
        title: t("wizard.chanty.botTokenTitle"),
        lines: [
            t("wizard.chanty.helpOpenConsole"),
            t("wizard.chanty.helpCreateBot"),
            t("wizard.chanty.helpBaseUrl"),
            t("wizard.chanty.helpBotMember"),
            t("wizard.channels.docs", { link: formatDocsLink("/chanty", "chanty") }),
        ],
        shouldShow: ({ cfg, accountId }) => !isChantyConfigured(resolveChantyAccountWithSecrets(cfg, accountId)),
    },
    envShortcut: {
        prompt: t("wizard.chanty.envPrompt"),
        preferredEnvVar: "CHANTY_BOT_TOKEN",
        isAvailable: ({ cfg, accountId }) => {
            if (accountId !== DEFAULT_ACCOUNT_ID) {
                return false;
            }
            const resolvedAccount = resolveChantyAccountWithSecrets(cfg, accountId);
            const hasConfigValues = hasConfiguredSecretInput(resolvedAccount.config.botToken) ||
                Boolean(resolvedAccount.config.baseUrl?.trim());
            return Boolean(process.env.CHANTY_BOT_TOKEN?.trim() &&
                process.env.CHANTY_URL?.trim() &&
                !hasConfigValues);
        },
        apply: ({ cfg, accountId }) => applySetupAccountConfigPatch({
            cfg,
            channelKey: channel,
            accountId,
            patch: {},
        }),
    },
    credentials: [
        {
            inputKey: "botToken",
            providerHint: channel,
            credentialLabel: t("wizard.chanty.botToken"),
            preferredEnvVar: "CHANTY_BOT_TOKEN",
            envPrompt: t("wizard.chanty.envPrompt"),
            keepPrompt: t("wizard.chanty.botTokenKeep"),
            inputPrompt: t("wizard.chanty.botTokenInput"),
            inspect: ({ cfg, accountId }) => {
                const resolvedAccount = resolveChantyAccountWithSecrets(cfg, accountId);
                return {
                    accountConfigured: isChantyConfigured(resolvedAccount),
                    hasConfiguredValue: hasConfiguredSecretInput(resolvedAccount.config.botToken),
                };
            },
            applySet: async ({ cfg, accountId, value }) => applyChantySetupConfigPatch({
                cfg,
                accountId,
                patch: { botToken: value },
            }),
        },
    ],
    textInputs: [
        {
            inputKey: "httpUrl",
            message: t("wizard.chanty.baseUrlPrompt"),
            confirmCurrentValue: false,
            currentValue: ({ cfg, accountId }) => resolveChantyAccountWithSecrets(cfg, accountId).baseUrl ??
                process.env.CHANTY_URL?.trim(),
            initialValue: ({ cfg, accountId }) => resolveChantyAccountWithSecrets(cfg, accountId).baseUrl ??
                process.env.CHANTY_URL?.trim(),
            shouldPrompt: ({ cfg, accountId, credentialValues, currentValue }) => {
                const resolvedAccount = resolveChantyAccountWithSecrets(cfg, accountId);
                const tokenConfigured = Boolean(resolvedAccount.botToken?.trim()) ||
                    hasConfiguredSecretInput(resolvedAccount.config.botToken);
                return Boolean(credentialValues.botToken) || !tokenConfigured || !currentValue;
            },
            validate: ({ value }) => normalizeChantyBaseUrl(value)
                ? undefined
                : "Chanty base URL must include a valid base URL.",
            normalizeValue: ({ value }) => normalizeChantyBaseUrl(value) ?? value.trim(),
            applySet: async ({ cfg, accountId, value }) => applyChantySetupConfigPatch({
                cfg,
                accountId,
                patch: { baseUrl: value },
            }),
        },
    ],
    disable: (cfg) => ({
        ...cfg,
        channels: {
            ...cfg.channels,
            chanty: {
                ...cfg.channels?.chanty,
                enabled: false,
            },
        },
    }),
};
