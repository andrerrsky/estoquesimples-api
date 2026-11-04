import type { AppServices } from '../../platform/http/context.js';
import { enqueueJob, registerJobHandler } from '../../platform/jobs/runner.js';
import { readOpenAiKey } from '../reviews/reviews.service.js';
import { AI_TOPICS, BlogAiWriter } from './blog-ai.js';
import { BlogCoverAi } from './blog-cover-ai.js';
import { BLOG_NOTIFY_JOB, BlogService } from './blog.service.js';

export const BLOG_AI_WRITE_JOB = 'blog.ai_write';
/** Capa de um post gerada pela IA (botão "Gerar com IA" na seção Capa do editor). */
export const BLOG_AI_COVER_JOB = 'blog.ai_cover';

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

  // Post escrito pela IA. Duas origens: a agenda (terça, quinta e sexta,
  // que se reagenda sozinha) e o botão "Escrever com IA" do painel
  // (`manual: true`, vira rascunho e não mexe na agenda). As duas passam
  // pela fila para ganhar a página de acompanhamento com log.
  registerJobHandler(BLOG_AI_WRITE_JOB, async (payload, context) => {
    const manual = payload['manual'] === true;
    try {
      const blog = new BlogService(context.services);
      const settings = await blog.settings();
      if (!manual && !settings.aiEnabled) {
        context.logger.info('geração de posts por IA desligada; nada a fazer');
        await context.log('Geração automática desligada no Blog › IA e configurações; nada a fazer.', 'warn');
        return;
      }
      if (!(await readOpenAiKey(context.services))) {
        context.logger.warn('geração de posts por IA sem chave da OpenAI configurada');
        if (manual) throw new Error('Configure a chave da OpenAI (painel › Inteligência artificial) para a IA escrever posts.');
        await context.log('Sem chave da OpenAI configurada (painel › Inteligência artificial); nada a fazer.', 'warn');
        return;
      }
      const topicKey = typeof payload['topicKey'] === 'string' ? payload['topicKey'] : null;
      const topic = topicKey ? AI_TOPICS.find((item) => item.key === topicKey) : undefined;
      if (topicKey && !topic) throw new Error(`Pauta desconhecida: ${topicKey}`);
      const membersOnly = !manual && isMembersOnlyRun(new Date()) && settings.aiMembersOnlyWeekly;
      await context.log(manual ? `Pedido pelo painel${typeof payload['requestedBy'] === 'string' ? ` (${payload['requestedBy']})` : ''}: o post sai como rascunho.` : 'Execução agendada.');
      const post = await new BlogAiWriter(context.services).writePost({
        membersOnly,
        ...(manual ? { publish: payload['publish'] === true } : {}),
        ...(topic ? { topic } : {}),
        report: context.progress,
        log: context.log,
      });
      // Capa: uma foto gerada pela IA. Falhar aqui não perde o post: ele fica
      // com a capa automática (título e categoria) e dá para gerar depois.
      let coverUrl: string | null = null;
      if (context.services.storage.configured) {
        try {
          const withCover = await new BlogCoverAi(context.services).generate(post.id, null, { report: context.progress, log: context.log });
          coverUrl = withCover.coverUrl;
        } catch (error) {
          await context.log(`Capa não gerada (o post fica com a capa automática): ${error instanceof Error ? error.message : String(error)}`, 'warn');
        }
      } else {
        await context.log('Armazenamento de imagens desligado: o post fica com a capa automática.', 'warn');
      }
      await context.setResult({ postId: post.id, slug: post.slug, title: post.title, status: post.status, coverUrl });
      context.logger.info({ postId: post.id, slug: post.slug, status: post.status, topic: post.aiTopic }, 'post do blog escrito pela IA');
    } finally {
      if (!manual) await scheduleNext(context.services);
    }
  });
  registerBlogCoverJob();
}

/** Gera a capa de um post (pedido pelo editor). */
export function registerBlogCoverJob(): void {
  registerJobHandler(BLOG_AI_COVER_JOB, async (payload, context) => {
    const postId = typeof payload['postId'] === 'string' ? payload['postId'] : null;
    if (!postId) throw new Error('Tarefa sem o id do post.');
    await context.log(`Pedido pelo editor${typeof payload['requestedBy'] === 'string' ? ` (${payload['requestedBy']})` : ''}.`);
    const post = await new BlogCoverAi(context.services).generate(postId, null, { report: context.progress, log: context.log });
    await context.setResult({ postId: post.id, slug: post.slug, title: post.title, coverUrl: post.coverUrl });
  });
}

export async function bootstrapBlogJobs(services: AppServices): Promise<void> {
  await scheduleNext(services);
}
