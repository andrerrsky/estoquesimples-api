import { z } from 'zod';

/**
 * Corpo de POST /ops/backup: o que scripts/backup-offsite.sh registra depois
 * de guardar a cópia. O teste do backup externo (backup-offsite-test.yml)
 * valida o corpo que o script monta contra este mesmo schema, para os dois
 * não se desencontrarem.
 */
export const backupRecordSchema = z.object({
  origem: z.string().max(200),
  tabelas: z.number().int().nonnegative(),
  registros: z.number().int().nonnegative(),
  duracaoSegundos: z.number().nonnegative(),
  /** Onde a cópia externa foi guardada e o SHA-256 do arquivo cifrado. */
  objeto: z.string().max(300).optional(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  migracao: z.number().int().nonnegative().max(1_000_000).optional(),
  schemaAtras: z.boolean().optional(),
  migracoesAtras: z.number().int().nonnegative().max(1_000_000).optional(),
  /** Fotos no bucket de origem na noite do backup (espelhadas na cópia). */
  fotos: z.number().int().nonnegative().max(1_000_000_000).optional(),
  schemaAFrente: z.boolean().optional(),
  migracoesAFrente: z.number().int().nonnegative().max(1_000_000).optional(),
}).strict();

export type BackupRecord = z.infer<typeof backupRecordSchema>;
