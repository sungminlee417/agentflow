import type { Metadata } from "next";
import "./globals.css";
import { ThemeProvider } from "@/components/theme-provider";
import { Toaster } from "sonner";

export const metadata: Metadata = {
  // The %s slot lets each page override just the leading part —
  // e.g. /video-ideas sets title="Video ideas" and the tab shows
  // "Video ideas · agentflow".
  title: {
    default: "agentflow",
    template: "%s · agentflow",
  },
  description:
    "AI-driven content workflow: generate video ideas grounded in your audience, run reviews on what you ship, and steer the next batch with what worked.",
  icons: {
    icon: "/icon.svg",
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="min-h-screen">
        <ThemeProvider
          attribute="class"
          defaultTheme="system"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster
            position="bottom-right"
            richColors
            closeButton
            theme="system"
          />
        </ThemeProvider>
      </body>
    </html>
  );
}
