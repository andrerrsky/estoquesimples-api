import { z } from 'zod';

/**
 * Schemas compartilhados pela API administrativa.
 *
 * Toda listagem recebe a mesma paginação e devolve o mesmo envelope, para que
 * o painel tenha um único componente de tabela e o backend um único jeito de
 * limitar o custo de uma consulta.
 */

export const ADMIN_ROLES = ['owner', 'support', 'viewer'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Ordem de poder: cada papel inclui os de baixo. */
export const ADMIN_ROLE_RANK: Record<AdminRole, number> = { viewer: 10, support: 50, owner: 100 };

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

export function paginatedSchema<T extends z.ZodTypeAny>(item: T) {
  return z.object({
    items: z.array(item),
    page: z.number().int(),
    pageSize: z.number().int(),
    total: z.number().int(),
  });
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export function offsetOf(query: PaginationQuery): number {
  return (query.page - 1) * query.pageSize;
}

/** Datas ISO em query string; ausentes viram null. */
export const dateRangeQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});

export const searchQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
});

export const uuidParam = <K extends string>(name: K) =>
  z.object({ [name]: z.string().uuid() } as Record<K, z.ZodString>);

export const adminPublicSchema = z.object({
  id: z.string().uuid(),
  email: z.string(),
  name: z.string(),
  role: z.enum(ADMIN_ROLES),
  status: z.enum(['active', 'disabled']),
  lastLoginAt: z.string().nullable(),
  createdAt: z.string(),
});

export type AdminPublic = z.infer<typeof adminPublicSchema>;

export const adminLoginBodySchema = z
  .object({
    email: z.string().trim().min(3).max(254).email().transform((v) => v.toLowerCase()),
    password: z.string().min(1).max(200),
  })
  .strict();

/**
 * Ações destrutivas exigem que o painel reenvie o motivo. Não é segurança
 * (o painel já está autenticado): é para que a linha de auditoria explique
 * por que a conta foi suspensa, e não só que foi.
 */
export const reasonBodySchema = z
  .object({
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const messageSchema = z.object({ message: z.string() });

export const errorSchema = z.object({
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      details: z.array(z.object({ field: z.string().optional(), message: z.string() })).optional(),
      correlationId: z.string().optional(),
    })
    .passthrough(),
});

export const commonAdminErrors = {
  400: errorSchema,
  401: errorSchema,
  403: errorSchema,
  404: errorSchema,
  409: errorSchema,
  429: errorSchema,
};

export const iso = (date: Date | null | undefined): string | null => date?.toISOString() ?? null;
