import { describe, expect, it } from 'vitest';

import { parseCsv, parsePlayReviewsCsv, reviewIdFromLink } from '../../src/modules/reviews/play-reviews-csv.js';

const HEADER =
  'Package Name,App Version Code,App Version Name,Reviewer Language,Device,Review Submit Date and Time,Review Submit Millis Since Epoch,Review Last Update Date and Time,Review Last Update Millis Since Epoch,Star Rating,Review Title,Review Text,Developer Reply Date and Time,Developer Reply Millis Since Epoch,Developer Reply Text,Review Link';

describe('relatório de avaliações da Play Console', () => {
  it('lê aspas, vírgulas e quebras de linha dentro do campo', () => {
    expect(parseCsv('a,"b, c","d ""e""\nf"\r\n1,2,3\n')).toEqual([
      ['a', 'b, c', 'd "e"\nf'],
      ['1', '2', '3'],
    ]);
  });

  it('tira o id da avaliação dos dois formatos de link', () => {
    expect(reviewIdFromLink('http://play.google.com/console/developers/1/app/2/user-feedback/review-details?reviewId=gp%3AAOqpTOE1&corpus=PUBLISHED_REVIEWS')).toBe('gp:AOqpTOE1');
    expect(reviewIdFromLink('https://play.google.com/apps/publisher?account=1#ReviewDetailsPlace:p=br.com.app&reviewid=gp:AOqpTOE2')).toBe('gp:AOqpTOE2');
    expect(reviewIdFromLink('')).toBeNull();
  });

  it('converte as linhas, junta título e texto e separa o que não dá para importar', () => {
    const csv = [
      `﻿${HEADER}`,
      'br.com.app,24,2.4,pt,a10,2019-11-14T10:00:00Z,1573725600000,2019-11-14T10:00:00Z,1573725600000,3,,"Muito bom, mas precisa de categorias",,,,"https://play.google.com/apps/publisher?account=1#ReviewDetailsPlace:p=br.com.app&reviewid=gp:AAA"',
      'br.com.app,30,3.0,pt,s22,2022-04-05T10:00:00Z,1649152800000,2022-04-05T10:00:00Z,1649152800000,4,Ótimo,"Uso todo dia",2022-04-06T10:00:00Z,1649239200000,Obrigado!,"https://play.google.com/x?reviewId=gp:BBB"',
      'br.com.app,30,3.0,pt,s22,,,,,5,,,,,,"https://play.google.com/x?reviewId=gp:CCC"',
      'br.com.app,30,3.0,pt,s22,,,,,2,,Sem link,,,,',
      'br.com.outro,1,1,pt,x,,,,,1,,Outro app,,,,"https://play.google.com/x?reviewId=gp:DDD"',
    ].join('\n');
    const result = parsePlayReviewsCsv(csv, 'br.com.app');
    expect(result).toMatchObject({ withoutText: 1, withoutId: 1, otherPackage: 1 });
    expect(result.reviews).toHaveLength(2);
    expect(result.reviews[0]).toMatchObject({ reviewId: 'gp:AAA', starRating: 3, text: 'Muito bom, mas precisa de categorias', appVersionCode: 24, developerReplyText: null });
    expect(result.reviews[0]!.userCommentAt?.toISOString()).toBe('2019-11-14T10:00:00.000Z');
    expect(result.reviews[1]).toMatchObject({ reviewId: 'gp:BBB', text: 'Ótimo\tUso todo dia', developerReplyText: 'Obrigado!' });
    expect(result.reviews[1]!.lastModifiedAt?.toISOString()).toBe('2022-04-06T10:00:00.000Z');
  });

  it('recusa um arquivo que não é o relatório de avaliações', () => {
    expect(() => parsePlayReviewsCsv('Data,Instalações\n2024-01-01,3\n', null)).toThrow(/relatório de avaliações/);
  });
});
