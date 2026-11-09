/**
 * Variedade das capas geradas pela IA. Sem isto o modelo cai sempre na mesma
 * foto (homem de meia-idade, camiseta verde, mercearia). Aqui o sistema
 * sorteia o tipo de comércio, quem aparece e o enquadramento, evitando o que
 * as últimas capas usaram; o modelo de texto escolhe entre algumas opções de
 * comércio a que combina com o post e descreve a cena.
 */

export interface CoverStyle {
  setting: string;
  person: string;
  framing: string;
}

/** Negócios em que o Estoque Simples é usado (os segmentos do cadastro e vizinhos). */
export const COVER_SETTINGS: Record<string, string> = {
  roupas: 'a small clothing boutique with folded jeans, shirts on hangers and a fitting room curtain',
  calcados: 'a shoe store stockroom with stacked shoe boxes and sneakers on display shelves',
  salao: 'a beauty salon with hair products, dye tubes and towels organized on shelves behind the chair',
  cosmeticos: 'a cosmetics and perfume shop with lipsticks, creams and perfume bottles on glass shelves',
  mercearia: 'a neighborhood grocery store with bulk grains, canned goods and fresh produce',
  ferragens: 'a hardware and building materials store with screws in drawers, paint cans and tools on pegboards',
  pet: 'a pet shop with bags of pet food, toys, leashes and an aquarium section',
  papelaria: 'a stationery store with notebooks, pens, colored paper and school supplies on shelves',
  autopecas: 'an auto parts store with boxed parts, oil bottles and tires on metal racks',
  celulares: 'a phone accessories shop with cases, chargers and headphones on a wall display',
  padaria: 'a bakery and café counter with bread baskets, cakes and coffee bags behind it',
  bebidas: 'a beverage distributor with crates of bottles and stacked cases in a bright warehouse',
  artesanato: 'a handmade crafts studio with fabric rolls, yarn, jars of beads and finished pieces',
  farmacia: 'a small pharmacy with organized medicine boxes and hygiene products on white shelves',
  utilidades: 'a home goods store with kitchenware, plastic containers and cleaning products',
  ecommerce: 'an online seller packing orders at a table with cardboard boxes, bubble wrap and products on shelves',
  floricultura: 'a flower shop with buckets of fresh flowers, potted plants and wrapping paper',
  brinquedos: 'a toy store with colorful boxed toys, plush animals and board games on shelves',
};

export const COVER_PEOPLE: Record<string, string> = {
  mulher_negra_30: 'a Black Brazilian woman in her early 30s with braided hair',
  jovem_cacheado: 'a young Brazilian man in his 20s with curly hair and a casual t-shirt',
  senhora_60: 'a Brazilian woman in her 60s with short grey hair and glasses',
  nipo_40: 'a Japanese-Brazilian woman in her 40s',
  homem_barba_40: 'a Brazilian man in his late 30s with a full beard and a denim shirt',
  jovem_mulher_parda: 'a young mixed-race Brazilian woman in her 20s with long dark hair in a ponytail',
  homem_negro_50: 'a Black Brazilian man in his 50s with a short grey beard',
  dupla: 'two coworkers, a woman and a man in their 30s, working together',
  so_maos: 'only the hands of the person working (no face visible)',
  sem_pessoa: 'no people at all, only the products and the space, neatly organized',
};

export const COVER_FRAMINGS: Record<string, string> = {
  detalhe: 'close-up detail shot of products and hands, background softly blurred',
  plano_medio: 'medium shot at eye level, the person in profile or three-quarter view',
  amplo: 'wide shot of the store interior showing the shelves and the person small in the scene',
  por_tras: 'over-the-shoulder shot from behind the person, looking at what they are organizing',
  de_cima: 'top-down view of a table or counter with products being sorted',
};

/** Sorteia sem repetir os mais recentes; `random` injetável para os testes. */
function pickFresh(keys: string[], recent: string[], avoid: number, random: () => number): string {
  const blocked = new Set(recent.slice(0, avoid));
  const pool = keys.filter((key) => !blocked.has(key));
  const options = pool.length > 0 ? pool : keys;
  return options[Math.floor(random() * options.length) % options.length]!;
}

/**
 * Estilo da próxima capa. `recent`: estilos das últimas capas, da mais nova
 * para a mais antiga. Devolve até 4 comércios candidatos (o modelo escolhe o
 * que combina com o assunto), uma pessoa e um enquadramento.
 */
export function pickCoverStyle(recent: CoverStyle[], random: () => number = Math.random): { settings: string[]; person: string; framing: string } {
  const recentSettings = recent.map((item) => item.setting);
  const settings: string[] = [];
  const keys = Object.keys(COVER_SETTINGS);
  while (settings.length < 4) {
    const next = pickFresh(keys.filter((key) => !settings.includes(key)), recentSettings, 8, random);
    settings.push(next);
  }
  return {
    settings,
    person: pickFresh(Object.keys(COVER_PEOPLE), recent.map((item) => item.person), 5, random),
    framing: pickFresh(Object.keys(COVER_FRAMINGS), recent.map((item) => item.framing), 2, random),
  };
}
