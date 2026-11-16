/* DNVB wordmark (from dnvbindonesia.com) with the product tag. Used in the dashboard and the landing page. */
export default function DnvbLogo({ height = 22, tag = true, invert = false }: { height?: number; tag?: boolean; invert?: boolean }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
      <img src="/brand/dnvb-logo.png" alt="dnvb" height={height} style={{ height, width: 'auto', display: 'block', filter: invert ? 'invert(1)' : undefined }} />
      {tag && (
        <span style={{ fontSize: Math.max(10, Math.round(height * 0.5)), fontWeight: 600, color: invert ? '#fff' : '#F55D9E', letterSpacing: '-0.01em', whiteSpace: 'nowrap' }}>
          TikTok Hub
        </span>
      )}
    </span>
  );
}
