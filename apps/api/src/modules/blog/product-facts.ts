/**
 * Fatos do produto em fonte única: a IA do blog escreve a partir deles e os
 * arquivos para buscadores de IA (llms.txt) os publicam. Só o que o app faz
 * hoje; sem preços (são configuráveis no servidor).
 */
export const PRODUCT_FACT_LINES: readonly string[] = [
  'É um controle de estoque brasileiro para pequenos negócios: mercearia, loja de roupas, pet shop, papelaria, distribuidora, lanchonete, revenda, salão.',
  'Existe como aplicativo Android (Google Play) e como versão web em estoquesimples.com.br (navegador no computador, tablet e celular, inclusive iPhone e iPad como web app na tela inicial). Não existe app na App Store.',
  'Cadastro de produtos com nome, categoria, fornecedor, localização, unidade (un, kg, L, caixa…), valor unitário, estoque mínimo, código de barras e foto.',
  'Entradas e saídas em poucos toques; o saldo se atualiza na hora; todo movimento fica no histórico com data e quem lançou; é possível estornar.',
  'Aviso de estoque baixo: na lista, nos relatórios e, no Android, uma notificação diária no aparelho; na web, avisos opcionais no navegador.',
  'Leitor de código de barras pela câmera (Android e navegadores com câmera) e por leitor USB no computador.',
  'Relatórios: valor do estoque, produtos abaixo do mínimo, movimentações por período, em PDF para compartilhar. Análise avançada (tendências, giro) no plano Equipe.',
  'Importar e exportar por planilha (CSV/Excel) e JSON; backup; os dados ficam na nuvem com conta grátis.',
  'Plano Gratuito: uma pessoa, nuvem incluída, com teto de produtos. Plano Equipe (assinatura mensal, cancelável quando quiser): várias pessoas no mesmo estoque com papéis (quem cadastra, quem movimenta, quem só consulta), produtos sem limite na nuvem, análise avançada e identidade visual da empresa. Assinatura pela Google Play ou, na web, por Pix, boleto ou cartão.',
  'O app Android funciona sem internet; a versão web precisa de internet.',
  'NÃO faz: emissão de nota fiscal, PDV/frente de caixa, integração automática com marketplaces, controle de lotes/validade por data (a validade pode ser anotada na descrição), multi-depósito, contas a pagar.',
];
