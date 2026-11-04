import type { AppServices } from '../../platform/http/context.js';
import { AppError, ErrorCode } from '../../platform/http/errors.js';
import type { AdminActor } from '../admin/admin-audit.service.js';
import { sniffImage } from '../images/image-processing.js';
import { OpenAiClient } from '../reviews/openai-client.js';
import { readOpenAiKey } from '../reviews/reviews.service.js';
import { BlogService, type BlogPostView } from './blog.service.js';

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
    const scene = (await client.completeJson(
      `You art-direct cover photos for a Brazilian small-business blog about inventory control (Estoque Simples). Describe ONE realistic photograph for the post's cover. Rules: a real, everyday scene in a small Brazilian business (corner grocery, clothing store, hardware store, bakery, stockroom, market stall), concrete objects and products, natural light, warm and professional. People are fine, seen at work (hands, profile, back), never posing for the camera. No text, letters, numbers, labels, price tags, logos, brands, phone or computer screens with readable content, charts, or illustrations. Answer in JSON: {"scene": "the scene in English, 40 to 70 words, describing subject, setting, light and framing", "alt": "alt text in Brazilian Portuguese describing what the photo shows, up to 120 characters"}.`,
      `Post title: ${post.title}\nSummary: ${post.excerpt}\nCategory: ${post.category}\nPost text (excerpt): ${summary}`,
      400,
      0.8,
    )) as { scene?: string; alt?: string };
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
    const image = await client.generateImage(prompt, { model, quality });
    await log(`Foto gerada com ${image.model}${image.model !== model ? ` (o ${model} não está liberado para esta conta)` : ''} em ${((Date.now() - startedAt) / 1000).toFixed(1)} s, ${Math.round(image.bytes.length / 1024)} KB.`);

    await report('Recortando em 1200×630 e guardando');
    // gpt-image-1 devolve PNG; o dall-e-3 também, mas o tipo vem dos bytes para não depender disso.
    const kind = sniffImage(image.bytes);
    if (!kind) throw new AppError(502, ErrorCode.SERVICE_UNAVAILABLE, 'A OpenAI devolveu a imagem num formato inesperado.');
    const updated = await this.blog.setCover(actor, postId, image.bytes, `image/${kind}`, { coverAlt: alt });
    await log(`Capa gravada: ${updated.coverUrl ?? '—'}`);
    return updated;
  }
}
