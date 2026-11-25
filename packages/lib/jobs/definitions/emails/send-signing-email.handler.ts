import { isRecipientEmailValidForSending } from '@documenso/lib/utils/recipients';
import { prisma } from '@documenso/prisma';
import { DocumentStatus, EnvelopeType, RecipientRole, SendStatus } from '@prisma/client';

import { RECIPIENT_ROLE_TO_EMAIL_TYPE } from '../../../constants/recipient-roles';
import { buildEnvelopeEmailHeaders } from '../../../server-only/email/build-envelope-email-headers';
import { getEmailContext } from '../../../server-only/email/get-email-context';
import { renderDocumentInvitation } from '../../../server-only/email/render-document-invitation';
import { assertOrganisationRatesAndLimits } from '../../../server-only/rate-limit/assert-organisation-rates-and-limits';
import { updateRecipientNextReminder } from '../../../server-only/recipient/update-recipient-next-reminder';
import { DOCUMENT_AUDIT_LOG_TYPE } from '../../../types/document-audit-logs';
import { extractDerivedDocumentEmailSettings } from '../../../types/document-email';
import { createDocumentAuditLogData } from '../../../utils/document-audit-logs';
import { unsafeBuildEnvelopeIdQuery } from '../../../utils/envelope';
import type { JobRunIO } from '../../client/_internal/job';
import type { TSendSigningEmailJobDefinition } from './send-signing-email';

export const run = async ({ payload, io }: { payload: TSendSigningEmailJobDefinition; io: JobRunIO }) => {
  const { userId, documentId, recipientId, requestMetadata } = payload;

  const [user, envelope, recipient] = await Promise.all([
    prisma.user.findFirstOrThrow({
      where: {
        id: userId,
      },
      select: {
        id: true,
        email: true,
        name: true,
      },
    }),
    prisma.envelope.findFirstOrThrow({
      where: {
        ...unsafeBuildEnvelopeIdQuery(
          {
            type: 'documentId',
            id: documentId,
          },
          EnvelopeType.DOCUMENT,
        ),
        status: DocumentStatus.PENDING,
      },
      include: {
        documentMeta: true,
        user: {
          select: {
            disabled: true,
          },
        },
        team: {
          select: {
            teamEmail: true,
            name: true,
          },
        },
      },
    }),
    prisma.recipient.findFirstOrThrow({
      where: {
        id: recipientId,
      },
    }),
  ]);

  if (recipient.role === RecipientRole.CC) {
    return;
  }

  const isRecipientSigningRequestEmailEnabled = extractDerivedDocumentEmailSettings(
    envelope.documentMeta,
  ).recipientSigningRequest;

  if (!isRecipientSigningRequestEmailEnabled) {
    return;
  }

  const emailContext = await getEmailContext({
    emailType: 'RECIPIENT',
    source: {
      type: 'team',
      teamId: envelope.teamId,
    },
    meta: envelope.documentMeta,
  });

  const { organisationId, claims, emailsDisabled, senderEmail, replyToEmail, emailTransport } = emailContext;

  // Don't send signing invitations if the organisation has email sending disabled or the owner is disabled (e.g. banned).
  if (envelope.user.disabled || emailsDisabled) {
    return;
  }

  const recipientEmailType = RECIPIENT_ROLE_TO_EMAIL_TYPE[recipient.role];

  if (isRecipientEmailValidForSending(recipient)) {
    try {
      await assertOrganisationRatesAndLimits({
        organisationId,
        organisationClaim: claims,
        type: 'email',
        count: 1,
      });
    } catch (_err) {
      io.logger.warn({
        msg: 'Recipient signing email dropped: org rate limit exceeded',
        organisationId,
        recipientId: recipient.id,
        envelopeId: envelope.id,
      });

      // Job is consumed and NOT retried.
      return;
    }

    await io.runTask('send-signing-email', async () => {
      const invitation = await renderDocumentInvitation({ envelope, recipient, user, context: emailContext });

      await emailTransport.sendMail({
        to: {
          name: recipient.name,
          address: recipient.email,
        },
        from: senderEmail,
        replyTo: replyToEmail,
        ...invitation,
        headers: buildEnvelopeEmailHeaders({
          userId,
          envelopeId: envelope.id,
          teamId: envelope.teamId,
        }),
      });
    });
  }

  const sentAt = new Date();

  await io.runTask('update-recipient', async () => {
    await prisma.recipient.update({
      where: {
        id: recipient.id,
      },
      data: {
        sendStatus: SendStatus.SENT,
        sentAt,
      },
    });
  });

  // Compute the first reminder time based on the envelope's effective settings.
  await updateRecipientNextReminder({
    recipientId: recipient.id,
    envelopeId: envelope.id,
    sentAt,
    lastReminderSentAt: null,
  });

  await prisma.documentAuditLog.create({
    data: createDocumentAuditLogData({
      type: DOCUMENT_AUDIT_LOG_TYPE.EMAIL_SENT,
      envelopeId: envelope.id,
      user,
      requestMetadata,
      data: {
        emailType: recipientEmailType,
        recipientId: recipient.id,
        recipientName: recipient.name,
        recipientEmail: recipient.email,
        recipientRole: recipient.role,
        isResending: false,
      },
    }),
  });
};
