import type { Metadata } from "next";
import Link from "next/link";

const ogImage = { width: 1200, height: 630, type: "image/png", alt: "TrustGate" };
const v1Description = "A GenLayer deal inspector for AI agents: the original TrustGate, unchanged. The current version, TrustGate V1.3, is at trustgatecheck.xyz.";

export const metadata: Metadata = {
  title: "TrustGate Version 1 · Deal inspector",
  description: v1Description,
  openGraph: { type: "website", url: "/v1", siteName: "TrustGate", title: "TrustGate V1", description: v1Description, locale: "en_US", images: [{ url: "/opengraph-image.png", ...ogImage }] },
  twitter: { card: "summary_large_image", title: "TrustGate V1", description: v1Description, creator: "@eam__sha", images: [{ url: "/twitter-image.png", ...ogImage }] },
};
import { DealInspector } from "@/components/deal-inspector";

// V1 (the deal inspector) unchanged; only this notice is added around it.
export default function V1() {
  return (
    <>
      <div className="v1-notice" role="note">
        <span>This is TrustGate Version 1. <Link href="/">Go to V1.3 (current) →</Link></span>
        <span>V1 reports may not load: V1 depends on contract reads (gen_call), which failed on GenLayer Studio Next for all contracts during our work and may still fail intermittently.</span>
      </div>
      <DealInspector />
    </>
  );
}
