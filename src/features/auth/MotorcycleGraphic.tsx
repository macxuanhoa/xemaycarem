export function MotorcycleGraphic({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 240 120"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={className}
      aria-hidden="true"
    >
      <defs>
        {/* Gradients */}
        <linearGradient id="bodyGrad" x1="40" y1="40" x2="200" y2="80" gradientUnits="userSpaceOnUse">
          <stop stopColor="#c7d2fe" />
          <stop offset="0.5" stopColor="#818cf8" />
          <stop offset="1" stopColor="#4f46e5" />
        </linearGradient>
        <linearGradient id="darkParts" x1="0" y1="0" x2="0" y2="1">
          <stop stopColor="#312e81" stopOpacity="0.8" />
          <stop offset="1" stopColor="#0f172a" stopOpacity="0.95" />
        </linearGradient>
        <linearGradient id="headlightBeam" x1="195" y1="46" x2="240" y2="52" gradientUnits="userSpaceOnUse">
          <stop stopColor="#e0e7ff" stopOpacity="0.8" />
          <stop offset="1" stopColor="#818cf8" stopOpacity="0" />
        </linearGradient>
        <linearGradient id="exhaustGrad" x1="100" y1="84" x2="165" y2="76" gradientUnits="userSpaceOnUse">
          <stop stopColor="#94a3b8" />
          <stop offset="1" stopColor="#cbd5e1" />
        </linearGradient>
      </defs>

      {/* Ground shadow & light track */}
      <ellipse cx="118" cy="106" rx="90" ry="3.5" fill="#000000" opacity="0.55" />
      <line x1="20" y1="106" x2="220" y2="106" stroke="#818cf8" strokeWidth="1" strokeDasharray="3 3" opacity="0.3" />

      {/* Headlight beam */}
      <polygon points="196,44 240,36 240,58 198,48" fill="url(#headlightBeam)" />

      {/* === REAR WHEEL === */}
      <circle cx="48" cy="82" r="23" stroke="#94a3b8" strokeWidth="4" fill="#090d16" />
      {/* 5-spoke sport rim */}
      <circle cx="48" cy="82" r="16" stroke="#475569" strokeWidth="1.2" opacity="0.6" />
      <line x1="48" y1="67" x2="48" y2="97" stroke="#cbd5e1" strokeWidth="1.5" opacity="0.7" />
      <line x1="33" y1="77" x2="63" y2="87" stroke="#cbd5e1" strokeWidth="1.5" opacity="0.7" />
      <line x1="37" y1="92" x2="59" y2="72" stroke="#cbd5e1" strokeWidth="1.5" opacity="0.7" />
      {/* Brake Rotor & Red Caliper */}
      <circle cx="48" cy="82" r="11" stroke="#f43f5e" strokeWidth="2" strokeDasharray="3 2" />
      <rect x="56" y="75" width="7" height="12" rx="2" fill="#ef4444" />
      <circle cx="48" cy="82" r="5" fill="#e2e8f0" />

      {/* === FRONT WHEEL === */}
      <circle cx="188" cy="82" r="23" stroke="#94a3b8" strokeWidth="4" fill="#090d16" />
      {/* 5-spoke sport rim */}
      <circle cx="188" cy="82" r="16" stroke="#475569" strokeWidth="1.2" opacity="0.6" />
      <line x1="188" y1="67" x2="188" y2="97" stroke="#cbd5e1" strokeWidth="1.5" opacity="0.7" />
      <line x1="173" y1="77" x2="203" y2="87" stroke="#cbd5e1" strokeWidth="1.5" opacity="0.7" />
      <line x1="177" y1="92" x2="199" y2="72" stroke="#cbd5e1" strokeWidth="1.5" opacity="0.7" />
      {/* Brake Rotor & Red Caliper */}
      <circle cx="188" cy="82" r="12" stroke="#f43f5e" strokeWidth="2" strokeDasharray="3 2" />
      <rect x="174" y="75" width="7" height="13" rx="2" fill="#ef4444" />
      <circle cx="188" cy="82" r="5" fill="#e2e8f0" />

      {/* === FRONT INVERTED TELESCOPIC FORK === */}
      <line x1="188" y1="82" x2="164" y2="34" stroke="#e2e8f0" strokeWidth="4" strokeLinecap="round" />
      <line x1="185" y1="78" x2="167" y2="40" stroke="#818cf8" strokeWidth="1.5" opacity="0.8" />

      {/* Front Mudguard / Fender */}
      <path d="M168 68C174 58 196 58 204 70" stroke="#818cf8" strokeWidth="3.5" strokeLinecap="round" fill="none" />

      {/* === HANDLEBAR & COCKPIT CONTROLS === */}
      <path d="M164 34L156 26L148 24" stroke="#e2e8f0" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
      {/* Rearview Mirrors (Left & Right) */}
      <line x1="156" y1="26" x2="153" y2="15" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" />
      <polygon points="149,15 156,12 157,17 150,19" fill="#818cf8" />

      {/* Aerodynamic Windscreen */}
      <path d="M164 34C168 25 177 18 188 16" stroke="#c7d2fe" strokeWidth="3" strokeLinecap="round" />

      {/* === FRONT FAIRING COWL & LED HEADLIGHT === */}
      <path
        d="M188 16C197 22 203 34 198 46L180 60L162 52L164 34Z"
        fill="url(#bodyGrad)"
        stroke="#e0e7ff"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      {/* High-intensity LED Headlight */}
      <polygon points="196,40 200,43 194,48 191,44" fill="#ffffff" />
      <path d="M184 48L194 48" stroke="#38bdf8" strokeWidth="1.8" strokeLinecap="round" />

      {/* === MAIN CHASSIS / TANK / ENGINE AREA === */}
      <path
        d="M162 52C148 57 134 58 120 58C106 58 94 48 80 48C68 48 58 56 48 64L40 74C46 74 56 72 64 72C74 72 86 80 96 86L116 90L144 88L156 74L162 52Z"
        fill="url(#darkParts)"
        stroke="#818cf8"
        strokeWidth="1.8"
        strokeLinejoin="round"
      />

      {/* Tank Cover Accent Badge */}
      <path d="M138 52C128 50 114 50 102 54L114 62L134 60Z" fill="url(#bodyGrad)" opacity="0.85" />

      {/* === TWO-TIER SPORT SADDLE === */}
      <path
        d="M66 48C78 48 92 56 112 56C122 56 130 52 136 48C138 52 134 58 124 60C110 61 96 56 76 54C64 53 58 51 66 48Z"
        fill="#1e1b4b"
        stroke="#818cf8"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />

      {/* === ENGINE & TRANSMISSION CRANKCASE === */}
      <rect x="88" y="70" width="36" height="22" rx="5" fill="#0f172a" stroke="#64748b" strokeWidth="1.5" />
      <circle cx="106" cy="81" r="7" stroke="#94a3b8" strokeWidth="1.5" fill="#1e293b" />
      <line x1="93" y1="74" x2="100" y2="74" stroke="#64748b" strokeWidth="1" />
      <line x1="93" y1="78" x2="100" y2="78" stroke="#64748b" strokeWidth="1" />
      <line x1="93" y1="82" x2="100" y2="82" stroke="#64748b" strokeWidth="1" />

      {/* === SPORT EXHAUST & MUFFLER === */}
      <path
        d="M106 88C116 90 132 90 146 84L162 80C165 79 167 81 165 84L146 91C132 95 116 94 104 90Z"
        fill="url(#exhaustGrad)"
        stroke="#e2e8f0"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <ellipse cx="162" cy="81" rx="2.5" ry="3.5" fill="#475569" />

      {/* === REAR SWINGARM & MONOSHOCK === */}
      <line x1="48" y1="82" x2="88" y2="78" stroke="#cbd5e1" strokeWidth="3.5" strokeLinecap="round" />
      <line x1="60" y1="79" x2="78" y2="64" stroke="#f43f5e" strokeWidth="2.5" strokeLinecap="round" />

      {/* === SPORT TAIL COWL & LED TAILLIGHT === */}
      <path d="M26 76C32 64 42 58 54 56" stroke="#818cf8" strokeWidth="3" strokeLinecap="round" />
      <polygon points="22,76 27,74 27,78" fill="#ef4444" />
    </svg>
  );
}
