/**
 * Textos dos e-mails do ciclo de vida.
 *
 * Estilo de pré-vendas (SDR), em texto simples e curto: assinados por uma
 * pessoa, um assunto que soa como mensagem e não como propaganda, um
 * benefício concreto, **uma** ação por e-mail e uma pergunta que convida a
 * responder (as respostas vão para o suporte). O último da sequência de
 * ativação é o "e-mail de despedida": avisa que é o último, o que costuma
 * ser o que mais recebe resposta.
 *
 * Nenhum dado do estoque do cliente aparece aqui além de contagens.
 */
export const LIFECYCLE_KINDS = [
  'activation_d1',
  'activation_d4',
  'activation_d8',
  'confirm_email',
  'reengage_14d',
  'limit_40',
  'limit_50',
  // Aviso antes da 1ª cobrança cheia de assinatura com cupom (transacional).
  'promo_renewal_monthly_d7',
  'promo_renewal_yearly_d15',
  'promo_renewal_yearly_d3',
  // Campanha Black Friday 2026 para a base grátis (docs/black-friday-2026.md).
  'bf2026_launch',
  'bf2026_today',
  'bf2026_last_day',
] as const;
export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];

export const LIFECYCLE_LABELS: Record<LifecycleKind, string> = {
  activation_d1: 'Ativação · dia 1 (cadastre o 1º produto)',
  activation_d4: 'Ativação · dia 4 (importe a planilha)',
  activation_d8: 'Ativação · dia 8 (último, pessoal)',
  confirm_email: 'Confirmar e-mail (quem já ativou)',
  reengage_14d: 'Reengajamento · 14 dias sem uso',
  limit_40: 'Plano grátis · 40 de 50 produtos',
  limit_50: 'Plano grátis · limite atingido',
  promo_renewal_monthly_d7: 'Cupom · mensal, 7 dias antes da 1ª mensalidade cheia',
  promo_renewal_yearly_d15: 'Cupom · anual, 15 dias antes da renovação',
  promo_renewal_yearly_d3: 'Cupom · anual, 3 dias antes da renovação',
  bf2026_launch: 'Black Friday · 20/11 (lançamento)',
  bf2026_today: 'Black Friday · 27/11 (é hoje)',
  bf2026_last_day: 'Black Friday · 01/12 (último dia)',
};

/** Avisos de assinatura: saem mesmo para quem não recebe as dicas (só uma vez por marco). */
export const TRANSACTIONAL_KINDS: ReadonlySet<LifecycleKind> = new Set(['promo_renewal_monthly_d7', 'promo_renewal_yearly_d15', 'promo_renewal_yearly_d3']);

/** Dados da oferta ou da assinatura com cupom, para os e-mails de promoção. */
export interface PromoTemplateContext {
  label: string;
  code: string;
  /** Preço cheio do anual e do mensal (de `plans`). */
  yearlyFullCents: number;
  yearlyPromoCents: number;
  monthlyFullCents: number;
  /** Último dia da campanha (inclusivo). */
  endsAt: Date;
  /** Data da próxima cobrança (YYYY-MM-DD) e o valor cheio dela, nos avisos de renovação. */
  nextDueDate?: string | null;
  nextChargeCents?: number | null;
}

/** Exemplo do painel (aba Textos): os números da Black Friday 2026. */
export const SAMPLE_PROMO: PromoTemplateContext = {
  label: 'Black Friday',
  code: 'BF26',
  yearlyFullCents: 19990,
  yearlyPromoCents: 11990,
  monthlyFullCents: 2499,
  endsAt: new Date('2026-12-02T02:59:59Z'),
  nextDueDate: '2026-12-20',
  nextChargeCents: 2499,
};

export interface TemplateContext {
  firstName: string;
  workspaceName: string | null;
  emailVerified: boolean;
  productCount: number;
  lowStockCount: number | null;
  /** Monta um link rastreável para um caminho da aplicação web. */
  link: (path: string) => string;
  unsubscribeUrl: string;
  /** Só nos e-mails de promoção; sem ele, valem os números de exemplo. */
  promo?: PromoTemplateContext | null;
}

export interface RenderedEmail {
  subject: string;
  text: string;
}

function hello(ctx: TemplateContext): string {
  return ctx.firstName ? `Oi, ${ctx.firstName}!` : 'Oi!';
}

function footer(ctx: TemplateContext): string {
  return (
    '\n\n—\nAndré\nEstoque Simples · estoquesimples.com.br\n\n' +
    `Você recebe estas mensagens porque criou uma conta no Estoque Simples. Para não receber mais: ${ctx.unsubscribeUrl}`
  );
}

/** Rodapé dos avisos de assinatura: sem descadastro (não é propaganda). */
function transactionalFooter(): string {
  return (
    '\n\n—\nAndré\nEstoque Simples · estoquesimples.com.br\n\n' +
    'Este é um aviso sobre a assinatura da sua empresa: ele chega mesmo para quem não recebe as dicas por e-mail.'
  );
}

