import { getFeed, probeContractReads } from "@/lib/feed-server";
import { VAULT_CONTRACT } from "@/lib/vault";

// Vault feed for the TrustGate V1.3 site, rebuilt from the contract's transaction history.
// The response says where the data came from and whether direct contract reads work right now.

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const requested = new URL(request.url).searchParams.get("contract");
  const contract = requested && /^0x[0-9a-fA-F]{40}$/.test(requested) ? requested : VAULT_CONTRACT;
  try {
    const [feed, reads] = await Promise.all([getFeed(contract), probeContractReads(contract)]);
    const events = feed.events;
    return Response.json(
      {
        contract,
        events,
        source: `transaction history · contract reads ${reads.ok ? "working" : `failing (${reads.detail})`}`,
        readsWorking: reads.ok,
        fetchedAt: new Date(feed.at).toISOString(),
        cachedStale: feed.stale,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return Response.json({ contract, events: [], error: error instanceof Error ? error.message : "Feed unavailable" }, { status: 502 });
  }
}
