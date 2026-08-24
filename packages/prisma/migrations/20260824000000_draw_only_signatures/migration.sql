-- New document metadata and organisation defaults are draw-only. Existing
-- rows are intentionally left untouched so completed contracts retain their
-- historical signature metadata.
ALTER TABLE "DocumentMeta"
ALTER COLUMN "typedSignatureEnabled" SET DEFAULT false,
ALTER COLUMN "uploadSignatureEnabled" SET DEFAULT false,
ALTER COLUMN "drawSignatureEnabled" SET DEFAULT true;

ALTER TABLE "OrganisationGlobalSettings"
ALTER COLUMN "typedSignatureEnabled" SET DEFAULT false,
ALTER COLUMN "uploadSignatureEnabled" SET DEFAULT false,
ALTER COLUMN "drawSignatureEnabled" SET DEFAULT true;