const brl = (cents: number): string =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(cents / 100).replace(/\u00a0/g, ' ');

const dayMonth = (date: Date): string =>
  new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit' }).format(date);

/** "2026-12-20" → "20/12/2026". */
const dateBr = (value: string | null | undefined): string => {
  if (!value) return 'a próxima data de cobrança';
  const [y, m, d] = value.split('-');
  return `${d}/${m}/${y}`;
};

function campaignEmail(kind: 'bf2026_launch' | 'bf2026_today' | 'bf2026_last_day', ctx: TemplateContext): RenderedEmail {
  const p = ctx.promo ?? SAMPLE_PROMO;
  const off = Math.round((1 - p.yearlyPromoCents / p.yearlyFullCents) * 100);
  const until = dayMonth(p.endsAt);
  const perMonth = p.yearlyPromoCents / 12 < 1000 ? 'menos de R$ 10 por mês' : `cerca de ${brl(Math.round(p.yearlyPromoCents / 12))} por mês`;
  const subject =
    kind === 'bf2026_launch'
      ? `${p.label}: Estoque Simples com ${off}% off`
      : kind === 'bf2026_today'
        ? `É hoje: ${p.label} do Estoque Simples com ${off}% off`
        : `Último dia: Estoque Simples com ${off}% off`;
  // Texto simples não tem pré-cabeçalho: a 1ª linha é o que aparece na prévia da caixa de entrada.
  const preheader =
    kind === 'bf2026_last_day'
      ? `Plano anual por ${brl(p.yearlyPromoCents)}, só até hoje (${until})`
      : `Plano anual por ${brl(p.yearlyPromoCents)}, só até ${until}`;
  const opening =
    kind === 'bf2026_today'
      ? `É hoje a ${p.label}. `
      : kind === 'bf2026_last_day'
        ? `Último dia da ${p.label}: o desconto acaba hoje à meia-noite. `
        : '';
  return {
    subject,
    text:
      `${preheader}\n\n` +
      `${hello(ctx)}\n\n` +
      opening +
      `Produtos ilimitados, sua equipe e seus aparelhos sincronizados. De ${brl(p.yearlyFullCents)} por ${brl(p.yearlyPromoCents)} no ano — ${perMonth}.\n\n` +
      `Ativar com desconto: ${ctx.link(`/black-friday?cupom=${encodeURIComponent(p.code)}`)}` +
      footer(ctx),
  };
}

function renewalEmail(kind: 'promo_renewal_monthly_d7' | 'promo_renewal_yearly_d15' | 'promo_renewal_yearly_d3', ctx: TemplateContext): RenderedEmail {
  const p = ctx.promo ?? SAMPLE_PROMO;
  const monthly = kind === 'promo_renewal_monthly_d7';
  const value = brl(p.nextChargeCents ?? (monthly ? p.monthlyFullCents : p.yearlyFullCents));
  const when = dateBr(p.nextDueDate);
  const company = ctx.workspaceName ? ` da ${ctx.workspaceName}` : '';
  return {
    subject: monthly ? `Sua próxima mensalidade do plano Equipe: ${value} em ${when}` : `Seu plano Equipe renova em ${when} por ${value}`,
    text:
      `${hello(ctx)}\n\n` +
      (monthly
        ? `O desconto da ${p.label} valeu para o 1º mês do plano Equipe${company}. A próxima mensalidade, em ${when}, será de ${value} (o preço normal), na mesma forma de pagamento.\n\n`
        : `O plano Equipe${company} foi contratado com o desconto da ${p.label} e renova em ${when} por ${value} ao ano (o preço normal), na mesma forma de pagamento.\n\n`) +
      'Para continuar, não precisa fazer nada. Se preferir cancelar a renovação, é só abrir Plano; o acesso continua até o fim do período já pago.\n\n' +
      `Ver o plano: ${ctx.link('/app/plano')}\n\n` +
      'Ficou alguma dúvida? É só responder este e-mail.' +
      transactionalFooter(),
  };
}

function confirmPs(ctx: TemplateContext): string {
  return ctx.emailVerified ? '' : `\n\nP.S.: ainda falta confirmar o seu e-mail (é o que permite convidar a sua equipe): ${ctx.link('/app/conta')}`;
}

