/**
 * O texto buscado na Central de Ajuda, preparado para virar propriedade de
 * evento — ou descartado.
 *
 * Por que isto existe: até agora `help.searched` guardava só a contagem de
 * resultados, e com isso sabíamos que 29 pessoas procuraram algo sem saber
 * **o quê**. Essas são as dúvidas reais de quem usa o produto, e servem de
 * pauta para a ajuda e para o blog.
 *
 * Por que com filtro: o campo é livre. A política de privacidade promete
 * eventos "sem conteúdo do estoque", o que esta busca não é — ela é sobre o
 * aplicativo. Ainda assim, alguém pode digitar um e-mail ou um telefone ali
 * sem pensar, e isso não pode virar evento. Na dúvida, descarta-se o termo:
 * o evento continua saindo com a contagem, como antes.
 *
 * A busca na lista de produtos (`search.performed`) continua **sem texto**:
 * aquilo é conteúdo do estoque do cliente.
 */

/** Parece dado de alguém? E-mail, telefone/CPF/CNPJ, cartão, endereço web. */
function pareceDadoPessoal(texto: string): boolean {
  if (texto.includes('@')) return true;
  if (/https?:|www\./i.test(texto)) return true;
  // 6 dígitos seguidos já não é "quantidade" nem "estoque 10": é identificador.
  if (/\d[\d\s.-]{5,}/.test(texto)) return true;
  return false;
}

/** Até onde o termo é guardado. Dúvida real cabe folgado nisso. */
export const LIMITE = 60;

/**
 * Devolve o termo pronto para o evento, ou `null` quando ele não deve ser
 * registrado (vazio, longo demais para ser dúvida, ou com cara de dado
 * pessoal).
 */
export function termoDeBusca(bruto: string): string | null {
  const limpo = bruto.trim().replace(/\s+/g, ' ').toLocaleLowerCase('pt-BR');
  if (limpo.length < 2) return null;
  // Texto muito longo não é busca: é alguém colando algo. Fora.
  if (limpo.length > LIMITE) return null;
  if (pareceDadoPessoal(limpo)) return null;
  return limpo;
}
