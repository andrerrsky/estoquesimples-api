import { z } from 'zod';

import { BLOG_CATEGORY_SLUGS } from './blog.categories.js';

export const blogSlugSchema = z
  .string()
  .trim()
  .min(3)
  .max(90)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use só letras minúsculas, números e hífens.');

export const blogFaqSchema = z
  .array(
    z.object({
      question: z.string().trim().min(5).max(200),
      answer: z.string().trim().min(10).max(1000),
    }),
  )
  .max(6);

/** O que o painel manda ao criar ou editar um post. */
export const blogPostBodySchema = z
  .object({
    title: z.string().trim().min(5).max(120),
    /** Título da aba e do Google (até 60 caracteres); vazio = o título. */
    seoTitle: z.string().trim().max(70).nullish(),
    slug: blogSlugSchema.optional(),
    excerpt: z.string().trim().min(40).max(200),
    contentMd: z.string().trim().min(100).max(60_000),
    category: z.enum(BLOG_CATEGORY_SLUGS),
    tags: z.array(z.string().trim().min(2).max(40)).max(8).default([]),
    faq: blogFaqSchema.default([]),
    coverAlt: z.string().trim().max(200).nullish(),
    authorName: z.string().trim().min(2).max(80).optional(),
    /** Exclusivo para quem tem conta (cadeado no site público). */
    membersOnly: z.boolean().default(false),
  })
  .strict();

export type BlogPostBody = z.infer<typeof blogPostBodySchema>;

export const blogListQuerySchema = z.object({
  category: z.enum(BLOG_CATEGORY_SLUGS).optional(),
  /** Mês no formato AAAA-MM. */
  month: z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])$/)
    .optional(),
  q: z.string().trim().max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(12),
});

export type BlogListQuery = z.infer<typeof blogListQuerySchema>;

export const blogSettingsSchema = z
  .object({
    /** A OpenAI escreve posts sozinha (2× por semana). */
    aiEnabled: z.boolean(),
    /** Publica o post da IA na hora; desligado, ele fica como rascunho para revisão. */
    aiAutoPublish: z.boolean(),
    /** Terceiro post semanal, exclusivo para quem tem conta (quarta-feira). */
    aiMembersOnlyWeekly: z.boolean().default(true),
    /** Avisa todo mundo (push e caixa de notificações) a cada post publicado. */
    notifyOnPublish: z.boolean(),
  })
  .strict();

export type BlogSettings = z.infer<typeof blogSettingsSchema>;

export const DEFAULT_BLOG_SETTINGS: BlogSettings = { aiEnabled: true, aiAutoPublish: true, aiMembersOnlyWeekly: true, notifyOnPublish: true };