export function renderLifecycleEmail(kind: LifecycleKind, ctx: TemplateContext): RenderedEmail {
  switch (kind) {
    case 'activation_d1':
      return {
        subject: 'Seu estoque está pronto (falta 1 passo)',
        text:
          `${hello(ctx)}\n\n` +
          'Vi que você criou a conta no Estoque Simples ontem, mas o estoque ainda está vazio.\n\n' +
          'Cadastrar o primeiro produto leva menos de um minuto: nome, quantidade e, se quiser, o estoque mínimo para ser avisado antes de acabar.\n\n' +
          `Cadastre agora: ${ctx.link('/app/estoque?primeiro=1')}\n\n` +
          'Ficou alguma dúvida? É só responder este e-mail.' +
          confirmPs(ctx) +
          footer(ctx),
      };
    case 'activation_d4':
      return {
        subject: 'Já controla o estoque numa planilha?',
        text:
          `${hello(ctx)}\n\n` +
          'Muita gente que chega ao Estoque Simples já tem a lista de produtos numa planilha ou num caderno.\n\n' +
          'Se for o seu caso, dá para trazer tudo de uma vez:\n' +
          '1. Abra "Importar" no menu\n' +
          '2. Escolha o arquivo (Excel ou CSV)\n' +
          '3. Confira as colunas e confirme\n\n' +
          `Importar agora: ${ctx.link('/app/importar')}\n\n` +
          'Como você controla o estoque hoje? Se me contar, eu te digo o jeito mais rápido de começar.' +
          confirmPs(ctx) +
          footer(ctx),
      };
    case 'activation_d8':
      return {
        subject: 'Posso te ajudar a começar?',
        text:
          `${hello(ctx)}\n\n` +
          'Esta é a minha última mensagem sobre isso, prometo.\n\n' +
          'Você criou a conta no Estoque Simples há uma semana e ainda não cadastrou nenhum produto. Normalmente é por um destes motivos:\n' +
          '- não deu tempo (acontece);\n' +
          '- não ficou claro por onde começar;\n' +
          '- o app não faz algo de que você precisa.\n\n' +
          'Qual foi o seu caso? Responda com uma linha: eu leio pessoalmente e te ajudo a configurar, ou anoto o que falta.\n\n' +
          `Se quiser tentar de novo agora: ${ctx.link('/app/estoque?primeiro=1')}` +
          footer(ctx),
      };
    case 'confirm_email':
      return {
        subject: 'Confirme seu e-mail para chamar a equipe',
        text:
          `${hello(ctx)}\n\n` +
          `Que bom ver ${ctx.workspaceName ? `a ${ctx.workspaceName}` : 'a sua empresa'} com produtos no Estoque Simples!\n\n` +
          'Falta só confirmar o seu e-mail. Com ele confirmado, você pode convidar outras pessoas para trabalhar no mesmo estoque.\n\n' +
          `Confirmar: ${ctx.link('/app/conta')}` +
          footer(ctx),
      };
    case 'reengage_14d': {
      const low =
        ctx.lowStockCount && ctx.lowStockCount > 0
          ? `Pelo que está registrado, ${ctx.lowStockCount === 1 ? '1 produto está' : `${ctx.lowStockCount} produtos estão`} abaixo do estoque mínimo.\n\n`
          : '';
      return {
        subject: `${ctx.workspaceName ?? 'Seu estoque'}: o estoque está em dia?`,
        text:
          `${hello(ctx)}\n\n` +
          'Faz duas semanas que ninguém mexe no estoque por aqui. ' +
          low +
          'Uma conferida rápida com as entradas e saídas destes dias deixa tudo certo de novo, e o relatório de reposição mostra o que comprar.\n\n' +
          `Abrir o estoque: ${ctx.link('/app/estoque')}\n\n` +
          'Se parou de usar por algum motivo, me conta respondendo este e-mail? Ajuda muito a melhorar.' +
          footer(ctx),
      };
    }
    case 'limit_40':
      return {
        subject: 'Você já cadastrou 40 dos 50 produtos grátis',
        text:
          `${hello(ctx)}\n\n` +
          `${ctx.workspaceName ?? 'Sua empresa'} já tem ${ctx.productCount} produtos no Estoque Simples. O plano grátis guarda até 50 na nuvem.\n\n` +
          'Antes de chegar lá, vale conhecer o plano Equipe: produtos sem limite, outras pessoas no mesmo estoque e a Análise Avançada.\n\n' +
          `Ver o plano: ${ctx.link('/app/plano')}\n\n` +
          'Tem alguma dúvida sobre o plano? Responda este e-mail.' +
          footer(ctx),
      };
    case 'promo_renewal_monthly_d7':
    case 'promo_renewal_yearly_d15':
    case 'promo_renewal_yearly_d3':
      return renewalEmail(kind, ctx);
    case 'bf2026_launch':
    case 'bf2026_today':
    case 'bf2026_last_day':
      return campaignEmail(kind, ctx);
    case 'limit_50':
      return {
        subject: 'Seu estoque chegou ao limite do plano grátis',
        text:
          `${hello(ctx)}\n\n` +
          `${ctx.workspaceName ?? 'Sua empresa'} chegou aos 50 produtos do plano grátis. Os que já estão cadastrados continuam aí; para cadastrar mais na nuvem, é preciso o plano Equipe.\n\n` +
          `Assinar: ${ctx.link('/app/plano')}\n\n` +
          'Se o valor estiver pesando agora, me responda: vejo o que dá para fazer.' +
          footer(ctx),
      };
  }
}
