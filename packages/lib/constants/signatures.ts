export const SIGNATURE_CANVAS_DPI = 2;
export const SIGNATURE_MIN_COVERAGE_THRESHOLD = 0.01;

/**
 * This deployment only accepts signatures captured with the drawing canvas.
 *
 * Keep the legacy metadata columns so existing signed envelopes can still be
 * rendered, but normalize every new or edited envelope to this policy.
 */
export const DRAW_ONLY_SIGNATURE_SETTINGS = {
  typedSignatureEnabled: false,
  uploadSignatureEnabled: false,
  drawSignatureEnabled: true,
} as const;

export const isBase64Image = (value: string) => value.startsWith('data:image/png;base64,');
