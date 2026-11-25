import { msg } from '@lingui/core/macro';
import type { OrganisationType } from '@prisma/client';

// Uploaded PDF and Word files may carry their extension into the envelope title.
export const getSigningInvitationDocumentName = (title: string) => {
  const extensionIndex = title.search(/\.(?:pdf|docx)\s*$/i);
  if (extensionIndex < 0) {
    return title;
  }

  return title.slice(0, extensionIndex).trimEnd() || title;
};

type SigningInvitationSender = {
  organisationType?: OrganisationType;
  includeSenderDetails?: boolean;
  inviterName?: string | null;
  inviterEmail?: string | null;
  teamName?: string | null;
  recipientName?: string;
  selfSigner?: boolean;
};

export const getSigningInvitationIntro = ({
  organisationType,
  includeSenderDetails,
  inviterName,
  inviterEmail,
  teamName,
  recipientName,
  selfSigner,
}: SigningInvitationSender) => {
  let senderName = inviterName?.trim() || inviterEmail?.trim();

  if (organisationType === 'ORGANISATION') {
    senderName = (includeSenderDetails && inviterName?.trim()) || teamName?.trim();
  }

  if (
    !senderName ||
    selfSigner ||
    senderName.toLowerCase() === 'fantasy caravan' ||
    senderName.toLowerCase() === recipientName?.trim().toLowerCase()
  ) {
    return msg`You have a document to sign.`;
  }

  return msg`${senderName} sent you a document to sign.`;
};
