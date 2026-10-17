import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "TrustGate Version 1 · Deal inspector" };
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
