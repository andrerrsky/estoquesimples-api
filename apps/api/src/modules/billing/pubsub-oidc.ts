import { createRemoteJWKSet, jwtVerify } from 'jose';

/**
 * Autenticação de push do Pub/Sub (OIDC): com ela ativada no Google Cloud,
 * cada entrega traz `Authorization: Bearer <JWT>` assinado pelo Google, com
 * `aud` igual ao configurado na assinatura e `email` da service account que
 * envia. Conferir isso prova que a chamada veio do Pub/Sub do projeto, e não
 * de quem descobriu o token da query string (que pode aparecer em logs).
 */
const GOOGLE_JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), { cacheMaxAge: 6 * 3600_000 });

export async function verifyPubSubOidc(
  authorization: string | undefined,
  expected: { audience: string; serviceAccountEmail: string },
): Promise<boolean> {
  if (!authorization?.startsWith('Bearer ')) return false;
  try {
    const { payload } = await jwtVerify(authorization.slice('Bearer '.length).trim(), GOOGLE_JWKS, {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: expected.audience,
      algorithms: ['RS256'],
    });
    return payload['email'] === expected.serviceAccountEmail && payload['email_verified'] === true;
  } catch {
    return false;
  }
}
