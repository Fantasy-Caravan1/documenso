import { mapSecondaryIdToDocumentId } from '@documenso/lib/utils/envelope';
import { prisma } from '@documenso/prisma';
import { seedTeamDocumentWithMeta } from '@documenso/prisma/seed/documents';
import { seedUser } from '@documenso/prisma/seed/users';
import { expect, test } from '@playwright/test';

import { apiSignin } from '../fixtures/authentication';

test('[TEAMS]: new contracts only allow drawn signatures', async ({ page }) => {
  const { user, team } = await seedUser();

  await apiSignin({
    page,
    email: user.email,
    redirectPath: `/t/${team.url}/settings/document`,
  });

  await page.getByTestId('signature-types-trigger').click();
  await expect(page.getByRole('option', { name: 'Draw' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Type' })).toHaveCount(0);
  await expect(page.getByRole('option', { name: 'Upload' })).toHaveCount(0);

  const document = await seedTeamDocumentWithMeta(team);
  const documentMeta = await prisma.documentMeta.findUniqueOrThrow({
    where: { id: document.documentMetaId },
  });

  expect(documentMeta.typedSignatureEnabled).toBe(false);
  expect(documentMeta.uploadSignatureEnabled).toBe(false);
  expect(documentMeta.drawSignatureEnabled).toBe(true);

  await page.goto(`/t/${team.url}/documents/${mapSecondaryIdToDocumentId(document.secondaryId)}/edit`);
  await page.getByRole('button', { name: 'Advanced Options' }).click();

  const signatureTypes = page.getByRole('combobox').filter({ hasText: 'Draw' });

  await expect(signatureTypes).toBeVisible();
  await expect(signatureTypes).not.toContainText('Type');
  await expect(signatureTypes).not.toContainText('Upload');

  await page.goto(`/sign/${document.recipients[0].token}`);
  await page.getByTestId('signature-pad-dialog-button').click();

  await expect(page.getByTestId('signature-pad-draw')).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Type' })).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Upload' })).toHaveCount(0);
});
