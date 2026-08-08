import { ImageResponse } from "next/og";
import { pwaIconElement } from "@/lib/pwaIcon";

const SIZE = 192;

export async function GET() {
  return new ImageResponse(pwaIconElement(SIZE), { width: SIZE, height: SIZE });
}
