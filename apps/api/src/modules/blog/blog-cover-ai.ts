import { and, desc, eq, isNotNull, ne } from 'drizzle-orm';

import { blogPosts } from '../../platform/db/schema/index.js';
import type { AppServices } from '../../platform/http/context.js';
import { AppError, ErrorCode } from '../../platform/http/errors.js';
import type { AdminActor } from '../admin/admin-audit.service.js';
import { sniffImage } from '../images/image-processing.js';
import { OpenAiClient } from '../reviews/openai-client.js';
import { readOpenAiKey } from '../reviews/reviews.service.js';
import { BlogService, type BlogPostView } from './blog.service.js';
import { COVER_FRAMINGS, COVER_PEOPLE, COVER_SETTINGS, pickCoverStyle, type CoverStyle } from './blog-cover-style.js';

type Log = (message: string, level?: 'info' | 'warn' | 'error') => Promise<void>;

/**
 * Capa do post gerada pela IA: uma fotografia realista, sem texto, recortada
 * em 1200×630 (o tamanho que as metatags, o JSON-LD e o <img> declaram).
 *
 * Duas chamadas: o modelo de texto lê o post e descreve uma cena fotográfica
 * concreta (e o texto alternativo em português); o modelo de imagem gera a
 * foto a partir dela. A cena é pedida em inglês, que os modelos de imagem
 * seguem melhor. O recorte usa o mesmo `normalizeImage` do envio manual,
 * com foco automático no assunto.
 */
export class BlogCoverAi {
  private readonly blog: BlogService;

  constructor(private readonly services: AppServices) {
    this.blog = new BlogService(services);
  }

  async generate(postId: string, actor: AdminActor | null, hooks: { report?: (step: string) => Promise<void>; log?: Log } = {}): Promise<BlogPostView> {
    const report = hooks.report ?? (async () => undefined);
    const log = hooks.log ?? (async () => undefined);
    const apiKey = await readOpenAiKey(this.services);
    if (!apiKey) throw new AppError(409, ErrorCode.CONFLICT, 'Configure a chave da OpenAI (painel › Inteligência artificial) para gerar capas.');
    if (!this.services.storage.configured) throw new AppError(503, ErrorCode.IMAGES_UNAVAILABLE, 'O armazenamento de imagens não está disponível agora.');
    const post = await this.blog.getById(postId);
    const client = new OpenAiClient(apiKey, this.services.env.OPENAI_MODEL);

    await report('Descrevendo a cena da foto');
    const summary = (post.contentMd ?? '').replace(/[#*_>`[\]()]/g, ' ').replace(/\s+/g, ' ').slice(0, 1500);
    const recent = (
      await this.services.db
        .select({ style: blogPosts.coverStyle })
        .from(blogPosts)
        .where(and(isNotNull(blogPosts.coverStyle), ne(blogPosts.id, postId)))
        .orderBy(desc(blogPosts.updatedAt))
        .limit(10)
    )
      .map((row) => row.style)
      .filter((style): style is CoverStyle => !!style);
    const picked = pickCoverStyle(recent);
    const settingOptions = picked.settings.map((key) => `- ${key}: ${COVER_SETTINGS[key]}`).join('\n');
    const scene = (await client.completeJson(
      `You art-direct cover photos for a Brazilian small-business blog about inventory control (Estoque Simples), used by many kinds of small shops, not only groceries. Describe ONE realistic photograph for the post's cover. Pick the business that best fits the post from these options (use exactly one key):\n${settingOptions}\nWho appears: ${COVER_PEOPLE[picked.person]}. Framing: ${COVER_FRAMINGS[picked.framing]}. Keep those choices; vary clothing (no green t-shirt, no apron unless it fits the business), colors and props. People are seen at work, never posing for the camera. A real, everyday Brazilian scene, natural light, warm and professional. No text, letters, numbers, labels, price tags, logos, brands, phone or computer screens with readable content, charts, or illustrations. Answer in JSON: {"setting": "the chosen key", "scene": "the scene in English, 40 to 70 words, describing subject, setting, light and framing", "alt": "alt text in Brazilian Portuguese describing what the photo shows, up to 120 characters"}.`,
      `Post title: ${post.title}\nSummary: ${post.excerpt}\nCategory: ${post.category}\nPost text (excerpt): ${summary}`,
      450,
      0.9,
    )) as { setting?: string; scene?: string; alt?: string };
    const settingKey = typeof scene.setting === 'string' && picked.settings.includes(scene.setting) ? scene.setting : picked.settings[0]!;
    const style: CoverStyle = { setting: settingKey, person: picked.person, framing: picked.framing };
    await log(`Estilo: ${style.setting} · ${style.person} · ${style.framing}`);
    const sceneText = String(scene.scene ?? '').trim();
    const alt = String(scene.alt ?? '').trim().slice(0, 200) || `Foto ilustrativa do post ${post.title}`;
    if (sceneText.length < 20) throw new AppError(502, ErrorCode.SERVICE_UNAVAILABLE, 'A OpenAI não descreveu uma cena válida para a capa.');
    await log(`Cena: ${sceneText}`);
    await log(`Texto alternativo: ${alt}`);

    const model = this.services.env.OPENAI_IMAGE_MODEL;
    const quality = this.services.env.OPENAI_IMAGE_QUALITY;
    await report(`Gerando a foto com ${model} (pode levar até 1 minuto)`);
    const prompt = `Photorealistic editorial photograph, shot on a full-frame camera with a 35mm lens, natural light, shallow depth of field, realistic colors and textures. ${sceneText} Horizontal composition with the main subject near the center and some breathing room on the sides, because the image will be cropped to a 1200x630 banner. The image must contain absolutely no text, letters, numbers, signs, labels, logos or watermarks.`;
    const startedAt = Date.now();
    const image = await client.generateImage(prompt, { model, quality, onAttempt: (message) => log(message, 'warn') });
    await log(`Foto gerada com ${image.model}${image.model !== model ? ` (o ${model} não está liberado para esta conta)` : ''} em ${((Date.now() - startedAt) / 1000).toFixed(1)} s, ${Math.round(image.bytes.length / 1024)} KB.`);

    await report('Recortando em 1200×630 e guardando');
    // gpt-image-1 devolve PNG; o dall-e-3 também, mas o tipo vem dos bytes para não depender disso.
    const kind = sniffImage(image.bytes);
    if (!kind) throw new AppError(502, ErrorCode.SERVICE_UNAVAILABLE, 'A OpenAI devolveu a imagem num formato inesperado.');
    const updated = await this.blog.setCover(actor, postId, image.bytes, `image/${kind}`, { coverAlt: alt });
    await this.services.db.update(blogPosts).set({ coverStyle: style }).where(eq(blogPosts.id, postId));
    await log(`Capa gravada: ${updated.coverUrl ?? '—'}`);
    return updated;
  }
}
