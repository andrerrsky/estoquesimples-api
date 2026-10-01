import { boolean, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

import { platformAdmins } from './admin.js';

const tz = { withTimezone: true } as const;

/** Cópia local das avaliações da Play Store (a API do Google só lista 7 dias). */
export const playReviews = pgTable(
  'play_reviews',
  {
    reviewId: text('review_id').primaryKey(),
    authorName: text('author_name'),
    starRating: integer('star_rating').notNull(),
    text: text('text'),
    language: text('language'),
    device: text('device'),
    androidOsVersion: text('android_os_version'),
    appVersionCode: integer('app_version_code'),
    appVersionName: text('app_version_name'),
    userCommentAt: timestamp('user_comment_at', tz),
    lastModifiedAt: timestamp('last_modified_at', tz),
    developerReplyText: text('developer_reply_text'),
    developerReplyAt: timestamp('developer_reply_at', tz),
    repliedViaPanel: boolean('replied_via_panel').notNull().default(false),
    repliedByAdminId: uuid('replied_by_admin_id').references(() => platformAdmins.id, { onDelete: 'set null' }),
    raw: jsonb('raw').notNull().default({}),
    firstSeenAt: timestamp('first_seen_at', tz).notNull().defaultNow(),
    fetchedAt: timestamp('fetched_at', tz).notNull().defaultNow(),
  },
  (table) => [
    index('play_reviews_time_idx').on(table.lastModifiedAt.desc()),
    index('play_reviews_unanswered_idx')
      .on(table.lastModifiedAt.desc())
      .where(sql`${table.developerReplyText} IS NULL`),
  ],
);

/** Chaves de serviços de terceiros usadas pelo painel, cifradas em repouso. */
export const adminSettings = pgTable('admin_settings', {
  key: text('key').primaryKey(),
  valueEnc: text('value_enc').notNull(),
  updatedAt: timestamp('updated_at', tz).notNull().defaultNow(),
  updatedBy: uuid('updated_by').references(() => platformAdmins.id, { onDelete: 'set null' }),
});

export type PlayReview = typeof playReviews.$inferSelect;
