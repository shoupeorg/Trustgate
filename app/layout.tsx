import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TrustGate",
  description: "A pre-commitment risk layer for agent-to-agent transactions.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
