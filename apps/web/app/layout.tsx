import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "agentflow",
  description: "Background agents for content + coaching",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">{children}</body>
    </html>
  );
}
