import { Img, Link } from '../components';
import { useBranding } from '../providers/branding';
import { getSafeBrandingUrl } from '../utils/branding-url';

const FANTASY_CARAVAN_BRAND_URL = 'https://fantasycaravan.com.au';
export const FANTASY_CARAVAN_LOGO_PATH = '/static/fantasy-logo-2026-email.png';
const FANTASY_CARAVAN_LOGO_WIDTH = 180;
const FANTASY_CARAVAN_LOGO_HEIGHT = 68;

export type TemplateBrandingLogoProps = {
  assetBaseUrl: string;
  className?: string;
};

/**
 * Renders the email logo.
 *
 * - When custom branding is enabled with a logo, the branding logo is shown.
 *   If a safe (http/https) Brand Website is configured, the logo links to it.
 * - Otherwise the Fantasy Caravan logo is shown.
 */
export const TemplateBrandingLogo = ({ assetBaseUrl, className = 'mb-4 h-6' }: TemplateBrandingLogoProps) => {
  const branding = useBranding();

  const hasCustomBrandingLogo = branding.brandingEnabled && Boolean(branding.brandingLogo);

  if (!hasCustomBrandingLogo) {
    const fantasyCaravanLogoUrl = new URL(FANTASY_CARAVAN_LOGO_PATH, assetBaseUrl).toString();

    return (
      <Link href={FANTASY_CARAVAN_BRAND_URL} target="_blank">
        <Img
          src={fantasyCaravanLogoUrl}
          alt="Fantasy Caravan Logo"
          width={FANTASY_CARAVAN_LOGO_WIDTH}
          height={FANTASY_CARAVAN_LOGO_HEIGHT}
          className="mb-4"
          style={{
            display: 'block',
            height: `${FANTASY_CARAVAN_LOGO_HEIGHT}px`,
            maxWidth: `${FANTASY_CARAVAN_LOGO_WIDTH}px`,
            width: `${FANTASY_CARAVAN_LOGO_WIDTH}px`,
          }}
        />
      </Link>
    );
  }

  const brandingLogo = <Img src={branding.brandingLogo} alt="Branding Logo" className={className} />;

  const safeBrandingUrl = getSafeBrandingUrl(branding.brandingUrl);

  if (!safeBrandingUrl) {
    return brandingLogo;
  }

  return (
    <Link href={safeBrandingUrl} target="_blank">
      {brandingLogo}
    </Link>
  );
};

export default TemplateBrandingLogo;
