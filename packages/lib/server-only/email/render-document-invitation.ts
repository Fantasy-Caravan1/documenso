import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { FANTASY_CARAVAN_LOGO_PATH } from '@documenso/email/template-components/template-branding-logo';
import { DocumentInviteEmailTemplate } from '@documenso/email/templates/document-invite';
import type { I18n } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import type { DocumentMeta, Envelope, Recipient, Team, TeamEmail, User } from '@prisma/client';
import { DocumentSource, OrganisationType, RecipientRole } from '@prisma/client';
import type { Attachment } from 'nodemailer/lib/mailer';
import { createElement } from 'react';

import { getI18nInstance } from '../../client-only/providers/i18n-server';
import { NEXT_PUBLIC_WEBAPP_URL } from '../../constants/app';
import { RECIPIENT_ROLES_DESCRIPTION } from '../../constants/recipient-roles';
import { logger } from '../../utils/logger';
import { renderCustomEmailTemplate } from '../../utils/render-custom-email-template';
import { renderEmailWithI18N } from '../../utils/render-email-with-i18n';
import { getSigningInvitationDocumentName } from '../../utils/signing-invitation';
import type { EmailContextResponse } from './get-email-context';

type InvitationOptions = {
  envelope: Pick<Envelope, 'title' | 'source'> & {
    documentMeta: Pick<DocumentMeta, 'message' | 'subject'> | null;
    team: Pick<Team, 'name'> & { teamEmail: Pick<TeamEmail, 'email'> | null };
  };
  recipient: Pick<Recipient, 'name' | 'email' | 'role' | 'token'>;
  user: Pick<User, 'name' | 'email'>;
  context: Pick<EmailContextResponse, 'branding' | 'emailLanguage' | 'organisationType' | 'emailTransport'> & {
    settings: Pick<EmailContextResponse['settings'], 'includeSenderDetails'>;
  };
  isReminder?: boolean;
};

export const renderDocumentInvitation = async (options: InvitationOptions) => {
  const { envelope, recipient, user, context, isReminder } = options;
  const { branding, emailLanguage, organisationType, settings, emailTransport } = context;
  const { documentMeta, team } = envelope;
  const i18n = await getI18nInstance(emailLanguage);
  const isSigner = recipient.role === RecipientRole.SIGNER;
  const documentName = isSigner ? getSigningInvitationDocumentName(envelope.title) : envelope.title;
  const selfSigner = recipient.email === user.email;
  const variables = { 'signer.name': recipient.name, 'signer.email': recipient.email, 'document.name': documentName };
  const copy = isSigner
    ? { subject: i18n._(msg`Signature requested — ${documentName}`), message: documentMeta?.message || '' }
    : getRoleInvitationCopy(options, i18n, selfSigner);
  if (documentMeta?.subject) {
    copy.subject = renderCustomEmailTemplate(documentMeta.subject, variables);
  }
  const subject =
    isReminder && (isSigner || documentMeta?.subject) ? i18n._(msg`Reminder: ${copy.subject}`) : copy.subject;
  const logo = isSigner ? await getInlineLogo(emailTransport.transporter.name) : undefined;
  const assetBaseUrl = NEXT_PUBLIC_WEBAPP_URL();
  const template = createElement(DocumentInviteEmailTemplate, {
    // The template formats the stored title itself, including when opened in the preview app.
    documentName: envelope.title,
    recipientName: recipient.name,
    inviterName: user.name || undefined,
    inviterEmail: organisationType === OrganisationType.ORGANISATION ? team.teamEmail?.email || user.email : user.email,
    assetBaseUrl,
    signingLogoSrc: logo && `cid:${logo.cid}`,
    signDocumentLink: `${assetBaseUrl}/sign/${recipient.token}`,
    reportUrl: `${assetBaseUrl}/report/${recipient.token}`,
    customBody: renderCustomEmailTemplate(copy.message, variables),
    role: recipient.role,
    selfSigner,
    organisationType,
    teamName: team.name,
    includeSenderDetails: isSigner || !isReminder ? settings.includeSenderDetails : undefined,
  });

  const [html, text] = await Promise.all([
    renderEmailWithI18N(template, { lang: emailLanguage, branding }),
    renderEmailWithI18N(template, { lang: emailLanguage, branding, plainText: true }),
  ]);

  return { subject, html, text, attachments: logo ? [logo] : undefined };
};

// These HTTP adapters omit Content-ID. Their recipients use the same public brand asset.
const getInlineLogo = async (transportName: string): Promise<Attachment | undefined> => {
  if (transportName === 'ResendMailTransport' || transportName === 'CloudflareMailTransport') {
    return;
  }

  try {
    const logoPath = createRequire(import.meta.url).resolve(`@documenso/remix/public${FANTASY_CARAVAN_LOGO_PATH}`);
    return {
      filename: 'fantasy-caravan.png',
      content: await readFile(logoPath),
      cid: 'fantasy-caravan-logo-2026@fantasycaravan.com.au',
      contentDisposition: 'inline',
      contentType: 'image/png',
    };
  } catch (error) {
    logger.warn({ msg: 'Using public logo URL for signing invitation', error });
    return;
  }
};

const getRoleInvitationCopy = (options: InvitationOptions, i18n: I18n, selfSigner: boolean) => {
  const { envelope, recipient, user, context, isReminder } = options;
  const { team, documentMeta } = envelope;
  const recipientActionVerb = i18n._(RECIPIENT_ROLES_DESCRIPTION[recipient.role].actionVerb).toLowerCase();

  if (context.organisationType === OrganisationType.ORGANISATION) {
    const subject = isReminder
      ? i18n._(msg`Reminder: ${team.name} invited you to ${recipientActionVerb} a document`)
      : i18n._(msg`${team.name} invited you to ${recipientActionVerb} a document`);
    if (documentMeta?.message) {
      return { subject, message: documentMeta.message };
    }
    const inviterName = user.name || '';
    const message = isReminder
      ? msg`${user.name || user.email} on behalf of "${team.name}" has invited you to ${recipientActionVerb} the document "${envelope.title}".`
      : context.settings.includeSenderDetails
        ? msg`${inviterName} on behalf of "${team.name}" has invited you to ${recipientActionVerb} the document "${envelope.title}".`
        : msg`${team.name} has invited you to ${recipientActionVerb} the document "${envelope.title}".`;
    return { subject, message: i18n._(message) };
  }

  if (!isReminder && envelope.source === DocumentSource.TEMPLATE_DIRECT_LINK) {
    return {
      subject: i18n._(msg`Please ${recipientActionVerb} this document created by your direct template`),
      message: i18n._(
        msg`A document was created by your direct template that requires you to ${recipientActionVerb} it.`,
      ),
    };
  }

  if (selfSigner) {
    return {
      subject: isReminder
        ? i18n._(msg`Reminder: Please ${recipientActionVerb} your document`)
        : i18n._(msg`Please ${recipientActionVerb} your document`),
      message: i18n._(
        msg`You have initiated the document ${`"${envelope.title}"`} that requires you to ${recipientActionVerb} it.`,
      ),
    };
  }

  return {
    subject: isReminder
      ? i18n._(msg`Reminder: Please ${recipientActionVerb} this document`)
      : i18n._(msg`Please ${recipientActionVerb} this document`),
    message: documentMeta?.message || '',
  };
};
