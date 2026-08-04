import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { applyAccountNameToChannelSection, applySetupAccountConfigPatch, migrateBaseNameToDefaultAccount, } from "openclaw/plugin-sdk/setup";
import { createSetupInputPresenceValidator } from "openclaw/plugin-sdk/setup-runtime";
import { resolveChantyAccount, } from "./setup.accounts.runtime.js";
import { normalizeChantyBaseUrl } from "./setup.client.runtime.js";
import { hasConfiguredSecretInput } from "./setup.secret-input.runtime.js";
const channel = "chanty";
export function isChantyConfigured(account) {
    const tokenConfigured = Boolean(account.botToken?.trim()) || hasConfiguredSecretInput(account.config.botToken);
    return tokenConfigured && Boolean(account.baseUrl);
}
export function resolveChantyAccountWithSecrets(cfg, accountId) {
    return resolveChantyAccount({
        cfg,
        accountId,
        allowUnresolvedSecretRef: true,
    });
}
export function applyChantySetupConfigPatch(params) {
    const namedConfig = applyAccountNameToChannelSection({
        cfg: params.cfg,
        channelKey: channel,
        accountId: params.accountId,
        name: params.name,
    });
    const next = params.accountId !== DEFAULT_ACCOUNT_ID
        ? migrateBaseNameToDefaultAccount({
            cfg: namedConfig,
            channelKey: channel,
        })
        : namedConfig;
    return applySetupAccountConfigPatch({
        cfg: next,
        channelKey: channel,
        accountId: params.accountId,
        patch: params.patch,
    });
}
export const chantySetupAdapter = {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) => applyAccountNameToChannelSection({
        cfg,
        channelKey: channel,
        accountId,
        name,
    }),
    validateInput: createSetupInputPresenceValidator({
        defaultAccountOnlyEnvError: "Chanty env vars can only be used for the default account.",
        whenNotUseEnv: [
            {
                someOf: ["token"],
                message: "Chanty requires --token and --http-url",
            },
            {
                someOf: ["httpUrl"],
                message: "Chanty requires --token and --http-ur",
            },
        ],
        validate: ({ input }) => {
            const token = input.token;
            const baseUrl = normalizeChantyBaseUrl(input.httpUrl);
            if (!input.useEnv && (!token || !baseUrl)) {
                return "Chanty requires --token and --http-url";
            }
            if (input.httpUrl && !baseUrl) {
                return "Chanty --http-url must include a valid base URL.";
            }
            return null;
        },
    }),
    applyAccountConfig: ({ cfg, accountId, input }) => {
        const token = input.botToken ?? input.token;
        const baseUrl = normalizeChantyBaseUrl(input.httpUrl);
        return applyChantySetupConfigPatch({
            cfg,
            accountId,
            name: input.name,
            patch: input.useEnv
                ? {}
                : {
                    ...(token ? { botToken: token } : {}),
                    ...(baseUrl ? { baseUrl } : {}),
                },
        });
    },
};
