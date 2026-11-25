import type { MessageDescriptor } from '@lingui/core';
import { msg } from '@lingui/core/macro';
import { useLingui } from '@lingui/react';
import { Trans } from '@lingui/react/macro';
import { createElement, Fragment } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { Head, Html, Img, Preview } from '../components';
import { useBranding } from '../providers/branding';
import { TemplateCustomMessageBody } from './template-custom-message-body';

type SigningInvitationProps = {
  recipientName?: string;
  introduction: MessageDescriptor;
  documentName: string;
  signDocumentLink: string;
  logoSrc: string;
  reportUrl?: string;
  customBody?: string;
};

export const TemplateSigningInvitation = ({
  recipientName,
  introduction,
  documentName,
  signDocumentLink,
  logoSrc,
  reportUrl,
  customBody,
}: SigningInvitationProps) => {
  const { _, i18n } = useLingui();
  const branding = useBranding();
  const companyDetails = branding.brandingEnabled && branding.brandingCompanyDetails?.trim();

  return (
    <Html lang={i18n.locale}>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="color-scheme" content="light" />
        <style>{responsiveStyles}</style>
      </Head>
      <body style={{ margin: 0, padding: 0, backgroundColor: '#e8edf1', WebkitTextSizeAdjust: '100%' }}>
        <Preview>{_(msg`You can read the full document before signing.`)}</Preview>
        <table {...layoutTable} width="100%" bgcolor="#e8edf1" style={{ width: '100%', tableLayout: 'fixed' }}>
          <tbody>
            <tr>
              <td align="center" className="invitation-surround" style={{ padding: '22px 12px' }}>
                <table
                  {...layoutTable}
                  align="center"
                  width={568}
                  bgcolor="#ffffff"
                  style={{
                    width: 568,
                    maxWidth: '100%',
                    tableLayout: 'fixed',
                    border: '1px solid #c8d1d9',
                    backgroundColor: '#ffffff',
                    fontFamily,
                    textAlign: 'left',
                  }}
                >
                  <tbody>
                    <tr>
                      <td
                        className="invitation-inset"
                        style={{ backgroundColor: '#e2eaf0', borderTop: '3px solid #29486a', padding: '16px 25px' }}
                      >
                        <table {...layoutTable} width="100%" style={{ tableLayout: 'fixed' }}>
                          <tbody>
                            <tr>
                              <td width={173} valign="middle" className="invitation-stack">
                                <Img
                                  src={logoSrc}
                                  alt="Fantasy Caravan"
                                  width={124}
                                  height={47}
                                  style={{
                                    display: 'block',
                                    width: 124,
                                    maxWidth: '100%',
                                    height: 'auto',
                                    color: '#1c3450',
                                    fontFamily,
                                    fontSize: 14,
                                  }}
                                />
                              </td>
                              <td valign="middle" className="invitation-stack invitation-intro" style={textStyle}>
                                <p style={{ margin: 0, color: '#1c3450', fontWeight: 'bold' }}>
                                  {recipientName ? <Trans>Hello {recipientName},</Trans> : <Trans>Hello,</Trans>}
                                </p>
                                <p style={{ margin: '2px 0 0' }}>{_(introduction)}</p>
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </td>
                    </tr>
                    <tr>
                      <td className="invitation-inset" style={{ padding: '21px 25px 24px' }}>
                        {/* biome-ignore lint/a11y/useSemanticElements: the plain-text renderer uppercases native headings, which would alter filenames. */}
                        <div role="heading" aria-level={1} className="invitation-title" style={titleStyle}>
                          {documentName.split(/(?<=[_.\-/])/u).map((part, index) => (
                            <Fragment key={index}>
                              {index > 0 && <wbr />}
                              {part}
                            </Fragment>
                          ))}
                        </div>
                        {customBody?.trim() && (
                          <TemplateCustomMessageBody text={customBody} style={{ ...textStyle, margin: '12px 0 0' }} />
                        )}
                      </td>
                    </tr>
                    <tr>
                      <td align="center" style={{ backgroundColor: actionColor, fontSize: 0, lineHeight: 0 }}>
                        <SigningButton href={signDocumentLink} label={_(msg`Review & sign`)} />
                      </td>
                    </tr>
                    <tr>
                      <td
                        className="invitation-inset"
                        style={{ ...footerStyle, padding: '14px 29px 15px', borderTop: '1px solid #d4dce2' }}
                      >
                        <p style={{ margin: 0 }}>
                          <Trans>Please keep this link private.</Trans>
                          {reportUrl && (
                            <>
                              {'  '}
                              <a href={reportUrl} style={{ color: footerStyle.color, textDecoration: 'underline' }}>
                                <Trans>Report this request</Trans>
                              </a>
                            </>
                          )}
                        </p>
                        {companyDetails && (
                          <TemplateCustomMessageBody
                            text={companyDetails}
                            style={{ ...footerStyle, margin: '8px 0 0' }}
                          />
                        )}
                      </td>
                    </tr>
                  </tbody>
                </table>
              </td>
            </tr>
          </tbody>
        </table>
      </body>
    </Html>
  );
};

