import { createRemoteJWKSet, jwtVerify } from 'jose';

import { AppError, ErrorCode } from '../../platform/http/errors.js';

/**
 * "Continuar com o Google" (Google Identity Services, na web).
 *
 * A página recebe do Google um ID token (JWT assinado pelo Google) e o envia
 * para a API. Aqui conferimos a assinatura com as chaves públicas do Google
 * (cacheadas pelo `jose`), o emissor, o público (`aud` = nosso Client ID) e a
 * validade. Só aceitamos e-mail **confirmado pelo Google**: é o que permite
 * ligar a conta Google a uma conta nossa com o mesmo e-mail sem risco de
 * alguém se passar por outra pessoa. Nenhum segredo do Google é necessário.
 */
export interface GoogleProfile {
  /** Id estável da conta Google. */
  sub: string;
  email: string;
  name: string;
}

export type GoogleVerifier = (credential: string) => Promise<GoogleProfile>;

const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'));

export function invalidGoogleCredential(message = 'Não foi possível confirmar a conta Google. Tente de novo.'): AppError {
  return new AppError(401, ErrorCode.AUTH_TOKEN_INVALID, message);
}

export function createGoogleVerifier(clientId: string): GoogleVerifier {
  return async (credential) => {
    let payload: Record<string, unknown>;
    try {
      ({ payload } = await jwtVerify(credential, GOOGLE_JWKS, {
        issuer: ['https://accounts.google.com', 'accounts.google.com'],
        audience: clientId,
        clockTolerance: 30,
      }));
    } catch {
      throw invalidGoogleCredential();
    }
    return profileFromClaims(payload);
  };
}

/** Exportada para os testes: as regras sobre os dados que vêm do Google. */
export function profileFromClaims(payload: Record<string, unknown>): GoogleProfile {
  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const verified = payload.email_verified === true || payload.email_verified === 'true';
  if (!sub || !email || !email.includes('@')) throw invalidGoogleCredential();
  if (!verified) throw invalidGoogleCredential('Este e-mail ainda não foi confirmado no Google. Use e-mail e senha ou confirme o e-mail no Google.');
  const rawName = typeof payload.name === 'string' ? payload.name : typeof payload.given_name === 'string' ? payload.given_name : '';
  const name = rawName.trim().slice(0, 120) || email.split('@')[0]!.slice(0, 120);
  return { sub, email, name };
}
