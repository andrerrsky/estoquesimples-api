import { and, eq, inArray, sql } from 'drizzle-orm';

import type { Database, Transaction } from '../../platform/db/client.js';
import { workspaceImages, type WorkspaceImage } from '../../platform/db/schema/index.js';
import type { AppServices } from '../../platform/http/context.js';
import { AppError, ErrorCode } from '../../platform/http/errors.js';
import { imageKey } from '../../platform/storage/object-storage.js';
import { planLimitReached } from '../billing/plan-limits.js';
import { normalizeImage, sha256 } from './image-processing.js';

const MB = 1024 * 1024;

export interface ImageView {
  hash: string;
  contentType: string;
  bytes: number;
  width: number;
  height: number;
}

const view = (row: WorkspaceImage): ImageView => ({ hash: row.hash, contentType: row.contentType, bytes: row.bytes, width: row.width, height: row.height });

/** Imagens dos produtos: envio, leitura e coleta de lixo. Ver docs/images.md. */
export class ImageService {
  constructor(private readonly services: AppServices) {}

  private get storage() {
    return this.services.storage;
  }

  assertAvailable(): void {
    if (!this.storage.configured) {
      throw new AppError(503, ErrorCode.IMAGES_UNAVAILABLE, 'O envio de imagens não está disponível agora. Tente novamente mais tarde.');
    }
  }

  /**
   * Recebe, valida e guarda uma imagem. Idempotente: o mesmo arquivo (ou um
   * que resulte no mesmo conteúdo) devolve a imagem que já existe, sem gastar
   * cota nem gravar de novo — reenviar depois de uma falha de conexão é seguro.
   *
   * @param quotaMb cota do plano em MB (0 = plano sem imagens, null = sem limite)
   */
  async upload(
    tx: Transaction,
    input: { workspaceId: string; userId: string; bytes: Buffer; contentType: string; quotaMb: number | null; planKey: string },
  ): Promise<{ image: ImageView; created: boolean }> {
    this.assertAvailable();
    const { workspaceId } = input;
    const sourceHash = sha256(input.bytes);

    // Mesmo arquivo já enviado: reconhecido sem decodificar nada.
    const [known] = await tx
      .select()
      .from(workspaceImages)
      .where(and(eq(workspaceImages.workspaceId, workspaceId), eq(workspaceImages.sourceHash, sourceHash)))
      .limit(1);
    if (known) {
      await this.touch(tx, workspaceId, known.hash);
      return { image: view(known), created: false };
    }

    const normalized = await normalizeImage(input.bytes, input.contentType, { maxEdge: this.services.env.IMAGE_MAX_EDGE });

    // O conteúdo já existe na empresa (outro arquivo que resulta nos mesmos bytes).
    const [same] = await tx
      .select()
      .from(workspaceImages)
      .where(and(eq(workspaceImages.workspaceId, workspaceId), eq(workspaceImages.hash, normalized.hash)))
      .limit(1);
    if (same) {
      await this.touch(tx, workspaceId, same.hash);
      return { image: view(same), created: false };
    }

    // Cota por plano. A soma é do que está guardado agora, não do histórico.
    if (input.quotaMb !== null) {
      const used = await this.usedBytes(tx, workspaceId);
      if (input.quotaMb <= 0 || used + normalized.bytes.length > input.quotaMb * MB) {
        throw planLimitReached({
          feature: 'imagens.armazenamento_mb',
          limit: input.quotaMb,
          current: Math.ceil(used / MB),
          planKey: input.planKey,
          message:
            input.quotaMb <= 0
              ? 'O plano desta empresa não inclui imagens de produtos.'
              : `O armazenamento de imagens desta empresa (${input.quotaMb} MB) está cheio. Remova fotos que não usa mais ou assine o plano Equipe.`,
        });
      }
    }

    // Objeto primeiro, linha depois: se a gravação do objeto falhar, nada
    // aponta para ele; se a linha falhar, sobra um objeto sem referência
    // (inofensivo, e o reenvio o reaproveita porque a chave é o hash).
    await this.storage.put(imageKey(workspaceId, normalized.hash), normalized.bytes, normalized.contentType);

    const [row] = await tx
      .insert(workspaceImages)
      .values({
        workspaceId,
        hash: normalized.hash,
        sourceHash,
        contentType: normalized.contentType,
        bytes: normalized.bytes.length,
        width: normalized.width,
        height: normalized.height,
        createdBy: input.userId,
      })
      .onConflictDoUpdate({ target: [workspaceImages.workspaceId, workspaceImages.hash], set: { orphanedAt: null } })
      .returning();
    if (!row) throw new Error('Falha ao registrar a imagem.');
    return { image: view(row), created: true };
  }

