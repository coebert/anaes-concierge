/**
 * Maps a surgical specialty name to a consistent colour scheme used
 * across the theatre rota grid. Common specialties get curated colours
 * (plastics = blue, ortho = orange, etc.); anything unknown falls back
 * to a deterministic hash-picked palette entry so the same specialty
 * always renders in the same colour.
 *
 * Tailwind v4 needs literal class names in source to keep utilities in
 * the build, so every class string here is hard-coded — do not template
 * the colour name.
 */

export type SpecialtyTone = {
  /** Tailwind classes applied to the session cell background + border. */
  cell: string;
  /** Tailwind classes for the specialty label text. */
  label: string;
  /** Hex-ish dot used in legends. */
  swatch: string;
};

const PALETTE: Record<string, SpecialtyTone> = {
  blue: {
    cell: "bg-blue-500/10 border-l-4 border-l-blue-500",
    label: "text-blue-700 dark:text-blue-300",
    swatch: "bg-blue-500",
  },
  orange: {
    cell: "bg-orange-500/10 border-l-4 border-l-orange-500",
    label: "text-orange-700 dark:text-orange-300",
    swatch: "bg-orange-500",
  },
  rose: {
    cell: "bg-rose-500/10 border-l-4 border-l-rose-500",
    label: "text-rose-700 dark:text-rose-300",
    swatch: "bg-rose-500",
  },
  emerald: {
    cell: "bg-emerald-500/10 border-l-4 border-l-emerald-500",
    label: "text-emerald-700 dark:text-emerald-300",
    swatch: "bg-emerald-500",
  },
  violet: {
    cell: "bg-violet-500/10 border-l-4 border-l-violet-500",
    label: "text-violet-700 dark:text-violet-300",
    swatch: "bg-violet-500",
  },
  amber: {
    cell: "bg-amber-500/10 border-l-4 border-l-amber-500",
    label: "text-amber-700 dark:text-amber-300",
    swatch: "bg-amber-500",
  },
  cyan: {
    cell: "bg-cyan-500/10 border-l-4 border-l-cyan-500",
    label: "text-cyan-700 dark:text-cyan-300",
    swatch: "bg-cyan-500",
  },
  pink: {
    cell: "bg-pink-500/10 border-l-4 border-l-pink-500",
    label: "text-pink-700 dark:text-pink-300",
    swatch: "bg-pink-500",
  },
  lime: {
    cell: "bg-lime-500/10 border-l-4 border-l-lime-500",
    label: "text-lime-700 dark:text-lime-300",
    swatch: "bg-lime-500",
  },
  teal: {
    cell: "bg-teal-500/10 border-l-4 border-l-teal-500",
    label: "text-teal-700 dark:text-teal-300",
    swatch: "bg-teal-500",
  },
  indigo: {
    cell: "bg-indigo-500/10 border-l-4 border-l-indigo-500",
    label: "text-indigo-700 dark:text-indigo-300",
    swatch: "bg-indigo-500",
  },
  fuchsia: {
    cell: "bg-fuchsia-500/10 border-l-4 border-l-fuchsia-500",
    label: "text-fuchsia-700 dark:text-fuchsia-300",
    swatch: "bg-fuchsia-500",
  },
  slate: {
    cell: "bg-slate-500/10 border-l-4 border-l-slate-400",
    label: "text-slate-700 dark:text-slate-300",
    swatch: "bg-slate-500",
  },
};

const FALLBACK_ORDER: (keyof typeof PALETTE)[] = [
  "cyan", "pink", "lime", "teal", "indigo", "fuchsia", "violet", "amber",
];

/**
 * Keyword → palette key. First substring match wins, so order matters
 * (more specific terms before generic ones).
 */
const KEYWORD_MAP: Array<[RegExp, keyof typeof PALETTE]> = [
  [/plastic|burn/i, "blue"],
  [/orthop|ortho|trauma|spine|spinal/i, "orange"],
  [/gynae|obstetric|maternity|obs/i, "rose"],
  [/general\s*surg|colorectal|upper\s*gi|hpb|hepato|breast/i, "emerald"],
  [/urolog/i, "violet"],
  [/vascular/i, "amber"],
  [/cardiac|cardio|thoracic|cardiothoracic/i, "pink"],
  [/neuro/i, "fuchsia"],
  [/ent|otolaryng|oral|maxillof|maxfax|max-fax/i, "cyan"],
  [/ophthalm|eye/i, "teal"],
  [/paed|pediatric/i, "lime"],
  [/dental/i, "indigo"],
  [/pain/i, "slate"],
];

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

const NEUTRAL: SpecialtyTone = {
  cell: "",
  label: "text-green-600 dark:text-green-400",
  swatch: "bg-muted",
};

export function specialtyTone(name: string | null | undefined): SpecialtyTone {
  if (!name) return NEUTRAL;
  for (const [re, key] of KEYWORD_MAP) {
    if (re.test(name)) return PALETTE[key];
  }
  const key = FALLBACK_ORDER[hashString(name.toLowerCase()) % FALLBACK_ORDER.length];
  return PALETTE[key];
}
