import type { Metadata } from "next";
import "./globals.css";

const title = "TrustGate V1.3 · Before an Agent Says Yes";
const description =
  "A gate every payment must pass before an AI agent says yes. Vault, seller-signed offers, and GenLayer validators that accept, reject or renegotiate the deal on-chain.";

export const metadata: Metadata = {
  metadataBase: new URL("https://trustgatecheck.xyz"),
  title,
  description,
  openGraph: { type: "website", url: "/", siteName: "TrustGate", title, description, locale: "en_US" },
  twitter: { card: "summary_large_image", title, description, creator: "@eam__sha" },
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
