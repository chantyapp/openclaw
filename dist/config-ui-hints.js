export const chantyChannelConfigUiHints = {
    "": {
        label: "Chanty",
        help: "Chanty channel provider configuration for bot auth, access policy, slash commands, and preview streaming.",
    },
    dmPolicy: {
        label: "Chanty DM Policy",
        help: 'Direct message access control ("pairing" recommended). "open" requires channels.chanty.allowFrom=["*"].',
    },
    streaming: {
        label: "Chanty Streaming Mode",
        help: 'Unified Chanty stream preview mode: "off" | "partial" | "block" | "progress". "progress" keeps a single editable progress draft until final delivery.',
    },
    "streaming.mode": {
        label: "Chanty Streaming Mode",
        help: 'Canonical Chanty preview mode: "off" | "partial" | "block" | "progress".',
    },
    "streaming.progress.label": {
        label: "Chanty Progress Label",
        help: 'Initial progress draft title. Use "auto" for built-in single-word labels, a custom string, or false to hide the title.',
    },
    "streaming.progress.labels": {
        label: "Chanty Progress Label Pool",
        help: 'Candidate labels for streaming.progress.label="auto". Leave unset to use OpenClaw built-in progress labels.',
    },
    "streaming.progress.maxLines": {
        label: "Chanty Progress Max Lines",
        help: "Maximum number of compact progress lines to keep below the draft label (default: 8).",
    },
    "streaming.progress.maxLineChars": {
        label: "Chanty Progress Max Line Chars",
        help: "Maximum characters per compact progress line before truncation (default: 120). Prose cuts at word boundaries; commands and paths keep useful suffixes.",
    },
    "streaming.progress.toolProgress": {
        label: "Chanty Progress Tool Lines",
        help: "Show compact tool/progress lines in progress draft mode (default: true). Set false to keep only the label until final delivery.",
    },
    "streaming.progress.commandText": {
        label: "Chanty Progress Command Text",
        help: 'Command/exec detail in progress draft lines: "raw" preserves released behavior; "status" shows only the tool label.',
    },
    "streaming.preview.toolProgress": {
        label: "Chanty Draft Tool Progress",
        help: "Show tool/progress activity in the live draft preview post (default: true). Set false to hide interim tool updates while the draft preview stays active.",
    },
    "streaming.preview.commandText": {
        label: "Chanty Draft Command Text",
        help: 'Command/exec detail in preview tool-progress lines: "raw" preserves released behavior; "status" shows only the tool label.',
    },
    "streaming.block.enabled": {
        label: "Chanty Block Streaming Enabled",
        help: 'Enable chunked block-style Chanty preview delivery when channels.chanty.streaming.mode="block".',
    },
    "streaming.block.coalesce": {
        label: "Chanty Block Streaming Coalesce",
        help: "Merge streamed Chanty block replies before final delivery.",
    },
};
