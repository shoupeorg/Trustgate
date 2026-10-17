import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "TrustGate V1.3",
  description: "Before an Agent Says Yes: a GenLayer commitment vault for AI agents.",
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
