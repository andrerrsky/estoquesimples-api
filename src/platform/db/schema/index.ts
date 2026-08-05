/**
 * Modelo de leitura do schema, para o construtor de consultas.
 *
 * ESTES ARQUIVOS NÃO SÃO A FONTE DA VERDADE. O schema real é o conjunto de
 * migrations em `src/platform/db/migrations`, escritas à mão em SQL. As
 * definições aqui existem só para o Drizzle saber montar SELECT, INSERT e
 * UPDATE com os tipos certos.
 *
 * Consequências práticas de trabalhar assim:
 *
 *  - `drizzle-kit push` e `drizzle-kit generate` NUNCA devem ser executados
 *    neste projeto. O gerador não expressa políticas de RLS, GRANTs por
 *    coluna, funções SECURITY DEFINER, índices únicos parciais nem CHECKs —
 *    ou seja, justamente o que sustenta o isolamento entre empresas. Rodá-lo
 *    produziria um diff que remove tudo isso sem avisar.
 *  - Uma divergência entre estes arquivos e as migrations é um bug destes
 *    arquivos. A correção é ajustar a declaração daqui, nunca "consertar" o
 *    banco para casar com ela.
 *  - Índices e chaves estrangeiras são declarados aqui apenas para que o
 *    modelo descreva a realidade (e para que quem lê o código não precise
 *    abrir o SQL). Eles não criam nada: o `ON CONFLICT` de uma consulta
 *    depende do índice que existe no banco, não do que está escrito aqui.
 *  - O que NÃO está representado, por não ter equivalente no Drizzle:
 *    políticas de RLS, GRANTs, CHECKs, triggers e funções.
 */

export * from './auth.js';
export * from './workspaces.js';
export * from './billing.js';
export * from './inventory.js';
