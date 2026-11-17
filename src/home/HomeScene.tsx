export default function HomeScene({ mood = "calm" }: { mood?: "calm" | "warning" | "offline" }) {
  return <svg viewBox="0 0 320 275" className={`home-scene home-scene--${mood}`} aria-hidden="true">
    <circle cx="179" cy="138" r="108" fill="#dcebdd"/>
    <circle cx="276" cy="56" r="9" fill="#fbfdf6"/><circle cx="73" cy="93" r="4" fill="#c1d7c4"/>
    <path d="M51 73h26m-13-13v26" stroke="#bcd2bf" strokeWidth="2" strokeLinecap="round"/>
    <path d="M19 244Q167 209 316 244" fill="#c8dcc7"/>
    <path d="M90 141 178 71 265 141V237H90Z" fill="#fdfcf5"/>
    <path d="M77 140 171 63Q178 58 185 64L279 140" fill="none" stroke={mood === "warning" ? "#af7e64" : "#5d856a"} strokeWidth="15" strokeLinecap="round" strokeLinejoin="round"/>
    <rect x="219" y="65" width="21" height="40" rx="4" fill="#75967c"/>
    <rect x="155" y="163" width="44" height="74" rx="22" fill="#92b399"/>
    <circle cx="187" cy="202" r="2.3" fill="#f8faf2"/>
    <rect x="107" y="156" width="29" height="34" rx="3" fill="#d5e4d0"/>
    <path d="M121.5 156V190M107 173H136" stroke="#fffdf6" strokeWidth="4"/>
    <rect x="219" y="156" width="29" height="34" rx="3" fill="#d5e4d0"/>
    <path d="M233.5 156V190M219 173H248" stroke="#fffdf6" strokeWidth="4"/>
    <path d="M54 237V174" stroke="#79997a" strokeWidth="5"/>
    <ellipse cx="54" cy="168" rx="24" ry="37" fill="#a1bb9a"/>
    <path d="M54 210V180m0 14-10-9m10 1 9-9" fill="none" stroke="#82a084" strokeWidth="2.5" strokeLinecap="round"/>
    <ellipse cx="272" cy="238" rx="27" ry="4" fill="#b4cbb2"/>
    <path d="M253 235v-12q4-16 17-10l14 13 12-2" fill="none" stroke="#c29d76" strokeWidth="12" strokeLinecap="round"/>
    <path d="M269 221v16m14-11v11" stroke="#c29d76" strokeWidth="7" strokeLinecap="round"/>
    <ellipse cx="261" cy="211" rx="12" ry="13" fill="#d8b78e"/>
    <path d="M252 205 249 217" stroke="#9f7c5e" strokeWidth="7" strokeLinecap="round"/>
    <circle cx="266" cy="210" r="1.7" fill="#3e4b3a"/>
    <circle cx="272" cy="214" r="2" fill="#7c6852"/>
    <circle cx="195" cy="118" r="24" fill="#fff"/>
    {mood === "warning" ? <path d="M195 106v13m0 7v1" stroke="#be755b" strokeWidth="4" strokeLinecap="round"/> : mood === "offline" ? <path d="M187 118h16" stroke="#8a9c8b" strokeWidth="4" strokeLinecap="round"/> : <path d="m185 117 7 7 13-14" fill="none" stroke="#618e6d" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>}
    <path d="M141 246h75" stroke="#b3cbb3" strokeWidth="4" strokeLinecap="round"/>
    <path d="M87 241h8m202 2h7" stroke="#8eae92" strokeWidth="3" strokeLinecap="round"/>
  </svg>;
}
