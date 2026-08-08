// Shared visual for every generated app icon (favicon, apple-touch-icon, and the PWA
// manifest's 192/512/maskable icons) so they're all the same mark at different sizes,
// rendered via next/og's ImageResponse (Satori) rather than checked-in binary assets.
// Colors match the dashboard's existing dark zinc theme and sky/emerald accents.
export function pwaIconElement(sizePx: number, options: { maskable?: boolean } = {}) {
  const { maskable = false } = options;
  // Maskable icons need their content well inside Android's adaptive-icon "safe zone" --
  // the OS may crop the outer edges into a circle/squircle/rounded-square depending on
  // the launcher, so the badge is shrunk and centered rather than filling the canvas.
  const badgeSize = maskable ? Math.round(sizePx * 0.62) : sizePx;
  const badgeRadius = Math.round(badgeSize * 0.22);
  const fontSize = Math.round(badgeSize * 0.56);

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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: badgeSize,
          height: badgeSize,
          borderRadius: badgeRadius,
          background: "linear-gradient(135deg, #0ea5e9 0%, #10b981 100%)",
        }}
      >
        <div style={{ display: "flex", color: "#fff", fontSize, fontWeight: 800, fontFamily: "sans-serif" }}>J</div>
      </div>
    </div>
  );
}
