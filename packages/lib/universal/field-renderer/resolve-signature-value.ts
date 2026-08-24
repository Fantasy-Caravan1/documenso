import type { Signature } from '@prisma/client';

type SignatureValue = Pick<Signature, 'signatureImageAsBase64' | 'typedSignature'> | null | undefined;

export type ResolvedSignatureValue = { type: 'image'; value: string } | { type: 'typed'; value: string } | null;

/**
 * Resolve persisted signature data for rendering.
 *
 * Typed signatures can no longer be created, but must remain renderable on
 * contracts that were completed before the draw-only policy was introduced.
 */
export const resolveSignatureValue = (signature: SignatureValue): ResolvedSignatureValue => {
  if (signature?.signatureImageAsBase64) {
    return { type: 'image', value: signature.signatureImageAsBase64 };
  }

  if (signature?.typedSignature) {
    return { type: 'typed', value: signature.typedSignature };
  }

  return null;
};
