import { describe, expect, it } from 'vitest';

import { extractDerivedDocumentMeta } from './document';
import { generateDefaultOrganisationSettings } from './organisations';

describe('extractDerivedDocumentMeta', () => {
  it('forces newly created envelopes to use drawn signatures only', () => {
    const settings = {
      ...generateDefaultOrganisationSettings(),
      typedSignatureEnabled: true,
      uploadSignatureEnabled: true,
      drawSignatureEnabled: false,
    };

    const documentMeta = extractDerivedDocumentMeta(settings, {
      typedSignatureEnabled: true,
      uploadSignatureEnabled: true,
      drawSignatureEnabled: false,
    });

    expect(documentMeta).toMatchObject({
      typedSignatureEnabled: false,
      uploadSignatureEnabled: false,
      drawSignatureEnabled: true,
    });
  });
});
