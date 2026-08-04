import { BlockStreamingCoalesceSchema, DmPolicySchema, GroupPolicySchema, MarkdownConfigSchema, requireOpenAllowFrom, } from "openclaw/plugin-sdk/channel-config-primitives";
import { z } from "zod";
import { buildSecretInputSchema } from "./secret-input.js";
const ChantyGroupSchema = z
    .object({
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
    maxRetries: z.number().int().min(0).max(10).optional(),
    initialDelayMs: z.number().int().min(100).max(60000).optional(),
    maxDelayMs: z.number().int().min(1000).max(60000).optional(),
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
    native: z.union([z.boolean(), z.literal("auto")]).optional(),
    nativeSkills: z.union([z.boolean(), z.literal("auto")]).optional(),
    callbackPath: z.string().optional(),
    callbackUrl: z.string().optional(),
})
    .strict()
    .optional();
const ChantyNetworkSchema = z
    .object({
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
    groups: z.record(z.string(), ChantyGroupSchema.optional()).optional(),
    network: ChantyNetworkSchema,
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
