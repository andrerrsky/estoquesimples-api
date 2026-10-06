import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client, S3ServiceException } from '@aws-sdk/client-s3';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';

import type { Env } from '../config/env.js';

/**
 * Armazenamento de objetos (binários das imagens).
 *
 * A aplicação só conhece esta interface. Em produção é um bucket S3
 * compatível (o bucket do Railway); em desenvolvimento e teste, uma pasta.
 * Trocar de provedor (Cloudflare R2, Backblaze, AWS) é mudar variáveis de
 * ambiente, não código.
 *
 * As chaves são sempre montadas pelo servidor (`imageKey`), nunca vêm do
 * cliente.
 */
export interface ObjectStorage {
  readonly kind: 's3' | 'fs' | 'none';
  /** Há onde guardar? Sem isso, as rotas de imagem respondem 503. */
  readonly configured: boolean;
  put(key: string, body: Buffer, contentType: string): Promise<void>;
  /** `null` quando o objeto não existe. */
  get(key: string): Promise<Buffer | null>;
  /** Apagar o que não existe não é erro. */
  delete(key: string): Promise<void>;
}

/** Chave do objeto: a empresa está no caminho, então listar/auditar por empresa é trivial. */
export function imageKey(workspaceId: string, hash: string): string {
  return `workspaces/${workspaceId}/images/${hash}.webp`;
}

/** Logotipo da marca: fora da cota de fotos, em prefixo próprio. */
export function brandLogoKey(workspaceId: string, hash: string): string {
  return `workspaces/${workspaceId}/brand/${hash}.webp`;
}

const KEY_PATTERN = /^workspaces\/[0-9a-f-]{36}\/(images|brand)\/[0-9a-f]{64}\.webp$/;

function assertKey(key: string): void {
  if (!KEY_PATTERN.test(key)) throw new Error('Chave de objeto inválida.');
}

class DisabledStorage implements ObjectStorage {
  readonly kind = 'none' as const;
  readonly configured = false;
  async put(): Promise<void> {
    throw new Error('Armazenamento de imagens não configurado.');
  }
  async get(): Promise<Buffer | null> {
    throw new Error('Armazenamento de imagens não configurado.');
  }
  async delete(): Promise<void> {
    throw new Error('Armazenamento de imagens não configurado.');
  }
}

export class S3Storage implements ObjectStorage {
  readonly kind = 's3' as const;
  readonly configured = true;
  private readonly client: S3Client;

  constructor(
    private readonly bucket: string,
    options: { endpoint?: string | undefined; region: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean },
  ) {
    this.client = new S3Client({
      region: options.region,
      ...(options.endpoint ? { endpoint: options.endpoint } : {}),
      forcePathStyle: options.forcePathStyle,
      credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey },
      // Os checksums extras que o SDK novo acrescenta por padrão não são
      // aceitos por todo armazenamento compatível com S3.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      maxAttempts: 3,
    });
  }

  async put(key: string, body: Buffer, contentType: string): Promise<void> {
    assertKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentLength: body.length,
        ContentType: contentType,
        // O conteúdo de uma chave nunca muda (o nome é o hash).
        CacheControl: 'private, max-age=31536000, immutable',
      }),
    );
  }

  async get(key: string): Promise<Buffer | null> {
    assertKey(key);
    try {
      const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
      if (!result.Body) return null;
      return Buffer.from(await result.Body.transformToByteArray());
    } catch (error) {
      if (error instanceof S3ServiceException && (error.name === 'NoSuchKey' || error.$metadata.httpStatusCode === 404)) return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** Pasta local: desenvolvimento e testes. Escrita atômica (arquivo temporário + rename). */
export class FsStorage implements ObjectStorage {
  readonly kind = 'fs' as const;
  readonly configured = true;
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  private pathOf(key: string): string {
    assertKey(key);
    const full = resolve(join(this.root, key));
    if (!full.startsWith(this.root + sep)) throw new Error('Chave de objeto inválida.');
    return full;
  }

  async put(key: string, body: Buffer): Promise<void> {
    const full = this.pathOf(key);
    await mkdir(dirname(full), { recursive: true });
    const temp = `${full}.${process.pid}.tmp`;
    await writeFile(temp, body);
    await rename(temp, full);
  }

  async get(key: string): Promise<Buffer | null> {
    try {
      return await readFile(this.pathOf(key));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathOf(key), { force: true });
  }
}

/**
 * Escolhe o armazenamento pelo ambiente: bucket S3 se `S3_BUCKET` estiver
 * definido; senão, pasta local fora de produção; em produção sem bucket, as
 * imagens ficam desligadas (a API sobe normalmente).
 */
export function createStorage(env: Env): ObjectStorage {
  if (env.S3_BUCKET) {
    if (!env.S3_ACCESS_KEY_ID || !env.S3_SECRET_ACCESS_KEY) {
      throw new Error('S3_BUCKET exige S3_ACCESS_KEY_ID e S3_SECRET_ACCESS_KEY.');
    }
    return new S3Storage(env.S3_BUCKET, {
      endpoint: env.S3_ENDPOINT,
      region: env.S3_REGION,
      accessKeyId: env.S3_ACCESS_KEY_ID,
      secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      forcePathStyle: env.S3_FORCE_PATH_STYLE,
    });
  }
  if (env.NODE_ENV === 'production' || env.NODE_ENV === 'staging') return new DisabledStorage();
  return new FsStorage(env.IMAGE_FS_DIR);
}
