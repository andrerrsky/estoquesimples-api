import {
  SignJWT,
  jwtVerify,
  importPKCS8,
  importSPKI,
  generateKeyPair,
  errors as joseErrors,
  type KeyLike,
} from 'jose';

import type { Env } from '../config/env.js';
import { AppError, ErrorCode, unauthorized } from '../http/errors.js';

/**
 * Access tokens assinados com Ed25519 (EdDSA).
 *
 * EdDSA em vez de HMAC porque a chave de verificação é pública: se um dia
 * outro serviço precisar validar tokens, ele recebe apenas a chave pública.
 * O `kid` no cabeçalho permite rotacionar a chave mantendo os tokens antigos
 * válidos até expirarem.
 */

const ALGORITHM = 'EdDSA';

export interface AccessTokenClaims {
  /** ID do usuário. */
  sub: string;
  /** ID da sessão, para revogação individual. */
  sid: string;
  /** Versão de permissão do usuário no momento da emissão. */
  ver: number;
  /** ID do dispositivo, quando a sessão está vinculada a um. */
  did?: string;
}

export interface VerifiedAccessToken extends AccessTokenClaims {
  exp: number;
  iat: number;
}

export interface JwtKeys {
  privateKey: KeyLike;
  publicKey: KeyLike;
  keyId: string;
}

export async function loadJwtKeys(env: Env, warn?: (message: string) => void): Promise<JwtKeys> {
  if (env.JWT_PRIVATE_KEY && env.JWT_PUBLIC_KEY) {
    const privateKey = await importPKCS8(normalizePem(env.JWT_PRIVATE_KEY), ALGORITHM);
    const publicKey = await importSPKI(normalizePem(env.JWT_PUBLIC_KEY), ALGORITHM);
    return { privateKey, publicKey, keyId: env.JWT_KEY_ID };
  }

  // Só chega aqui em desenvolvimento ou teste: env.ts exige as chaves em
  // staging e produção. Tokens não sobrevivem a um restart, o que é aceitável
  // localmente e evita commitar uma chave de exemplo no repositório.
  warn?.(
    'JWT_PRIVATE_KEY não definida: gerando par de chaves efêmero. ' +
      'Os tokens emitidos serão invalidados no próximo restart.',
  );
  const pair = await generateKeyPair(ALGORITHM, { extractable: false });
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, keyId: 'ephemeral' };
}

function normalizePem(value: string): string {
  // Variáveis de ambiente frequentemente chegam com \n literais.
  return value.includes('\\n') ? value.replace(/\\n/g, '\n') : value;
}

export class TokenService {
  constructor(
    private readonly keys: JwtKeys,
    private readonly env: Env,
  ) {}

  async signAccessToken(claims: AccessTokenClaims): Promise<{ token: string; expiresIn: number }> {
    const expiresIn = this.env.ACCESS_TOKEN_TTL_SECONDS;
    const payload: Record<string, unknown> = { sid: claims.sid, ver: claims.ver };
    if (claims.did) payload['did'] = claims.did;

    const token = await new SignJWT(payload)
      .setProtectedHeader({ alg: ALGORITHM, kid: this.keys.keyId, typ: 'JWT' })
      .setSubject(claims.sub)
      .setIssuer(this.env.JWT_ISSUER)
      .setAudience(this.env.JWT_AUDIENCE)
      .setIssuedAt()
      .setExpirationTime(`${expiresIn}s`)
      .sign(this.keys.privateKey);

    return { token, expiresIn };
  }

  async verifyAccessToken(token: string): Promise<VerifiedAccessToken> {
    try {
      const { payload } = await jwtVerify(token, this.keys.publicKey, {
        algorithms: [ALGORITHM],
        issuer: this.env.JWT_ISSUER,
        audience: this.env.JWT_AUDIENCE,
      });

      const sub = payload.sub;
      const sid = payload['sid'];
      const ver = payload['ver'];
      if (typeof sub !== 'string' || typeof sid !== 'string' || typeof ver !== 'number') {
        throw unauthorized(ErrorCode.AUTH_TOKEN_INVALID, 'Token com formato inesperado.');
      }

      const did = payload['did'];
      return {
        sub,
        sid,
        ver,
        ...(typeof did === 'string' ? { did } : {}),
        exp: payload.exp ?? 0,
        iat: payload.iat ?? 0,
      };
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof joseErrors.JWTExpired) {
        throw unauthorized(ErrorCode.AUTH_TOKEN_EXPIRED, 'Token de acesso expirado.');
      }
      throw unauthorized(ErrorCode.AUTH_TOKEN_INVALID, 'Token de acesso inválido.');
    }
  }
}
