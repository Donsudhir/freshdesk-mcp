import { z } from "zod";

const positiveId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const statusSchema = z.union([
  z.literal(2),
  z.literal(3),
  z.literal(4),
  z.literal(5),
]);
export const prioritySchema = z.union([
  z.literal(1),
  z.literal(2),
  z.literal(3),
  z.literal(4),
]);
const utcTimestamp = z.iso.datetime({ offset: false });

export const emptyInputSchema = z.strictObject({});
export const listInputSchema = z.strictObject({
  updated_since: utcTimestamp.describe(
    "Required UTC ISO timestamp; makes the list window explicit.",
  ),
  page: z.number().int().min(1).max(300).default(1),
  per_page: z.number().int().min(1).max(100).default(30),
  order: z.enum(["asc", "desc"]).default("desc"),
});
export const getInputSchema = z.strictObject({
  ticket_id: positiveId,
  include_description: z.boolean().default(false),
});
export const searchInputSchema = z
  .strictObject({
    status: statusSchema.optional(),
    priority: prioritySchema.optional(),
    group_id: positiveId.optional(),
    agent_id: positiveId.optional(),
    tag: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9 _.-]{0,63}$/)
      .describe("One exact tag; quotes and query operators are not accepted.")
      .optional(),
    created_since: z.iso.date().optional(),
    created_until: z.iso.date().optional(),
    updated_since: z.iso.date().optional(),
    page: z.number().int().min(1).max(10).default(1),
  })
  .superRefine((value, ctx) => {
    const { page: _page, ...filters } = value;
    if (!Object.values(filters).some((field) => field !== undefined)) {
      ctx.addIssue({
        code: "custom",
        message: "At least one search filter is required.",
      });
    }
    if (
      value.created_since !== undefined &&
      value.created_until !== undefined &&
      value.created_since > value.created_until
    ) {
      ctx.addIssue({
        code: "custom",
        message: "created_since must not be later than created_until.",
      });
    }
  });

export type ListInput = z.infer<typeof listInputSchema>;
export type GetInput = z.infer<typeof getInputSchema>;
export type SearchInput = z.infer<typeof searchInputSchema>;

export const rawTicketSchema = z.object({
  id: positiveId,
  subject: z.string(),
  status: z.number().int().positive(),
  priority: z.number().int().positive(),
  created_at: utcTimestamp,
  updated_at: utcTimestamp,
  tags: z.array(z.string()).nullable().optional(),
  description_text: z.string().nullable().optional(),
});
export const rawTicketListSchema = z.array(rawTicketSchema).max(100);
export const rawSearchResultSchema = z.object({
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  results: z.array(rawTicketSchema).max(30),
});

export const ticketSummarySchema = z.object({
  id: positiveId,
  subject: z.string().max(240),
  status: z.number().int(),
  status_label: z.string(),
  priority: z.number().int(),
  priority_label: z.string(),
  created_at: utcTimestamp,
  updated_at: utcTimestamp,
  tags: z.array(z.string().max(64)).max(20),
  tags_available: z.boolean(),
  text_truncated: z.boolean(),
});
export const ticketDetailSchema = ticketSummarySchema.extend({
  description_included: z.boolean(),
  description_available: z.boolean(),
  description_text: z.string().max(2000).optional(),
  description_truncated: z.boolean(),
});

export const publicErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  retry_after_ms: z.number().nonnegative().optional(),
});

export function toolOutputSchema<T extends z.ZodType>(data: T) {
  return z
    .object({
      ok: z.boolean(),
      data: data.optional(),
      error: publicErrorSchema.optional(),
    })
    .superRefine((value, ctx) => {
      if (
        (value.ok && (value.data === undefined || value.error !== undefined)) ||
        (!value.ok && (value.error === undefined || value.data !== undefined))
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Success requires data only; failure requires error only.",
        });
      }
    });
}

export const outputEnvelopeSchema = toolOutputSchema(
  z.record(z.string(), z.unknown()),
);
const rateLimitSchema = z.object({
  total: z.number().int().nonnegative().nullable(),
  remaining: z.number().int().nonnegative().nullable(),
  used_by_request: z.number().int().nonnegative().nullable(),
});
const dataContext = {
  source: z.literal("freshdesk"),
  data_classification: z.literal("untrusted_customer_content"),
  warning: z.string(),
  rate_limit: rateLimitSchema,
  attempts: z.number().int().min(1).max(4),
};
export const authOutputSchema = toolOutputSchema(
  z.object({
    authenticated: z.literal(true),
    ticket_read_access: z.literal(true),
    mode: z.enum(["live", "demo"]),
    account_origin: z.url(),
    rate_limit: rateLimitSchema,
    attempts: z.number().int().min(1).max(4),
  }),
);
export const listOutputSchema = toolOutputSchema(
  z.object({
    ...dataContext,
    updated_since: utcTimestamp,
    tickets: z.array(ticketSummarySchema).max(100),
    pagination: z.object({
      page: z.number().int().min(1).max(300),
      per_page: z.number().int().min(1).max(100),
      has_more: z.boolean(),
      next_page: z.number().int().min(1).max(300).nullable(),
      limit_reached: z.boolean(),
    }),
  }),
);
export const getOutputSchema = toolOutputSchema(
  z.object({ ...dataContext, ticket: ticketDetailSchema }),
);
export const searchOutputSchema = toolOutputSchema(
  z.object({
    ...dataContext,
    query: z.string().max(512),
    tickets: z.array(ticketSummarySchema).max(30),
    pagination: z.object({
      page: z.number().int().min(1).max(10),
      per_page: z.literal(30),
      total_matches: z.number().int().nonnegative(),
      max_accessible_results: z.literal(300),
      has_more: z.boolean(),
      next_page: z.number().int().min(1).max(10).nullable(),
      limit_reached: z.boolean(),
    }),
    limitations: z.array(z.string()),
  }),
);
