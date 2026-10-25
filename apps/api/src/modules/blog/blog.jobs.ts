import type { AppServices } from '../../platform/http/context.js';
import { enqueueJob, registerJobHandler } from '../../platform/jobs/runner.js';
import { readOpenAiKey } from '../reviews/reviews.service.js';
import { BlogAiWriter } from './blog-ai.js';
import { BLOG_NOTIFY_JOB, BlogService } from './blog.service.js';

export const BLOG_AI_WRITE_JOB = 'blog.ai_write';

/**
 * Terça e sexta às 9h de Brasília (12:00 UTC): os dois posts públicos da
 * semana. Quinta, o terceiro: exclusivo para quem tem conta (ver
 * `aiMembersOnlyWeekly`), com conteúdo a mais.
 */
const PUBLIC_WEEKDAYS_UTC = [2, 5];
const MEMBERS_WEEKDAY_UTC = 4;
const HOUR_UTC = 12;

/** O post de quinta é o exclusivo. */
export function isMembersOnlyRun(runAt: Date): boolean {
  return runAt.getUTCDay() === MEMBERS_WEEKDAY_UTC;
}

export function nextAiRun(from = new Date(), options: { membersOnlyWeekly?: boolean } = {}): Date {
  const weekdays = options.membersOnlyWeekly === false ? PUBLIC_WEEKDAYS_UTC : [...PUBLIC_WEEKDAYS_UTC, MEMBERS_WEEKDAY_UTC];
  for (let offset = 0; offset < 8; offset += 1) {
    const candidate = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate() + offset, HOUR_UTC, 0, 0));
    if (weekdays.includes(candidate.getUTCDay()) && candidate.getTime() > from.getTime() + 60_000) return candidate;
  }
  return new Date(from.getTime() + 7 * 86_400_000);
}

async function scheduleNext(services: AppServices): Promise<void> {
  const settings = await new BlogService(services).settings();
  const runAt = nextAiRun(new Date(), { membersOnlyWeekly: settings.aiMembersOnlyWeekly });
  await enqueueJob(services.db, {
    kind: BLOG_AI_WRITE_JOB,
    uniqueKey: `${BLOG_AI_WRITE_JOB}:${runAt.toISOString().slice(0, 10)}`,
    runAt,
    maxAttempts: 2,
  });
}

export function registerBlogJobs(_services: AppServices): void {
  // Aviso de post novo: caixa de notificações de todas as contas e push.
  registerJobHandler(BLOG_NOTIFY_JOB, async (payload, context) => {
    const postId = typeof payload['postId'] === 'string' ? payload['postId'] : null;
    if (!postId) {
      context.logger.error({ payload }, 'aviso de post sem id; tarefa ignorada');
      return;
    }
    const result = await new BlogService(context.services).notifyEveryone(postId);
    context.logger.info({ postId, ...result }, 'post do blog avisado');
  });

  // Post escrito pela IA. Sem chave ou com a geração desligada, só reagenda.
  registerJobHandler(BLOG_AI_WRITE_JOB, async (_payload, context) => {
    try {
      const blog = new BlogService(context.services);
      const settings = await blog.settings();
      if (!settings.aiEnabled) {
        context.logger.info('geração de posts por IA desligada; nada a fazer');
        return;
      }
      if (!(await readOpenAiKey(context.services))) {
        context.logger.warn('geração de posts por IA sem chave da OpenAI configurada');
        return;
      }
      const membersOnly = isMembersOnlyRun(new Date()) && settings.aiMembersOnlyWeekly;
      const post = await new BlogAiWriter(context.services).writePost({ membersOnly });
      context.logger.info({ postId: post.id, slug: post.slug, status: post.status, topic: post.aiTopic }, 'post do blog escrito pela IA');
    } finally {
      await scheduleNext(context.services);
    }
  });
}

export async function bootstrapBlogJobs(services: AppServices): Promise<void> {
  await scheduleNext(services);
}
