import { describe, expect, it, vi } from 'vitest';

import { getSigningInvitationDocumentName, getSigningInvitationIntro } from './signing-invitation';

// The recipient privacy rule selects the English source message before Lingui translates it.
vi.mock('@lingui/core/macro', () => ({ msg: String.raw }));

const sender = {
  organisationType: 'ORGANISATION',
  inviterName: 'Casey',
  inviterEmail: 'casey@example.invalid',
  teamName: 'People Operations',
} as const;

describe('signing invitation document name', () => {
  it.each([
    ['FC-D-000_NDA_EN_V1.0.pdf', 'FC-D-000_NDA_EN_V1.0'],
    ['R&D.v1.0.PDF', 'R&D.v1.0'],
    ['R&D.v1.0.DoCx', 'R&D.v1.0'],
    ['Report.docx.pdf', 'Report.docx'],
    ['R&D.v1.0', 'R&D.v1.0'],
    ['example.com', 'example.com'],
    ['report.pdf.notes', 'report.pdf.notes'],
    ['.PDF', '.PDF'],
    ['  .docx', '  .docx'],
    ['', ''],
  ])('displays %j as %j', (storedName, displayedName) => {
    expect(getSigningInvitationDocumentName(storedName)).toBe(displayedName);
  });
});

describe('signing invitation sender details', () => {
  it('uses only the team name when sender details are hidden', () => {
    expect(getSigningInvitationIntro({ ...sender, includeSenderDetails: false })).toBe(
      'People Operations sent you a document to sign.',
    );
    expect(getSigningInvitationIntro({ ...sender, includeSenderDetails: false, teamName: '' })).toBe(
      'You have a document to sign.',
    );
  });

  it('shows the permitted sender and falls back to the team when a member has no display name', () => {
    expect(getSigningInvitationIntro({ ...sender, includeSenderDetails: true })).toBe(
      'Casey sent you a document to sign.',
    );
    expect(getSigningInvitationIntro({ ...sender, includeSenderDetails: true, inviterName: ' ' })).toBe(
      'People Operations sent you a document to sign.',
    );
  });

  it('identifies a personal sender by email when their name is absent', () => {
    expect(getSigningInvitationIntro({ organisationType: 'PERSONAL', inviterEmail: 'casey@example.invalid' })).toBe(
      'casey@example.invalid sent you a document to sign.',
    );
  });

  it('avoids repeating the brand or inviting a recipient to sign on their own behalf', () => {
    for (const options of [
      { ...sender, teamName: ' Fantasy CARAVAN ' },
      { ...sender, includeSenderDetails: true, recipientName: ' CASEY ' },
      { ...sender, selfSigner: true },
    ]) {
      expect(getSigningInvitationIntro(options)).toBe('You have a document to sign.');
    }
  });
});
