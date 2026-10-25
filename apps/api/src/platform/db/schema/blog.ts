import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { platformAdmins } from './admin.js';

const tz = { withTimezone: true } as const;

export interface BlogFaqItem {
  question: string;
  answer: string;
}

/** Posts do blog (ver migration 0021 e docs/blog.md). */
export const blogPosts = pgTable(
  'blog_posts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    slug: text('slug').notNull().unique(),
    title: text('title').notNull(),
    seoTitle: text('seo_title'),
    excerpt: text('excerpt').notNull(),
    contentMd: text('content_md').notNull(),
    contentHtml: text('content_html').notNull(),
    category: text('category').notNull(),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    faq: jsonb('faq').$type<BlogFaqItem[]>().notNull().default([]),
    status: text('status').$type<'draft' | 'published'>().notNull().default('draft'),
    publishedAt: timestamp('published_at', tz),
    coverHash: text('cover_hash'),
    coverAlt: text('cover_alt'),
    authorName: text('author_name').notNull().default('Equipe Estoque Simples'),
    readingMinutes: integer('reading_minutes').notNull().default(3),
    aiGenerated: boolean('ai_generated').notNull().default(false),
    /** Só quem tem conta lê inteiro; no site público aparece o começo e um convite para se cadastrar. */
    membersOnly: boolean('members_only').notNull().default(false),
    aiModel: text('ai_model'),
    aiTopic: text('ai_topic'),
    notifiedAt: timestamp('notified_at', tz),
    createdBy: uuid('created_by').references(() => platformAdmins.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', tz).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  },
  (table) => [index('blog_posts_category_idx').on(table.category, table.publishedAt)],
);
