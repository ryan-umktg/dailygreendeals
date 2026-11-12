/** Small helpers for the admin's plain HTML forms. */
export const fstr = (f: FormData, k: string, max = 1000) => {
  const v = f.get(k);
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null;
};
export const fnum = (f: FormData, k: string) => {
  const v = fstr(f, k, 40);
  if (v === null) return null;
  const n = Number(v.replace(/[$,%\s]/g, ''));
  return Number.isFinite(n) ? n : null;
};
export const fbool = (f: FormData, k: string) => (f.get(k) ? 1 : 0);
export const fall = (f: FormData, k: string) => f.getAll(k).filter((v): v is string => typeof v === 'string' && v !== '');

/** <input type="datetime-local"> value (Denver time) ⇄ UTC ISO. */
export function fromLocalInput(v: string | null): string | null {
  if (!v) return null;
  const d = new Date(v.length === 10 ? `${v}T23:59:59-07:00` : `${v}:00-07:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
export function toLocalInput(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(new Date(iso).getTime() - 7 * 3600_000);
  return d.toISOString().slice(0, 16);
}

export const back = (to: string) => new Response(null, { status: 303, headers: { location: to } });

export const slugify = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
