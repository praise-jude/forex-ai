import { PWA_ICON_DATA_URL } from "./pwaIconImage";

// Shared visual for every generated app icon (favicon, apple-touch-icon, and the PWA
// manifest's 192/512/maskable icons) so they're all the same mark at different sizes,
// rendered via next/og's ImageResponse (Satori) rather than checked-in binary assets.
export function pwaIconElement(sizePx: number, options: { maskable?: boolean } = {}) {
  const { maskable = false } = options;
  // Maskable icons need their content well inside Android's adaptive-icon "safe zone" --
  // the OS may crop the outer edges into a circle/squircle/rounded-square depending on
  // the launcher, so the badge is shrunk and centered rather than filling the canvas.
  const badgeSize = maskable ? Math.round(sizePx * 0.62) : sizePx;
  const badgeRadius = Math.round(badgeSize * 0.18);

  return (
    <div
      style={{
        width: sizePx,
        height: sizePx,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#09090b",
      }}
    >
      {/* Satori (next/og's ImageResponse renderer) only understands plain <img>, not
          next/image's <Image /> -- this never reaches a real browser DOM. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={PWA_ICON_DATA_URL}
        alt=""
        width={badgeSize}
        height={badgeSize}
        style={{ borderRadius: badgeRadius, objectFit: "cover" }}
      />
    </div>
  );
}
