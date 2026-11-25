import { describe, expect, it } from 'vitest';

import { batchPayload, EMPTY_BATCH } from '../src/components/stock/BatchFields';

describe('lote informado na entrada', () => {
  it('não manda campo vazio: entrada sem lote continua uma entrada comum', () => {
    expect(batchPayload(EMPTY_BATCH)).toEqual({});
    expect(batchPayload({ ...EMPTY_BATCH, batchCode: '   ' })).toEqual({});
  });

  it('manda só o que foi preenchido, com o lote sem espaço em volta', () => {
    expect(batchPayload({ batchCode: ' L2026-11 ', manufacturedOn: '', expiresOn: '2027-01-31' })).toEqual({
      batchCode: 'L2026-11',
      expiresOn: '2027-01-31',
    });
  });
});
