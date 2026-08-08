import type { MetadataRoute } from "next";

// Opens straight into the real dashboard, not the untouched create-next-app placeholder
// still living at "/" -- that's what a home-screen tap should actually land on.
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/dashboard",
    name: "Forex AI — JUDE Trading Assistant",
    short_name: "Forex AI",
    description: "SMC signal dashboard with the JUDE voice trade assistant, MetaApi/Exness execution, and an AI risk guardian.",
    start_url: "/dashboard",
    scope: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#09090b",
    theme_color: "#09090b",
    icons: [
      { src: "/icon-192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon-512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icon-512-maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
