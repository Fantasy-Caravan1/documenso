import { describe, expect, it } from 'vitest';

import { resolveSignatureValue } from './resolve-signature-value';

describe('resolveSignatureValue', () => {
  it('keeps typed signatures on completed historical contracts renderable', () => {
    expect(
      resolveSignatureValue({
        typedSignature: 'Historical Signer',
        signatureImageAsBase64: null,
      }),
    ).toEqual({ type: 'typed', value: 'Historical Signer' });
  });

  it('prefers a stored signature image when both legacy values exist', () => {
    expect(
      resolveSignatureValue({
        typedSignature: 'Historical Signer',
        signatureImageAsBase64: 'data:image/png;base64,drawn-signature',
      }),
    ).toEqual({ type: 'image', value: 'data:image/png;base64,drawn-signature' });
  });
});
