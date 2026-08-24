import { type Field, FieldType } from '@prisma/client';
import { describe, expect, it } from 'vitest';

import { extractFieldInsertionValues } from './envelope-signing';

const signatureField = {
  type: FieldType.SIGNATURE,
} as Field;

const documentMeta = {
  timezone: null,
  dateFormat: null,
};

describe('extractFieldInsertionValues signature policy', () => {
  it('rejects typed signatures even when legacy metadata allowed them', () => {
    expect(() =>
      extractFieldInsertionValues({
        field: signatureField,
        fieldValue: {
          type: FieldType.SIGNATURE,
          value: 'Typed Name',
        },
        documentMeta,
      }),
    ).toThrowError('Only drawn signatures are allowed');
  });

  it('accepts a PNG produced by the drawing canvas', () => {
    expect(
      extractFieldInsertionValues({
        field: signatureField,
        fieldValue: {
          type: FieldType.SIGNATURE,
          value: 'data:image/png;base64,c2lnbmF0dXJl',
        },
        documentMeta,
      }),
    ).toEqual({
      customText: '',
      inserted: true,
    });
  });
});
