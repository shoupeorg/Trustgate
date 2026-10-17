import { Syne } from "next/font/google";
import { VaultApp } from "@/components/vault-app";
import "./landing.css";
import "./landing-ux.css";

const syne = Syne({ subsets: ["latin"], weight: ["400", "500", "600", "700", "800"], variable: "--syne", display: "swap" });

// Runs while the HTML is parsed, before the first paint: the landing always opens at the top
// (no scroll restore, no jump to a #hash); ?negotiation= links keep their query string.
const OPEN_AT_TOP = `if('scrollRestoration' in history)history.scrollRestoration='manual';if(location.hash)history.replaceState(null,'',location.pathname+location.search);window.scrollTo(0,0);`;

export default function Home() {
  return (
    <div className={syne.variable}>
      <script dangerouslySetInnerHTML={{ __html: OPEN_AT_TOP }} />
      <VaultApp />
    </div>
  );
}
