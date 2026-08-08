import { ImageResponse } from "next/og";
import { pwaIconElement } from "@/lib/pwaIcon";

const SIZE = 512;

export async function GET() {
  return new ImageResponse(pwaIconElement(SIZE, { maskable: true }), { width: SIZE, height: SIZE });
}
