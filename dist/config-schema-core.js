// Chanty helper module supports config schema core behavior.
import { BlockStreamingCoalesceSchema, DmPolicySchema, GroupPolicySchema, MarkdownConfigSchema, requireOpenAllowFrom, } from "openclaw/plugin-sdk/channel-config-primitives";
import { z } from "zod";
import { buildSecretInputSchema } from "./secret-input.js";
const ChantyGroupSchema = z
    .object({
    /** Whether mentions are required to trigger the bot in this group. */
    requireMention: z.boolean().optional(),
})
    .strict();
function requireChantyOpenAllowFrom(params) {
    requireOpenAllowFrom({
        policy: params.policy,
        allowFrom: params.allowFrom,
        ctx: params.ctx,
        path: ["allowFrom"],
        message: 'channels.chanty.dmPolicy="open" requires channels.chanty.allowFrom to include "*"',
    });
}
const DmChannelRetrySchema = z
    .object({
    /** Maximum number of retry attempts for DM channel creation (default: 3) */
    maxRetries: z.number().int().min(0).max(10).optional(),
    /** Initial delay in milliseconds before first retry (default: 1000) */
    initialDelayMs: z.number().int().min(100).max(60000).optional(),
    /** Maximum delay in milliseconds between retries (default: 10000) */
    maxDelayMs: z.number().int().min(1000).max(60000).optional(),
    /** Timeout for each individual DM channel creation request in milliseconds (default: 30000) */
    timeoutMs: z.number().int().min(5000).max(120000).optional(),
})
    .strict()
    .refine((data) => {
    if (data.initialDelayMs !== undefined && data.maxDelayMs !== undefined) {
        return data.initialDelayMs <= data.maxDelayMs;
    }
    return true;
}, {
    message: "initialDelayMs must be less than or equal to maxDelayMs",
    path: ["initialDelayMs"],
})
    .optional();
const ChantySlashCommandsSchema = z
    .object({
    /** Enable native slash commands. "auto" resolves to false (opt-in). */
    native: z.union([z.boolean(), z.literal("auto")]).optional(),
    /** Also register skill-based commands. */
    nativeSkills: z.union([z.boolean(), z.literal("auto")]).optional(),
    /** Path for the callback endpoint on the gateway HTTP server. */
    callbackPath: z.string().optional(),
    /** Explicit callback URL (e.g. behind reverse proxy). */
    callbackUrl: z.string().optional(),
})
    .strict()
    .optional();
const ChantyNetworkSchema = z
    .object({
    /** Dangerous opt-in for self-hosted Chanty on trusted private/internal hosts. */
    dangerouslyAllowPrivateNetwork: z.boolean().optional(),
})
    .strict()
    .optional();
const ChantyStreamingModeSchema = z.enum(["off", "partial", "block", "progress"]);
const ChantyStreamingProgressSchema = z
    .object({
    label: z.union([z.string(), z.literal(false)]).optional(),
    labels: z.array(z.string()).optional(),
    maxLines: z.number().int().positive().optional(),
    maxLineChars: z.number().int().positive().optional(),
    toolProgress: z.boolean().optional(),
})
    .strict();
const ChantyStreamingPreviewSchema = z
    .object({
    toolProgress: z.boolean().optional(),
})
    .strict();
const ChantyStreamingBlockSchema = z
    .object({
    enabled: z.boolean().optional(),
    coalesce: BlockStreamingCoalesceSchema.optional(),
})
    .strict();
const ChantyStreamingSchema = z.union([
    ChantyStreamingModeSchema,
    z.boolean(),
    z
        .object({
        mode: ChantyStreamingModeSchema.optional(),
        chunkMode: z.enum(["length", "newline"]).optional(),
        preview: ChantyStreamingPreviewSchema.optional(),
        progress: ChantyStreamingProgressSchema.optional(),
        block: ChantyStreamingBlockSchema.optional(),
    })
        .strict(),
]);
const ChantyAccountSchemaBase = z
    .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    dangerouslyAllowNameMatching: z.boolean().optional(),
    markdown: MarkdownConfigSchema,
    enabled: z.boolean().optional(),
    configWrites: z.boolean().optional(),
    botToken: buildSecretInputSchema().optional(),
    baseUrl: z.string().optional(),
    chatmode: z.enum(["oncall", "onmessage", "onchar"]).optional(),
    oncharPrefixes: z.array(z.string()).optional(),
    requireMention: z.boolean().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    streaming: ChantyStreamingSchema.optional(),
    blockStreaming: z.boolean().optional(),
    blockStreamingCoalesce: BlockStreamingCoalesceSchema.optional(),
    replyToMode: z.enum(["off", "first", "all", "batched"]).optional(),
    responsePrefix: z.string().optional(),
    actions: z
        .object({
        reactions: z.boolean().optional(),
    })
        .optional(),
    commands: ChantySlashCommandsSchema,
    interactions: z
        .object({
        callbackBaseUrl: z.string().optional(),
        allowedSourceIps: z.array(z.string()).optional(),
    })
        .optional(),
    /** Per-group configuration (keyed by Chanty channel ID or "*" for default). */
    groups: z.record(z.string(), ChantyGroupSchema.optional()).optional(),
    /** Network policy overrides for self-hosted Chanty on trusted private/internal hosts. */
    network: ChantyNetworkSchema,
    /** Retry configuration for DM channel creation */
    dmChannelRetry: DmChannelRetrySchema,
})
    .strict();
const ChantyAccountSchema = ChantyAccountSchemaBase.superRefine((value, ctx) => {
    requireChantyOpenAllowFrom({
        policy: value.dmPolicy,
        allowFrom: value.allowFrom,
        ctx,
    });
});
export const ChantyConfigSchema = ChantyAccountSchemaBase.extend({
    accounts: z.record(z.string(), ChantyAccountSchema.optional()).optional(),
    defaultAccount: z.string().optional(),
}).superRefine((value, ctx) => {
    requireChantyOpenAllowFrom({
        policy: value.dmPolicy,
        allowFrom: value.allowFrom,
        ctx,
    });
});
