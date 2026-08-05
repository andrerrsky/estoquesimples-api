import type { FastifyError, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';

import { AppError, ErrorCode, type ErrorCodeValue, type ErrorDetail } from './errors.js';
import { isProduction } from '../config/env.js';

interface ErrorBody {
  error: {
    code: ErrorCodeValue | string;
    message: string;
    details?: ErrorDetail[];
    correlationId: string;
    [key: string]: unknown;
  };
}

/** Códigos de erro do Postgres que sabemos traduzir para respostas de negócio. */
const PG_UNIQUE_VIOLATION = '23505';
const PG_FOREIGN_KEY_VIOLATION = '23503';
const PG_CHECK_VIOLATION = '23514';
const PG_INSUFFICIENT_PRIVILEGE = '42501';

function pgErrorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const code = (error as { code: unknown }).code;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

export function registerErrorHandler(app: FastifyInstance): void {
  const env = app.services.env;
  const production = isProduction(env);

  app.setNotFoundHandler((request, reply) => {
    const body: ErrorBody = {
      error: {
        code: ErrorCode.NOT_FOUND,
        message: `Rota não encontrada: ${request.method} ${request.url}`,
        correlationId: request.id,
      },
    };
    return reply.code(404).send(body);
  });

  app.setErrorHandler((error: FastifyError | Error, request: FastifyRequest, reply: FastifyReply) => {
    const correlationId = request.id;

    if (error instanceof AppError) {
      if (!error.expected) {
        request.log.error({ err: error, code: error.code }, 'erro inesperado tratado');
      }
      const body: ErrorBody = {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details ? { details: error.details } : {}),
          ...(error.extra ?? {}),
          correlationId,
        },
      };
      return reply.code(error.statusCode).send(body);
    }

    // Falha de validação do corpo, params ou query.
    if (hasZodFastifySchemaValidationErrors(error)) {
      const details: ErrorDetail[] = error.validation.map((issue) => ({
        field: issue.params.issue.path.join('.') || undefined,
        message: issue.params.issue.message,
      }));
      const body: ErrorBody = {
        error: {
          code: ErrorCode.VALIDATION_FAILED,
          message: 'Dados inválidos na requisição.',
          details,
          correlationId,
        },
      };
      return reply.code(400).send(body);
    }

    // A resposta não bateu com o schema declarado. É bug nosso, nunca do
    // cliente: devolvemos 500 e logamos o detalhe para corrigir.
    if (isResponseSerializationError(error)) {
      request.log.error(
        { err: error, route: `${error.method} ${error.url}` },
        'resposta fora do schema declarado',
      );
      const body: ErrorBody = {
        error: {
          code: ErrorCode.INTERNAL,
          message: 'Erro interno ao montar a resposta.',
          correlationId,
        },
      };
      return reply.code(500).send(body);
    }

    const fastifyError = error as FastifyError;

    if (fastifyError.code === 'FST_ERR_CTP_BODY_TOO_LARGE') {
      const body: ErrorBody = {
        error: {
          code: ErrorCode.PAYLOAD_TOO_LARGE,
          message: 'Requisição excede o tamanho máximo permitido.',
          correlationId,
        },
      };
      return reply.code(413).send(body);
    }

    if (
      fastifyError.code === 'FST_ERR_CTP_EMPTY_JSON_BODY' ||
      fastifyError.code === 'FST_ERR_CTP_INVALID_JSON_BODY'
    ) {
      const body: ErrorBody = {
        error: {
          code: ErrorCode.MALFORMED_JSON,
          message: 'Corpo da requisição não é um JSON válido.',
          correlationId,
        },
      };
      return reply.code(400).send(body);
    }

    const pgCode = pgErrorCode(error);
    if (pgCode) {
      // RLS negando a operação chega aqui. Tratamos como 403 e logamos como
      // erro: significa que uma camada acima deveria ter barrado antes.
      if (pgCode === PG_INSUFFICIENT_PRIVILEGE) {
        request.log.error({ err: error }, 'operação bloqueada pelo banco (RLS ou privilégio)');
        const body: ErrorBody = {
          error: {
            code: ErrorCode.FORBIDDEN,
            message: 'Operação não permitida.',
            correlationId,
          },
        };
        return reply.code(403).send(body);
      }

      if (pgCode === PG_UNIQUE_VIOLATION) {
        request.log.warn({ err: error }, 'violação de unicidade não tratada pelo caso de uso');
        const body: ErrorBody = {
          error: {
            code: ErrorCode.CONFLICT,
            message: 'Registro já existe.',
            correlationId,
          },
        };
        return reply.code(409).send(body);
      }

      if (pgCode === PG_FOREIGN_KEY_VIOLATION || pgCode === PG_CHECK_VIOLATION) {
        request.log.warn({ err: error }, 'violação de integridade referencial');
        const body: ErrorBody = {
          error: {
            code: ErrorCode.VALIDATION_FAILED,
            message: 'Dados inconsistentes para esta operação.',
            correlationId,
          },
        };
        return reply.code(400).send(body);
      }
    }

    if (fastifyError.statusCode && fastifyError.statusCode < 500) {
      const body: ErrorBody = {
        error: {
          code: fastifyError.code ?? ErrorCode.VALIDATION_FAILED,
          message: fastifyError.message,
          correlationId,
        },
      };
      return reply.code(fastifyError.statusCode).send(body);
    }

    // Qualquer coisa que chegue aqui é imprevista. O log leva o erro completo;
    // a resposta, apenas o correlationId para o suporte cruzar com o log.
    request.log.error({ err: error }, 'erro não tratado');

    const body: ErrorBody = {
      error: {
        code: ErrorCode.INTERNAL,
        message: 'Erro interno. Tente novamente em instantes.',
        correlationId,
      },
    };

    if (!production) {
      body.error['debug'] = { name: error.name, message: error.message };
    }

    return reply.code(500).send(body);
  });
}
