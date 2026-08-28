import { z } from 'zod';

import { movementInputSchema, productInputSchema } from '../sync/sync.schemas.js';

export const BACKUP_FORMAT = 'estoquesimples.backup';
export const BACKUP_VERSION = 1;

export const exportQuerySchema = z
  .object({
    includeDeleted: z
      .enum(['true', 'false'])
      .optional()
      .default('false')
      .transform((value) => value === 'true'),
  })
  .strict();

export const exportProductSchema = productInputSchema.omit({ previous: true });
export const exportMovementSchema = movementInputSchema.extend({
  recordedAt: z.number().int().nonnegative().optional(),
});

export const backupFileSchema = z
  .object({
    format: z.literal(BACKUP_FORMAT),
    version: z.literal(BACKUP_VERSION),
    exportedAt: z.number().int().nonnegative(),
    source: z.literal('cloud'),
    workspaceId: z.string().uuid(),
    products: z.array(exportProductSchema),
    movements: z.array(exportMovementSchema),
  })
  .strict();

export type BackupFile = z.infer<typeof backupFileSchema>;
export type ExportQuery = z.infer<typeof exportQuerySchema>;
