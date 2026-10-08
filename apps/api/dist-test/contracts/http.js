import { z } from "zod";
import { durableOperationStatusSchema, operationStatusSchema, } from "./command.js";
import { nonEmptyIdSchema, positiveVersionSchema } from "./identifiers.js";
const strictObject = (shape) => z.object(shape).strict();
const codePointText = (max) => z
    .string()
    .min(1)
    .max(max * 2)
    .refine((value) => Array.from(value).length <= max, {
    message: `Must contain at most ${max} Unicode code points`,
});
const paginationSchema = strictObject({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
});
const timestampSchema = z.string().datetime({ offset: true });
export const createQueryRequestSchema = strictObject({
    templateId: z.literal("trial_1"),
    gameplayReleaseId: nonEmptyIdSchema,
});
export const leaveQueryRequestSchema = strictObject({
    expectedVersion: positiveVersionSchema,
});
export const createPlayerRequestSchema = strictObject({
    displayName: codePointText(20).refine((value) => Array.from(value).length >= 2),
    factionId: z.enum([
        "faction_1",
        "faction_2",
        "faction_3",
        "faction_4",
        "faction_5",
        "faction_6",
    ]),
    powerId: z.enum(["power_1", "power_2"]),
    professionId: z.enum([
        "profession_1",
        "profession_2",
        "profession_3",
        "profession_4",
        "profession_5",
        "profession_6",
    ]),
    gameplayReleaseId: nonEmptyIdSchema,
});
export const submitActionRequestSchema = strictObject({
    actionType: z.literal("inspect"),
    siteId: z.enum(["site_1", "site_2", "site_3"]),
});
export const castVoteRequestSchema = strictObject({
    choiceId: z.enum(["choice_1", "choice_2", "abstain"]),
    expectedVersion: positiveVersionSchema,
});
const replacementTextSchema = codePointText(2000);
const recipientIdsSchema = z
    .array(nonEmptyIdSchema)
    .min(1)
    .max(10)
    .refine((ids) => new Set(ids).size === ids.length, {
    message: "Recipient IDs must be unique",
});
export const publicSpreadRequestSchema = strictObject({
    scriptId: nonEmptyIdSchema,
    mode: z.literal("public"),
    replacementText: replacementTextSchema.optional(),
});
export const directedSpreadRequestSchema = strictObject({
    scriptId: nonEmptyIdSchema,
    mode: z.literal("directed"),
    recipientIds: recipientIdsSchema,
    replacementText: replacementTextSchema.optional(),
});
export const spreadRequestSchema = z.discriminatedUnion("mode", [
    publicSpreadRequestSchema,
    directedSpreadRequestSchema,
]);
export const sendMessageRequestSchema = strictObject({
    text: codePointText(500),
});
export const reportRequestSchema = strictObject({
    targetType: z.enum(["message", "script", "player"]),
    targetId: nonEmptyIdSchema,
    reasonCode: z.string().trim().min(1).max(64),
    text: codePointText(500).optional(),
});
export const paginationRequestSchema = paginationSchema;
export const retrySagaRequestSchema = strictObject({
    expectedVersion: positiveVersionSchema,
    reason: codePointText(500),
});
export const dispatchStateRequestSchema = strictObject({
    paused: z.boolean(),
    reason: codePointText(500),
    expectedVersion: positiveVersionSchema,
});
export const moderationRequestSchema = strictObject({
    action: z.enum(["mute", "unmute", "disable"]),
    reason: codePointText(500),
    until: z.string().datetime({ offset: true }).optional(),
}).refine((request) => request.action === "mute" || request.until === undefined, {
    message: "An expiration time is only valid when muting an account",
});
export const adminSagaListRequestSchema = strictObject({
    status: durableOperationStatusSchema.optional(),
    ...paginationSchema.shape,
});
export const mfaEnrollRequestSchema = strictObject({});
export const mfaConfirmRequestSchema = strictObject({
    code: z.string().regex(/^\d{6}$/),
});
export const mfaReauthenticateRequestSchema = strictObject({
    password: z.string().min(1).max(1024),
    code: z.string().regex(/^\d{6}$/),
});
export const writeReceiptSchema = strictObject({
    operationId: nonEmptyIdSchema.optional(),
    resourceId: nonEmptyIdSchema.optional(),
    aggregateVersion: positiveVersionSchema.optional(),
}).refine((receipt) => receipt.operationId || receipt.resourceId, {
    message: "A write receipt must identify an operation or resource",
});
export const reportAcceptedResponseSchema = strictObject({
    reportId: nonEmptyIdSchema,
    status: z.literal("accepted"),
});
export const channelMessageResponseSchema = strictObject({
    messageId: nonEmptyIdSchema,
    createdAt: z.string().datetime({ offset: true }),
});
export const publicLeaderboardEntrySchema = strictObject({
    playerId: nonEmptyIdSchema,
    displayName: codePointText(20),
    score: z.number().int().nonnegative().safe(),
    rank: z.string().min(1).max(32),
});
export const leaderboardResponseSchema = strictObject({
    items: z.array(publicLeaderboardEntrySchema).max(50),
    nextCursor: z.string().min(1).max(512).nullable(),
    boardVersion: positiveVersionSchema,
    serverTime: z.string().datetime({ offset: true }),
});
export const notificationResponseSchema = strictObject({
    notificationId: nonEmptyIdSchema,
    messageKey: z.string().min(1).max(128),
    args: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
    createdAt: z.string().datetime({ offset: true }),
});
export const notificationListResponseSchema = strictObject({
    items: z.array(notificationResponseSchema).max(50),
    nextCursor: z.string().min(1).max(512).nullable(),
    serverTime: z.string().datetime({ offset: true }),
});
export const createPlayerResponseSchema = strictObject({
    playerId: nonEmptyIdSchema,
    displayName: codePointText(20),
    factionId: z.enum([
        "faction_1",
        "faction_2",
        "faction_3",
        "faction_4",
        "faction_5",
        "faction_6",
    ]),
    powerId: z.enum(["power_1", "power_2"]),
    professionId: z.enum([
        "profession_1",
        "profession_2",
        "profession_3",
        "profession_4",
        "profession_5",
        "profession_6",
    ]),
    aggregateVersion: positiveVersionSchema,
});
export const queryPhaseSchema = z.enum([
    "waiting",
    "exploring",
    "voting",
    "settling",
    "settlement_failed",
    "completed",
    "cancelled",
]);
export const querySnapshotResponseSchema = strictObject({
    queryId: nonEmptyIdSchema,
    phase: queryPhaseSchema,
    deadline: timestampSchema.nullable(),
    serverTime: timestampSchema,
    gameplayReleaseId: nonEmptyIdSchema,
    aggregateVersion: positiveVersionSchema,
    participants: z
        .array(strictObject({
        displayName: codePointText(20),
        isSelf: z.boolean(),
    }))
        .min(1)
        .max(4)
        .refine((participants) => participants.filter(({ isSelf }) => isSelf).length === 1, { message: "A query snapshot must contain exactly one current player" }),
    self: strictObject({
        actionsUsed: z.number().int().min(0).max(2),
        voteChoice: z.enum(["choice_1", "choice_2", "abstain"]).nullable(),
        evidenceCards: z.array(strictObject({
            cardId: nonEmptyIdSchema,
            siteId: z.enum(["site_1", "site_2", "site_3"]),
            text: codePointText(2000),
        })),
    }),
});
export const acceptedOperationResponseSchema = strictObject({
    operationId: nonEmptyIdSchema,
    status: z.literal("accepted"),
    aggregateVersion: positiveVersionSchema.optional(),
});
export const spreadOperationResponseSchema = strictObject({
    operationId: nonEmptyIdSchema,
    status: durableOperationStatusSchema,
    total: z.number().int().nonnegative(),
    granted: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
}).refine((result) => result.granted + result.skipped + result.pending <= result.total, { message: "Spread progress cannot exceed the audience total" });
export const channelMessageListResponseSchema = strictObject({
    items: z
        .array(strictObject({
        messageId: nonEmptyIdSchema,
        senderDisplayName: codePointText(20),
        text: codePointText(500),
        createdAt: timestampSchema,
    }))
        .max(50),
    nextCursor: z.string().min(1).max(512).nullable(),
    serverTime: timestampSchema,
});
export const adminSagaListResponseSchema = strictObject({
    items: z.array(operationStatusSchema).max(50),
    nextCursor: z.string().min(1).max(512).nullable(),
    serverTime: timestampSchema,
});
export const moderationResponseSchema = strictObject({
    targetAccountId: nonEmptyIdSchema,
    action: z.enum(["mute", "unmute", "disable"]),
    appliedAt: timestampSchema,
    aggregateVersion: positiveVersionSchema,
});
export const dispatchStateResponseSchema = strictObject({
    paused: z.boolean(),
    updatedAt: timestampSchema,
    aggregateVersion: positiveVersionSchema,
});
export const boardSnapshotResponseSchema = strictObject({
    boardVersion: positiveVersionSchema,
    tension: z.number().int().min(0).max(100),
    factions: z
        .array(strictObject({
        factionId: z.enum([
            "faction_1",
            "faction_2",
            "faction_3",
            "faction_4",
            "faction_5",
            "faction_6",
        ]),
        strength: z.number().int().min(0).max(100),
    }))
        .length(6)
        .refine((factions) => new Set(factions.map(({ factionId }) => factionId)).size === 6, { message: "Each faction must appear exactly once" }),
    updatedAt: timestampSchema,
    serverTime: timestampSchema,
});
