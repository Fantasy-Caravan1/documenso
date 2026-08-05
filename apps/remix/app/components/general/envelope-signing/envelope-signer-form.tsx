import { isSignatureFieldType } from '@documenso/prisma/guards/is-signature-field';
import { Input } from '@documenso/ui/primitives/input';
import { Label } from '@documenso/ui/primitives/label';
import { RadioGroup, RadioGroupItem } from '@documenso/ui/primitives/radio-group';
import { SignaturePadDialog } from '@documenso/ui/primitives/signature-pad/signature-pad-dialog';
import { useToast } from '@documenso/ui/primitives/use-toast';
import { Plural, Trans } from '@lingui/react/macro';
import { FieldType, RecipientRole } from '@prisma/client';
import { useMemo, useState } from 'react';

import { useEmbedSigningContext } from '~/components/embed/embed-signing-context';

import { useRequiredDocumentSigningAuthContext } from '../document-signing/document-signing-auth-provider';
import { useRequiredEnvelopeSigningContext } from '../document-signing/envelope-signing-provider';

export default function EnvelopeSignerForm() {
  const {
    fullName,
    signature,
    setFullName,
    setSignature,
    envelope,
    recipientFields,
    recipient,
    assistantFields,
    assistantRecipients,
    selectedAssistantRecipient,
    setSelectedAssistantRecipientId,
    signField,
  } = useRequiredEnvelopeSigningContext();
  const { executeActionAuthProcedure } = useRequiredDocumentSigningAuthContext();

  const { isNameLocked, isEmailLocked } = useEmbedSigningContext() || {};
  const { toast } = useToast();
  const [isAutoSigningSignature, setIsAutoSigningSignature] = useState(false);

  const hasSignatureField = useMemo(() => {
    return recipientFields.some((field) => isSignatureFieldType(field.type));
  }, [recipientFields]);

  const unsignedSignatureFields = useMemo(() => {
    if (recipient.role === RecipientRole.ASSISTANT || recipient.role === RecipientRole.VIEWER) {
      return [];
    }

    return recipientFields.filter((field) => field.type === FieldType.SIGNATURE && !field.inserted);
  }, [recipient.role, recipientFields]);

  const isSubmitting = isAutoSigningSignature;

  const handleSignatureChange = async (nextSignature: string) => {
    setSignature(nextSignature ?? '');

    if (!nextSignature || unsignedSignatureFields.length === 0) {
      return;
    }

    setIsAutoSigningSignature(true);

    try {
      await executeActionAuthProcedure({
        onReauthFormSubmit: async (authOptions) => {
          for (const field of unsignedSignatureFields) {
            await signField(
              field.id,
              {
                type: FieldType.SIGNATURE,
                value: nextSignature,
              },
              authOptions,
            );
          }
        },
        actionTarget: FieldType.SIGNATURE,
      });
    } catch (err) {
      console.error(err);

      toast({
        title: 'Error',
        description: 'An error occurred while signing the field.',
        variant: 'destructive',
      });
    } finally {
      setIsAutoSigningSignature(false);
    }
  };

  if (recipient.role === RecipientRole.VIEWER) {
    return null;
  }

  if (recipient.role === RecipientRole.ASSISTANT) {
    return (
      <fieldset className="embed--DocumentWidgetForm rounded-2xl border-border sm:border sm:p-3 dark:bg-background">
        <RadioGroup
          className="gap-0 space-y-2 shadow-none sm:space-y-3"
          value={selectedAssistantRecipient?.id?.toString()}
          onValueChange={(value) => {
            setSelectedAssistantRecipientId(Number(value));
          }}
        >
          {assistantRecipients
            .filter((r) => r.fields.length > 0)
            .map((r) => (
              <div key={r.id} className="relative flex flex-col gap-4 rounded-lg border border-border bg-widget p-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <RadioGroupItem
                      id={r.id.toString()}
                      value={r.id.toString()}
                      className="after:absolute after:inset-0"
                    />

                    <div className="grid grow gap-1">
                      <Label className="inline-flex items-start" htmlFor={r.id.toString()}>
                        {r.name}

                        {r.id === recipient.id && (
                          <span className="ml-2 text-muted-foreground">
                            <Trans>(You)</Trans>
                          </span>
                        )}
                      </Label>
                      <p className="text-muted-foreground text-xs">{r.email}</p>
                    </div>
                  </div>
                  <div className="text-muted-foreground text-xs leading-[inherit]">
                    <Plural
                      value={assistantFields.filter((field) => field.recipientId === r.id).length}
                      one="# field"
                      other="# fields"
                    />
                  </div>
                </div>
              </div>
            ))}
        </RadioGroup>
      </fieldset>
    );
  }

  return (
    <fieldset disabled={isSubmitting} className="flex flex-1 flex-col gap-4">
      <div className="flex flex-1 flex-col gap-y-4">
        <div>
          <Label htmlFor="full-name">
            <Trans>Full Name</Trans>
          </Label>

          <Input
            type="text"
            id="full-name"
            className="mt-2 bg-background"
            value={fullName}
            disabled={isNameLocked}
            onChange={(e) => !isNameLocked && setFullName(e.target.value.trimStart())}
          />
        </div>

        {hasSignatureField && (
          <div>
            <Label htmlFor="Signature">
              <Trans>Signature</Trans>
            </Label>

            <SignaturePadDialog
              className="mt-2"
              disabled={isSubmitting}
              fullName={fullName}
              value={signature ?? ''}
              onChange={(v) => void handleSignatureChange(v ?? '')}
              dialogConfirmText="Sign"
              typedSignatureEnabled={envelope.documentMeta.typedSignatureEnabled}
              uploadSignatureEnabled={envelope.documentMeta.uploadSignatureEnabled}
              drawSignatureEnabled={envelope.documentMeta.drawSignatureEnabled}
            />
          </div>
        )}
      </div>
    </fieldset>
  );
}
