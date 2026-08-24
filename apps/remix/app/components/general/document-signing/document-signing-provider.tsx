import { createContext, useContext, useState } from 'react';

export type DocumentSigningContextValue = {
  fullName: string;
  setFullName: (_value: string) => void;
  email: string;
  setEmail: (_value: string) => void;
  signature: string | null;
  setSignature: (_value: string | null) => void;
};

const DocumentSigningContext = createContext<DocumentSigningContextValue | null>(null);

export const useDocumentSigningContext = () => {
  return useContext(DocumentSigningContext);
};

export const useRequiredDocumentSigningContext = () => {
  const context = useDocumentSigningContext();

  if (!context) {
    throw new Error('Signing context is required');
  }

  return context;
};

export interface DocumentSigningProviderProps {
  fullName?: string | null;
  email?: string | null;
  /** @deprecated Ignored. Every contract requires a fresh drawn signature. */
  signature?: string | null;
  /** @deprecated Ignored. New signatures are always drawn. */
  typedSignatureEnabled?: boolean;
  /** @deprecated Ignored. New signatures are always drawn. */
  uploadSignatureEnabled?: boolean;
  /** @deprecated Ignored. New signatures are always drawn. */
  drawSignatureEnabled?: boolean;
  children: React.ReactNode;
}

export const DocumentSigningProvider = ({
  fullName: initialFullName,
  email: initialEmail,
  children,
}: DocumentSigningProviderProps) => {
  const [fullName, setFullName] = useState(initialFullName || '');
  const [email, setEmail] = useState(initialEmail || '');

  // Each contract must capture a fresh signature from the drawing canvas.
  const [signature, setSignature] = useState<string | null>(null);

  return (
    <DocumentSigningContext.Provider
      value={{
        fullName,
        setFullName,
        email,
        setEmail,
        signature,
        setSignature,
      }}
    >
      {children}
    </DocumentSigningContext.Provider>
  );
};

DocumentSigningProvider.displayName = 'DocumentSigningProvider';
