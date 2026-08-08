import { ImageResponse } from "next/og";
import { pwaIconElement } from "@/lib/pwaIcon";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(pwaIconElement(size.width), size);
}