  /** Metadados + bytes. `null` se a imagem não é desta empresa (ou foi apagada). */
  async find(tx: Transaction, workspaceId: string, hash: string): Promise<WorkspaceImage | null> {
    const [row] = await tx
      .select()
      .from(workspaceImages)
      .where(and(eq(workspaceImages.workspaceId, workspaceId), eq(workspaceImages.hash, hash)))
      .limit(1);
    return row ?? null;
  }

  async read(workspaceId: string, hash: string): Promise<Buffer | null> {
    this.assertAvailable();
    return this.storage.get(imageKey(workspaceId, hash));
  }

  /** Dos hashes informados, quais existem nesta empresa. */
  async existing(tx: Transaction, workspaceId: string, hashes: string[]): Promise<Set<string>> {
    if (hashes.length === 0) return new Set();
    const rows = await tx
      .select({ hash: workspaceImages.hash })
      .from(workspaceImages)
      .where(and(eq(workspaceImages.workspaceId, workspaceId), inArray(workspaceImages.hash, hashes)));
    return new Set(rows.map((row) => row.hash));
  }

  async usedBytes(tx: Transaction | Database, workspaceId: string): Promise<number> {
    const rows = await tx.execute<{ total: string | null }>(sql`SELECT coalesce(sum(bytes), 0)::text AS total FROM workspace_images WHERE workspace_id = ${workspaceId}`);
    return Number(rows.rows[0]?.total ?? 0);
  }

  /** Imagem em uso de novo: sai da fila de remoção. */
  private async touch(tx: Transaction, workspaceId: string, hash: string): Promise<void> {
    await tx
      .update(workspaceImages)
      .set({ orphanedAt: null })
      .where(and(eq(workspaceImages.workspaceId, workspaceId), eq(workspaceImages.hash, hash), sql`${workspaceImages.orphanedAt} IS NOT NULL`));
  }

  // -------------------------------------------------------------------------
  // Coleta de lixo
  // -------------------------------------------------------------------------

  /**
   * Remove do bucket as imagens que nenhum produto usa mais (foto trocada,
   * removida ou produto apagado de vez).
   *
   * Em duas etapas, para nunca apagar o que um aparelho offline ainda vai
   * apontar: primeiro a imagem é *marcada* (sem referência e com mais de um
   * dia); só é apagada se continuar sem referência depois de
   * `IMAGE_GC_GRACE_DAYS`. Produto apagado (tombstone) ainda conta como
   * referência até a limpeza definitiva do produto.
   */
  async collectGarbage(limit = 200): Promise<{ marked: number; restored: number; deleted: number }> {
    if (!this.storage.configured) return { marked: 0, restored: 0, deleted: 0 };
    const db = this.services.db;
    const referenced = sql`EXISTS (SELECT 1 FROM products p WHERE p.workspace_id = workspace_images.workspace_id AND p.photo_hash = workspace_images.hash)`;

    const marked = await db.execute(sql`
      UPDATE workspace_images SET orphaned_at = now()
      WHERE orphaned_at IS NULL AND created_at < now() - interval '1 day' AND NOT ${referenced}
    `);
    const restored = await db.execute(sql`UPDATE workspace_images SET orphaned_at = NULL WHERE orphaned_at IS NOT NULL AND ${referenced}`);

    const grace = this.services.env.IMAGE_GC_GRACE_DAYS;
    const due = await db.execute<{ id: string; workspace_id: string; hash: string }>(sql`
      SELECT id, workspace_id, hash FROM workspace_images
      WHERE orphaned_at IS NOT NULL AND orphaned_at < now() - make_interval(days => ${grace}) AND NOT ${referenced}
      ORDER BY orphaned_at LIMIT ${limit}
    `);
    let deleted = 0;
    for (const row of due.rows) {
      // Objeto antes da linha: se o bucket falhar, a linha fica e a próxima
      // rodada tenta de novo; nunca sobra linha apontando para nada.
      await this.storage.delete(imageKey(row.workspace_id, row.hash));
      const result = await db.execute(sql`
        DELETE FROM workspace_images WHERE id = ${row.id} AND NOT ${referenced}
      `);
      if ((result.rowCount ?? 0) > 0) deleted += 1;
    }
    return { marked: marked.rowCount ?? 0, restored: restored.rowCount ?? 0, deleted };
  }
}
