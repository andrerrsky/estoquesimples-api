import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";

import { badRequest, ErrorCode } from "../../platform/http/errors.js";
import { AI_TOPICS, BlogAiWriter, topicStatus } from "../blog/blog-ai.js";
import { BLOG_CATEGORIES } from "../blog/blog.categories.js";
import {
  blogPostBodySchema,
  blogSettingsSchema,
} from "../blog/blog.schemas.js";
import { BlogService } from "../blog/blog.service.js";
import { nextAiRun } from "../blog/blog.jobs.js";
import { readOpenAiKey } from "../reviews/reviews.service.js";
import { adminActor, requireAdmin } from "./admin-auth.plugin.js";
import {
  commonAdminErrors,
  messageSchema,
  paginationQuerySchema,
  uuidParam,
} from "./admin.schemas.js";

/**
 * Blog pelo painel: criar, editar, publicar, despublicar e apagar posts;
 * prévia do Markdown; capa; configurações da IA; e "escrever agora".
 */
export async function registerAdminBlogRoutes(
  app: FastifyInstance,
): Promise<void> {
  const routes = app.withTypeProvider<ZodTypeProvider>();
  const service = new BlogService(app.services);
  // A capa chega como corpo binário (o mesmo que as fotos de produto em /v1/images).
  app.addContentTypeParser(
    ["image/webp", "image/jpeg", "image/png"],
    { parseAs: "buffer", bodyLimit: 6 * 1024 * 1024 },
    (_request, body, done) => done(null, body),
  );

  routes.get(
    "/blog/posts",
    {
      preHandler: requireAdmin("viewer"),
      schema: {
        tags: ["admin"],
        summary: "Posts do blog (todos os estados)",
        hide: true,
        querystring: paginationQuerySchema.extend({
          status: z.enum(["draft", "published"]).optional(),
          q: z.string().trim().max(100).optional(),
        }),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.listAll(request.query),
  );

  routes.get(
    "/blog/meta",
    {
      preHandler: requireAdmin("viewer"),
      schema: {
        tags: ["admin"],
        summary: "Categorias, configurações, pautas da IA e próxima execução",
        hide: true,
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async () => {
      const settings = await service.settings();
      return {
        categories: BLOG_CATEGORIES,
        settings,
        openAiConfigured: (await readOpenAiKey(app.services)) !== null,
        nextAiRun: nextAiRun(new Date(), {
          membersOnlyWeekly: settings.aiMembersOnlyWeekly,
        }).toISOString(),
        topics: await topicStatus(app.services),
        topicsTotal: AI_TOPICS.length,
      };
    },
  );

  routes.put(
    "/blog/settings",
    {
      preHandler: requireAdmin("support"),
      schema: {
        tags: ["admin"],
        summary: "Configurações do blog (IA e avisos)",
        hide: true,
        body: blogSettingsSchema,
        response: { 200: blogSettingsSchema, ...commonAdminErrors },
      },
    },
    async (request) => service.saveSettings(adminActor(request), request.body),
  );

  routes.get(
    "/blog/posts/:postId",
    {
      preHandler: requireAdmin("viewer"),
      schema: {
        tags: ["admin"],
        summary: "Um post, com o Markdown",
        hide: true,
        params: uuidParam("postId"),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.getById(request.params.postId),
  );

  routes.post(
    "/blog/preview",
    {
      preHandler: requireAdmin("viewer"),
      schema: {
        tags: ["admin"],
        summary: "Prévia do Markdown",
        hide: true,
        body: z.object({ contentMd: z.string().max(60_000) }),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) => service.preview(request.body.contentMd),
  );

  routes.post(
    "/blog/posts",
    {
      preHandler: requireAdmin("support"),
      schema: {
        tags: ["admin"],
        summary: "Cria um post (rascunho)",
        hide: true,
        body: blogPostBodySchema,
        response: { 201: z.any(), ...commonAdminErrors },
      },
    },
    async (request, reply) =>
      reply
        .code(201)
        .send(await service.create(adminActor(request), request.body)),
  );

  routes.put(
    "/blog/posts/:postId",
    {
      preHandler: requireAdmin("support"),
      schema: {
        tags: ["admin"],
        summary: "Edita um post",
        hide: true,
        params: uuidParam("postId"),
        body: blogPostBodySchema,
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) =>
      service.update(adminActor(request), request.params.postId, request.body),
  );

  routes.post(
    "/blog/posts/:postId/publish",
    {
      preHandler: requireAdmin("support"),
      schema: {
        tags: ["admin"],
        summary: "Publica o post (e avisa todo mundo, conforme a configuração)",
        hide: true,
        params: uuidParam("postId"),
        body: z.object({ notify: z.boolean().optional() }).default({}),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) =>
      service.publish(adminActor(request), request.params.postId, {
        ...(request.body.notify !== undefined
          ? { notify: request.body.notify }
          : {}),
      }),
  );

  routes.post(
    "/blog/posts/:postId/unpublish",
    {
      preHandler: requireAdmin("support"),
      schema: {
        tags: ["admin"],
        summary: "Volta o post a rascunho",
        hide: true,
        params: uuidParam("postId"),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) =>
      service.unpublish(adminActor(request), request.params.postId),
  );

  routes.delete(
    "/blog/posts/:postId",
    {
      preHandler: requireAdmin("support"),
      schema: {
        tags: ["admin"],
        summary: "Apaga o post",
        hide: true,
        params: uuidParam("postId"),
        response: { 200: messageSchema, ...commonAdminErrors },
      },
    },
    async (request) => {
      await service.remove(adminActor(request), request.params.postId);
      return { message: "Post apagado." };
    },
  );

  routes.put(
    "/blog/posts/:postId/cover",
    {
      preHandler: requireAdmin("support"),
      bodyLimit: 6 * 1024 * 1024,
      schema: {
        tags: ["admin"],
        summary: "Envia a imagem de capa (JPEG, PNG ou WebP)",
        hide: true,
        params: uuidParam("postId"),
        response: {
          200: z.any(),
          ...commonAdminErrors,
          413: z.any(),
          415: z.any(),
          503: z.any(),
        },
      },
    },
    async (request) => {
      const contentType = String(request.headers["content-type"] ?? "")
        .split(";")[0]!
        .trim();
      if (!Buffer.isBuffer(request.body))
        throw badRequest(
          ErrorCode.VALIDATION_FAILED,
          "Envie o arquivo da imagem no corpo da requisição.",
        );
      return service.setCover(
        adminActor(request),
        request.params.postId,
        request.body,
        contentType,
      );
    },
  );

  routes.delete(
    "/blog/posts/:postId/cover",
    {
      preHandler: requireAdmin("support"),
      schema: {
        tags: ["admin"],
        summary: "Remove a capa",
        hide: true,
        params: uuidParam("postId"),
        response: { 200: z.any(), ...commonAdminErrors },
      },
    },
    async (request) =>
      service.removeCover(adminActor(request), request.params.postId),
  );

  routes.post(
    "/blog/ai/write",
    {
      preHandler: requireAdmin("support"),
      schema: {
        tags: ["admin"],
        summary:
          "A IA escreve um post agora (rascunho, salvo pedido para publicar)",
        hide: true,
        body: z
          .object({
            publish: z.boolean().default(false),
            topicKey: z.string().max(60).optional(),
          })
          .default({}),
        response: { 200: z.any(), ...commonAdminErrors, 502: z.any() },
      },
    },
    async (request) => {
      const topic = request.body.topicKey
        ? AI_TOPICS.find((item) => item.key === request.body.topicKey)
        : undefined;
      if (request.body.topicKey && !topic)
        throw badRequest(ErrorCode.VALIDATION_FAILED, "Pauta desconhecida.");
      return new BlogAiWriter(app.services).writePost({
        publish: request.body.publish,
        ...(topic ? { topic } : {}),
      });
    },
  );
}
