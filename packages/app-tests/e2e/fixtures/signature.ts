import { AppError, AppErrorCode } from '@documenso/lib/errors/app-error';
import type { Page } from '@playwright/test';

export const drawSignature = async (page: Page) => {
  const canvas = page.getByTestId('signature-pad-draw');
  const box = await canvas.boundingBox();

  if (!box) {
    throw new AppError(AppErrorCode.INVALID_REQUEST, {
      message: 'Signature drawing canvas is not visible',
    });
  }

  for (const row of [1, 2, 3, 4]) {
    const y = box.y + (box.height * row) / 5;

    await page.mouse.move(box.x + box.width * 0.1, y);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.9, y, { steps: 20 });
    await page.mouse.up();
  }
};

/**
 * Will open the signature pad dialog and sign it.
 */
export const signSignaturePad = async (page: Page) => {
  await page.waitForTimeout(200);

  await page.getByTestId('signature-pad-dialog-button').click();

  await drawSignature(page);

  // Click Next button
  await page.getByRole('button', { name: 'Next' }).click();
};

/**
 * For when the signature pad is already open.
 */
export const signDirectSignaturePad = async (page: Page) => {
  await page.waitForTimeout(200);

  await drawSignature(page);
};