const SigningButton = ({ href, label }: { href: string; label: string }) => {
  const labelStyle = { fontFamily, fontSize: 16, fontWeight: 'bold', color: '#ffffff' };
  // Classic Outlook uses Word to render email. Its VML rectangle makes the whole bar clickable.
  // Build the markup with React so the destination and localized label are HTML-escaped.
  const outlookButton = renderToStaticMarkup(
    createElement(
      'v:rect',
      {
        'xmlns:v': 'urn:schemas-microsoft-com:vml',
        href,
        fillcolor: actionColor,
        stroked: 'false',
        style: { width: '566px', height: '50px', vTextAnchor: 'middle' },
      },
      createElement('w:anchorlock', { 'xmlns:w': 'urn:schemas-microsoft-com:office:word' }),
      createElement('center', { style: labelStyle }, label),
    ),
  );

  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: conditional comments need raw markup; React escaped its dynamic values above. */}
      <span dangerouslySetInnerHTML={{ __html: `<!--[if mso]>${outlookButton}<![endif]-->` }} />
      <a href={href} style={{ ...labelStyle, ...actionStyle }}>
        {label}
      </a>
    </>
  );
};

const layoutTable = { role: 'presentation', border: 0, cellPadding: 0, cellSpacing: 0 } as const;
const fontFamily = 'Arial, Helvetica, sans-serif';
const actionColor = '#233e5e';
const textStyle = {
  fontFamily,
  fontSize: 15,
  lineHeight: '22px',
  color: '#415569',
  overflowWrap: 'anywhere',
  wordWrap: 'break-word',
} as const;
const titleStyle = {
  margin: 0,
  fontFamily: "'Helvetica Neue', Arial, Helvetica, sans-serif",
  fontSize: 33,
  lineHeight: '38px',
  fontWeight: 'bold',
  letterSpacing: '-0.65px',
  color: '#1c3450',
  overflowWrap: 'anywhere',
  wordWrap: 'break-word',
  wordBreak: 'break-word',
} as const;
const actionStyle = {
  display: 'block',
  width: '100%',
  backgroundColor: actionColor,
  lineHeight: '50px',
  textAlign: 'center',
  textDecoration: 'none',
  msoHide: 'all',
} as const;
const footerStyle = { ...textStyle, fontSize: 12, lineHeight: '20px', color: '#4d6072' };
const responsiveStyles = `
  table, td { mso-table-lspace: 0pt; mso-table-rspace: 0pt; }
  @media only screen and (max-width: 480px) {
    .invitation-surround { padding: 12px 8px !important; }
    .invitation-inset { padding-left: 20px !important; padding-right: 20px !important; }
    .invitation-stack { display: block !important; width: 100% !important; }
    .invitation-intro { padding-top: 12px !important; }
    .invitation-title { font-size: 30px !important; line-height: 35px !important; }
  }
`;
