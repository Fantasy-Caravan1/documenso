import { DocumentSignatureType } from '@documenso/lib/constants/document';
import { isBase64Image } from '@documenso/lib/constants/signatures';

import type { HTMLAttributes } from 'react';
import { useState } from 'react';

import { cn } from '../../lib/utils';
import { SignaturePadDraw } from './signature-pad-draw';

export type SignaturePadValue = {
  type: DocumentSignatureType;
  value: string;
};

export type SignaturePadProps = Omit<HTMLAttributes<HTMLCanvasElement>, 'onChange'> & {
  fullName?: string;
  value?: string;
  onChange?: (_value: SignaturePadValue) => void;

  disabled?: boolean;

  /** @deprecated Ignored. New signatures are always drawn. */
  typedSignatureEnabled?: boolean;
  /** @deprecated Ignored. New signatures are always drawn. */
  uploadSignatureEnabled?: boolean;
  /** @deprecated Ignored. New signatures are always drawn. */
  drawSignatureEnabled?: boolean;

  onValidityChange?: (isValid: boolean) => void;
};

export const SignaturePad = ({ className, value = '', onChange, disabled = false }: SignaturePadProps) => {
  const [drawSignature, setDrawSignature] = useState(isBase64Image(value) ? value : '');

  const onDrawSignatureChange = (value: string) => {
    setDrawSignature(value);

    onChange?.({
      type: DocumentSignatureType.DRAW,
      value,
    });
  };

  return (
    <div
      className={cn(
        {
          'pointer-events-none': disabled,
        },
        className,
      )}
    >
      <div className="relative flex aspect-signature-pad items-center justify-center rounded-md border border-border bg-muted/25 text-center">
        <SignaturePadDraw className="h-full w-full" onChange={onDrawSignatureChange} value={drawSignature} />
      </div>
    </div>
  );
};
