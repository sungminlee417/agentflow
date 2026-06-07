import type { NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

export async function middleware(request: NextRequest) {
  return updateSession(request);
}

export const config = {
  matcher: [
    // Exclude:
    //   - Next.js internals (_next/static, _next/image, favicon)
    //   - Static images (any path ending in image extension)
    //   - Static text/config files served from /public (.txt, .xml, .json)
    //     — these are how third parties verify domain ownership (TikTok,
    //     Google Search Console, etc.) and how crawlers read robots.txt /
    //     sitemap.xml. Routing them through Supabase auth would 307 them
    //     to /login and break verification.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|txt|xml|json)$).*)",
  ],
};
